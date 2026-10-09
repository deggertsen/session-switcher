'use strict';
// OpenClaw session integration: surfaces Gateway agent sessions (Discord channels,
// crons, subagents, voice rooms, direct chats) as read-only rows in Session Switcher,
// and reads their transcripts node-side from the live session store.
//
// Data sources (all local, no secrets handled):
//  - `openclaw sessions --json --all-agents` for the session list (same CLI humans use)
//  - the session store SQLite (WAL, opened read-only per request, closed after) for history
//  - conversation labels + first/last real user prompts so rows say what they're about
//
// v1 is deliberately view-only: no session creation, no message sending.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

const AGENT_NAMES = { main: 'Celeste' };
const prettyAgent = id => AGENT_NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Agent');
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Surface naming from session keys like agent:<id>:<surface>:<rest>
function keyParts(key) {
  const m = /^agent:([^:]+):([^:]+):?([\s\S]*)$/.exec(String(key || ''));
  return m ? { agent: m[1], surface: m[2], rest: m[3] } : null;
}
function surfaceLabel(surface, rest) {
  switch (surface) {
    case 'discord': return /channel/.test(rest) ? 'Discord channel' : /thread/.test(rest) ? 'Discord thread' : 'Discord';
    case 'cron': return 'Cron run';
    case 'subagent': return 'Subagent';
    case 'voice': return 'Voice room';
    case 'direct': return 'Direct chat';
    case 'test': return 'Test';
    default: return surface.charAt(0).toUpperCase() + surface.slice(1);
  }
}

// agentId -> workspace folder, from the OpenClaw config on disk.
function workspaces() {
  const out = {};
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entries = (cfg.agents && cfg.agents.entries) || {};
    for (const [id, e] of Object.entries(entries)) {
      const w = e && e.workspace && typeof e.workspace === 'string' && e.workspace.trim();
      if (w) out[id] = w;
    }
    const def = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.workspace) || null;
    if (def) out.__default = def;
  } catch { /* no config, no grouping */ }
  if (!out.main) out.main = path.join(os.homedir(), 'clawd');
  return out;
}

function flattenContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string').map(b => b.text).join('\n\n');
}

// A real user's words, unwrapped from injected scaffolding: realtime voice turns
// carry their speech inside <input>…</input>; spawned runs get context blocks first.
function unwrapUser(text) {
  let t = String(text || '');
  const m = /<input>([\s\S]*?)<\/input>/.exec(t);
  if (m) t = m[1];
  t = t.replace(/\[(?:Subagent Task|Subagent Context|System[\w ]*|Inter-session[\w ]*|openclaw[^\]]*)\][^\n]*/gi, '');
  const cm = /^\[cron:[0-9a-f-]+ ([^\]]{0,60})\]\s*/.exec(t); if (cm) { const rest = t.slice(cm[0].length).replace(/^[-:|\s]+/, ''); t = rest ? `${cm[1].trim()}: ${rest}` : cm[1].trim(); }
  t = t.replace(/^(>>\s*)?OpenClaw runtime context[^\n]*:(?!\S)/i, '');
  t = t.replace(/<[^>\n]{1,60}>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
const isNoise = t => !t || t.length < 8 || /^<|^<<<|^## /i.test(t) || /^>>/.test(t) || /^You are running as a subagent/i.test(t) || /^OpenClaw runtime context/i.test(t) || /^Disable automatic completion turns/i.test(t) || /^This content was routed by OpenClaw/i.test(t);

function createOpenClaw({ log = () => {}, dataDir } = {}) {
  let cache = null;            // { rows, sig }
  let pending = null;
  let onChange = null;
  let lastError = null;

  // Persisted per-session titles/prompts so rows stay rich without rescanning every file.
  const TITLES_FILE = path.join(dataDir || os.tmpdir(), 'openclaw-titles.json');
  let titleCache = { version: 2, byId: {} };
  let titlesDirty = false, titlesTimer = null;
  const loadTitles = () => { try { const saved = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')); if (saved && saved.version === titleCache.version) titleCache = saved; } catch { /* first run or superseded cache: re-derive */ } };
  const saveTitles = () => {
    titlesDirty = false;
    try {
      const ids = Object.keys(titleCache.byId);
      if (ids.length > 3000) {
        ids.sort((a, b) => (titleCache.byId[a].at || 0) - (titleCache.byId[b].at || 0));
        for (const k of ids.slice(0, ids.length - 3000)) delete titleCache.byId[k];
      }
      fs.writeFileSync(TITLES_FILE, JSON.stringify(titleCache));
    } catch { /* best effort */ }
  };
  const saveTitlesSoon = () => {
    if (!titlesDirty || titlesTimer) return;
    titlesTimer = setTimeout(() => { titlesTimer = null; saveTitles(); }, 800);
  };
  loadTitles();

  function toRow(s, ws) {
    const p = keyParts(s.key) || { agent: s.agentId, surface: 'session', rest: '' };
    const surface = surfaceLabel(p.surface, p.rest);
    const agent = p.agent || s.agentId || 'main';
    const name = AGENT_NAMES[agent] || prettyAgent(agent);
    const fallbackTitle = `${name} · ${surface}`;
    const cwd = ws[agent] || ws.__default;
    return {
      id: s.key,
      provider: 'openclaw',
      sessionId: s.sessionId || null,
      agent,
      title: fallbackTitle,
      autoTitle: fallbackTitle,
      firstPrompt: null,
      lastPrompt: null,
      updated: s.updatedAt || (s.ageMs ? Date.now() - s.ageMs : 0),
      cwd: cwd && fs.existsSync(cwd) ? cwd : null,
      status: s.status || 'idle',
      model: s.model || s.modelOverride || null,
      totalTokens: s.totalTokens || 0,
      channel: p.surface,
      folderExists: !!(cwd && fs.existsSync(cwd)),
      _fresh: !!(s.sessionId && !titleCache.byId[s.sessionId]),
    };
  }

  function storePath(agent) {
    return path.join(os.homedir(), '.openclaw', 'agents', agent || 'main', 'agent', 'openclaw-agent.sqlite');
  }

  // For each fresh session: its conversation label (#channel / group / direct) and
  // its first + last real user prompts, read from that agent's store in one pass.
  function deriveBatch(agent, ids) {
    const file = storePath(agent);
    if (!fs.existsSync(file)) return new Map();
    let db = null;
    const out = new Map();
    try {
      db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1500');
      const labelStmt = db.prepare('SELECT c.label, c.kind FROM session_conversations sc JOIN conversations c ON c.conversation_id = sc.conversation_id WHERE sc.session_id = ? LIMIT 1');
      const headStmt = db.prepare('SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 40');
      const tailStmt = db.prepare('SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 30');
      const take = rows => {
        for (const r of rows) {
          let e; try { e = JSON.parse(r.event_json); } catch { continue; }
          const msg = e && e.message;
          if (!msg || msg.role !== 'user') continue;
          const t = unwrapUser(flattenContent(msg.content));
          if (isNoise(t)) continue;
          return t;
        }
        return null;
      };
      for (const sid of ids) {
        const ent = { at: Date.now(), first: null, last: null, channelLabel: null };
        try {
          const l = labelStmt.get(sid);
          if (l && l.label) {
            const lbl = String(l.label);
            const hash = lbl.indexOf('#');
            if (hash >= 0) ent.channelLabel = clip(lbl.slice(hash), 40);
            else if (l.kind === 'direct') ent.channelLabel = 'direct chat';
            // opaque provider ids keep the plain surface label instead
          }
        } catch { /* mapping may not exist */ }
        try { ent.first = take(headStmt.all(sid)); ent.last = take(tailStmt.all(sid)); } catch { /* store moved */ }
        ent.first = clip(ent.first || '', 90) || null;
        ent.last = clip(ent.last || '', 220) || null;
        out.set(sid, ent);
      }
    } catch (err) {
      log(`openclaw titles ${agent}: ${err.message}`);
    } finally { try { if (db) db.close(); } catch { /* already closed */ } }
    return out;
  }

  function enrich(rows) {
    const nowMs = Date.now();
    const fresh = rows.filter(r => r._fresh && r.sessionId);
    const live = rows.filter(r => r.sessionId && !r._fresh && (r.status === 'running' || nowMs - (r.updated || 0) < 15 * 60 * 1000)).slice(0, 60);
    const needs = fresh.concat(live);
    const byAgent = new Map();
    for (const r of needs) {
      if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
      byAgent.get(r.agent).push(r.sessionId);
    }
    for (const [agent, ids] of byAgent) {
      const got = deriveBatch(agent, ids);
      for (const [sid, ent] of got) if (ent.first || ent.last || ent.channelLabel) titleCache.byId[sid] = ent;
      if (got.size) titlesDirty = true;
    }
    saveTitlesSoon();
    for (const r of rows) {
      r._fresh = undefined;
      const c = r.sessionId ? titleCache.byId[r.sessionId] : null;
      r.firstPrompt = c ? (c.first || null) : null;
      r.lastPrompt = c ? (c.last || null) : null;
      const name = AGENT_NAMES[r.agent] || prettyAgent(r.agent);
      const seed = c && !c.channelLabel && c.first ? clip(c.first, 60) : null;
      if (c && c.channelLabel) r.title = `${name} · ${c.channelLabel}`;
      else if (seed) r.title = `${name} · ${seed}`;
    }
    return rows;
  }

  function list(limit = 200) {
    const args = ['sessions', '--json', '--all-agents', '--limit', String(limit)];
    return new Promise(resolve => {
      let out = '', err = '';
      const child = spawn('openclaw', args, { cwd: dataDir || os.homedir() });
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { lastError = e.message; resolve(null); });
      child.on('close', code => {
        if (code !== 0) { if (err.trim()) log(`openclaw sessions: ${err.trim().slice(0, 200)}`); return resolve(null); }
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 20000);
    });
  }

  // Refresh like codexSessions does: resolve fast with the cache, update in background.
  async function sessions(maxAgeMs = 20000) {
    if (pending) return cache ? cache.rows : [];
    const stale = !cache || Date.now() - cache.at > maxAgeMs;
    if (stale) {
      pending = true;
      list().then(d => {
        pending = null;
        if (!d) return;
        const ws = workspaces();
        const rows = enrich((d.sessions || []).map(s => toRow(s, ws)).filter(r => r.cwd));
        const sig = rows.map(r => `${r.id}:${r.updated}:${r.status}:${r.title}`).join('|');
        if (!cache || cache.sig !== sig) { const first = !cache; cache = { at: Date.now(), sig, rows }; if (!first || rows.length) { if (onChange) onChange(); } }
        else cache.at = Date.now();
      }).catch(() => { pending = null; });
    }
    return cache ? cache.rows : [];
  }

  const known = keyOrId => (cache ? cache.rows.find(r => r.id === keyOrId || r.sessionId === keyOrId) : null);
  const cached = () => (cache ? cache.rows : []);
  const error = () => lastError;

  // ---- transcript history (live store, read-only per request) ----
  async function history(id, { limit = 200 } = {}) {
    const row = known(id);
    const sessionId = row ? row.sessionId : null;
    if (!sessionId) return { items: [], start: null, cursor: null, error: 'unknown-session' };
    const file = storePath(row.agent);
    if (!fs.existsSync(file)) return { items: [], start: null, cursor: null, error: 'no-store' };
    let db;
    try {
      db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1500');
      const rows = db.prepare(
        'SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
      ).all(sessionId, limit * 4);   // headroom: some rows are thinking/system events
      const items = [];
      for (const r of rows) {
        if (items.length >= limit) break;
        let ev = null;
        try { ev = r.event_zstd ? JSON.parse(zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString('utf8')) : JSON.parse(r.event_json); } catch { continue; }
        const msg = ev && ev.message;
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = flattenContent(msg.content).replace(/\s+\n/g, '\n').trim();
        if (!text) continue;
        if (role === 'user') {
          text = unwrapUser(text);
          if (!text || isNoise(text)) continue;
        }
        if (text.length > 4000) text = text.slice(0, 3999) + '…';
        items.push({ role, text, at: ev.timestamp || null });
      }
      items.reverse();
      return { items, start: null, cursor: null };
    } catch (err) {
      log(`openclaw history ${row.agent}: ${err.message}`);
      return { items: [], start: null, cursor: null, error: 'read-failed' };
    } finally { try { if (db) db.close(); } catch { /* already closed */ } }
  }

  return { sessions, cached, known, history, error, onSessionsChanged: fn => { onChange = fn; } };
}

module.exports = { createOpenClaw, prettyAgent };