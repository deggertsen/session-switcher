'use strict';
/* Session Switcher: the hub (main window). The chat window lives in chat-ui.js, which uses the
   helpers defined here: TOKEN, api, esc, toast, S, current, ringById, stamp, wrap, showMenu, closeMenu,
   loadSessions, renderSide, renderMain, Viewer, usageLine, miniDial, markSeen, updateTitle. */

const TOKEN = window.TOKEN;
const RINGS = ['#c98a7c', '#9d8ce0', '#c58a4f', '#b9a3c9', '#d79bb6', '#cfc3a6'];
const CODEX_RING = '#6f97d8';
const GLYPHS = ['❖', '◈', '◆', '☘', '☾', '✥', '⚑', '⚔', '✧', '❝', '➤', '◉'];
const WORKING = new Set(['thinking', 'writing', 'tool', 'starting']);
const $ = id => document.getElementById(id);
const S = {
  accounts: [], projects: [], running: {}, live: {}, acct: null, view: 'hub', folder: null, dryRun: false,
  pins: new Set(), prefs: {}, hits: null, q: '', index: null, drawerId: null,
  activity: [], usage: {}, connected: false, seen: {}, codex: null, worlds: {}, prompts: [], worldTab: 'chats',
};
const inApp = () => S.prefs.openIn !== 'terminal';
const liveOf = id => S.live[String(id).toLowerCase()] || null;

/* ---------- small helpers ---------- */
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; }
try { S.pins = new Set(JSON.parse(store('pins') || '[]')); } catch { /* none */ }
try { S.seen = JSON.parse(store('seen') || '{}') || {}; } catch { S.seen = {}; }
S.recentProv = store('recentProv') || 'all';
const savePins = () => store('pins', JSON.stringify([...S.pins]));
// Favorite chats (pinned to the top of the sidebar), and sidebar sections you've folded away.
try { S.favs = new Set(JSON.parse(store('favChats') || '[]')); } catch { S.favs = new Set(); }
try { S.navFold = new Set(JSON.parse(store('navFold') || '[]')); } catch { S.navFold = new Set(); }
function togglePin(cwd) {
  const on = !S.pins.has(cwd);
  if (on) S.pins.add(cwd); else S.pins.delete(cwd);
  savePins(); renderNav();
  if (S.view === 'hub') renderHubLists(); else if (S.view === 'folder') renderPage();
  toast(on ? `Pinned ${S.projects.find(p => p.cwd === cwd)?.name || 'it'} to the sidebar.` : 'Unpinned.', 4000, { label: 'Undo', run: () => togglePin(cwd) });
}
function toggleFav(id) {
  const k = String(id).toLowerCase(), on = !S.favs.has(k);
  if (on) S.favs.add(k); else S.favs.delete(k);
  store('favChats', JSON.stringify([...S.favs]));
  renderNav(); if (window.ChatUI && ChatUI.refreshFav) ChatUI.refreshFav();
  toast(on ? 'Pinned the chat to the sidebar.' : 'Unpinned the chat.', 4000, { label: 'Undo', run: () => toggleFav(id) });
}
const isFav = id => !!id && S.favs.has(String(id).toLowerCase());
window.toggleFav = toggleFav; window.isFav = isFav;
function openChatFromNav(id) {
  const [s] = sessionById(id); if (!s) return toast('That chat isn’t in the list any more.');
  if (liveOf(s.id)) return ChatUI.open({ sessionId: s.id });
  if (isRunning(s.id)) return ChatUI.watch({ sessionId: s.id, source: 'terminal' });
  return inApp() ? ChatUI.open({ sessionId: s.id }) : openDrawer(s.id);
}

async function api(p, body) {
  let r;
  try {
    r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'X-Switcher-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Session Switcher isn’t running. Start it again from its shortcut or “Start Claude Switcher.bat”.');
  }
  const j = await r.json().catch(() => ({ error: 'Unexpected answer from the app.' }));
  if (r.status === 403 && (j.reason === 'stale' || !j.error)) { location.reload(); throw new Error('Reloading…'); }
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { reason: j.reason, status: r.status });
  return j;
}

let toastTimer;
// A short message at the bottom. With an action ({ label, run }), it carries a button, like Undo.
function toast(msg, ms = 5000, action = null) {
  const t = $('toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); wrap(action.run)(); };
    t.append(' ', b);
  }
  t.classList.toggle('has-act', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), action ? Math.max(ms, 6000) : ms);
}
function wrap(fn) { return async (...args) => { try { return await fn(...args); } catch (err) { if (err.message !== 'Reloading…') toast(err.message, 9000); if (err.reason) reload().catch(() => {}); } return undefined; }; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const glyphFor = name => GLYPHS[hash(name) % GLYPHS.length];
const initial = s => (String(s).trim()[0] || '?').toUpperCase();
const plural = (n, w, many) => `${n} ${n === 1 ? w : (many || `${w}s`)}`;
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const nword = (n, cap = true) => { const w = n < WORDS.length ? WORDS[n] : String(n); return cap ? w : w.toLowerCase(); };
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const agoL = t => { const v = ago(t); return /^[A-Z][a-z]{2} \d/.test(v) ? v : v.toLowerCase(); };
const stamp = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dur(ms, withSeconds) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return withSeconds ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
// "6:12 PM", "tomorrow 9:48 AM", "Sat 9:48 PM" or "Oct 14".
function when(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const now = new Date(), day = 864e5;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= midnight && t < midnight + day) return clock(t);
  if (t >= midnight + day && t < midnight + 2 * day) return `tomorrow ${clock(t)}`;
  if (t > now.getTime() && t < midnight + 7 * day) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const current = () => S.accounts.find(a => a.id === S.acct) || S.accounts[0];
const ringOf = a => RINGS[Math.max(0, S.accounts.indexOf(a)) % RINGS.length];
// Codex accounts: the main one plus any extra ChatGPT or Ollama accounts. S.codex is the active one
// (new Codex chats run as it); S.codex.accounts lists them all. Each keeps a Codex-family color.
const CODEX_RINGS = [CODEX_RING, '#5fc4c9', '#8f7fe0', '#7fb79a', '#c9a24c'];
const codexAccts = () => (S.codex ? (S.codex.accounts && S.codex.accounts.length ? S.codex.accounts : [S.codex]) : []);
const codexAcct = id => codexAccts().find(x => x.id === id) || null;
const codexRing = id => CODEX_RINGS[Math.max(0, codexAccts().findIndex(x => x.id === id)) % CODEX_RINGS.length];
async function setCodexActive(id) {
  if (!S.codex || !id || S.codex.id === id || !codexAcct(id)) return;
  const r = await api('/api/codex/active', { id });
  S.codex = r.codex; renderAll();
}
const ringById = id => { if (codexAcct(id)) return codexRing(id); const a = S.accounts.find(x => x.id === id); return a ? ringOf(a) : 'var(--ash-2)'; };
// A Claude account, or Codex shown as an account (for headers and the usage chip).
const acctById = id => (codexAcct(id) ? (x => ({ id: x.id, name: x.name, email: x.email, plan: x.plan, signedIn: x.signedIn, codex: true }))(codexAcct(id)) : S.accounts.find(x => x.id === id) || null);
const codexReady = () => !!(S.codex && S.codex.enabled && S.codex.signedIn);
const isCodex = s => !!(s && s.provider === 'codex');
const isOpenClaw = s => !!(s && s.provider === 'openclaw');
const ocAgent = s => (s && s.agent ? (s.agent === 'main' ? 'Celeste' : s.agent.charAt(0).toUpperCase() + s.agent.slice(1)) : 'OpenClaw');
const canLaunch = a => !!a && a.signedIn && a.lock.ok;
const isRunning = id => !!S.running[String(id).toLowerCase()];
function highlight(text, q) {
  const out = esc(text);
  const terms = String(q || '').trim().split(/\s+/).filter(t => t.length > 1).map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return out;
  return out.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>');
}
function allSessions() { const all = []; for (const p of S.projects) for (const s of p.sessions) all.push([s, p]); return all; }
function sessionById(id) { const want = String(id || '').toLowerCase(); for (const p of S.projects) { const s = p.sessions.find(x => x.id.toLowerCase() === want); if (s) return [s, p]; } return [null, null]; }
const lastLine = t => { const parts = String(t || '').trim().split(/\n\s*\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean); return parts.length ? parts[parts.length - 1] : ''; };
const plainMd = t => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

const ICON = {
  lock: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.4" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  more: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1.5" fill="currentColor"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><circle cx="14" cy="9" r="1.5" fill="currentColor"/></svg>',
  caret: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5L6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ---------- usage ---------- */
const SPAN = { fiveHour: 5 * 3600e3, week: 7 * 864e5 };
const usageOf = id => S.usage[id] || null;
const leftOf = w => (w && typeof w.used === 'number' ? Math.max(0, Math.round(100 - w.used)) : null);
function elapsed(w, span) {
  if (!w || !w.resetsAt) return null;
  const rem = Date.parse(w.resetsAt) - Date.now();
  if (!(rem >= 0)) return null;
  return Math.min(1, Math.max(0, 1 - rem / span));
}
// At the rate this window has been used so far, does it run out before it resets?
function paceOf(w, span) {
  const t = elapsed(w, span);
  if (t === null || t < 0.08 || !(w.used > 2) || w.used >= 100) return null;
  const spent = t * span, rate = w.used / spent, toReset = Date.parse(w.resetsAt) - Date.now();
  const toLimit = (100 - w.used) / rate;
  return toLimit < toReset ? { runsOut: Date.now() + toLimit, early: toReset - toLimit } : { projected: Math.min(100, Math.round(w.used + rate * toReset)) };
}
// The window that limits you first: the one with less left.
function binding(u) {
  if (!u || !u.data || !u.data.available) return null;
  const f = u.data.fiveHour, w = u.data.week;
  const fl = leftOf(f), wl = leftOf(w);
  if (fl === null && wl === null) return null;
  if (wl !== null && (fl === null || wl < fl)) return { key: 'week', label: 'this week', short: 'week', w, left: wl };
  return { key: 'fiveHour', label: 'five-hour window', short: '5 hr', w: f, left: fl };
}
const hot = left => left !== null && left <= 15;

// The dials draw themselves once, the first time the hub shows them.
let dialsDrawn = false;
function arc(r, frac, cls, width) {
  const c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac || 0));
  return `<circle class="track" cx="100" cy="100" r="${r}" stroke-width="${width}"/>${f > 0 ? `<circle class="arc ${cls}${dialsDrawn ? '' : ' draw'}" style="--c:${c.toFixed(2)}" cx="100" cy="100" r="${r}" stroke-width="${width}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - f)).toFixed(2)}" transform="rotate(-90 100 100)"/>` : ''}`;
}
function polar(r, frac) { const a = frac * 2 * Math.PI - Math.PI / 2; return [100 + r * Math.cos(a), 100 + r * Math.sin(a)]; }
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function dialSvg(u) {
  const d = u && u.data && u.data.available ? u.data : null;
  const f = d && d.fiveHour, w = d && d.week;
  const fl = leftOf(f), wl = leftOf(w);
  let ticks = '';
  for (let i = 0; i < 7; i++) { const [x1, y1] = polar(92.5, i / 7), [x2, y2] = polar(97, i / 7); ticks += `<line class="tick major" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; }
  for (let i = 0; i < 7; i++) { const [x, y] = polar(106, (i + 0.5) / 7); ticks += `<text class="rn" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${ROMAN[i]}</text>`; }
  for (let i = 0; i < 5; i++) { const [x1, y1] = polar(76.5, i / 5), [x2, y2] = polar(80.5, i / 5); ticks += `<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; }
  const now = (r, frac) => { if (frac === null) return ''; const [x, y] = polar(r, frac); return `<circle class="now" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4"/>`; };
  const fe = elapsed(f, SPAN.fiveHour), we = elapsed(w, SPAN.week);
  const center = fl !== null
    ? `<text class="lbl" x="100" y="80">five hours</text><text class="big ${hot(fl) ? 'hot' : ''}" x="100" y="113">${fl}%</text><text class="lbl" x="100" y="131">left</text>`
    : wl !== null
    ? `<text class="lbl" x="100" y="80">this week</text><text class="big ${hot(wl) ? 'hot' : ''}" x="100" y="113">${wl}%</text><text class="lbl" x="100" y="131">left</text>`
    : `<text class="lbl" x="100" y="96">usage</text><text class="lbl" x="100" y="112">not known yet</text>`;
  return `<svg class="dial ${d ? '' : 'unknown'}" viewBox="-14 -14 228 228" role="img" aria-label="${d ? [fl !== null ? `Five-hour window ${fl}% left` : '', wl !== null ? `week ${wl}% left` : ''].filter(Boolean).join(', ') : 'Usage not known yet'}">
    ${ticks}
    ${arc(86, w ? w.used / 100 : 0, `week ${hot(wl) ? 'hot' : ''}`, 7)}
    ${arc(68, f ? f.used / 100 : 0, `five ${hot(fl) ? 'hot' : ''}`, 10)}
    <circle class="face" cx="100" cy="100" r="58"/>
    ${now(86, we)}${now(68, fe)}
    ${center}
  </svg>`;
}
// A small two-ring dial: inner is the five-hour window, outer is the week.
function miniDial(id, size = 22) {
  const u = usageOf(id), d = u && u.data && u.data.available ? u.data : null;
  const ring = (r, frac, color, width) => { const c = 2 * Math.PI * r; const f = Math.max(0, Math.min(1, frac || 0)); return `<circle cx="20" cy="20" r="${r}" fill="none" style="stroke:rgb(var(--c-2a242e))" stroke-width="${width}"/>${f > 0 ? `<circle cx="20" cy="20" r="${r}" fill="none" style="stroke:${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - f)).toFixed(2)}" transform="rotate(-90 20 20)"/>` : ''}`; };
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">${ring(16.5, d && d.week ? d.week.used / 100 : 0, 'rgb(var(--c-7a3530))', 4.5)}${ring(9.5, d && d.fiveHour ? d.fiveHour.used / 100 : 0, 'rgb(var(--c-d08072))', 5)}</svg>`;
}
// One line for headers: "36% left of the five-hour window, resets 6:12 PM".
function usageLine(id, { short = false } = {}) {
  const u = usageOf(id);
  if (!u) return '';
  if (!u.data) return u.error ? 'Usage unavailable' : 'Checking usage…';
  if (!u.data.available) return '';
  const b = binding(u); if (!b) return '';
  if (b.left <= 0) return `Limit reached${b.w.resetsAt ? `, resets ${when(b.w.resetsAt)}` : ''}`;
  return short ? `${b.left}% left · ${b.short}` : `${b.left}% left ${b.key === 'week' ? 'this week' : 'in five hours'}${b.w.resetsAt ? `, resets ${when(b.w.resetsAt)}` : ''}`;
}

/* ---------- what each running chat is doing ---------- */
const seenKey = x => (x.sessionId ? `s:${String(x.sessionId).toLowerCase()}` : `k:${x.key}`);
const isSeen = x => (S.seen[seenKey(x)] || 0) >= (x.finishedAt || 0) - 1500;
function markSeen(x) {
  if (!x) return;
  const k = seenKey(x);
  if ((S.seen[k] || 0) >= (x.finishedAt || Date.now()) - 1500) return;
  S.seen[k] = Date.now();
  const cutoff = Date.now() - 3 * 864e5;
  for (const [key, t] of Object.entries(S.seen)) if (t < cutoff) delete S.seen[key];
  store('seen', JSON.stringify(S.seen));
  renderLive(); renderNav();
}
// approve | question | terminal-wait | reply | working | quiet | ended
function statusOf(x) {
  if (x.phase === 'waiting') return (x.pending || []).some(p => p.question) ? 'question' : 'approve';
  if (x.phase === 'waiting-terminal') return 'terminal-wait';
  if (WORKING.has(x.phase)) return 'working';
  if (x.phase === 'ended') return 'ended';
  if (x.finishedAt && (x.source === 'app' || x.lastText) && !isSeen(x)) return 'reply';
  return 'quiet';
}
const NEEDS = new Set(['approve', 'question', 'terminal-wait']);
const awaiting = () => S.activity.filter(x => NEEDS.has(statusOf(x)) || statusOf(x) === 'reply')
  .sort((a, b) => (NEEDS.has(statusOf(b)) - NEEDS.has(statusOf(a))) || ((b.finishedAt || b.lastEventAt || 0) - (a.finishedAt || a.lastEventAt || 0)));
const atWork = () => S.activity.filter(x => statusOf(x) === 'working');
const quietOpen = () => S.activity.filter(x => statusOf(x) === 'quiet' || statusOf(x) === 'ended');
const asked = x => /\?["”’)\]]*\s*$/.test(lastLine(x.lastText));
const VERB_NOW = { Bash: 'Running', PowerShell: 'Running', Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing', NotebookEdit: 'Editing', Glob: 'Finding', Grep: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching', Agent: 'Delegating', Task: 'Delegating', TodoWrite: 'Planning', TaskCreate: 'Planning', TaskUpdate: 'Planning', Artifact: 'Publishing', AskUserQuestion: 'Asking' };
function wantsTo(p) {
  if (!p) return 'Wants your OK';
  switch (p.toolName) {
    case 'Bash': case 'PowerShell': return 'Wants to run a command';
    case 'Edit': case 'MultiEdit': return 'Wants to edit a file';
    case 'Write': return 'Wants to write a file';
    case 'WebFetch': return 'Wants to open a web page';
    case 'WebSearch': return 'Wants to search the web';
    default: return `Wants to use ${p.toolName}`;
  }
}
function whereOf(x) {
  const as = x.accountId ? `<span class="ring" style="--ring:${ringById(x.accountId)}"></span>as ${esc(x.accountName || '')}` : '';
  const place = x.source === 'terminal' ? 'in a terminal' : x.source === 'elsewhere' ? 'in another app' : '';
  return [x.folder ? esc(x.folder) : '', place, as].filter(Boolean).join(', ');
}
function sparkSvg(spark) {
  if (!spark || !spark.length) return '';
  const max = Math.max(1, ...spark);
  return `<svg class="spark" width="${spark.length * 4}" height="22" viewBox="0 0 ${spark.length * 4} 22" aria-hidden="true">${spark.map((v, i) => { const h = v ? Math.max(2, Math.round(20 * Math.min(1, v / max))) : 1; return `<rect x="${i * 4}" y="${22 - h}" width="2.6" height="${h}" rx="1"/>`; }).join('')}</svg>`;
}
const keyOf = x => x.key || `s:${x.sessionId}`;
const findActivity = k => S.activity.find(x => keyOf(x) === k) || null;
function openActivity(x) {
  if (!x) return;
  markSeen(x);
  if (x.source === 'app') return ChatUI.openKey(x.key);
  return ChatUI.watch({ sessionId: x.sessionId, source: x.source });
}

/* ---------- data ---------- */
async function loadState() {
  const j = await api('/api/state');
  S.accounts = j.accounts; S.dryRun = j.dryRun; S.platform = j.platform; S.prefs = j.prefs; S.index = j.index; S.appVersion = j.appVersion; S.codex = j.codex || null;
  const saved = store('acct');
  if (!S.accounts.some(a => a.id === S.acct)) S.acct = S.accounts.some(a => a.id === saved) ? saved : S.accounts[0].id;
}
async function loadSessions() {
  const j = await api('/api/sessions');
  S.projects = j.projects; S.root = j.root; S.running = j.running || {}; S.live = j.live || {};
  if (S.view === 'folder' && !S.projects.some(p => p.cwd === S.folder)) S.view = 'hub';
}
async function loadActivity() { const j = await api('/api/activity'); S.activity = j.list || []; }
async function loadUsage() { const j = await api('/api/usage'); S.usage = j.usage || {}; }
async function reload() {
  await loadState();
  await Promise.all([loadSessions(), loadActivity().catch(() => {}), loadUsage().catch(() => {})]);
  renderAll();
  if (S.drawerId) openDrawer(S.drawerId, true);
}

/* ---------- keyed patching, so live updates don't disturb hover, focus or typing ---------- */
function patch(container, items, keyFn, htmlFn, emptyHtml = '') {
  if (!container) return;
  const want = items.map(it => ({ k: keyFn(it), h: htmlFn(it).trim() }));
  const sig = want.map(w => `${w.k}\u0001${w.h}`).join('\u0002') || `empty:${emptyHtml}`;
  if (container._sig === sig) return;
  container._sig = sig;
  if (!want.length) { container.innerHTML = emptyHtml; return; }
  const old = new Map();
  for (const el of [...container.children]) { if (el.dataset && el.dataset.k) old.set(el.dataset.k, el); else el.remove(); }
  const active = document.activeElement;
  let prev = null;
  for (const w of want) {
    let el = old.get(w.k);
    // A card you're typing in stays as it is until you're done (no caret jumps, no lost input).
    const typingIn = el && active && el.contains(active) && active.matches('textarea, input[type="text"]') && !!active.value;
    if (!typingIn && (!el || el._h !== w.h)) {
      const t = document.createElement('template'); t.innerHTML = w.h;
      const n = t.content.firstElementChild; n.dataset.k = w.k; n._h = w.h;
      if (el) {
        // Carry over anything typed into a quick reply, and keep focus where it was.
        const oi = el.querySelector('textarea, input[type="text"]'), ni = n.querySelector('textarea, input[type="text"]');
        const hadFocus = active && el.contains(active);
        const focusAttr = hadFocus && active.dataset ? Object.entries(active.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(v)}"]`).join('') : '';
        if (oi && ni) { ni.value = oi.value; }
        el.replaceWith(n);
        if (hadFocus) { const f = (oi && active === oi ? ni : null) || (focusAttr && n.querySelector(focusAttr)); if (f) { f.focus({ preventScroll: true }); if (f === ni && typeof ni.setSelectionRange === 'function') ni.setSelectionRange(ni.value.length, ni.value.length); } }
      }
      el = n;
    }
    old.delete(w.k);
    const next = prev ? prev.nextElementSibling : container.firstElementChild;
    if (next !== el) container.insertBefore(el, next);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

/* ---------- top bar ---------- */
function renderBar() {
  const A = awaiting(), W = atWork();
  document.body.classList.toggle('working', W.length > 0);
  const p = $('pulse');
  p.classList.toggle('needs', A.length > 0);
  const parts = [];
  if (W.length) parts.push(`<span class="ember-dot" aria-hidden="true"></span><span><b>${W.length}</b> <span class="p-label">at work</span></span>`);
  if (A.length) parts.push(`${parts.length ? '<span class="sep" aria-hidden="true"></span>' : ''}<span class="gilt-dot" aria-hidden="true"></span><span class="p-need"><b>${A.length}</b> <span class="p-label">${A.length === 1 ? 'awaits you' : 'await you'}</span></span>`);
  if (!parts.length) parts.push('<span class="ash-dot" aria-hidden="true"></span><span class="p-label">All quiet</span>');
  p.innerHTML = parts.join('');
  p.setAttribute('aria-label', `${W.length} at work, ${A.length} awaiting you`);

  // Which account this is about: the open chat's, otherwise the one new chats open as.
  const chatAcct = window.ChatUI && ChatUI.isOpen() && ChatUI.accountId ? ChatUI.accountId() : null;
  const inChat = !!(window.ChatUI && ChatUI.isOpen());
  const a = (chatAcct && acctById(chatAcct)) || (inChat ? null : current());
  const chip = $('usechip');
  if (!a) { chip.hidden = !inChat; chip.innerHTML = inChat ? '<span class="ac-who"><small>This chat runs</small><b>Outside the app</b></span>' : ''; chip.style.removeProperty('--ring'); return; }
  const u = usageOf(a.id), d = u && u.data && u.data.available ? u.data : null;
  const cell = (label, w) => {
    if (!w) return '';
    const l = leftOf(w);
    return `<span class="ac-win ${hot(l) ? 'hot' : ''}"><small>${label}</small><b>${l}% left</b>${w.resetsAt ? `<i>resets ${esc(when(w.resetsAt))}</i>` : ''}</span>`;
  };
  chip.hidden = false;
  chip.style.setProperty('--ring', ringById(a.id));
  chip.innerHTML = `<span class="ac-ring">${miniDial(a.id, 30)}</span>
    <span class="ac-who"><small>${inChat ? 'This chat runs as' : 'New chats open as'}</small><b>${esc(a.name)}</b></span>
    ${d ? `<span class="ac-sep" aria-hidden="true"></span>${cell('5-hour window', d.fiveHour)}${cell('This week', d.week)}`
      : a.signedIn ? `<span class="ac-sep" aria-hidden="true"></span><span class="ac-win"><small>Usage</small><b>${u && u.error ? 'Unavailable' : 'Checking…'}</b></span>` : '<span class="ac-sep" aria-hidden="true"></span><span class="ac-win"><small>Account</small><b>Not signed in</b></span>'}`;
  chip.insertAdjacentHTML('beforeend', '<span class="ac-caret" aria-hidden="true">▾</span>');
  chip.title = `${inChat ? 'This chat runs as' : 'New chats open as'} ${a.name}${a.email ? ` (${a.email})` : ''}. ${usageLine(a.id) || ''} Click to see all your accounts.`;
}
function updateTitle() {
  const n = awaiting().length;
  document.title = n ? `(${n}) Session Switcher` : 'Session Switcher';
}

/* ---------- nav ---------- */
function renderNav() {
  const a = current();
  const A = awaiting().length, W = atWork().length;
  const total = S.projects.reduce((n, p) => n + p.sessions.length, 0);
  // Folders, split by which assistant the chats belong to. Pinned folders come first in each.
  const clsOf = x => isCodex(x) ? 'codex' : isOpenClaw(x) ? 'openclaw' : 'claude';
  const group = prov => S.projects.map(p => ({ p, list: p.sessions.filter(x => clsOf(x) === prov) })).filter(x => x.list.length);
  const item = (x, prov) => {
    const live = x.list.some(c => isRunning(c.id) || liveOf(c.id));
    const firstProv = S.projects.find(q => q.cwd === x.p.cwd)?.sessions.some(c => clsOf(c) === 'claude') ? 'claude' : S.projects.find(q => q.cwd === x.p.cwd)?.sessions.some(c => clsOf(c) === 'openclaw') ? 'openclaw' : 'codex';
    const cur = S.view === 'folder' && S.folder === x.p.cwd && (S.prov ? S.prov === prov : !S.pins.has(x.p.cwd) && prov === firstProv);
    return `<button class="nav-i ${prov}" data-view="folder" data-cwd="${esc(x.p.cwd)}" data-prov="${prov}" aria-current="${cur}">
      <span class="glyph" aria-hidden="true">${glyphFor(x.p.name)}</span><span class="ni-t">${esc(x.p.name)}</span>
      ${live ? '<span class="live-dot" title="A chat here is open right now"></span>' : ''}<span class="count">${x.list.length}</span></button>`;
  };
  const claude = group('claude'), codexF = group('codex'), ocF = group('openclaw');
  // Pinned: projects and favorite chats, at the top.
  const pinnedP = [...S.pins].map(cwd => S.projects.find(p => p.cwd === cwd)).filter(Boolean);
  const pinnedC = [...S.favs].map(id => sessionById(id)).filter(([s2]) => s2);
  const chatDot = id => { const x = S.activity.find(y => y.sessionId && y.sessionId.toLowerCase() === id.toLowerCase()); if (!x) return ''; const st = statusOf(x); return NEEDS.has(st) || st === 'reply' ? '<span class="gilt-dot nav-dot" title="Waiting for you"></span>' : st === 'working' ? '<span class="ember-dot nav-dot" title="At work"></span>' : ''; };
  const fold = (id, label, count, cls = '') => `<button class="nav-h prov ${cls} fold" data-fold="${id}" aria-expanded="${!S.navFold.has(id)}"><span class="pmark" aria-hidden="true"></span>${label}<span class="count">${count}</span><span class="fold-c" aria-hidden="true">▾</span></button>`;
  const pinnedHtml = pinnedP.length || pinnedC.length ? `${fold('pinned', 'Pinned', pinnedP.length + pinnedC.length, 'pinned')}
    ${S.navFold.has('pinned') ? '' : pinnedP.map(p => `<button class="nav-i pin" data-view="folder" data-cwd="${esc(p.cwd)}" aria-current="${S.view === 'folder' && S.folder === p.cwd && !S.prov}"><span class="glyph" aria-hidden="true">★</span><span class="ni-t">${esc(p.name)}</span>${p.sessions.some(c => isRunning(c.id) || liveOf(c.id)) ? '<span class="live-dot"></span>' : ''}<span class="count">${p.sessions.length}</span></button>`).join('')
      + pinnedC.map(([c, p]) => `<button class="nav-i nav-chat ${isCodex(c) ? 'codex' : ''}" data-navchat="${esc(c.id)}" title="${esc(c.title)} · ${esc(p.name)}" aria-current="${!!(window.ChatUI && ChatUI.isOpen() && ChatUI.sessionId && ChatUI.sessionId() === c.id)}"><span class="glyph" aria-hidden="true">❝</span><span class="ni-t"><span class="nc-t">${esc(c.title)}</span><small>${esc(p.name)}${isCodex(c) ? ' · Codex' : ''}</small></span>${chatDot(c.id)}</button>`).join('')}` : '';
  const nClaude = claude.reduce((n, x) => n + x.list.length, 0), nCodex = codexF.reduce((n, x) => n + x.list.length, 0), nOpenClaw = ocF.reduce((n, x) => n + x.list.length, 0);
  const showCodex = S.codex && S.codex.enabled;
  const fresh = S.projects.filter(p => !p.sessions.length);
  const blocked = a && (a.pinnedOrg || a.expectEmail) && !a.lock.ok;
  const html = `
    <button class="seal ${blocked ? 'blocked' : ''}" id="seal" aria-haspopup="menu" aria-expanded="false" title="Choose which account new chats open as">
      <span class="seal-mark" style="--ring:${a ? ringOf(a) : 'var(--ash)'}">${a ? miniDial(a.id, 44) : ''}<b>${esc(a ? initial(a.name) : '?')}</b></span>
      <span class="seal-t"><span class="seal-k">${blocked ? 'Blocked' : 'Working as'}</span><span class="seal-n">${esc(a ? a.name : 'No account')}</span><span class="seal-e">${esc(a && a.signedIn ? (a.email || 'Signed in') : 'Not signed in')}</span></span>
      <span class="seal-caret">${ICON.caret}</span>
    </button>
    <div class="nav-h">Begin</div>
    <button class="nav-i" data-view="hub" aria-current="${S.view === 'hub'}"><span class="glyph" aria-hidden="true">✦</span><span class="ni-t">The hub</span>${A ? `<span class="tag gilt">${A}</span>` : W ? `<span class="tag">${W}</span>` : ''}</button>
    <button class="nav-i" data-view="recent" aria-current="${S.view === 'recent'}"><span class="glyph" aria-hidden="true">✧</span><span class="ni-t">Recent chats</span><span class="count">${total}</span></button>
    <button class="nav-i" data-view="palette" aria-current="${S.view === 'search'}"><span class="glyph" aria-hidden="true">❝</span><span class="ni-t">Search every chat</span><span class="count">Ctrl K</span></button>
    <button class="nav-i nav-new" data-view="newproject"><span class="glyph" aria-hidden="true">+</span><span class="ni-t">New project</span></button>
    ${fresh.length ? `<div class="nav-h prov fresh"><span class="pmark" aria-hidden="true"></span>No chats yet<span class="count">${fresh.length}</span></div>${fresh.map(p => `<button class="nav-i" data-view="folder" data-cwd="${esc(p.cwd)}" aria-current="${S.view === 'folder' && S.folder === p.cwd}"><span class="glyph" aria-hidden="true">${glyphFor(p.name)}</span><span class="ni-t">${esc(p.name)}</span><span class="tag ghost">New</span></button>`).join('')}` : ''}
    ${pinnedHtml}
    ${fold('claude', 'Claude Code', nClaude, 'claude')}
    ${S.navFold.has('claude') ? '' : claude.length ? claude.map(x => item(x, 'claude')).join('') : '<p class="nav-empty">No Claude Code chats yet.</p>'}
    ${showCodex ? `${fold('codex', 'Codex', nCodex, 'codex')}
    ${S.navFold.has('codex') ? '' : codexF.length ? codexF.map(x => item(x, 'codex')).join('') : `<p class="nav-empty">${codexReady() ? 'No Codex chats yet. Start one with “New Codex chat” on the Codex card.' : 'Sign in on the Codex card to use Codex here.'}</p>`}` : ''}
    ${ocF.length ? `${fold('openclaw', 'OpenClaw', nOpenClaw, 'openclaw')}
    ${S.navFold.has('openclaw') ? '' : ocF.map(x => item(x, 'openclaw')).join('')}` : ''}
    <p class="nav-foot">${S.appVersion ? `Session Switcher ${esc(S.appVersion)}. ` : ''}Your chats never leave this PC.</p>`;
  // Only when something would look different (it's asked for several times a second while chats work).
  if ($('nav')._h === html) return;
  $('nav')._h = html;
  const focused = document.activeElement && $('nav').contains(document.activeElement) ? document.activeElement : null;
  const keep = focused && (focused.dataset.cwd ? `[data-cwd="${CSS.escape(focused.dataset.cwd)}"][data-view="${focused.dataset.view || ''}"]` : focused.dataset.view ? `[data-view="${focused.dataset.view}"]` : focused.dataset.navchat ? `[data-navchat="${CSS.escape(focused.dataset.navchat)}"]` : focused.dataset.fold ? `[data-fold="${focused.dataset.fold}"]` : focused.id ? `#${focused.id}` : null);
  $('nav').innerHTML = html;
  if (keep) $('nav').querySelector(keep)?.focus({ preventScroll: true });
}

/* ---------- the hub ---------- */
function heroHtml() {
  const a = current();
  const A = awaiting(), W = atWork().length;
  const N = A.filter(x => NEEDS.has(statusOf(x))).length, R = A.length - N;
  const Q = quietOpen().filter(x => x.source === 'app' && x.phase !== 'ended').length;
  let h, em;
  if (A.length) {
    h = `${nword(A.length)} ${A.length === 1 ? 'chat awaits' : 'chats await'} you.`;
    const parts = [];
    if (N) parts.push(N === 1 ? 'one needs your OK' : `${nword(N, false)} need your OK`);
    if (R) parts.push(R === 1 ? 'one has replied' : `${nword(R, false)} have replied`);
    if (W) parts.push(W === 1 ? 'one is still at work' : `${nword(W, false)} are still at work`);
    em = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.` : `${parts[0]}.`;
    em = em[0].toUpperCase() + em.slice(1);
  } else if (W) { h = `${nword(W)} ${W === 1 ? 'chat' : 'chats'} at work.`; em = 'Nothing needs you yet.'; }
  else { h = 'All quiet.'; em = Q ? (Q === 1 ? 'One chat is open and ready.' : `${nword(Q)} chats are open and ready.`) : 'Pick up any chat below.'; }

  let say = '';
  if (a) {
    say = a.signedIn ? `New chats open as <b>${esc(a.name)}</b>${a.plan ? ` (${esc(a.plan)})` : ''}. ` : `<b>${esc(a.name)}</b> isn’t signed in yet. `;
    const u = usageOf(a.id), d = u && u.data && u.data.available ? u.data : null;
    if (d) {
      const fl = leftOf(d.fiveHour), wl = leftOf(d.week);
      if (fl === 0) say += `It has reached its five-hour limit, which resets <b>${esc(when(d.fiveHour.resetsAt))}</b>.`;
      else if (wl === 0) say += `It has reached its weekly limit, which resets <b>${esc(when(d.week.resetsAt))}</b>.`;
      else if (fl !== null) {
        say += `It has <b>${fl}%</b> of its five-hour window left${d.fiveHour.resetsAt ? ` (resets ${esc(when(d.fiveHour.resetsAt))})` : ''}${wl !== null ? ` and <b>${wl}%</b> of the week` : ''}.`;
        const pf = paceOf(d.fiveHour, SPAN.fiveHour), pw = paceOf(d.week, SPAN.week);
        const run = [pf && pf.runsOut ? ['five-hour window', pf.runsOut] : null, pw && pw.runsOut ? ['week', pw.runsOut] : null].filter(Boolean).sort((x, y) => x[1] - y[1])[0];
        if (run) say += ` At this pace the ${run[0]} runs out around <b>${esc(when(new Date(run[1]).toISOString()))}</b>.`;
      }
    } else if (a.signedIn && u && u.error) say += 'Its usage isn’t available right now.';
    else if (a.signedIn) say += 'Checking its usage…';
  }
  const first = A[0];
  const latest = allSessions().sort((x, y) => y[0].updated - x[0].updated)[0];
  const better = headroomPick();
  const acts = [];
  if (first) acts.push(`<button class="btn gilt" data-hero="first">${NEEDS.has(statusOf(first)) ? 'Answer the first one' : 'Read the latest reply'}</button>`);
  if (better) acts.push(`<button class="btn" data-hero="switch" data-acct="${esc(better.a.id)}">Work as ${esc(better.a.name)}</button>`);
  if (!first && latest && canLaunch(a)) acts.push(`<button class="btn" data-hero="latest" data-sid="${esc(latest[0].id)}" title="${esc(latest[0].title)}">Continue “${esc(latest[0].title.length > 34 ? `${latest[0].title.slice(0, 33)}…` : latest[0].title)}”</button>`);
  const today = new Date();
  return `<section class="hero" aria-label="Right now">
    <svg class="hero-sigil" aria-hidden="true"><use href="#sigil"/></svg>
    <div class="hero-in">
      <div>
        <p class="eyebrow">${esc(today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} · <span data-clock>${esc(clock(today))}</span></p>
        <h1>${esc(h)}<em>${esc(em)}</em></h1>
        ${say ? `<p>${say}</p>` : ''}
        ${acts.length ? `<div class="hero-act">${acts.join('')}</div>` : ''}
      </div>
      ${a ? `<div class="stamp">Working as<b>${esc(a.name)}</b>${a.plan ? esc(a.plan) : ''}</div>` : ''}
    </div>
  </section>`;
}

function guardHtml() {
  const a = current(); if (!a) return '';
  const locked = !!(a.pinnedOrg || a.expectEmail);
  let out = '';
  const signBtn = a.expectEmail ? `<button class="btn prime" data-act="signin-direct" data-acct="${esc(a.id)}">Sign in as ${esc(a.expectEmail)}</button>` : `<button class="btn prime" data-act="signin" data-acct="${esc(a.id)}">Sign in</button>`;
  if (locked && !a.lock.ok) out += `<div class="guard" role="alert"><p><b>${esc(a.name)} is blocked.</b> ${esc(a.lockMessage)} Chats won’t open with it until then.</p>${signBtn}</div>`;
  else if (!a.signedIn) out += `<div class="guard"><p><b>${esc(a.name)} isn’t signed in.</b> If the sign-in page asks which organization to use, choose the one whose plan this account should use, then lock the account to it.</p>${signBtn}</div>`;
  return out;
}

function awaitCard(x) {
  const st = statusOf(x), k = keyOf(x);
  const p = (x.pending || [])[0];
  const label = { approve: 'Needs your OK', question: 'Has a question', 'terminal-wait': 'Waiting in its terminal', reply: asked(x) ? 'Your turn · asked you something' : x.ok === false ? 'Your turn · stopped early' : 'Your turn' }[st];
  const since = st === 'reply' ? `<span class="o-time" data-ago="${x.finishedAt}"></span>` : `<span class="o-time">waiting <span data-since="${x.lastEventAt || Date.now()}"></span></span>`;
  let body = '';
  if (st === 'approve') body = `<p class="o-ask">${esc(wantsTo(p))}${p && (p.detail || p.summary) ? `:</p><p class="o-cmd"><code>${esc(p.detail || p.summary)}</code></p>` : '.</p>'}`;
  else if (st === 'question') body = `<p class="o-ask">Claude asked a multiple-choice question. Open the chat to answer it.</p>`;
  else if (st === 'terminal-wait') body = `<p class="o-ask">It looks like it’s waiting for you in its terminal${x.tool ? ` (${esc(x.tool)}${x.detail ? `: <code>${esc(x.detail)}</code>` : ''})` : ''}. Switch to that window to answer.</p>`;
  else {
    const said = plainMd(lastLine(x.lastText));
    body = said ? `<blockquote class="o-quote">${esc(said.length > 320 ? `${said.slice(0, 319)}…` : said)}</blockquote>` : '<p class="o-ask">Claude finished its turn.</p>';
  }
  let acts = '';
  if (st === 'approve' && x.source === 'app') {
    acts = `<button class="btn gilt sm" data-a="allow">Allow</button>${p && p.canAlways ? '<button class="btn sm" data-a="always" title="Don’t ask again for this kind of action in this project">Always allow</button>' : ''}<button class="btn sm" data-a="deny">Deny</button><span class="spacer"></span><button class="btn quiet sm" data-a="open">Open chat</button>`;
  } else if (st === 'question') acts = '<button class="btn gilt sm" data-a="open">Answer it</button>';
  else if (st === 'terminal-wait') acts = '<button class="btn sm" data-a="open">Watch it here</button>';
  else if (x.source === 'app') {
    acts = `<form class="qr" data-a="reply"><textarea rows="1" placeholder="Reply to Claude…" aria-label="Reply to ${esc(x.title || 'this chat')}" data-qr="1"></textarea><button class="btn prime sm" type="submit">Send</button></form>
      <div class="qr-row"><button class="btn quiet sm" data-a="open">Open chat</button><button class="btn quiet sm" data-a="seen" title="Move it out of “Awaiting you”">${ICON.check} Mark as read</button></div>`;
  } else {
    acts = `<button class="btn sm" data-a="open">Read it here</button>${x.source === 'elsewhere' ? '<button class="btn quiet sm" data-a="resume">Continue it here</button>' : ''}<span class="spacer"></span><button class="btn quiet sm" data-a="seen">${ICON.check} Mark as read</button>`;
  }
  return `<article class="omen summons ${NEEDS.has(st) ? 'needs' : 'reply'}"><div class="omen-in">
    <header class="o-top"><span class="${NEEDS.has(st) ? 'gilt-dot' : 'reply-dot'}" aria-hidden="true"></span>${esc(label)}${since}</header>
    <h3 class="o-title"><button data-a="open">${esc(x.title || 'New chat')}</button></h3>
    <p class="o-where">${whereOf(x)}</p>
    ${body}
    <footer class="o-foot ${x.source === 'app' && st === 'reply' ? 'stack' : ''}">${acts}</footer>
  </div></article>`;
}

function workCard(x) {
  const st = statusOf(x);
  const label = x.phase === 'starting' ? 'Starting' : x.phase === 'thinking' ? 'Thinking' : x.phase === 'writing' ? 'Writing' : x.source === 'terminal' ? 'Working in a terminal' : 'Working';
  const since = x.turnStartedAt || x.lastEventAt;
  const step = x.phase === 'tool' && (x.tool || x.detail) ? `<div class="o-step"><span class="v">${esc(VERB_NOW[x.tool] || 'Using')}</span><code>${esc(x.detail || x.tool || '')}</code></div>` : '';
  const said = plainMd(lastLine(x.lastText));
  const line = said ? `<p class="o-line">${esc(said)}</p>` : x.lastPrompt ? `<p class="o-line dim">You asked: ${esc(x.lastPrompt)}</p>` : '';
  return `<article class="omen ${st === 'working' ? 'working' : st}"><div class="omen-in">
    <header class="o-top"><span class="${x.source === 'app' ? 'ember-dot' : 'violet-dot'}" aria-hidden="true"></span>${esc(label)}<span class="o-time" data-since="${since || ''}"></span></header>
    <h3 class="o-title"><button data-a="open">${esc(x.title || 'New chat')}</button></h3>
    <p class="o-where">${whereOf(x)}</p>
    ${step}${line}
    <footer class="o-foot">${sparkSvg(x.spark)}<button class="btn quiet sm" data-a="open">${x.source === 'app' ? 'Open' : 'Watch'}</button></footer>
  </div></article>`;
}

function quietChip(x) {
  const st = statusOf(x);
  return `<button class="qchip" data-a="open" title="${esc(x.title || '')}"><span class="${st === 'ended' ? 'ash-dot' : x.source === 'app' ? 'ready-dot' : 'violet-dot'}" aria-hidden="true"></span><span class="qc-t">${esc(x.title || 'New chat')}</span><span class="qc-s">${st === 'ended' ? 'stopped' : x.source === 'terminal' ? 'terminal' : x.source === 'elsewhere' ? 'other app' : 'ready'}</span></button>`;
}

function headroomPick() {
  const a = current(); if (!a) return null;
  const room = acct => { const b = binding(usageOf(acct.id)); return b ? b.left : null; };
  const mine = room(a);
  let best = null;
  for (const o of S.accounts) {
    if (o.id === a.id || !canLaunch(o)) continue;
    const r = room(o); if (r === null) continue;
    if (!best || r > best.r) best = { a: o, r };
  }
  if (!best || mine === null) return null;
  return mine < 40 && best.r - mine >= 25 ? best : null;
}

// "Someone's Organization" is how a personal plan is named; call it that.
const orgLabel = a => (a.orgName ? (/['’]s Organi[sz]ation$/i.test(a.orgName) ? 'Personal' : a.orgName) : '');
function dialCard(a) {
  const u = usageOf(a.id);
  const cur = a.id === S.acct;
  const locked = !!(a.pinnedOrg || a.expectEmail);
  const blocked = locked && !a.lock.ok;
  return dialShell(a, u, cur, blocked, locked, usageDetail(u, a.signedIn, 'Sign in to see this account’s usage and reset times.'));
}
const fmtCredits = v => { const n = Number(v); return v === null || v === undefined || v === '' ? 'on' : isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v); };
function usageDetail(u, signedIn, signedOutText) {
  const d = u && u.data && u.data.available ? u.data : null;
  const win = (name, w) => {
    if (!w) return '';
    const l = leftOf(w);
    return `<li><span class="w-n">${name}</span><span class="w-v ${hot(l) ? 'hot' : ''}">${l}% left</span>
      <span class="w-bar"><i class="${hot(l) ? 'hot' : ''}" style="width:${Math.min(100, Math.max(0, w.used))}%"></i></span>
      <span class="w-r">${Math.round(w.used)}% used${w.resetsAt ? ` · resets <b>${esc(when(w.resetsAt))}</b>, <span data-until="${Date.parse(w.resetsAt)}">in ${esc(dur(Date.parse(w.resetsAt) - Date.now()))}</span>` : ''}</span></li>`;
  };
  let detail = '';
  if (d) {
    detail = `<ul class="win">${win('Five-hour window', d.fiveHour, SPAN.fiveHour)}${win('This week', d.week, SPAN.week)}</ul>`;
    const chips = d.models.filter(m => m.used !== null).map(m => { const l = leftOf(m); return `<span class="model ${hot(l) ? 'hot' : ''}" title="${esc(m.name)} weekly limit${m.resetsAt ? `, resets ${when(m.resetsAt)}` : ''}">${esc(m.name)} <b>${l}% left</b></span>`; });
    if (d.extra) chips.push(`<span class="model" title="Extra usage beyond your plan">${d.extra.credits !== undefined && d.extra.used === null ? `Credits <b>${esc(d.extra.unlimited ? 'unlimited' : fmtCredits(d.extra.credits))}</b>` : `Extra usage <b>${d.extra.used !== null ? `${Math.round(d.extra.used)}% of monthly cap` : 'on'}</b>`}</span>`);
    if (chips.length) detail += `<div class="models">${chips.join('')}</div>`;
    const pf = paceOf(d.fiveHour, SPAN.fiveHour), pw = paceOf(d.week, SPAN.week);
    const runs = [pf && pf.runsOut ? ['five-hour window', pf] : null, pw && pw.runsOut ? ['week', pw] : null].filter(Boolean).sort((x, y) => x[1].runsOut - y[1].runsOut)[0];
    if (runs) detail += `<p class="pace"><span class="glyph" aria-hidden="true">✦</span><span>At this pace the ${runs[0]} runs out around <b>${esc(when(new Date(runs[1].runsOut).toISOString()))}</b>, ${esc(dur(runs[1].early))} before it resets.</span></p>`;
    else if (pf && pf.projected !== undefined) detail += `<p class="pace calm"><span class="glyph" aria-hidden="true">✧</span><span>On pace: about ${pf.projected}% of this five-hour window used by the time it resets.</span></p>`;
  } else if (!signedIn) detail = `<p class="dc-msg">${esc(signedOutText)}</p>`;
  else if (u && u.data && !u.data.available) detail = `<p class="dc-msg">This sign-in doesn’t have plan limits to show (for example, an API key).</p>`;
  else if (u && u.error) detail = `<p class="dc-msg">${esc(u.error)}</p>`;
  else detail = `<p class="dc-msg">Checking usage…</p>`;
  return detail;
}
function dialShell(a, u, cur, blocked, locked, detail) {
  const acts = [];
  if (!cur) acts.push(`<button class="btn ${canLaunch(a) ? 'prime' : ''} sm" data-act="use" data-acct="${esc(a.id)}">Work as ${esc(a.name)}</button>`);
  acts.push(`<button class="btn sm ${a.signedIn ? '' : 'prime'}" data-act="${a.expectEmail && !a.lock.ok ? 'signin-direct' : 'signin'}" data-acct="${esc(a.id)}">${a.signedIn ? 'Switch sign-in' : 'Sign in'}</button>`);
  if (a.signedIn && a.lock.ok && !a.pinnedOrg) acts.push(`<button class="btn sm" data-act="lock" data-acct="${esc(a.id)}" title="Only open chats while it’s signed in to ${esc(orgLabel(a) || 'this plan')}">Lock to this plan</button>`);
  acts.push(`<button class="btn quiet sm" data-act="web" data-acct="${esc(a.id)}" title="Regular Claude chats for this account, in their own window">claude.ai</button>`);
  acts.push(`<span class="spacer"></span><button class="icon" data-act="acct-more" data-acct="${esc(a.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(a.name)}">${ICON.more}</button>`);

  const plan = a.signedIn && a.plan ? `<span class="tag ${a.kind === 'team' ? 'ghost' : ''}">${esc(a.plan)}</span>` : '';
  const org = a.signedIn && orgLabel(a) ? `<span class="eyebrow">${esc(orgLabel(a))}</span>` : '';
  const lockTitle = locked ? `Locked to ${[a.expectEmail, a.pinnedOrg && a.pinnedOrg.name].filter(Boolean).join(', ')}` : '';
  const checked = [u && u.at ? `Usage checked ${agoL(u.at)}` : '', a.verified ? `sign-in confirmed ${agoL(a.verifiedAt)}` : a.verifyError ? 'couldn’t confirm the sign-in' : ''].filter(Boolean).join(' · ');
  return `<article class="dial-card ${cur ? 'current' : ''} ${blocked ? 'blocked' : ''}" data-acct-card="${esc(a.id)}" style="--ring:${ringOf(a)}">
    <div class="dial-wrap">${dialSvg(u)}<div class="legend"><span><i class="l5"></i>5 hours</span><span><i class="lw"></i>week</span><span><i class="ln"></i>time passed</span></div></div>
    <div class="dc-body">
      <div class="dc-k">${plan}${org}</div>
      <h3 class="dc-name">${esc(a.name)}${locked ? `<span class="lock ${blocked ? 'bad' : ''}" title="${esc(lockTitle)}">${ICON.lock}<span class="sr">${esc(lockTitle)}</span></span>` : ''}</h3>
      <p class="dc-who">${a.signedIn ? esc(a.email || 'Signed in') : 'Not signed in'}${blocked ? ` · <span style="color:var(--ember)">${esc(a.lockMessage || 'blocked')}</span>` : ''}${!a.shared ? ' · some data isn’t shared yet (see Setup)' : ''}</p>
      ${detail}
      ${checked ? `<p class="dc-checked">${esc(checked)}</p>` : ''}
      <div class="dc-act">${acts.join('')}</div>
    </div>
  </article>`;
}

// Codex, shown beside the Claude accounts.
function codexCard(c = S.codex) {
  const u = usageOf(c.id);
  const ollama = c.kind === 'ollama', many = codexAccts().length > 1, on = many && S.codex && S.codex.id === c.id;
  const da = `data-acct="${esc(c.id)}"`;
  let detail, acts = [];
  if (c.installed === false) {
    detail = '<p class="dc-msg">Codex is OpenAI’s coding agent. Install it to work on these folders with your ChatGPT plan too, with pictures shown as Codex makes them.</p>';
    acts.push('<button class="btn prime sm" data-act="codex-install">Install Codex</button>');
  } else if (ollama && !c.signedIn) {
    detail = `<p class="dc-msg">${esc(c.error || 'Codex runs through the Ollama app on this computer, with cloud models from your ollama.com account.')}</p>`;
    acts.push(`<button class="btn prime sm" data-act="codex-check" ${da}>Check again</button>`);
    acts.push(`<button class="btn quiet sm" data-act="codex-signin" ${da}>ollama signin</button>`);
  } else if (!c.signedIn) {
    detail = c.signingIn ? '<p class="dc-msg">Finish signing in to ChatGPT (on OpenAI’s site) in your browser. This card updates by itself when you’re done.</p>'
      : `<p class="dc-msg">${c.error ? esc(c.error) : 'Codex uses your ChatGPT account (OpenAI), separate from your Claude accounts. Sign in to use its plan here.'}</p>`;
    acts.push(`<button class="btn prime sm" data-act="codex-signin" ${da}>${c.signingIn ? 'Open the sign-in page again' : 'Sign in with ChatGPT'}</button>`);
  } else if (ollama) {
    const models = (c.cloudModels || []).slice(0, 6);
    detail = `${c.error ? `<p class="dc-msg">${esc(c.error)}</p>` : ''}<p class="dc-msg">${models.length ? `Cloud models: ${models.map(m => `<code>${esc(m)}</code>`).join(' ')}` : 'No cloud models pulled yet. Pick one in the model picker, or run <code>ollama pull &lt;model&gt;:cloud</code>.'}</p><p class="dc-msg"><small>ollama.com shows its own usage limits; there’s no way to read them here.</small></p>`;
    acts.push(`<button class="btn prime sm" data-act="codex-new" ${da} aria-haspopup="menu" aria-expanded="false">New Ollama chat</button>`);
    acts.push(`<button class="btn quiet sm" data-act="web" ${da} title="Your ollama.com usage and settings">ollama.com</button>`);
  } else {
    detail = usageDetail(u, true, '');
    acts.push(`<button class="btn prime sm" data-act="codex-new" ${da} aria-haspopup="menu" aria-expanded="false">New Codex chat</button>`);
    acts.push(`<button class="btn quiet sm" data-act="usage" ${da} ${u && u.checking ? 'disabled' : ''}>${u && u.checking ? 'Checking…' : 'Check usage'}</button>`);
    acts.push(`<button class="btn quiet sm" data-act="web" ${da} title="Regular ChatGPT, in its own window">chatgpt.com</button>`);
  }
  acts.push(`<span class="spacer"></span><button class="icon" data-act="codex-more" ${da} aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(c.name)}">` + ICON.more + '</button>');
  const checked = [u && u.at ? `Usage checked ${agoL(u.at)}` : '', c.checkedAt ? `sign-in checked ${agoL(c.checkedAt)}` : ''].filter(Boolean).join(' · ');
  return `<article class="dial-card codex-card${on ? ' on' : ''}" style="--ring:${codexRing(c.id)}">
    <div class="dial-wrap">${dialSvg(c.signedIn && !ollama ? u : null)}<div class="legend"><span><i class="l5"></i>5 hours</span><span><i class="lw"></i>week</span><span><i class="ln"></i>time passed</span></div></div>
    <div class="dc-body">
      <div class="dc-k">${c.plan ? `<span class="tag codex">${esc(c.plan)}</span>` : ''}${on ? '<span class="tag gold">new Codex chats</span>' : ''}<span class="eyebrow">${ollama ? 'Ollama · through Codex' : 'OpenAI'}</span></div>
      <h3 class="dc-name">${esc(c.name || 'Codex')}</h3>
      <p class="dc-who">${c.signedIn ? esc(c.email || 'Signed in') : c.installed === false ? 'Not installed' : 'Not signed in'}</p>
      ${detail}
      ${checked ? `<p class="dc-checked">${esc(checked)}</p>` : ''}
      <div class="dc-act">${acts.join('')}</div>
    </div>
  </article>`;
}
// Signing Codex in to ChatGPT, in a small window that shows exactly where the sign-in happens.
async function codexSignIn(method = 'browser') {
  if (!$('cxdlg')) {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="cxdlg" class="cxdlg" aria-labelledby="cxTitle"><div id="cxBody"></div></dialog>');
    $('cxdlg').addEventListener('click', wrap(async e => {
      const b = e.target.closest('[data-cx]');
      if (!b) { if (e.target === $('cxdlg')) $('cxdlg').close(); return; }
      if (b.dataset.cx === 'close') return $('cxdlg').close();
      if (b.dataset.cx === 'copy') { try { await navigator.clipboard.writeText(b.dataset.text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = b.dataset.label; }, 1500); } catch { prompt('Copy this:', b.dataset.text); } return; }
      if (b.dataset.cx === 'code') return codexSignIn('code');
      if (b.dataset.cx === 'browser') return codexSignIn('browser');
    }));
    $('cxdlg').addEventListener('close', () => { if (S.codex && S.codex.signingIn && !S.codex.signedIn) api('/api/codex/login-cancel', { account: S.codex.id }).catch(() => {}); });
  }
  const who = esc((S.codex && S.codex.name) || 'Codex');
  $('cxBody').innerHTML = `<h3 id="cxTitle">Sign in to ${who}</h3><p class="loading">Asking Codex for the ChatGPT sign-in page…</p>`;
  if (!$('cxdlg').open) $('cxdlg').showModal();
  let r;
  try { r = await api('/api/codex/login', { method, account: S.codex && S.codex.id }); }
  catch (err) { $('cxBody').innerHTML = `<h3 id="cxTitle">Sign in to ${who}</h3><p class="cx-err">${esc(err.message)}</p><div class="d-row"><button class="btn" data-cx="close">Close</button></div>`; return; }
  if (r.ollama) { $('cxBody').innerHTML = `<h3 id="cxTitle">Sign in to Ollama</h3><p>Finish <code>ollama signin</code> in the ${esc(r.how || 'terminal')} that just opened, then click <b>Check again</b> on the ${who} card.</p><div class="d-row"><button class="btn" data-cx="close">Close</button></div>`; return; }
  S.codexAuthUrl = r.authUrl || r.verificationUrl;
  const head = `<h3 id="cxTitle">Sign in to ${who}</h3><p>Codex uses your <b>ChatGPT</b> account, not Claude. The sign-in happens on OpenAI’s site${codexAccts().length > 1 ? `. Sign in with the ChatGPT account <b>${who}</b> should use; with an account switcher in your browser, switch to it first, or copy the link into a private window` : ''}:</p>`;
  if (r.type === 'chatgptDeviceCode') {
    $('cxBody').innerHTML = `${head}
      <p class="cx-host"><span class="glyph" aria-hidden="true">✦</span>${esc(r.host)}</p>
      <ol class="cx-steps"><li>Open the page below and sign in to ChatGPT.</li><li>Enter this code:</li></ol>
      <p class="cx-code">${esc(r.userCode)}</p>
      <div class="d-row cx-row"><a class="btn prime" href="${esc(r.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open ${esc(r.host)}</a><button class="btn" data-cx="copy" data-text="${esc(r.userCode)}" data-label="Copy code">Copy code</button></div>
      <p class="cx-wait" id="cxWait"><span class="gen-spin" aria-hidden="true"></span>Waiting for you to finish. This closes by itself.</p>
      <p class="cx-alt"><button class="linkish" data-cx="browser">Sign in with a link instead</button></p>`;
  } else {
    $('cxBody').innerHTML = `${head}
      <p class="cx-host"><span class="glyph" aria-hidden="true">✦</span>${esc(r.host)}</p>
      <div class="d-row cx-row"><a class="btn prime" href="${esc(r.authUrl)}" target="_blank" rel="noopener noreferrer">Open the ChatGPT sign-in page</a><button class="btn" data-cx="copy" data-text="${esc(r.authUrl)}" data-label="Copy link">Copy link</button></div>
      <p class="cx-note">If your browser is already signed in to a different ChatGPT account, copy the link into a private window instead.</p>
      <p class="cx-wait" id="cxWait"><span class="gen-spin" aria-hidden="true"></span>Waiting for you to finish. This closes by itself.</p>
      <p class="cx-alt"><button class="linkish" data-cx="code">Use a code instead</button> (works from any browser or device)</p>`;
  }
  await loadState(); renderLive();
}
// Called when the sign-in state changes, to close the sign-in window once Codex is signed in.
function codexLoginProgress() {
  const d = $('cxdlg');
  if (!d || !d.open || !S.codex) return;
  if (S.codex.signedIn) {
    $('cxBody').innerHTML = `<h3 id="cxTitle">Codex is signed in</h3><p>Signed in${S.codex.email ? ` as <b>${esc(S.codex.email)}</b>` : ''}${S.codex.plan ? ` (${esc(S.codex.plan)})` : ''}. Your Codex chats and usage are on the hub now.</p><div class="d-row"><button class="btn prime" data-cx="close">Done</button></div>`;
    setTimeout(() => { if (d.open && S.codex.signedIn) d.close(); }, 4000);
  } else if (!S.codex.signingIn && S.codex.error && $('cxWait')) {
    $('cxWait').innerHTML = `<span class="cx-err">${esc(S.codex.error)}</span> <button class="linkish" data-cx="browser">Try again</button>`;
  }
}
async function codexInstall() {
  const r = await api('/api/codex/install', {});
  if (r.dryRun) return toast(`Would open a terminal:\n${r.script}`, 9000);
  return toast(`Installing Codex in a ${r.how}. When it finishes, click ⋯ → Check again on the Codex card.`, 10000);
}
// Pick the folder a new Codex chat works in.
function codexNewMenu(anchor) {
  const folders = S.projects.filter(p => p.exists).slice(0, 14);
  if (!folders.length) return toast('There are no folders yet. Open a folder in Claude Code or Codex once and it appears here.');
  showMenu(anchor, folders.map(p => ({ label: p.name, hint: p.cwd, run: () => ChatUI.open({ cwd: p.cwd, mode: 'new', provider: 'codex' }) })));
}
async function addCodexAccount(kind) {
  const name = (prompt(kind === 'ollama' ? 'Name for the Ollama account:' : 'Name for this Codex account (for example “Work” or “Personal”):', kind === 'ollama' ? 'Ollama' : '') || '').trim();
  if (!name) return;
  const r = await api('/api/codex/accounts', { name, kind });
  S.codex = r.codex; renderAll();
  if (kind === 'ollama') toast(S.codex.signedIn ? `Added ${name}. New Codex chats now run through Ollama.` : `Added ${name}. Start the Ollama app, then click Check again on its card.`, 6000);
  else codexSignIn();
}
function codexMenu(anchor) {
  const c = S.codex || {};
  const extra = !c.main && c.id !== 'codex';
  showMenu(anchor, [
    { label: 'Check again', hint: 'sign-in, usage and chats', run: async () => { const r = await api('/api/codex/check', {}); S.codex = r.codex; S.usage = r.usage || S.usage; renderAll(); toast('Checked Codex.', 2000); } },
    ...(S.codexAuthUrl && !c.signedIn ? [{ label: 'Copy the sign-in link', hint: 'for a private browser window', run: async () => { try { await navigator.clipboard.writeText(S.codexAuthUrl); toast('Copied.', 1500); } catch { prompt('Copy this link:', S.codexAuthUrl); } } }] : []),
    ...(c.signedIn && c.kind !== 'ollama' ? [{ label: 'Open chatgpt.com', hint: 'regular ChatGPT, in its own window', run: () => openWeb(c.id) }, { label: `Sign out of ${c.name || 'Codex'}`, run: async () => { if (!(await appConfirm(`Sign ${c.name || 'Codex'} out of its ChatGPT account?\n\nYour Codex chats stay on this computer.`, { ok: 'Sign out', danger: true }))) return; await api('/api/codex/logout', { account: c.id }); await reload(); toast(`${c.name || 'Codex'} is signed out.`); } }] : []),
    '-',
    { label: 'Add another Codex account', hint: 'a second ChatGPT sign-in; chats stay shared', run: () => addCodexAccount('chatgpt') },
    ...(codexAccts().some(x => x.kind === 'ollama') ? [] : [{ label: 'Add Ollama', hint: 'Codex with ollama.com cloud models', run: () => addCodexAccount('ollama') }]),
    ...(extra ? [
      { label: 'Rename…', run: async () => { const n = (prompt('New name:', c.name) || '').trim(); if (!n || n === c.name) return; const r = await api('/api/codex/accounts/rename', { id: c.id, name: n }); S.codex = r.codex; renderAll(); } },
      { label: 'Remove from the list', hint: 'its sign-in folder stays', run: async () => { if (!(await appConfirm(`Remove ${c.name} from Session Switcher?\n\nIts chats stay. Its sign-in stays in ~/.${c.id} if you add it again.`, { ok: 'Remove', danger: true }))) return; const r = await api('/api/codex/accounts/remove', { id: c.id }); S.codex = r.codex; renderAll(); } },
    ] : []),
    '-',
    { label: 'Turn Codex off', hint: 'hides it everywhere; turn it back on in Setup', run: async () => { await api('/api/codex/settings', { enabled: false }); await reload(); toast('Codex is off. Turn it back on in Setup.'); } },
  ]);
}

function rowHtml(s, folderName, hit) {
  const a = current(); const cx = isCodex(s); const oc = isOpenClaw(s);
  const ok = oc ? true : cx ? codexReady() : canLaunch(a);
  const why = oc ? '' : cx ? (S.codex && S.codex.installed === false ? 'Install Codex first (Setup)' : 'Sign in to Codex first') : !a.signedIn ? `Sign in to ${a.name} first` : !a.lock.ok ? (a.lockMessage || 'Not on its locked account') : '';
  const sub = s.lastPrompt ? `You last asked: ${s.lastPrompt}` : (s.firstPrompt && s.title !== s.firstPrompt ? `Started with: ${s.firstPrompt}` : '');
  const live = liveOf(s.id);
  const run = !live && isRunning(s.id);
  const flags = (isFav(s.id) ? '<span class="r-fav" title="Pinned to the sidebar">★</span>' : '') + (oc ? `<span class="tag openclaw">✨ ${esc(ocAgent(s))}</span>` : '') + (cx ? '<span class="tag codex">Codex</span>' : '') + (live ? `<span class="tag line">In the window${!cx && live.accountId !== a.id ? ` as ${esc(live.accountName)}` : ''}</span>`
    : run ? '<span class="tag violet">In a terminal</span>' : (s.active ? '<span class="tag ghost">Just updated</span>' : ''));
  const primary = oc ? `<button class="btn sm" data-chat="${esc(s.id)}" title="View this OpenClaw session">Open</button>`
    : live ? `<button class="btn sm" data-chat="${esc(s.id)}" title="Go back to this chat">Return</button>`
    : run ? `<button class="btn sm" data-watch="${esc(s.id)}" title="Read it live here while it runs in its terminal">Watch</button>`
    : inApp() ? `<button class="btn sm" data-chat="${esc(s.id)}" ${ok ? '' : `disabled title="${esc(why)}"`}>Open</button>`
    : `<button class="btn sm" data-open="${esc(s.id)}" ${ok ? '' : `disabled title="${esc(why)}"`}>Resume</button>`;
  const opened = s.lastOpened ? `<span class="r-as" style="--ring:${ringById(s.lastOpened.account)}" title="Last opened from here as ${esc(s.lastOpened.accountName)}, ${esc(agoL(s.lastOpened.at))}"><i></i>as ${esc(s.lastOpened.accountName)}</span>` : '';
  return `<li class="row ${S.drawerId === s.id ? 'current' : ''}" data-row="${esc(s.id)}">
    <div class="r-when"><span class="r-ago">${esc(ago(s.updated))}</span><span class="r-date">${esc(stamp(s.updated))}</span>${opened}</div>
    <div class="r-what">
      <button class="r-title" data-preview="${esc(s.id)}" title="Details and latest messages">${hit ? highlight(s.title, S.q) : esc(s.title)}</button>${flags ? `<span class="r-flags">${flags}</span>` : ''}
      ${hit && hit.snippet ? `<p class="r-snip">${highlight(hit.snippet, S.q)}</p>` : (sub ? `<p class="r-sub">${esc(sub)}</p>` : '')}
      ${folderName ? `<span class="r-chip">${esc(folderName)}</span>` : ''}
    </div>
    <div class="r-go"><button class="icon" data-more="${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(s.title)}">${ICON.more}</button>${primary}</div>
  </li>`;
}

function secHead(eyebrow, title, extra = '') {
  return `<div class="sec-h"><p class="eyebrow">✦ ${esc(eyebrow)}</p><h2>${esc(title)}</h2>${extra ? `<div class="sec-x">${extra}</div>` : ''}</div>`;
}

function renderHub() {
  const better = headroomPick();
  const recent = allSessions().slice(0, 1);
  $('page').innerHTML = `
    <div id="heroSlot">${heroHtml()}</div>
    <div id="guardSlot">${guardHtml()}</div>
    <section class="sec" id="secAwait">
      ${secHead('Your move', 'Awaiting you')}
      <div class="summons-grid" id="awaitList"></div>
    </section>
    <section class="sec" id="secWork">
      ${secHead('Right now', 'At work')}
      <div class="board" id="board"></div>
      <div class="quietrow" id="quietList"></div>
    </section>
    <section class="sec" id="secWorlds">${secHead('By folder', 'Your projects', '<button class="btn sm" data-act="project-new">New project</button>')}<div class="atlas ${S.atlasEntered ? '' : 'enter'}" id="atlas"></div></section>
    <section class="sec">
      ${secHead('Pick up where you left off', 'Recent chats', `<button class="btn quiet sm" data-view="recent">All recent chats</button>`)}
      ${recent.length ? '<ul class="rows" id="recentList"></ul>' : `<p class="empty-line">No chats yet. Start one with <button class="linkish" data-act="project-new">New project</button>, or open a folder in Claude Code once and its chats appear here.</p>`}
    </section>
    <section class="sec" id="secAccounts">
      ${secHead('Your plans', 'Accounts and usage', `<button class="btn quiet sm" data-act="usage-all">Check all</button>`)}
      ${better ? `<div class="headroom"><span><b>${esc(better.a.name)}</b> has the most room right now: ${better.r}% left. ${esc(current().name)} has ${binding(usageOf(current().id)).left}%.</span><button class="btn sm" data-act="use" data-acct="${esc(better.a.id)}">Work as ${esc(better.a.name)}</button></div>` : ''}
      <div class="dials" id="dials"></div>
    </section>
    ${S.dryRun ? '<p class="note">Preview mode: terminal buttons show what would run instead of opening one.</p>' : ''}`;
  renderHubLists();
  renderLive(true);
  if (!dialsDrawn && !renderHub.timer) renderHub.timer = setTimeout(() => { dialsDrawn = true; }, 2600);
}
// Recent chats and the index, patched in place when transcripts change.
function renderHubLists() {
  const list = $('recentList');
  if (list) patch(list, allSessions().sort((x, y) => y[0].updated - x[0].updated).slice(0, 8), ([s]) => s.id, ([s, p]) => rowHtml(s, p.name));
  const atlas = $('atlas');
  if (atlas) {
    patch(atlas, atlasItems(), x => (x.add ? '+new' : x.p.cwd), x => (x.add ? newProjectTile(x.i) : worldCard(x.p, x.i)));
    // The projects rise in, once, the first time the atlas scrolls into view. (Any part of it:
    // on a phone the single column is many screens tall, so a share of it can never be visible.)
    if (!S.atlasEntered && !atlas._io) {
      const done = () => { S.atlasEntered = true; atlas.classList.remove('enter', 'go'); };
      if (!motionOk() || !('IntersectionObserver' in window)) done();
      else {
        atlas._io = new IntersectionObserver(es => {
          if (!es.some(x => x.isIntersecting)) return;
          atlas._io.disconnect(); atlas.classList.add('go'); setTimeout(done, 1900);
        }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
        atlas._io.observe(atlas);
      }
    }
    ensureWorlds();
  }
}

/* ---------- projects: each folder, with its art, documents and pictures ---------- */
const imageSrc = (p, cwd) => `/api/image?${new URLSearchParams({ token: TOKEN, path: p, ...(cwd ? { cwd } : {}) })}`;
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
let worldsLoading = null;
const worldFetch = {};
function loadWorld(cwd, fresh) {
  if (worldFetch[cwd] && !fresh) return worldFetch[cwd];
  const pr = api(`/api/project/info?${new URLSearchParams({ cwd, ...(fresh ? { fresh: '1' } : {}) })}`)
    .then(w => { S.worlds[cwd] = { ...w, at: Date.now() }; return S.worlds[cwd]; })
    .finally(() => { if (worldFetch[cwd] === pr) delete worldFetch[cwd]; });
  worldFetch[cwd] = pr;
  return pr;
}
const worldStale = cwd => !S.worlds[cwd] || Date.now() - S.worlds[cwd].at > 5 * 60 * 1000;
// Fetches project details a few at a time, then refreshes whatever shows them.
function ensureWorlds() {
  if (worldsLoading) return;
  const want = S.projects.filter(p => p.exists !== false && worldStale(p.cwd)).map(p => p.cwd);
  if (!want.length) return;
  worldsLoading = (async () => {
    for (let i = 0; i < want.length; i += 3) await Promise.all(want.slice(i, i + 3).map(c => loadWorld(c).catch(() => null)));
  })().finally(() => { worldsLoading = null; if (S.view === 'hub' && $('atlas')) patch($('atlas'), atlasItems(), x => (x.add ? '+new' : x.p.cwd), x => (x.add ? newProjectTile(x.i) : worldCard(x.p, x.i))); });
}
const atlasItems = () => [...S.projects.map((p, i) => ({ p, i })), { add: true, i: S.projects.length }];
function newProjectTile(i) {
  return `<button class="world world-new" data-act="project-new" style="--i:${Math.min(i, 12)}"><span class="wn-plus" aria-hidden="true"></span><b>New project</b><span>Make a folder and start a chat in it, as any of your accounts.</span></button>`;
}
// A project without cover art gets a soft gradient of its own, drawn from its name.
const TINTS = ['#a5463f', '#d9bf74', '#a58be8', '#cf8274', '#8f7f6a'];
function worldArt(p, w, cls = '', lazy = true) {
  const banner = w && w.banner;
  if (banner) return `<img class="${cls}" src="${esc(imageSrc(banner, p.cwd))}" alt="" ${lazy ? 'loading="lazy" ' : ''}decoding="async">`;
  const h = hash(p.name), a = TINTS[h % TINTS.length], b = TINTS[(h >>> 5) % TINTS.length === h % TINTS.length ? (h + 1) % TINTS.length : (h >>> 5) % TINTS.length];
  return `<span class="w-glyph ${cls}" style="--a:${a};--b:${b};--x:${18 + (h >>> 9) % 50}%;--y:${10 + (h >>> 13) % 50}%" aria-hidden="true"><b>${esc(initial(p.name))}</b></span>`;
}
function worldCard(p, i) {
  const w = S.worlds[p.cwd];
  const nClaude = p.sessions.filter(x => !isCodex(x)).length, nCodex = p.sessions.length - nClaude;
  const latest = p.sessions[0];
  const today = midnight();
  const chatsToday = p.sessions.filter(x => x.updated >= today).length;
  const live = p.sessions.some(x => isRunning(x.id) || liveOf(x.id));
  const bits = [chatsToday ? plural(chatsToday, 'chat') : '', w && w.today.docs ? plural(w.today.docs, 'doc') : '', w && w.today.images ? plural(w.today.images, 'image') : ''].filter(Boolean);
  return `<article class="world ${live ? 'is-live' : ''}" style="--i:${Math.min(i, 12)}">
    <button class="w-art" data-world="${esc(p.cwd)}" aria-label="Open ${esc(p.name)}">${worldArt(p, w)}<span class="w-shade" aria-hidden="true"></span>
      <span class="w-title"><span class="w-name">${esc(p.name)}</span>${live ? '<span class="live-dot" title="A chat here is open right now"></span>' : ''}</span></button>
    <div class="w-body">
      <p class="w-today ${bits.length ? 'on' : ''}">${bits.length ? `<span class="glyph" aria-hidden="true">✦</span>Today: ${esc(bits.join(', '))}` : p.sessions.length ? 'Quiet today' : 'New project'}</p>
      ${latest ? `<p class="w-last"><button class="linkish" data-preview="${esc(latest.id)}" title="${esc(latest.title)}">${esc(latest.title)}</button><span>${esc(agoL(latest.updated))}</span></p>` : `<p class="w-last quiet">No chats yet${p.added && p.updated ? `. Added ${esc(agoL(p.updated))}` : ''}.</p>`}
      <div class="w-act">
        ${latest && p.exists ? `<button class="btn sm" data-continue="${esc(latest.id)}">Continue</button>` : ''}
        <button class="btn quiet sm" data-act="world-new" data-cwd="${esc(p.cwd)}" aria-haspopup="menu" aria-expanded="false" ${p.exists ? '' : 'disabled'}>New chat</button>
        ${p.sessions.length ? `<span class="w-counts" title="${nClaude} Claude Code chats${nCodex ? `, ${nCodex} Codex chats` : ''}">${nClaude ? `<span class="pc claude">${nClaude}</span>` : ''}${nCodex ? `<span class="pc codex">${nCodex}</span>` : ''}</span>` : ''}
      </div>
    </div>
  </article>`;
}
// New chat in a project: Claude or Codex, plain or starting from a saved prompt.
function worldNewItems(cwd) {
  const p = S.projects.find(x => x.cwd === cwd); if (!p) return [];
  const a = current();
  return [
    { label: `New Claude chat`, hint: `as ${a.name}`, disabled: !canLaunch(a), why: a.lockMessage || 'Sign in first', run: () => ChatUI.open({ cwd, mode: 'new' }) },
    ...(S.codex && S.codex.enabled ? [{ label: 'New Codex chat', hint: 'ChatGPT', disabled: !codexReady(), why: 'Sign in to Codex first', run: () => ChatUI.open({ cwd, mode: 'new', provider: 'codex' }) }] : []),
    '-',
    ...S.prompts.slice(0, 10).map(pr => ({ label: `Start with: ${pr.title}`, hint: pr.provider === 'codex' ? 'runs in Codex' : '', disabled: pr.provider === 'codex' ? !codexReady() : !canLaunch(a), run: () => startWithPrompt(cwd, pr) })),
    { label: 'Edit prompts…', run: openPromptEditor },
  ];
}
function worldNewMenu(anchor, cwd) { const items = worldNewItems(cwd); if (items && items.length) showMenu(anchor, items); }

/* ---------- the prompt book ---------- */
const today8601 = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// {project} becomes the folder's name ({world} still works too) and {date} today's date.
const fillPrompt = (text, name) => String(text).replace(/\{(project|world)\}/gi, name || 'this project').replace(/\{date\}/gi, today8601());
async function loadPrompts() { try { const j = await api('/api/prompts'); S.prompts = j.prompts || []; S.promptSets = j.sets || []; } catch { S.prompts = S.prompts || []; } }
// The Codex prompt that makes a cover picture, if there is one.
const coverPrompt = () => S.prompts.find(x => x.id === 'cover' || x.id === 'keyart') || null;
function startWithPrompt(cwd, pr) {
  const p = S.projects.find(x => x.cwd === cwd);
  const provider = pr.provider === 'codex' ? 'codex' : 'claude';
  return ChatUI.open({ cwd, mode: 'new', provider, initialText: fillPrompt(pr.text, p ? p.name : '') });
}
function openPromptEditor() {
  closeMenu();
  if (!$('promptDlg')) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="promptDlg" class="wide prompt-dlg" aria-labelledby="pdTitle">
      <div class="setup-head"><h3 id="pdTitle">Prompts</h3><button class="icon" data-pd="close" aria-label="Close">✕</button></div>
      <div class="setup-body"><p class="pd-hint">Reusable starts for the jobs you repeat. <code>{project}</code> becomes the project’s folder name and <code>{date}</code> today’s date. Anything else in braces, like <code>{describe it}</code>, is a blank: the message box selects it so you can type over it. Type <code>/</code> in an empty message box to pick a prompt.</p><div id="pdList"></div>
      <div class="d-row pd-row"><button class="btn quiet" data-pd="sets" aria-haspopup="menu" aria-expanded="false">Add a starter set</button><button class="btn quiet" data-pd="reset">Restore the starter prompts</button><span class="spacer"></span><button class="btn" data-pd="add">Add a prompt</button><button class="btn prime" data-pd="save">Save</button></div></div></dialog>`);
    $('promptDlg').addEventListener('click', wrap(async e => {
      const b = e.target.closest('[data-pd]'); if (!b) return;
      const act = b.dataset.pd;
      if (act === 'close') return closePromptEditor();
      if (act === 'add') { $('promptDlg').dataset.dirty = '1'; $('pdList').insertAdjacentHTML('beforeend', promptRow({ id: '', title: '', text: '' })); $('pdList').lastElementChild.querySelector('input').focus(); return; }
      if (act === 'remove') { $('promptDlg').dataset.dirty = '1'; return b.closest('.pd-item').remove(); }
      if (act === 'reset') { if (!(await appConfirm('Put back the starter prompts?\n\nYour own prompts will be replaced.', { ok: 'Put them back', danger: true }))) return; S.prompts = (await api('/api/prompts', { reset: true })).prompts; return renderPromptEditor(); }
      if (act === 'sets') {
        return showMenu(b, (S.promptSets || []).map(st => ({ label: st.title, hint: `${plural(st.count, 'prompt')}, added to yours`, run: async () => { const n0 = S.prompts.length; S.prompts = (await api('/api/prompts', { addSet: st.id })).prompts; renderPromptEditor(); toast(S.prompts.length > n0 ? `Added ${plural(S.prompts.length - n0, 'prompt')} from ${st.title}.` : `You already have every prompt in ${st.title}.`, 3000); } })));
      }
      if (act === 'save') {
        const list = [...$('pdList').querySelectorAll('.pd-item')].map(el => ({ id: el.dataset.id, title: el.querySelector('.pd-t').value, text: el.querySelector('.pd-x').value, provider: el.querySelector('.pd-p').value === 'codex' ? 'codex' : undefined }));
        S.prompts = (await api('/api/prompts', { prompts: list })).prompts;
        toast(`Saved ${plural(S.prompts.length, 'prompt')}.`, 2000);
        $('promptDlg').dataset.dirty = '';
        return $('promptDlg').close();
      }
    }));
  }
  if (!$('promptDlg')._guard) {
    $('promptDlg')._guard = true;
    $('promptDlg').addEventListener('input', () => { $('promptDlg').dataset.dirty = '1'; });
    // Esc and clicks on the backdrop ask before throwing edits away. (A browser can refuse to hold
    // a dialog open on Esc; then it closes, and comes straight back to ask.)
    $('promptDlg').addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closePromptEditor(); } });
    $('promptDlg').addEventListener('cancel', e => { if (!e.cancelable) return; e.preventDefault(); closePromptEditor(); });
    $('promptDlg').addEventListener('close', () => { if ($('promptDlg').dataset.dirty) { $('promptDlg').showModal(); closePromptEditor(); } });
    $('promptDlg').addEventListener('click', e => { if (e.target === $('promptDlg')) closePromptEditor(); });
  }
  renderPromptEditor();
  $('promptDlg').showModal();
}
async function closePromptEditor() {
  const d = $('promptDlg');
  if ($('confirmDlg')?.open) return;
  if (d.dataset.dirty && !(await appConfirm('Discard your changes to the prompts?\n\nThey haven’t been saved.', { ok: 'Discard', cancel: 'Keep editing', danger: true }))) return;
  d.dataset.dirty = ''; d.close();
}
function promptRow(pr) {
  return `<div class="pd-item" data-id="${esc(pr.id || '')}"><div class="pd-top"><input class="pd-t" value="${esc(pr.title)}" placeholder="Name, like “Balance pass”" maxlength="80" aria-label="Prompt name">
    <select class="pd-p" aria-label="Runs in"><option value="claude" ${pr.provider === 'codex' ? '' : 'selected'}>Claude</option><option value="codex" ${pr.provider === 'codex' ? 'selected' : ''}>Codex</option></select>
    <button class="icon" data-pd="remove" aria-label="Remove this prompt">✕</button></div>
    <textarea class="pd-x" rows="3" placeholder="What to ask. {project} and {date} fill in automatically." aria-label="Prompt text">${esc(pr.text)}</textarea></div>`;
}
function renderPromptEditor() { $('pdList').innerHTML = S.prompts.map(promptRow).join(''); $('promptDlg').dataset.dirty = ''; }
/* ---------- new project: make a folder (or pick one you have) and start a chat in it ---------- */
const NP = { mode: 'new', places: null, busy: false };
// The same rules the server uses, so mistakes show while you type.
function folderNameProblem(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.length > 80) return 'Keep the name under 80 characters.';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) return 'A folder name can’t contain < > : " / \\ | ? or *.';
  if (/[. ]$/.test(n)) return 'A folder name can’t end with a dot or a space.';
  if (/^\.+$/.test(n)) return 'Pick a name with letters or numbers in it.';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return `Windows keeps the name “${n}” for itself. Pick another.`;
  return '';
}
const joinDir = (dir, name) => { const sep = (NP.places && NP.places.sep) || (dir.includes('\\') ? '\\' : '/'); return `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`; };
const shortDir = p => { const parts = String(p).split(/[\\/]+/).filter(Boolean); return parts.length > 2 ? `…${p.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(p.includes('\\') ? '\\' : '/')}` : p; };
async function openNewProject() {
  closeMenu(); closePalette();
  if (!$('npDlg')) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="npDlg" class="np-dlg" aria-labelledby="npTitle">
      <form id="npForm" novalidate>
        <div class="np-head"><h3 id="npTitle">New project</h3><button type="button" class="icon" data-np="close" aria-label="Close">✕</button></div>
        <div class="seg np-mode" role="group" aria-label="Where the project lives"><button type="button" data-np-mode="new" aria-pressed="true" class="on">Make a new folder</button><button type="button" data-np-mode="existing" aria-pressed="false">Use a folder I have</button></div>
        <div class="np-sec" id="npNew">
          <label class="np-f" for="npName"><span>Name</span></label>
          <input id="npName" maxlength="80" autocomplete="off" spellcheck="false" placeholder="My new project">
          <label class="np-f" for="npParent"><span>Location</span></label>
          <div class="np-loc"><input id="npParent" list="npPlaces" autocomplete="off" spellcheck="false"><button type="button" class="btn" data-np="browse">Browse…</button></div>
          <datalist id="npPlaces"></datalist>
          <div class="np-chips" id="npChips"></div>
          <p class="np-path" id="npPath"></p>
        </div>
        <div class="np-sec" id="npHave" hidden>
          <label class="np-f" for="npExisting"><span>Folder</span></label>
          <div class="np-loc"><input id="npExisting" autocomplete="off" spellcheck="false" placeholder="The full path, like C:\\Users\\you\\Projects\\Something"><button type="button" class="btn" data-np="browse-existing">Browse…</button></div>
          <p class="np-path">Nothing in it is moved or changed. It just appears in your projects.</p>
        </div>
        <fieldset class="np-as"><legend>Start a chat in it as</legend><div id="npAs"></div></fieldset>
        <div class="np-sec" id="npPromptRow"><label class="np-f" for="npPrompt"><span>Start with</span></label><select id="npPrompt"></select></div>
        <div class="np-err" id="npErr" role="alert" hidden></div>
        <div class="d-row"><button type="button" class="btn" data-np="close">Cancel</button><button type="submit" class="btn prime" id="npGo">Create project</button></div>
      </form></dialog>`);
    const d = $('npDlg');
    d.addEventListener('click', wrap(async e => {
      if (e.target === d) return d.close();
      const m = e.target.closest('[data-np-mode]'); if (m) return npMode(m.dataset.npMode);
      const ch = e.target.closest('[data-np-place]'); if (ch) { $('npParent').value = ch.dataset.npPlace; return npRefresh(); }
      const b = e.target.closest('[data-np]'); if (!b) return;
      if (b.dataset.np === 'close') return d.close();
      if (b.dataset.np === 'browse' || b.dataset.np === 'browse-existing') {
        const input = b.dataset.np === 'browse' ? $('npParent') : $('npExisting');
        b.disabled = true;
        try {
          const r = await api('/api/project/pick', { start: input.value || (NP.places && NP.places.suggested) || '', title: b.dataset.np === 'browse' ? 'Choose where the new project’s folder goes' : 'Choose the project’s folder' });
          if (r.unsupported) toast('The folder window only opens on Windows and macOS. Type the path instead.', 4000);
          else if (r.path) { input.value = r.path; npRefresh(); }
        } finally { b.disabled = false; input.focus(); }
        return;
      }
      if (b.dataset.np === 'use-existing') return npSubmit(true);
    }));
    $('npForm').addEventListener('submit', e => { e.preventDefault(); wrap(npSubmit)(false); });
    $('npForm').addEventListener('input', () => npRefresh());
    $('npForm').addEventListener('change', e => { if (e.target.name === 'npAs') npRefresh(); });
  }
  NP.busy = false;
  npMode('new', true);
  $('npName').value = ''; $('npExisting').value = '';
  $('npErr').hidden = true;
  npRenderAs();
  $('npPrompt').innerHTML = `<option value="">Nothing yet, I’ll write the first message</option>${S.prompts.map(pr => `<option value="${esc(pr.id)}">${esc(pr.title)}</option>`).join('')}`;
  $('npDlg').showModal();
  $('npName').focus();
  try {
    NP.places = await api('/api/project/places');
    if (!$('npParent').value) $('npParent').value = NP.places.suggested;
    $('npPlaces').innerHTML = NP.places.places.map(x => `<option value="${esc(x.path)}">`).join('');
    $('npChips').innerHTML = NP.places.places.filter(x => x.projects).slice(0, 4).map(x => `<button type="button" class="chip" data-np-place="${esc(x.path)}" title="${esc(x.path)}">${esc(shortDir(x.path))}<span class="count">${x.projects}</span></button>`).join('');
  } catch { /* you can still type a location */ }
  npRefresh();
}
function npMode(mode, quiet) {
  NP.mode = mode;
  for (const b of document.querySelectorAll('#npDlg [data-np-mode]')) { const on = b.dataset.npMode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  $('npNew').hidden = mode !== 'new'; $('npHave').hidden = mode !== 'existing';
  $('npGo').textContent = mode === 'new' ? 'Create project' : 'Add project';
  $('npErr').hidden = true;
  if (!quiet) (mode === 'new' ? $('npName') : $('npExisting')).focus();
  npRefresh();
}
// Who the first chat runs as: any Claude account, Codex, or no chat yet.
function npRenderAs() {
  const cur = current();
  const opts = S.accounts.map(a => {
    const ok = canLaunch(a);
    const why = !a.signedIn ? 'Not signed in' : !a.lock.ok ? (a.lockMessage || 'Not on its locked account') : usageLine(a.id, { short: true }) || a.email || 'Ready';
    return { v: a.id, ring: ringOf(a), name: a.name, sub: why, ok };
  });
  if (S.codex && S.codex.enabled) opts.push({ v: 'codex', ring: codexRing(S.codex.id), name: S.codex.name || 'Codex', sub: codexReady() ? (usageLine(S.codex.id, { short: true }) || (S.codex.kind === 'ollama' ? 'Ollama' : 'ChatGPT')) : 'Sign in to Codex first', ok: codexReady(), codex: true });
  opts.push({ v: 'none', name: 'Don’t start a chat yet', sub: 'Just make the folder and open the project', ok: true, none: true });
  const pick = (canLaunch(cur) && cur.id) || (opts.find(o => o.ok) || {}).v;
  $('npAs').innerHTML = opts.map(o => `<label class="np-opt ${o.ok ? '' : 'off'} ${o.codex ? 'codex' : ''}"><input type="radio" name="npAs" value="${esc(o.v)}" ${o.v === pick ? 'checked' : ''} ${o.ok ? '' : 'disabled'}>
    ${o.none ? '<span class="np-ring none" aria-hidden="true"></span>' : `<span class="np-ring" style="--ring:${o.ring}" aria-hidden="true"></span>`}<span class="np-t"><b>${esc(o.name)}</b><small>${esc(o.sub)}</small></span></label>`).join('');
}
function npRefresh() {
  if (!$('npDlg') || !$('npDlg').open) return;
  const as = (document.querySelector('#npAs input:checked') || {}).value;
  $('npPromptRow').hidden = as === 'none';
  if (NP.mode === 'new') {
    const name = $('npName').value.trim(), parent = $('npParent').value.trim();
    const bad = folderNameProblem(name);
    $('npPath').innerHTML = bad ? `<span class="np-bad">${esc(bad)}</span>` : name && parent ? `Creates <code>${esc(joinDir(parent, name))}</code>` : 'Pick a name and where its folder goes.';
    $('npGo').disabled = NP.busy || !name || !parent || !!bad || !as;
  } else $('npGo').disabled = NP.busy || !$('npExisting').value.trim() || !as;
}
async function npSubmit(useExisting) {
  if ($('npGo').disabled && !useExisting) return;
  const as = (document.querySelector('#npAs input:checked') || {}).value || 'none';
  const pr = as === 'none' ? null : S.prompts.find(x => x.id === $('npPrompt').value) || null;
  const body = NP.mode === 'existing' ? { existing: $('npExisting').value } : { parent: $('npParent').value, name: $('npName').value, useExisting };
  NP.busy = true; npRefresh(); $('npErr').hidden = true;
  let r;
  try { r = await api('/api/project/create', body); }
  catch (err) {
    NP.busy = false; npRefresh();
    $('npErr').hidden = false;
    $('npErr').innerHTML = err.reason === 'exists'
      ? `<span>${esc(err.message)} Use it as this project? Nothing in it changes.</span><button type="button" class="btn sm" data-np="use-existing">Use that folder</button>`
      : `<span>${esc(err.message)}</span>`;
    return;
  }
  NP.busy = false;
  $('npDlg').close();
  await loadSessions(); renderNav();
  const name = r.name;
  toast(`${r.created ? 'Created' : 'Added'} ${name}.`, 2500);
  const initialText = pr ? fillPrompt(pr.text, name) : '';
  if (as === 'none') return go('folder', r.cwd);
  if (as === 'codex') return ChatUI.open({ cwd: r.cwd, mode: 'new', provider: 'codex', initialText });
  return ChatUI.open({ cwd: r.cwd, mode: 'new', accountId: as, initialText });
}

/* ---------- a copy of the app for someone else ---------- */
function shareCopy() {
  if (!$('shareDlg')) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="shareDlg" aria-labelledby="shTitle"><form method="dialog" id="shForm">
      <h3 id="shTitle">Make a copy to share</h3>
      <p class="sh-p">A zip of Session Switcher for someone else. It has the app only: none of your accounts, sign-ins, chats, chat names, banners or projects go in it. They unzip it and double-click <b>Claude Switcher.vbs</b>, then sign in with their own accounts.</p>
      <label class="toggle"><input type="checkbox" id="shPrompts"><span><b>Include my prompts</b><span id="shCount"></span></span></label>
      <div class="d-row"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn prime" value="ok" id="shGo">Make the copy</button></div>
    </form></dialog>`);
    $('shareDlg').addEventListener('close', wrap(async () => {
      if ($('shareDlg').returnValue !== 'ok') return;
      const r = await api('/api/share-copy', { includePrompts: $('shPrompts').checked });
      const where = /[\\/]Desktop$/i.test(r.path.replace(/[\\/][^\\/]+$/, '')) ? 'on your Desktop' : `in ${r.path.replace(/[\\/][^\\/]+$/, '')}`;
      toast(`Saved “${r.path.split(/[\\/]/).pop()}” ${where}${r.withPrompts ? ', with your prompts' : ''}. That’s the file to send.`, 9000);
    }));
  }
  $('shCount').textContent = `So they start with your ${plural(S.prompts.length, 'prompt')}. Otherwise they get the starter set.`;
  $('shPrompts').checked = false;
  $('shareDlg').returnValue = '';
  $('shareDlg').showModal();
}

function promptMenu(anchor, cwd) {
  if (!S.prompts.length) return openPromptEditor();
  const a = current();
  showMenu(anchor, [
    ...S.prompts.map(pr => ({ label: pr.title, hint: pr.provider === 'codex' ? 'runs in Codex' : '', disabled: pr.provider === 'codex' ? !codexReady() : !canLaunch(a), why: pr.provider === 'codex' ? 'Sign in to Codex first' : (a.lockMessage || `Sign in to ${a.name} first`), run: () => startWithPrompt(cwd, pr) })),
    '-',
    { label: 'Edit prompts…', run: openPromptEditor },
  ]);
}

/* ---------- motion ---------- */
const motionOk = () => Local.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches;
// Runs a view change as a view transition when the browser can, so banners carry over between pages.
function transition(fn) {
  if (!document.startViewTransition || !motionOk() || document.hidden) { fn(); return null; }
  const t = document.startViewTransition(fn);
  t.updateCallbackDone.catch(err => toast(err.message || String(err)));
  t.finished.catch(() => {}).finally(() => { for (const el of document.querySelectorAll('.w-art[style*="view-transition-name"]')) el.style.viewTransitionName = ''; });
  return t;
}
function openWorld(cwd, el) {
  const art = el && (el.classList.contains('w-art') ? el : el.querySelector('.w-art'));
  S.worldTab = 'chats';
  if (art && motionOk()) art.style.viewTransitionName = 'world-banner';
  go('folder', cwd);
}

// The parts of the hub that change while chats run. Patched in place.
function renderLive(force) {
  renderBar(); updateTitle();
  if (window.ChatUI && ChatUI.renderRail) ChatUI.renderRail();
  if (S.view !== 'hub' || !$('awaitList')) return;
  const A = awaiting(), W = atWork(), Q = quietOpen();
  const heroNow = heroHtml();
  if (force || $('heroSlot')._h !== heroNow) { $('heroSlot').innerHTML = heroNow; $('heroSlot')._h = heroNow; }
  patch($('awaitList'), A, keyOf, awaitCard, '<p class="empty-line">Nothing is waiting on you. When Claude asks for your OK or finishes a reply, it shows up here first.</p>');
  patch($('board'), W, keyOf, workCard, `<p class="empty-line">${A.length ? 'Nothing else is working right now.' : 'Nothing is working right now. Open a chat and it appears here while it works.'}</p>`);
  patch($('quietList'), Q, keyOf, quietChip, '');
  $('quietList').classList.toggle('has', Q.length > 0);
  const dials = S.accounts.map(a => ({ a }));
  if (S.codex && S.codex.enabled) for (const cx of codexAccts()) dials.push({ cx });
  patch($('dials'), [...dials, { add: true }], x => (x.add ? 'add' : x.cx ? `cx:${x.cx.id}` : x.a.id), x => (x.add ? '<button class="add-card" data-act="add"><span class="glyph" aria-hidden="true">✦</span>Add another Claude account</button>' : x.cx ? codexCard(x.cx) : dialCard(x.a)));
  tick();
}

function renderRecent() {
  const every = allSessions().sort((x, y) => y[0].updated - x[0].updated);
  const hasCodex = every.some(([x]) => isCodex(x));
  const hasOc = every.some(([x]) => isOpenClaw(x));
  const provOf = x => isCodex(x) ? 'codex' : isOpenClaw(x) ? 'openclaw' : 'claude';
  const f = (hasCodex || hasOc) ? (S.recentProv || 'all') : 'all';
  const all = f === 'all' ? every : every.filter(([x]) => provOf(x) === f);
  const tab = (v, label, n) => `<button class="${f === v ? 'on' : ''}" data-recent="${v}" aria-pressed="${f === v}">${label} <span class="count">${n}</span></button>`;
  $('page').innerHTML = `<div id="guardSlot">${guardHtml()}</div>
    <header class="f-head"><div><p class="eyebrow">✧ Every folder</p><h1>Recent chats</h1><p class="f-meta">Your latest chats${f === 'codex' ? ' in Codex' : f === 'claude' ? ` in Claude Code, ready to open as ${esc(current().name)}` : ''}.</p></div>
      ${hasCodex ? `<div class="seg provseg" role="group" aria-label="Show">${tab('all', 'All', every.length)}${tab('claude', 'Claude Code', every.filter(([x]) => !isCodex(x)).length)}${tab('codex', 'Codex', every.filter(([x]) => isCodex(x)).length)}${hasOc ? tab('openclaw', 'OpenClaw', every.filter(([x]) => isOpenClaw(x)).length) : ''}</div>` : ''}</header>
    ${all.length ? `<ul class="rows sec-gap">${all.slice(0, 60).map(([x, p]) => rowHtml(x, p.name)).join('')}</ul>` : '<p class="empty-line">Nothing here yet.</p>'}`;
}
// A project: its banner, then its chats, documents and pictures.
function renderFolder() {
  const a = current(), p = S.projects.find(x => x.cwd === S.folder);
  if (!p) { S.view = 'hub'; return renderPage(); }
  const w = S.worlds[p.cwd];
  if (p.exists && worldStale(p.cwd)) loadWorld(p.cwd).then(() => { if (S.view === 'folder' && S.folder === p.cwd) renderFolder(); }).catch(() => {});
  const pinned = S.pins.has(p.cwd);
  const prov = S.prov;
  const list = prov ? p.sessions.filter(x => (isCodex(x) ? 'codex' : isOpenClaw(x) ? 'openclaw' : 'claude') === prov) : p.sessions;
  const other = prov ? p.sessions.length - list.length : 0;
  const otherName = prov === 'codex' ? 'Claude Code' : prov === 'openclaw' ? 'Claude Code' : 'Codex';
  const today = midnight();
  const bits = [plural(p.sessions.filter(x => x.updated >= today).length, 'chat'), w && w.today.docs ? plural(w.today.docs, 'document') : '', w && w.today.images ? plural(w.today.images, 'image') : ''];
  const todayLine = bits.slice(1).some(Boolean) || p.sessions.some(x => x.updated >= today) ? ` Today: ${bits.filter(Boolean).join(', ')}.` : '';
  const meta = [plural(list.length, prov === 'codex' ? 'Codex chat' : prov === 'claude' ? 'Claude Code chat' : prov === 'openclaw' ? 'OpenClaw session' : 'chat'), p.notes && prov !== 'codex' ? plural(p.notes, 'saved note') : null, `last used ${agoL(list.length ? list[0].updated : p.updated)}`].filter(Boolean).join(', ');
  const hasArt = !!(w && w.banner);
  const art = coverPrompt();
  const hint = p.exists && w && !hasArt
    ? (w.images.length ? '<button class="wp-hint" data-wtab="gallery">Choose a banner from the gallery</button>'
      : art && codexReady() ? `<button class="wp-hint" data-prompt="${esc(art.id)}">Make a cover image with Codex</button>` : '')
    : '';
  const heroH = `<div class="wp-art" style="view-transition-name:world-banner">${worldArt(p, w, '', false)}</div><span class="wp-shade" aria-hidden="true"></span>
    <div class="wp-in"><p class="eyebrow ${prov || ''}">${prov === 'codex' ? 'Codex chats in this project' : prov === 'claude' ? 'Claude Code chats in this project' : 'Project'}</p><h1>${esc(p.name)}</h1></div>${hint}`;
  const subH = `<div class="wp-where"><p class="f-path">${esc(p.cwd)}${p.exists ? '' : ' (this folder no longer exists)'}</p>
      <p class="f-meta">${esc(meta[0].toUpperCase() + meta.slice(1))}.${esc(todayLine)}${other ? ` <button class="linkish" data-view="folder" data-cwd="${esc(p.cwd)}" data-prov="${prov === 'codex' || prov === 'openclaw' ? 'claude' : 'codex'}">${other === 1 ? `1 ${otherName} chat` : `${other} ${otherName} chats`} here too</button>` : ''}</p></div>
    <div class="wp-tools"><button class="btn quiet sm" data-act="browse" ${p.exists ? '' : 'disabled'}>Browse files</button><button class="btn quiet sm" data-act="reveal" ${p.exists ? '' : 'disabled'}>Open folder</button><button class="btn quiet sm" data-act="pin">${pinned ? 'Unpin' : 'Pin to top'}</button></div>`;
  const off = !canLaunch(a) || !p.exists;
  const cxOff = !codexReady() || !p.exists;
  const cxWhy = S.codex && S.codex.installed === false ? 'Install Codex first (Setup)' : 'Sign in to Codex first';
  const claudeBtn = `<button class="btn ${prov === 'codex' ? '' : 'prime'}" data-act="${inApp() ? 'newchat' : 'new'}" ${off ? `disabled title="${esc(a.lockMessage || `Sign in to ${a.name} first`)}"` : `title="As ${esc(a.name)}"`}>New Claude chat</button>`;
  const codexBtn = S.codex && S.codex.enabled ? `<button class="btn ${prov === 'codex' ? 'prime' : 'codexbtn'}" data-act="${inApp() ? 'newcodex' : 'newcodex-term'}" ${cxOff ? `disabled title="${cxWhy}"` : ''}>New Codex chat</button>` : '';
  const tab = (id, label, n) => `<button role="tab" class="wt" id="wt-${id}" data-wtab="${id}" aria-controls="wpBody" aria-selected="${S.worldTab === id}" tabindex="${S.worldTab === id ? 0 : -1}">${label}<span class="count">${n}</span></button>`;
  const barH = `<div class="wtabs" role="tablist" aria-label="${esc(p.name)}">${tab('chats', 'Chats', list.length)}${tab('docs', 'Documents', w ? `${w.docs.length}${w.docs.length >= 200 ? '+' : ''}` : '·')}${tab('gallery', 'Gallery', w ? `${w.images.length}${w.images.length >= 300 ? '+' : ''}` : '·')}</div>
    <div class="wp-act"><button class="btn quiet" data-act="world-prompt" aria-haspopup="menu" aria-expanded="false" ${p.exists ? '' : 'disabled'}><span class="glyph" aria-hidden="true">❡</span>Start with a prompt</button>${prov === 'codex' ? codexBtn + claudeBtn : claudeBtn + codexBtn}<button class="icon" data-act="world-more" aria-haspopup="menu" aria-expanded="false" aria-label="More for this world">${ICON.more}</button></div>`;
  const page = $('page');
  if (page.dataset.worldPage !== p.cwd || !$('wpHero')) {
    page.dataset.worldPage = p.cwd;
    page.innerHTML = `<div id="guardSlot">${prov === 'codex' ? '' : guardHtml()}</div>
      <header class="wp-hero ${hasArt ? 'has-art' : ''}" id="wpHero"></header>
      <div class="wp-sub" id="wpSub"></div>
      <div class="wp-bar" id="wpBar"></div>
      <section class="wp-body" id="wpBody" role="tabpanel"></section>`;
  } else if ($('guardSlot')) { const g = prov === 'codex' ? '' : guardHtml(); if ($('guardSlot')._h !== g) { $('guardSlot').innerHTML = g; $('guardSlot')._h = g; } }
  const put = (id, h) => { const el = $(id); if (el._h !== h) { el.innerHTML = h; el._h = h; } };
  put('wpHero', heroH); $('wpHero').classList.toggle('has-art', hasArt);
  put('wpSub', subH); put('wpBar', barH);
  renderWorldBody();
}
function renderWorldBody() {
  const box = $('wpBody'); if (!box) return;
  const p = S.projects.find(x => x.cwd === S.folder); if (!p) return;
  const w = S.worlds[p.cwd];
  for (const b of document.querySelectorAll('.wtabs [data-wtab]')) { const on = b.dataset.wtab === S.worldTab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  box.setAttribute('aria-labelledby', `wt-${S.worldTab}`);
  const fresh = box.dataset.tab !== S.worldTab;
  box.dataset.tab = S.worldTab;
  const set = h => { if (fresh || box._h !== h) { box.innerHTML = h; box._h = h; } };
  if (S.worldTab === 'chats') {
    const prov = S.prov;
    const nOpenClaw = p.sessions.filter(isOpenClaw).length, nCodex = p.sessions.filter(isCodex).length, nClaude = p.sessions.length - nCodex - nOpenClaw;
    const list = prov ? p.sessions.filter(x => (isCodex(x) ? 'codex' : isOpenClaw(x) ? 'openclaw' : 'claude') === prov) : p.sessions;
    const segList = [['all', 'All', p.sessions.length], ['claude', 'Claude Code', nClaude], ['codex', 'Codex', nCodex], ['openclaw', 'OpenClaw', nOpenClaw]].filter(x => x[2]);
    const seg = segList.length > 1 ? `<div class="seg provseg" role="group" aria-label="Show">${segList.map(([v, l, n]) => `<button class="${(prov || 'all') === v ? 'on' : ''}" data-wprov="${v}" aria-pressed="${(prov || 'all') === v}">${l} <span class="count">${n}</span></button>`).join('')}</div>` : '';
    if (fresh || !$('wbList')) { box.innerHTML = '<div class="wb-top" id="wbTop"></div><div id="wbList"></div>'; box._h = null; }
    if ($('wbTop')._h !== seg) { $('wbTop').innerHTML = seg; $('wbTop')._h = seg; $('wbTop').hidden = !seg; }
    const lb = $('wbList');
    if (!list.length) { lb.innerHTML = `<p class="empty-line">No ${prov === 'codex' ? 'Codex chats' : prov === 'claude' ? 'Claude Code chats' : 'chats'} in this project yet. Start one above, or start with a prompt.</p>`; return; }
    if (!lb.querySelector(':scope > ul.rows')) lb.innerHTML = '<ul class="rows"></ul>';
    return patch(lb.firstElementChild, list, s => s.id, s => rowHtml(s, null));
  }
  if (!w) return set(`<p class="loading">${p.exists ? 'Reading this project’s files…' : 'This folder no longer exists.'}</p>`);
  if (S.worldTab === 'docs') {
    if (!w.docs.length) return set('<p class="empty-line">No markdown documents here yet. Notes, reviews and anything else chats write as markdown show up here, newest first.</p>');
    const t0 = midnight(), week = t0 - 6 * 864e5;
    const groups = [['Today', w.docs.filter(d => d.mtime >= t0)], ['This week', w.docs.filter(d => d.mtime < t0 && d.mtime >= week)], ['Earlier', w.docs.filter(d => d.mtime < week)]].filter(g => g[1].length);
    const row = d => { const dir = d.rel.slice(0, Math.max(0, d.rel.length - d.name.length)).replace(/[\\/]$/, ''); return `<li><button class="doc" data-doc="${esc(d.path)}" data-q="${esc(d.rel.toLowerCase())}"><span class="glyph" aria-hidden="true">❧</span><span class="doc-n">${esc(d.name.replace(/\.(md|markdown|mdx)$/i, ''))}</span><span class="doc-d">${esc(dir || '')}</span><span class="doc-w" data-ago="${d.mtime}">${esc(agoL(d.mtime))}</span></button></li>`; };
    set(`<div class="wb-top"><label class="wb-filter"><span class="sr">Filter documents</span><input type="search" id="docFilter" placeholder="Filter documents" autocomplete="off" spellcheck="false" value="${esc(S.docFilter || '')}"></label><span class="wb-note">${w.docs.length >= 200 ? 'The 200 newest documents' : plural(w.docs.length, 'document')}, newest first</span></div>
      ${groups.map(([g, list]) => `<div class="docgroup"><p class="dg-h">${g}<span class="count">${list.length}</span></p><ul class="docs">${list.map(row).join('')}</ul></div>`).join('')}`);
    return filterDocs();
  }
  if (!w.images.length) return set(`<p class="empty-line">No pictures here yet. Cover art, screenshots and anything Codex makes in this folder show up here.${codexReady() && coverPrompt() ? ` <button class="linkish" data-prompt="${esc(coverPrompt().id)}">Make a cover image with Codex</button>` : ''}</p>`);
  set(`<div class="wb-top"><span class="wb-note">${w.images.length >= 300 ? 'The 300 newest pictures' : plural(w.images.length, 'picture')}, newest first. Pick one as this project’s banner.</span>${w.bannerPicked ? '<button class="btn quiet sm" data-banner="-">Use the automatic banner</button>' : ''}</div>
    <ul class="gallery">${w.images.map((im, i) => `<li class="gi ${im.path === w.banner ? 'is-banner' : ''}" style="--i:${Math.min(i, 24)}"><button class="gi-img" data-img="${esc(im.path)}" aria-label="Open ${esc(im.name)}"><img src="${esc(imageSrc(im.path, p.cwd))}" alt="" loading="lazy" decoding="async"></button>
      <div class="gi-cap"><span class="gi-n" title="${esc(im.rel)}">${esc(im.name)}</span><span class="gi-w" data-ago="${im.mtime}">${esc(agoL(im.mtime))}</span></div>
      ${im.path === w.banner ? '<span class="gi-flag">Banner</span>' : `<button class="gi-use btn sm" data-banner="${esc(im.path)}">Use as banner</button>`}</li>`).join('')}</ul>`);
}
function filterDocs() {
  const q = (S.docFilter || '').trim().toLowerCase();
  for (const g of document.querySelectorAll('#wpBody .docgroup')) {
    let n = 0;
    for (const b of g.querySelectorAll('.doc')) { const hit = !q || b.dataset.q.includes(q); b.parentElement.hidden = !hit; n += hit; }
    g.hidden = !n;
  }
}
function worldMenu(anchor) {
  const a = current(), p = S.projects.find(x => x.cwd === S.folder); if (!p) return;
  showMenu(anchor, [
    { label: inApp() ? 'New Claude chat in a terminal' : 'New Claude chat in the window', hint: `as ${a.name}`, disabled: !canLaunch(a) || !p.exists, run: () => (inApp() ? wrap(async () => reportLaunch(await api('/api/new', { account: a.id, cwd: p.cwd }), `Starting a new chat as ${a.name}`))() : ChatUI.open({ cwd: p.cwd, mode: 'new' })) },
    ...(S.codex && S.codex.enabled ? [{ label: inApp() ? 'New Codex chat in a terminal' : 'New Codex chat in the window', disabled: !codexReady() || !p.exists, run: () => (inApp() ? wrap(async () => reportLaunch(await api('/api/new', { provider: 'codex', cwd: p.cwd }), 'Starting a new Codex chat'))() : ChatUI.open({ cwd: p.cwd, mode: 'new', provider: 'codex' })) }] : []),
    '-',
    { label: 'Look for new files', hint: 'documents and pictures', disabled: !p.exists, run: async () => { await loadWorld(p.cwd, true); renderFolder(); toast('Up to date.', 1500); } },
    { label: 'Edit prompts…', run: openPromptEditor },
    ...(p.added && !p.sessions.length ? ['-', { label: 'Remove from the list', hint: 'the folder itself stays', danger: true, run: async () => { await api('/api/project/forget', { cwd: p.cwd }); await loadSessions(); go('hub'); toast(`Removed ${p.name} from the list. Its folder is still there.`, 4000); } }] : []),
  ]);
}
function renderSearch() {
  const h = S.hits;
  const rows = h ? h.hits.map(x => { const [s, p] = sessionById(x.id); return s ? rowHtml(s, p.name, x) : ''; }).join('') : '';
  const pr = h && h.progress;
  $('page').innerHTML = `<header class="f-head"><div><p class="eyebrow">❝ Search</p><h1>“${esc(S.q)}”</h1><p class="f-meta">${h ? (h.hits.length === 1 ? 'One chat mentions it.' : `${nword(h.hits.length)} chats mention it.`) : 'Searching…'}</p></div>
      <div class="f-act"><button class="btn" data-act="search-again">Search again</button><button class="btn quiet" data-view="hub">Back to the hub</button></div></header>
    ${pr && !pr.ready ? `<p class="progress">Still reading chats (${pr.done} of ${pr.total}); results may grow.</p>` : ''}
    ${rows ? `<ul class="rows sec-gap">${rows}</ul>` : h ? '<p class="empty-line">Nothing matches. Search looks inside every message you and Claude wrote, plus titles and folder names.</p>' : ''}`;
}
function renderPage() {
  if (S.view === 'hub') renderHub();
  else if (S.view === 'recent') renderRecent();
  else if (S.view === 'folder') renderFolder();
  else if (S.view === 'search') renderSearch();
}
function renderAll() { renderNav(); renderPage(); renderBar(); updateTitle(); }
// Names the chat window uses.
const renderSide = () => renderNav();
const renderMain = () => renderPage();
function go(view, folder, prov) {
  const from = S.view === 'folder' && !(window.ChatUI && ChatUI.isOpen()) ? S.folder : null;
  if (view === 'folder' && folder !== undefined && folder !== S.folder) S.worldTab = 'chats';
  // The state changes now; the page redraws inside the transition.
  S.view = view; if (folder !== undefined) S.folder = folder;
  if (view === 'folder') S.prov = prov === 'claude' || prov === 'codex' ? prov : null;
  const run = () => {
    document.body.classList.remove('nav-open');
    if (window.ChatUI && ChatUI.isOpen()) ChatUI.close(true);
    renderNav(); renderPage(); window.scrollTo({ top: 0 });
    // Coming back from a project: its banner settles back into its card.
    if (view === 'hub' && from && motionOk()) {
      const art = document.querySelector(`#atlas > [data-k="${CSS.escape(from)}"] .w-art`);
      const r = art && art.getBoundingClientRect();
      if (r && r.top < innerHeight && r.bottom > 0) art.style.viewTransitionName = 'world-banner';
    }
  };
  const t = transition(run);
  return t ? t.updateCallbackDone.catch(() => {}) : Promise.resolve();
}
// Go to the hub, then bring one of its sections into view.
const hubTo = id => (S.view !== 'hub' || (window.ChatUI && ChatUI.isOpen()) ? go('hub') : Promise.resolve()).then(() => setTimeout(() => $(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30));

/* ---------- clocks ---------- */
function tick() {
  if (document.hidden) return;
  const now = Date.now();
  const set = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  for (const el of document.querySelectorAll('[data-since]')) { const t = +el.dataset.since; set(el, t ? dur(now - t, true) : ''); }
  for (const el of document.querySelectorAll('[data-ago]')) { const t = +el.dataset.ago; if (t) set(el, agoL(t)); }
  for (const el of document.querySelectorAll('[data-until]')) { const t = +el.dataset.until; set(el, t > now ? `in ${dur(t - now)}` : 'any moment'); }
  for (const el of document.querySelectorAll('[data-clock]')) set(el, clock(now));
}
setInterval(tick, 1000);

/* ---------- drawer ---------- */
let drawerSeq = 0;
async function openDrawer(id, quiet) {
  const [ods] = sessionById(id);
  if (ods && isOpenClaw(ods)) return ChatUI.openOc({ id: ods.id, sessionId: ods.sessionId, title: ods.title, agent: ods.agent, cwd: ods.cwd, folder: sessionById(id)[1] ? sessionById(id)[1].name : null });
  const seq = ++drawerSeq;
  const d = $('drawer');
  S.drawerId = id;
  if (!quiet) { d.innerHTML = '<div class="d-body"><p class="loading">Reading the chat…</p></div>'; d.hidden = false; }
  document.querySelectorAll('.row').forEach(el => el.classList.toggle('current', el.dataset.row === id));
  let p;
  try { p = await api(`/api/session?id=${encodeURIComponent(id)}`); }
  catch (err) { if (seq === drawerSeq) d.innerHTML = `<div class="d-body"><p class="loading">${esc(err.message)}</p></div>`; return; }
  if (seq !== drawerSeq || S.drawerId !== id) return;
  const s = p.session, st = p.stats, a = current();
  const scroller = d.querySelector('.d-body'); const keep = quiet && scroller ? scroller.scrollTop : null;
  const opened = s.lastOpened ? `Last opened from here as <b>${esc(s.lastOpened.accountName)}</b>, ${esc(agoL(s.lastOpened.at))}${s.lastOpened.mode === 'fork' ? ' (as a copy)' : s.lastOpened.mode === 'desktop' ? ' (in the desktop app)' : ''}.` : 'Not opened from Session Switcher yet.';
  const stat = (k, v) => (v ? `<div><dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>` : '');
  const live = liveOf(s.id);
  d.innerHTML = `
    <div class="d-top">
      <div class="d-head">
        <div><p class="eyebrow">${esc(s.folder)}${live ? ' · open in the chat window' : p.running ? ' · open in a terminal' : ''}</p><h2 class="d-title">${esc(s.title)}</h2></div>
        <button class="icon" data-dclose aria-label="Close details">✕</button>
      </div>
      <div class="d-actions">
        ${live ? `<button class="btn prime" data-chat="${esc(s.id)}">Return to this chat</button>` : p.running ? `<button class="btn prime" data-watch="${esc(s.id)}">Watch it live</button>` : `
        <button class="btn ${inApp() ? 'prime' : ''}" data-chat="${esc(s.id)}" ${canLaunch(a) && s.folderExists ? '' : 'disabled'}>Open as ${esc(a.name)}</button>
        <button class="btn ${inApp() ? '' : 'prime'}" data-open="${esc(s.id)}" ${canLaunch(a) && s.folderExists ? '' : 'disabled'}>Resume in a terminal</button>`}
        <button class="icon" data-more="${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions">${ICON.more}</button>
      </div>
    </div>
    <div class="d-body">
      <dl class="d-stats">
        ${stat('Messages', `${st.prompts} from you, ${st.replies} from Claude`)}
        ${stat('Tool calls', st.tools ? String(st.tools) : '')}
        ${stat('Started', st.first ? stamp(Date.parse(st.first)) : '')}
        ${stat('Last activity', stamp(s.updated))}
        ${stat('Branch', s.branch)}
        ${stat('Model', st.models.length ? (window.ChatUI && ChatUI.modelName ? ChatUI.modelName(st.models[st.models.length - 1]) : st.models[st.models.length - 1]) : '')}
        ${stat('Claude Code', st.version)}
        ${stat('Size', s.sizeKB >= 1024 ? `${(s.sizeKB / 1024).toFixed(1)} MB` : `${s.sizeKB} KB`)}
      </dl>
      <p class="d-opened">${opened}</p>
      <p class="d-h">Latest messages</p>
      ${p.messages.length ? `<ol class="msgs">${p.messages.map(m => `<li class="msg ${m.role}"><span class="who">${m.role === 'you' ? 'You' : 'Claude'}${m.at ? `, ${esc(stamp(Date.parse(m.at)))}` : ''}</span>${m.role === 'you' ? esc(m.text) : `<div class="md">${ChatUI.md(m.text)}</div>`}</li>`).join('')}</ol>` : '<p class="loading">No messages to show.</p>'}
    </div>`;
  const body = d.querySelector('.d-body');
  body.scrollTop = keep !== null ? keep : body.scrollHeight;
  if (!quiet) d.focus();
}
function closeDrawer() {
  $('drawer').hidden = true; S.drawerId = null; drawerSeq++;
  document.querySelectorAll('.row.current').forEach(el => el.classList.remove('current'));
}

/* ---------- menus ---------- */
let menuAnchor = null, menuReturn = null;
// anchor: the button it belongs to, or { x, y } for a right-click menu at the pointer.
function showMenu(anchor, items) {
  const m = $('menu');
  closeMenu();
  items = items.filter((it, i, all) => it !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
  // Labels line up whether or not an item has an icon.
  const glyphs = items.some(it => it !== '-' && it.glyph);
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button role="${it.checked !== undefined ? 'menuitemradio' : 'menuitem'}" ${it.checked !== undefined ? `aria-checked="${!!it.checked}"` : ''} data-i="${i}" ${it.disabled ? `disabled title="${esc(it.why || '')}"` : ''} class="${it.danger ? 'danger' : ''} ${it.html ? 'm-acct' : ''}">${it.html || `${it.glyph || glyphs ? `<span class="m-g" aria-hidden="true">${esc(it.glyph || '')}</span>` : ''}<span class="m-l">${esc(it.label)}${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</span>${it.keys ? `<kbd class="m-k">${esc(it.keys)}</kbd>` : ''}`}</button>`)).join('');
  menuReturn = document.activeElement;
  $('menuBack').hidden = false;
  m.hidden = false;
  placeAt(m, anchor);
  m.classList.remove('pop'); void m.offsetWidth; m.classList.add('pop');
  menuAnchor = anchor instanceof Element ? anchor : null;
  if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'true');
  m.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return; const it = items[+b.dataset.i]; closeMenu(true); wrap(it.run)(); };
  m.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
// Puts a popup under (or above) its anchor. Works in screen pixels, then divides by the interface
// size, since the page is scaled by it.
const uiScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--look-ui')) || 1;
function placeAt(m, anchor, align = 'start') {
  const z = uiScale();
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const W = window.innerWidth, H = window.innerHeight;
  const w = m.offsetWidth * z, h = m.offsetHeight * z;
  let left = align === 'end' || r.left + w > W - 8 ? r.right - w : r.left;
  left = Math.max(8, Math.min(W - w - 8, left));
  const up = r.bottom + h + 8 > H;
  const top = up ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  m.style.left = `${left / z}px`; m.style.top = `${top / z}px`;
  // Grows out of the point it was opened from.
  m.style.transformOrigin = `${Math.max(0, Math.min(w, r.left - left)) / z}px ${up ? '100%' : '0'}`;
}
function closeMenu(refocus) {
  const m = $('menu'); if (m.hidden) return;
  m.hidden = true;
  $('menuBack').hidden = true;
  if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
  if (refocus) {
    const back = menuAnchor && document.contains(menuAnchor) ? menuAnchor : menuReturn && document.contains(menuReturn) ? menuReturn : null;
    if (back && back.focus) back.focus({ preventScroll: true });
  }
  menuAnchor = null; menuReturn = null;
}
$('menu').addEventListener('keydown', e => {
  const btns = [...$('menu').querySelectorAll('button:not(:disabled)')];
  const i = btns.indexOf(document.activeElement);
  const go = j => { btns[(j + btns.length) % btns.length]?.focus({ preventScroll: true }); e.preventDefault(); };
  if (e.key === 'ArrowDown') return go(i + 1);
  if (e.key === 'ArrowUp') return go(i - 1);
  if (e.key === 'Home') return go(0);
  if (e.key === 'End') return go(btns.length - 1);
  if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(true); e.preventDefault(); return undefined; }
  // Type a letter to jump to the next item that starts with it.
  if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    const label = b => (b.querySelector('.m-l') || b).textContent.trim().toLowerCase();
    const next = [...btns.slice(i + 1), ...btns.slice(0, i + 1)].find(b => label(b).startsWith(k));
    if (next) { next.focus({ preventScroll: true }); e.preventDefault(); }
  }
  return undefined;
});
// The pointer and the keyboard highlight the same row.
$('menu').addEventListener('pointermove', e => { const b = e.target.closest('button:not(:disabled)'); if (b && document.activeElement !== b) b.focus({ preventScroll: true }); });
// Outside the menu: a click or tap closes it (and isn't passed to what's underneath); a right-click
// opens the right menu there instead; the wheel closes it.
// (Closing on the whole click, not the press, so the release can't land on what's underneath.)
$('menuBack').addEventListener('pointerdown', e => e.preventDefault());
$('menuBack').addEventListener('click', e => {
  e.preventDefault(); e.stopPropagation();
  const was = menuAnchor;
  closeMenu();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const other = el && el.closest && el.closest('[aria-haspopup]');
  if (other && other !== was && !other.closest('#menu')) other.click();
});
$('menuBack').addEventListener('contextmenu', e => {
  e.preventDefault();
  closeMenu();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey }));
});
$('menuBack').addEventListener('wheel', () => closeMenu(), { passive: true });
$('menu').addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('menu').hidden && !$('menu').contains(document.activeElement)) { closeMenu(true); e.stopPropagation(); } }, true);
window.addEventListener('resize', () => closeMenu());
window.addEventListener('blur', () => closeMenu());
document.addEventListener('scroll', e => { if (!$('menu').hidden && !(e.target instanceof Element && $('menu').contains(e.target))) closeMenu(); }, true);

function codexChatItems(s) {
  const ok = codexReady(), why = 'Sign in to Codex first';
  const live = liveOf(s.id);
  return [
    live ? { label: 'Return to this chat', run: () => ChatUI.open({ sessionId: s.id }) } : { label: 'Open in the chat window', hint: 'Codex', disabled: !ok, why, run: () => ChatUI.open({ sessionId: s.id }) },
    { label: 'Resume in a terminal', hint: 'codex resume', disabled: !ok || !!live, why: live ? 'It’s open in the chat window' : why, run: () => resume(s.id, 'resume') },
    { label: 'Open a copy in the chat window', hint: 'keeps the original', disabled: !ok, why, run: () => ChatUI.open({ sessionId: s.id, mode: 'fork' }) },
    { label: 'Resume a copy in a terminal', hint: 'codex fork', disabled: !ok, why, run: () => resume(s.id, 'fork') },
    '-',
    { label: 'Show details and messages', run: () => openDrawer(s.id) },
    { label: 'Browse this chat’s folder', run: () => Viewer.open({ path: '.', session: s.id }) },
    { label: 'Rename chat', run: () => renameChat(s.id) },
    { label: 'Copy terminal command', run: () => copyCommand(s.id) },
  ];
}
function codexChatMenu(anchor, s) { const items = codexChatItems(s); if (items && items.length) showMenu(anchor, [...items, '-', favItem(s.id)]); }
function chatItems(id) {
  const [s] = sessionById(id); if (!s) return [];
  if (isCodex(s)) return codexChatItems(s);
  if (isOpenClaw(s)) { const [, ocp2] = sessionById(id); return [
    { label: 'View this session here', hint: 'read-only transcript', run: () => ChatUI.openOc({ id: s.id, sessionId: s.sessionId, title: s.title, agent: s.agent, cwd: s.cwd, folder: ocp2 ? ocp2.name : null }) },
    '-',
  ]; }
  const a = current(); const ok = canLaunch(a);
  const why = !a.signedIn ? `Sign in to ${a.name} first` : (a.lockMessage || '');
  const live = liveOf(id), run = isRunning(id);
  const watchIt = { label: 'Watch it live here', hint: 'read-only while it runs in its terminal', run: () => ChatUI.watch({ sessionId: id, source: 'terminal' }) };
  return [
    ...(run && !live ? [watchIt] : []),
    live ? { label: 'Return to this chat', run: () => ChatUI.open({ sessionId: id }) }
      : { label: `Open in the chat window as ${a.name}`, hint: run ? 'it’s also open in a terminal' : '', disabled: !ok, why, run: () => ChatUI.open({ sessionId: id }) },
    { label: `Resume in a terminal as ${a.name}`, disabled: !ok || !!live, why: live ? 'It’s open in the chat window' : why, run: () => resume(id, 'resume') },
    { label: 'Open a copy in the chat window', hint: 'keeps the original', disabled: !ok, why, run: () => ChatUI.open({ sessionId: id, mode: 'fork' }) },
    { label: 'Resume a copy in a terminal', hint: 'keeps the original', disabled: !ok, why, run: () => resume(id, 'fork') },
    { label: 'Open in the desktop app', run: () => resume(id, 'desktop') },
    '-',
    { label: 'Show details and messages', run: () => openDrawer(id) },
    { label: 'Browse this chat’s folder', run: () => Viewer.open({ path: '.', session: id }) },
    { label: 'Rename chat', run: () => renameChat(id) },
    { label: 'Copy terminal command', run: () => copyCommand(id) },
    { label: 'Show transcript file', run: async () => { const r = await api('/api/reveal', { sessionId: id }); if (r.dryRun) toast(`Would run: ${r.script}`); } },
  ];
}
function chatMenu(anchor, id) { const items = chatItems(id); if (items && items.length) showMenu(anchor, [...items, '-', favItem(id)]); }
const favItem = id => ({ glyph: isFav(id) ? '☆' : '★', label: isFav(id) ? 'Unpin from the sidebar' : 'Pin to the sidebar', run: () => toggleFav(id) });

function sealMenu(anchor) {
  showMenu(anchor, [
    ...S.accounts.map(a => {
      const b = binding(usageOf(a.id));
      return {
        checked: a.id === S.acct,
        html: `${miniDial(a.id, 28)}<span class="m-t"><b>${esc(a.name)}</b><small>${esc(a.signedIn ? `${a.email || 'Signed in'}${a.plan ? `, ${a.plan}` : ''}` : 'Not signed in')}</small></span><span class="m-u">${b ? `${b.left}%` : ''}</span>`,
        run: () => useAccount(a.id),
      };
    }),
    '-',
    { label: 'Add an account', run: addAccount },
    { label: `Open claude.ai as ${current().name}`, hint: 'regular Claude chats, in its own window', run: () => openWeb(current().id) },
    { label: 'Accounts and usage', hint: 'on the hub', run: () => hubTo('secAccounts') },
  ]);
}

function accountItems(id) {
  const a = S.accounts.find(x => x.id === id) || current();
  return [
    { label: `Open claude.ai as ${a.name}`, hint: 'regular Claude chats, in its own window', run: () => openWeb(a.id) },
    '-',
    { label: 'Check sign-in now', run: async () => { await api('/api/accounts/verify', { account: a.id }); await reload(); toast(`Checked ${a.name} with Claude Code.`); } },
    { label: 'Check usage now', disabled: !a.signedIn, run: () => refreshUsage(a.id) },
    ...((a.pinnedOrg || a.expectEmail) ? [{ label: 'Unlock', hint: 'let it open chats on any account or plan', run: () => accountAction('unlock', a.id) }] : []),
    { label: 'Rename', run: () => accountAction('rename', a.id) },
    { label: 'Sign out', disabled: !a.signedIn, run: () => accountAction('signout', a.id) },
    ...(a.isDefault ? [] : ['-', { label: 'Remove from list', danger: true, run: () => accountAction('remove', a.id) }]),
  ];
}
function accountMenu(anchor, id) { const items = accountItems(id); if (items && items.length) showMenu(anchor, items); }

/* ---------- actions ---------- */
function reportLaunch(r, msg) {
  if (r.dryRun) toast(`Would open a ${r.how}:\n${r.script}`, 12000);
  else toast(`${msg}${r.how ? ` in a ${r.how}` : ''}.${r.note ? `\n${r.note}` : ''}`, r.note ? 9000 : 5000);
}
// Regular claude.ai chats, in a window that keeps this account's own web sign-in.
async function openWeb(id) {
  const a = acctById(id) || current();
  const r = await api('/api/web', { account: a.id });
  if (r.dryRun) return toast(`Would open: ${r.script}`, 9000);
  const seen = store(`web:${a.id}`);
  store(`web:${a.id}`, '1');
  const site = id === 'codex' ? 'chatgpt.com' : 'claude.ai';
  return toast(seen ? `Opened ${site}${id === 'codex' ? '' : ` as ${a.name}`}.` : `Opened ${site} in its own window. The first time, sign in there${a.email ? ` as ${a.email}` : ''}; it stays signed in after that, separately from your other accounts.`, seen ? 2500 : 12000);
}
function useAccount(id) {
  S.acct = id; store('acct', id);
  renderAll(); if (S.drawerId) openDrawer(S.drawerId, true);
  const a = current(); toast(`New chats open as ${a.name}.`, 2500);
}
async function refreshUsage(id) {
  if (id) { S.usage[id] = { ...(S.usage[id] || {}), checking: true }; renderLive(); }
  const r = await api('/api/usage/refresh', id ? { account: id } : {});
  S.usage = r.usage || S.usage; renderLive();
}
async function resume(id, mode = 'resume', force = false) {
  const a = current();
  const [s, ocp] = sessionById(id);
  if (s && isOpenClaw(s)) return ChatUI.openOc({ id: s.id, sessionId: s.sessionId, title: s.title, agent: s.agent, cwd: s.cwd, folder: ocp ? ocp.name : null });
  if (mode === 'resume' && !force && s && s.active && !isRunning(id) &&
      !(await appConfirm('This chat changed in the last few minutes, so it may still be open somewhere, like the desktop app. Opening it twice can mix up its history.\n\nResume anyway?', { ok: 'Resume anyway' }))) return;
  try {
    if (isCodex(s)) { const r = await api('/api/open', { provider: 'codex', sessionId: id, mode }); return reportLaunch(r, mode === 'fork' ? 'Opening a copy in Codex' : 'Resuming in Codex'); }
    const r = await api('/api/open', { account: a.id, sessionId: id, mode, force });
    reportLaunch(r, mode === 'desktop' ? 'Opening in the desktop app' : mode === 'fork' ? `Opening a copy as ${a.name}` : `Resuming as ${a.name}`);
  } catch (err) {
    if (err.reason === 'running' && await appConfirm(`${err.message}\n\nOpen it anyway?`, { ok: 'Open anyway' })) return resume(id, mode, true);
    throw err;
  }
}
async function renameChat(id) {
  const [s] = sessionById(id); if (!s) return;
  const name = await ask('Rename chat', 'Only changes the name shown here. Leave it empty to go back to the original title.', s.title, 'Rename', { maxLength: 120, allowEmpty: true });
  if (name === null) return;
  await api('/api/chat/rename', { sessionId: id, name });
  await loadSessions(); renderPage(); if (S.drawerId === id) openDrawer(id, true);
}
async function copyCommand(id) {
  const r = await api('/api/command', { account: S.acct, sessionId: id });
  try { await navigator.clipboard.writeText(r.command); toast(`Copied a PowerShell command that resumes this chat${isCodex(sessionById(id)[0]) ? ' in Codex' : ''}.`); }
  catch { prompt('Copy this command:', r.command); }
}
async function accountAction(act, id) {
  if (codexAcct(id)) { if (act === 'usage') return refreshUsage(id); if (act === 'web') return openWeb(id); return undefined; }
  const a = S.accounts.find(x => x.id === id) || current();
  if (act === 'use') return useAccount(a.id);
  if (act === 'web') return openWeb(a.id);
  if (act === 'usage') return refreshUsage(a.id);
  if (act === 'signin' || act === 'signin-direct') {
    let email = a.expectEmail;
    if (act === 'signin' || !email) {
      email = await ask(`Sign in to ${a.name}`,
        'Which Claude account should this profile use? A terminal opens with this email filled in, then you finish in your browser. Tip: if your browser is already signed in to a different Claude account, copy the sign-in link into a private window.',
        a.expectEmail || a.email || '', 'Open sign-in', { type: 'email', maxLength: 120, placeholder: 'name@example.com' });
      if (!email) return;
    }
    const r = await api('/api/signin', { account: a.id, email });
    if (r.dryRun) { reportLaunch(r); return reload(); }
    const org = a.pinnedOrg && a.pinnedOrg.email && a.pinnedOrg.email.toLowerCase() === String(email).toLowerCase() ? a.pinnedOrg.name : 'the one whose plan this account should use';
    toast(`Signing ${a.name} in as ${email} in a ${r.how}. Finish in your browser; if it asks which organization to use, choose ${org}. This page picks up the new sign-in by itself.`, 14000);
    return reload();
  }
  if (act === 'lock') {
    const r = await api('/api/accounts/lock', { account: a.id, lock: true });
    await reload(); return toast(`${a.name} is locked to ${r.account.expectEmail}, ${r.account.pinnedOrg.name}. Chats won’t open on any other account or plan.`);
  }
  if (act === 'unlock') {
    if (!(await appConfirm(`Unlock ${a.name}?\n\nChats will open with it no matter which account or plan it’s signed into.`, { ok: 'Unlock' }))) return;
    await api('/api/accounts/lock', { account: a.id, lock: false }); await reload(); return toast(`${a.name} is unlocked.`);
  }
  if (act === 'rename') {
    const name = await ask('Rename account', 'Shown on its card. It doesn’t change anything on your Claude account.', a.name, 'Rename');
    if (name && name !== a.name) { await api('/api/accounts/rename', { account: a.id, name }); await reload(); }
    return;
  }
  if (act === 'signout') {
    if (!(await appConfirm(`Sign ${a.name} out of ${a.email || 'its account'}?\n\nYour chats aren’t affected. You can sign in again any time.`, { ok: 'Sign out', danger: true }))) return;
    await api('/api/signout', { account: a.id }); await reload(); return toast(`${a.name} is signed out.`);
  }
  if (act === 'remove') {
    if (!(await appConfirm(`Remove “${a.name}” from the switcher?\n\nIts sign-in folder stays on disk at ${a.configDir}, and your chats aren’t touched. Adding an account with the same name later brings its sign-in back.`, { ok: 'Remove', danger: true }))) return;
    await api('/api/accounts/remove', { account: a.id }); if (S.acct === a.id) S.acct = null; await reload(); toast(`Removed ${a.name}.`);
  }
}
function ask(title, text, value, okLabel, opts = {}) {
  return new Promise(resolve => {
    const d = $('dlg'), inp = $('dlgInput');
    $('dlgTitle').textContent = title; $('dlgText').textContent = text; $('dlgOk').textContent = okLabel;
    inp.type = opts.type || 'text'; inp.maxLength = opts.maxLength || 40; inp.placeholder = opts.placeholder || '';
    inp.required = !opts.allowEmpty;
    inp.value = value || '';
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? inp.value.trim() : null);
    d.showModal(); inp.select();
  });
}
async function addAccount() {
  const name = await ask('Add a Claude account', 'For another Claude login. Chats, checkpoints, saved notes, skills and settings stay shared, so every account sees the same list. (Codex and ChatGPT have their own card; you don’t add them here.)', '', 'Add account');
  if (!name) return;
  if (/codex|chat\s*gpt|openai|\bgpt\b/i.test(name) && S.codex && S.codex.enabled) {
    if (!(await appConfirm(`“${name}” sounds like Codex.\n\nCodex signs in with your ChatGPT account on its own card, under Accounts and usage.`, { ok: 'Sign in to Codex instead', cancel: `Add “${name}” as a Claude account` }))) { /* add as Claude account */ }
    else return codexSignIn();
  }
  const r = await api('/api/accounts', { name });
  S.acct = r.account.id; store('acct', S.acct);
  await reload();
  await accountAction('signin', r.account.id);
}

/* ---------- setup ---------- */
async function loadHealth(showIn) {
  const j = await api('/api/health');
  const worst = j.checks.some(c => c.state === 'error') ? 'error' : j.checks.some(c => c.state === 'warn') ? 'warn' : 'ok';
  $('hdot').className = `hdot ${worst}`;
  $('setupBtn').title = worst === 'ok' ? 'Setup: everything looks good' : 'Setup: something needs attention';
  if (showIn) renderSetup(j);
  return j;
}
function renderSetup(j) {
  const p = j.prefs;
  const t = (k, label, text, local) => `<label class="toggle"><input type="checkbox" ${local ? `data-local="${k}"` : `data-pref="${k}"`} ${(local ? Local[k] : p[k]) ? 'checked' : ''}><span><b>${label}</b><span>${text}</span></span></label>`;
  $('setupBody').innerHTML = `
    <nav class="setup-toc" aria-label="Sections"><a href="#st-health">Health</a><a href="#st-alerts">Alerts</a><a href="#st-prefs">Preferences</a><a href="#st-codex">Codex</a><a href="#st-phone">Phone</a><a href="#st-app">App</a></nav>
    <ul class="checks" id="st-health">${j.checks.map(c => `<li class="check ${c.state}"><span class="st" aria-label="${c.state}"></span><span><b>${esc(c.label)}</b><span class="dt">${esc(c.detail)}</span></span>
      ${c.fix ? `<button class="btn sm" data-fix="${esc(c.fix.action)}" data-account="${esc(c.fix.account || '')}">${esc(c.fix.label)}</button>` : '<span></span>'}</li>`).join('')}</ul>
    <p class="d-h" id="st-alerts">Alerts and looks</p>
    <div class="prefs">
      ${t('sound', 'Chime when a chat needs you or replies', 'A soft bell. It doesn’t play for the chat you’re looking at.', true)}
      ${t('notify', 'Desktop notifications', `Shows a ${S.platform === 'darwin' ? 'macOS' : 'Windows'} notification when a chat needs you or replies while this window is in the background.`, true)}
      ${t('petals', 'Drifting petals', 'A few slow petals behind the hub. Turned off automatically if Windows is set to reduce motion.', true)}
      ${t('motion', 'Animations', 'World banners that open into their pages, cards that rise in, dials that draw themselves. Turned off automatically if Windows is set to reduce motion.', true)}
    </div>
    <p class="d-h" id="st-prefs">Preferences</p>
    <div class="prefs">
      <div class="field"><label for="prefOpenIn">When you click Open on a chat</label>
        <select id="prefOpenIn" data-pref="openIn">
          <option value="app" ${p.openIn !== 'terminal' ? 'selected' : ''}>Open it in Session Switcher’s chat window</option>
          <option value="terminal" ${p.openIn === 'terminal' ? 'selected' : ''}>Resume it in a terminal</option>
        </select></div>
      <div class="field"><label for="prefTerminal">Terminal chats open in</label>
        <select id="prefTerminal" data-pref="terminal">
          ${(S.platform === 'darwin' ? [['auto', 'Terminal'], ['iterm', 'iTerm']] : [['auto', 'Windows Terminal tab when available, otherwise a console window'], ['wt-tab', 'Windows Terminal, new tab'], ['wt-window', 'Windows Terminal, new window'], ['console', 'Classic console window']]).map(([v, l]) => `<option value="${v}" ${p.terminal === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      ${t('syncSettings', 'Keep extra accounts’ settings in step', 'Copies your main settings.json, CLAUDE.md and keybindings to extra accounts whenever the main copy is newer.')}
      ${t('syncState', 'Carry over MCP servers and folder trust', 'Before a chat opens with an extra account, adds any MCP servers, approved tools and trusted folders from your main account that it doesn’t have yet.')}
      ${t('cleanEnv', 'Use only account sign-ins', 'Ignores ANTHROPIC_API_KEY and similar settings on this PC, so the account you pick is always the one used.')}
      ${t('appWindow', 'Open as its own window', `Uses ${S.platform === 'darwin' ? 'Chrome (or Edge or Brave)' : 'Chrome or Edge'} to show Session Switcher without browser tabs or an address bar.`)}
      <div class="field"><label for="prefClaude">Claude Code command</label>
        <div class="row2"><input id="prefClaude" value="${esc(j.claudeCommand)}" spellcheck="false"><button class="btn" id="saveClaude">Save</button></div>
        <small>Leave as “claude” unless Setup can’t find Claude Code; then paste the full path to ${S.platform === 'darwin' ? 'claude (try <code>which claude</code> in Terminal)' : 'claude.exe'}.</small></div>
    </div>
    <p class="d-h" id="st-codex">Codex</p>
    <div class="prefs">
      <label class="toggle"><input type="checkbox" data-codex="enabled" ${j.codex && j.codex.enabled ? 'checked' : ''}><span><b>Use Codex too</b><span>Shows your Codex (OpenAI) chats next to Claude’s, with its own sign-in and usage.</span></span></label>
      <div class="field"><label for="prefCodex">Codex command</label>
        <div class="row2"><input id="prefCodex" value="${esc(j.codex ? j.codex.command : 'codex')}" spellcheck="false"><button class="btn" id="saveCodex">Save</button></div>
        <small>Leave as “codex” unless Setup can’t find it; then paste the full path to codex.cmd.</small></div>
    </div>
    ${window.REMOTE ? `<p class="d-h" id="st-phone">This phone</p><div class="prefs"><p class="ph-note">You’re using Session Switcher on your PC from this phone.</p>
      ${window.Android ? '<button class="btn" data-fix="phone-disconnect">Disconnect this phone</button>' : ''}</div>` : `<p class="d-h" id="st-phone">Phone access</p><div class="prefs" id="phoneBox"><p class="loading">Checking…</p></div>`}
    <p class="d-h" id="st-app">App</p>
    <div class="app-actions">
      <button class="btn" data-fix="shortcut">${S.platform === 'darwin' ? 'Add to Applications' : 'Create desktop shortcut'}</button>
      <button class="btn" data-fix="share-copy" title="A zip of the app for someone else, without your accounts, chats or settings">Make a copy to share</button>
      <button class="btn" data-fix="update-claude">Update Claude Code</button>
      <button class="btn danger" data-fix="quit">Quit Session Switcher</button>
    </div>
    <p class="ver">Session Switcher ${esc(j.appVersion)}. Your chats are read from your own .claude folder and never leave this PC.</p>`;
}
/* ---------- phone access: use this PC's Session Switcher from the Android app ---------- */
let phoneTimer = null;
async function loadPhone() {
  if (window.REMOTE || !$('phoneBox')) return;
  try { renderPhone(await api('/api/phone')); } catch (err) { $('phoneBox').innerHTML = `<p class="loading">${esc(err.message)}</p>`; }
}
function renderPhone(st) {
  const box = $('phoneBox'); if (!box) return;
  clearInterval(phoneTimer);
  const host = a => `${a.address}:${st.port}`;
  const lan = st.addresses.filter(a => !a.tailscale), ts = st.addresses.filter(a => a.tailscale);
  const left = st.pairing ? Math.max(0, Math.round((st.pairing.expiresAt - Date.now()) / 1000)) : 0;
  box.innerHTML = `
    <label class="toggle"><input type="checkbox" data-phone="enabled" ${st.enabled ? 'checked' : ''}><span><b>Let my phone use Session Switcher</b><span>Your phone (iPhone or Android) can see your chats, answer Claude and Codex, approve steps and switch models, over your Wi-Fi. Only phones you pair can connect. ${st.error ? `<b class="warn">${esc(st.error)}</b>` : ''}</span></span></label>
    ${st.enabled ? `
    <div class="ph-grid">
      <div class="ph-step"><span class="ph-n">1</span><div><b>Get the app</b><p><b>iPhone:</b> in Safari, open <code>http://${esc(lan[0] ? host(lan[0]) : `this-pc:${st.port}`)}/</code>, tap Share → <b>Add to Home Screen</b>, then open it from the Home Screen.<br><b>Android:</b> ${st.apk ? `open <code>http://${esc(lan[0] ? host(lan[0]) : `this-pc:${st.port}`)}/get</code> and install it.` : 'build it first with <code>mobile/android/build.cmd</code>.'}</p></div></div>
      <div class="ph-step"><span class="ph-n">2</span><div><b>This computer’s address</b><p>${lan.map(a => `<code class="ph-addr">${esc(host(a))}</code>`).join(' ') || '<i>No network found.</i>'}${ts.length ? `<br><small>Away from home with Tailscale: ${ts.map(a => `<code class="ph-addr">${esc(host(a))}</code>`).join(' ')}</small>` : ''}</p></div></div>
      <div class="ph-step"><span class="ph-n">3</span><div><b>Pair it</b>${st.pairing ? `<p class="ph-code" aria-label="Pairing code">${esc(st.pairing.code.slice(0, 4))}<span>·</span>${esc(st.pairing.code.slice(4))}</p><p><small id="phLeft">Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.</small> <button class="btn quiet sm" data-phone="cancel">Cancel</button></p>` : '<p><button class="btn prime sm" data-phone="pair">Show a pairing code</button></p>'}</div></div>
    </div>
    ${st.devices.length ? `<p class="ph-h">Paired phones</p><ul class="ph-dev">${st.devices.map(d => `<li><span class="glyph" aria-hidden="true">◈</span><span><b>${esc(d.name)}</b><small>paired ${esc(agoL(d.created))}${d.lastSeen ? ` · last used ${esc(agoL(d.lastSeen))}` : ''}</small></span><button class="btn quiet sm" data-phone="forget" data-id="${esc(d.id)}">Remove</button></li>`).join('')}</ul>` : ''}
    <p class="ph-warn">A paired phone can do anything you can do here, including letting Claude run commands on this PC. Pair only your own phones, and remove one you lose. ${S.platform === 'darwin' ? 'macOS may ask to let Node accept incoming connections; allow it.' : 'Windows may ask to let Node.js through the firewall; allow it on private networks.'}</p>` : ''}`;
  if (st.pairing) phoneTimer = setInterval(() => {
    const l = Math.max(0, Math.round((st.pairing.expiresAt - Date.now()) / 1000));
    const el = $('phLeft'); if (!el || !$('setup').open) { clearInterval(phoneTimer); return; }
    if (!l) { clearInterval(phoneTimer); loadPhone(); return; }
    el.textContent = `Works once, for ${Math.floor(l / 60)}:${String(l % 60).padStart(2, '0')}.`;
    if (l % 5 === 0) api('/api/phone').then(n => { if (!n.pairing && $('setup').open) renderPhone(n); }).catch(() => {});
  }, 1000);
}
async function openSetup(tab = 'health') {
  setupTab(tab);
  if (!$('setup').open) $('setup').showModal();
  if (tab === 'look') return renderLook();
  $('setupBody').innerHTML = '<p class="loading">Checking Claude Code, your accounts and shared data…</p>';
  try { await loadHealth(true); loadPhone(); } catch (err) { $('setupBody').innerHTML = `<p class="loading">${esc(err.message)}</p>`; }
  return undefined;
}
function setupTab(tab) {
  S.setupTab = tab;
  for (const b of document.querySelectorAll('[data-stab]')) b.setAttribute('aria-selected', String(b.dataset.stab === tab));
  $('setup').classList.toggle('look-tab', tab === 'look');
}
document.querySelector('.stabs').addEventListener('click', e => { const b = e.target.closest('[data-stab]'); if (b && b.dataset.stab !== S.setupTab) openSetup(b.dataset.stab); });

/* ---------- Appearance: themes, light/dark, text and interface size, font ---------- */
function renderLook() {
  const o = Look.get(), light = Look.isLight();
  const seg = (k, opts) => `<div class="lk-seg" role="radiogroup">${opts.map(([v, l, sub]) => `<button type="button" role="radio" aria-checked="${String(o[k]) === String(v)}" data-look="${k}" data-v="${v}">${l}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;
  const card = t => {
    const c = Look.swatch(t.id, light);
    return `<button type="button" class="lk-theme" role="radio" aria-checked="${o.theme === t.id}" data-look="theme" data-v="${t.id}" style="--sw-bg:${c.bg};--sw-card:${c.card};--sw-line:${c.line};--sw-ink:${c.ink};--sw-ash:${c.ash};--sw-acc:${c.accent};--sw-emb:${c.ember};--sw-gold:${c.gold};--sw-cx:${c.codex}">
      <span class="sw" aria-hidden="true"><span class="sw-bar"><i></i><i></i><i></i></span><span class="sw-card"><b></b><em></em><em class="s"></em><span class="sw-btn"></span><span class="sw-dot"></span></span></span>
      <span class="lk-tn"><b>${esc(t.name)}</b><small>${esc(t.note)}</small></span></button>`;
  };
  $('setupBody').innerHTML = `
    <p class="d-h">Light or dark</p>
    ${seg('mode', [['dark', '☾ Dark'], ['light', '☀ Light'], ['system', '◐ Match device']])}
    <p class="d-h">Theme</p>
    <div class="lk-themes" role="radiogroup" aria-label="Theme">${Look.THEMES.map(card).join('')}</div>
    <p class="d-h">Text</p>
    <div class="lk-row"><label for="lkText"><b>Text size</b><small>Messages, documents and the message box</small></label>
      <div class="lk-range"><span class="a-sm" aria-hidden="true">A</span><input type="range" id="lkText" min="80" max="150" step="5" value="${o.text}" data-look="text"><span class="a-lg" aria-hidden="true">A</span><output id="lkTextV">${o.text}%</output></div></div>
    <div class="lk-row"><span><b>Reading font</b><small>Classic is the bookish serif; Modern and Clean are easier on small screens</small></span>
      ${seg('font', [['classic', '<span class="fs-classic">Aa</span> Classic'], ['modern', '<span class="fs-modern">Aa</span> Modern'], ['clean', '<span class="fs-modern">Aa</span> Clean', 'sans headings too']])}</div>
    <label class="toggle"><input type="checkbox" data-look="bold" ${o.bold ? 'checked' : ''}><span><b>Bold text</b><span>Heavier letters everywhere, easier to read at a glance.</span></span></label>
    <label class="toggle"><input type="checkbox" data-look="contrast" ${o.contrast ? 'checked' : ''}><span><b>Higher contrast</b><span>Brighter text and stronger accents.</span></span></label>
    <p class="d-h">Interface</p>
    <div class="lk-row"><label for="lkUi"><b>Interface size</b><small>Scales everything: bars, buttons, cards and text</small></label>
      <div class="lk-range"><span class="a-sm" aria-hidden="true">▢</span><input type="range" id="lkUi" min="80" max="130" step="5" value="${o.ui}" data-look="ui"><span class="a-lg" aria-hidden="true">▢</span><output id="lkUiV">${o.ui}%</output></div></div>
    <div class="lk-preview" aria-hidden="true">
      <div class="turn" data-prov="claude"><div class="who"><span class="who-n">Claude</span><span class="who-m">Preview</span></div><div class="part"><div class="final"><div class="md"><p>This is how replies read. <strong>Bold words</strong>, <code>code</code> and <a href="#">links</a> follow your theme.</p></div></div></div></div>
      <div class="umsg"><div class="ububble"><div class="utext">And this is how your messages look.</div></div></div>
    </div>
    <div class="app-actions"><button class="btn" data-look-reset>Back to the original look</button></div>
    <p class="ver">Appearance is saved on this device, so your phone and your PC can each look their own way.</p>`;
}
$('setupBody').addEventListener('input', e => {
  const r = e.target.closest('input[type="range"][data-look]'); if (!r) return;
  Look.set({ [r.dataset.look]: Number(r.value) });
  const out = $(r.id === 'lkText' ? 'lkTextV' : 'lkUiV'); if (out) out.textContent = `${r.value}%`;
});
$('setupBody').addEventListener('click', e => {
  const b = e.target.closest('button[data-look]');
  if (b) { Look.set({ [b.dataset.look]: b.dataset.v }); renderLook(); return; }
  if (e.target.closest('[data-look-reset]')) { Look.reset(); renderLook(); toast('Back to the original look.', 2000); }
});
$('setupBody').addEventListener('change', e => {
  const c = e.target.closest('input[type="checkbox"][data-look]');
  if (c) { Look.set({ [c.dataset.look]: c.checked }); e.stopImmediatePropagation(); }
}, true);
$('setupClose').addEventListener('click', () => $('setup').close());
$('setupBody').addEventListener('click', e => {
  const a = e.target.closest('.setup-toc a'); if (!a) return;
  e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}, true);
$('setupBody').addEventListener('change', wrap(async e => {
  // The command boxes save when you leave them, like the switches do.
  if (e.target.id === 'prefClaude') { await api('/api/prefs', { claudeCommand: e.target.value }); toast('Saved. Checking again…', 2000); return loadHealth(true); }
  if (e.target.id === 'prefCodex') { await api('/api/codex/settings', { command: e.target.value }); toast('Saved. Checking again…', 2000); return loadHealth(true); }
  const ph = e.target.closest('[data-phone="enabled"]');
  if (ph) { renderPhone(await api('/api/phone', { enabled: ph.checked })); toast(ph.checked ? 'Phone access is on.' : 'Phone access is off. Paired phones can’t connect until you turn it on again.', 3500); return; }
  const loc = e.target.closest('[data-local]');
  if (loc) return setLocal(loc.dataset.local, loc.checked);
  const cxp = e.target.closest('[data-codex]');
  if (cxp) { await api('/api/codex/settings', { enabled: cxp.checked }); toast(cxp.checked ? 'Codex is on.' : 'Codex is off.', 2000); await reload(); return loadHealth(true); }
  const el = e.target.closest('[data-pref]'); if (!el) return;
  const k = el.dataset.pref;
  const r = await api('/api/prefs', { [k]: el.type === 'checkbox' ? el.checked : el.value });
  S.prefs = r.prefs; toast('Saved.', 1500); renderPage();
}));
$('setupBody').addEventListener('click', wrap(async e => {
  const ph = e.target.closest('button[data-phone]');
  if (ph) {
    const act = ph.dataset.phone;
    if (act === 'pair') { const r = await api('/api/phone/pair', {}); return renderPhone(r.status); }
    if (act === 'cancel') return renderPhone(await api('/api/phone/pair-cancel', {}));
    if (act === 'forget') { if (!(await appConfirm('Remove this phone?\n\nIt won’t be able to connect until you pair it again.', { ok: 'Remove', danger: true }))) return undefined; return renderPhone(await api('/api/phone/forget', { id: ph.dataset.id })); }
  }
  if (e.target.closest('[data-fix="phone-disconnect"]')) { if (await appConfirm('Disconnect this phone from your PC?\n\nYou can pair it again any time.', { ok: 'Disconnect', danger: true })) window.Android.disconnect(); return undefined; }
  if (e.target.id === 'saveCodex') { await api('/api/codex/settings', { command: $('prefCodex').value }); toast('Saved. Checking again…'); return loadHealth(true); }
  if (e.target.id === 'saveClaude') { await api('/api/prefs', { claudeCommand: $('prefClaude').value }); toast('Saved. Checking again…'); return loadHealth(true); }
  const b = e.target.closest('[data-fix]'); if (!b) return;
  const what = b.dataset.fix, account = b.dataset.account;
  if (what === 'signin') { $('setup').close(); S.acct = account; store('acct', account); renderAll(); return accountAction(current().expectEmail ? 'signin-direct' : 'signin', account); }
  if (what === 'set-claude-path') { $('prefClaude').focus(); return; }
  if (what === 'install-codex') return codexInstall();
  if (what === 'codex-signin') { $('setup').close(); return codexSignIn(); }
  if (what === 'fix-sharing') {
    const r = await api('/api/fix-sharing', { account });
    toast(r.errors.length ? `Some folders couldn’t be fixed: ${r.errors.join('; ')}` : `Done. Shared ${r.linked.length ? r.linked.join(', ') : 'everything'}${r.moved ? `, moved ${r.moved} item${r.moved === 1 ? '' : 's'} into your main folder` : ''}${r.conflicts ? `; ${r.conflicts} duplicate${r.conflicts === 1 ? ' was' : 's were'} kept aside, not deleted` : ''}.`, 9000);
    await reload(); return loadHealth(true);
  }
  if (what === 'update-claude') { const r = await api('/api/update-claude', {}); return r.dryRun ? reportLaunch(r) : toast(`Updating Claude Code in a ${r.how}. Close it when it finishes, then reopen Setup.`, 8000); }
  if (what === 'share-copy') return shareCopy();
  if (what === 'shortcut') { const r = await api('/api/shortcut', {}); return toast(r.dryRun ? 'Would create a desktop shortcut.' : S.platform === 'darwin' ? 'Added “Session Switcher” to Applications in your home folder. Find it with Spotlight or Launchpad.' : 'Added “Claude Session Switcher” to your desktop.'); }
  if (what === 'quit') return quitApp();
}));

/* ---------- this PC's own settings: alerts and petals ---------- */
const Local = {
  sound: store('sound') !== 'off',
  notify: store('notify') === 'on' && 'Notification' in window && Notification.permission === 'granted',
  petals: store('petals') !== 'off',
  motion: store('motion') !== 'off',
};
async function setLocal(k, on) {
  if (k === 'notify' && on) {
    if (!('Notification' in window)) { toast('This browser can’t show desktop notifications.'); on = false; }
    else if (Notification.permission !== 'granted') {
      const r = await Notification.requestPermission().catch(() => 'denied');
      if (r !== 'granted') { toast('Notifications are blocked for this window. Allow them in the browser’s site settings to turn this on.', 8000); on = false; }
    }
  }
  Local[k] = on; store(k, on ? 'on' : 'off');
  if (k === 'petals') petals();
  if (k === 'motion') applyMotion();
  if (k === 'sound' && on) chime('reply');
  renderLivePill();
  const box = document.querySelector(`[data-local="${k}"]`); if (box) box.checked = on;
}
function applyMotion() { document.body.classList.toggle('motion', motionOk()); }
matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { applyMotion(); petals(); });
function petals() {
  const box = $('petals');
  const on = Local.petals && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.classList.toggle('no-petals', !on);
  if (!on) { box.innerHTML = ''; return; }
  if (box.children.length) return;
  let h = '';
  for (let i = 0; i < 9; i++) {
    const r = n => ((hash(`petal${i}${n}`) % 1000) / 1000);
    h += `<i class="petal" style="--x0:${Math.round(r('x') * 95)}vw;--s:${8 + Math.round(r('s') * 8)}px;--o:${(0.06 + r('o') * 0.12).toFixed(2)};--d:${32 + Math.round(r('d') * 30)}s;--delay:-${Math.round(r('t') * 60)}s"></i>`;
  }
  box.innerHTML = h;
}

/* ---------- alerts: chime, notification, title ---------- */
let actx = null;
document.addEventListener('pointerdown', () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { /* no audio */ } }, { once: true });
function chime(kind) {
  if (!actx) return;
  try {
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime + 0.02;
    const notes = kind === 'needs' ? [[1318.5, 0, 0.06], [987.8, 0.17, 0.05]] : [[880, 0, 0.035], [1174.7, 0.11, 0.025]];
    for (const [f, dt, vol] of notes) {
      const g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(vol, t0 + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 1.5);
      g.connect(actx.destination);
      for (const [mult, amp] of [[1, 1], [2.76, 0.28], [5.4, 0.08]]) {
        const o = actx.createOscillator(), og = actx.createGain();
        o.type = 'sine'; o.frequency.value = f * mult; og.gain.value = amp;
        o.connect(og); og.connect(g); o.start(t0 + dt); o.stop(t0 + dt + 1.6);
      }
    }
  } catch { /* no audio */ }
}
const Alerts = { seen: new Map(), primed: false };
function watchActivity() {
  const next = new Map();
  for (const x of S.activity) {
    const k = keyOf(x), st = statusOf(x), was = Alerts.seen.get(k);
    const pend = (x.pending || []).map(p => p.requestId).join(',');
    next.set(k, { st, pend, fin: x.finishedAt });
    // Looking at it right now counts as reading it.
    const viewing = window.ChatUI && ChatUI.isViewing && ChatUI.isViewing(x) && document.hasFocus() && !document.hidden;
    if (viewing && st === 'reply') { markSeen(x); continue; }
    if (!Alerts.primed || viewing) continue;
    if (NEEDS.has(st) && (!was || !NEEDS.has(was.st) || (pend && pend !== was.pend))) notify('needs', x);
    else if (st === 'reply' && (!was || was.fin !== x.finishedAt) && (!was || was.st !== 'reply' || was.fin !== x.finishedAt)) { if (was) notify('reply', x); }
  }
  Alerts.seen = next; Alerts.primed = true;
}
function notify(kind, x) {
  if (Local.sound) chime(kind);
  if (Local.notify && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try {
      const p = (x.pending || [])[0];
      const body = kind === 'needs' ? (p ? `${wantsTo(p)}${p.detail || p.summary ? `: ${p.detail || p.summary}` : ''}` : 'Waiting for you.') : (plainMd(lastLine(x.lastText)).slice(0, 160) || 'Finished its turn.');
      const n = new Notification(kind === 'needs' ? `${x.title || 'A chat'} needs you` : `${x.title || 'A chat'} replied`, { body, tag: keyOf(x), silent: true });
      n.onclick = () => { window.focus(); openActivity(findActivity(keyOf(x)) || x); n.close(); };
    } catch { /* notifications unavailable */ }
  }
}

/* ---------- the live pill ---------- */
function renderLivePill() {
  const p = $('livepill');
  p.classList.toggle('off', !S.connected);
  $('lpText').textContent = S.connected ? 'Live' : 'Reconnecting';
  const b = $('lpBell');
  b.textContent = Local.sound || Local.notify ? 'Alerts on' : 'Alerts off';
  b.className = `lp-bell ${Local.sound || Local.notify ? 'on' : ''}`;
}
$('livepill').addEventListener('click', e => showMenu(e.currentTarget, [
  { label: Local.sound ? 'Turn the chime off' : 'Turn the chime on', hint: 'when a chat needs you or replies', run: () => setLocal('sound', !Local.sound) },
  { label: Local.notify ? 'Turn desktop notifications off' : 'Turn desktop notifications on', hint: 'while this window is in the background', run: () => setLocal('notify', !Local.notify) },
  { label: Local.petals ? 'Hide the drifting petals' : 'Show the drifting petals', run: () => setLocal('petals', !Local.petals) },
]));

/* ---------- command palette ---------- */
const Pal = { items: [], sel: 0 };
function score(text, q) {
  const t = String(text || '').toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const term of terms) { const i = t.indexOf(term); if (i < 0) return -1; s += i === 0 ? 30 : /\W/.test(t[i - 1]) ? 20 : 8; }
  return s;
}
function palItems(q) {
  const out = [];
  const add = (g, list) => { if (list.length) out.push({ g }, ...list); };
  const run = S.activity.map(x => ({ glyph: NEEDS.has(statusOf(x)) || statusOf(x) === 'reply' ? '✦' : '◉', t: x.title || 'New chat', s: `${{ approve: 'needs your OK', question: 'has a question', 'terminal-wait': 'waiting in its terminal', reply: 'your turn', working: 'at work', quiet: 'open', ended: 'stopped' }[statusOf(x)]}${x.folder ? ` · ${x.folder}` : ''}`, run: () => openActivity(x), text: `${x.title} ${x.folder}` }));
  const acts = [
    { glyph: '✦', t: 'Go to the hub', run: () => go('hub') },
    { glyph: '✧', t: 'Recent chats', run: () => go('recent') },
    { glyph: '⚙', t: 'Setup and health', run: openSetup, alias: 'settings options preferences config health' },
    { glyph: '◐', t: 'Appearance', s: 'themes, light or dark, text and interface size', run: () => openSetup('look') },
    { glyph: '?', t: 'Keyboard shortcuts', run: () => openShortcuts(), alias: 'keys hotkeys help' },
    { glyph: '◐', t: Look.isLight() ? 'Switch to dark mode' : 'Switch to light mode', run: () => Look.set({ mode: Look.isLight() ? 'dark' : 'light' }) },
    ...Look.THEMES.filter(t => t.id !== Look.get().theme).map(t => ({ glyph: '◉', t: `Theme: ${t.name}`, s: t.note, run: () => Look.set({ theme: t.id }) })),
    { glyph: '◈', t: 'Check usage for every account', run: () => refreshUsage() },
    ...S.accounts.filter(a => a.id !== S.acct).map(a => ({ glyph: '◆', t: `Work as ${a.name}`, s: usageLine(a.id, { short: true }), run: () => useAccount(a.id) })),
    ...S.accounts.map(a => ({ glyph: '❖', t: `Open claude.ai as ${a.name}`, s: 'regular Claude chats', run: () => openWeb(a.id) })),
    ...(S.codex && S.codex.enabled ? (S.codex.signedIn ? [{ glyph: '❖', t: 'Open chatgpt.com', s: 'regular ChatGPT', run: () => openWeb(S.codex.id) }, { glyph: '◈', t: 'Check Codex usage', run: () => refreshUsage(S.codex.id) }] : [{ glyph: '✥', t: 'Sign in to Codex with ChatGPT', run: codexSignIn }]) : []),
    { glyph: '✥', t: 'New project', s: 'make a folder and start a chat', run: () => openNewProject() },
    { glyph: '✥', t: 'Add an account', run: addAccount, alias: 'sign in login' },
    ...(window.REMOTE ? [] : [{ glyph: '⏻', t: 'Quit Session Switcher', run: quitApp, alias: 'exit close stop app' }]),
  ].map(x => ({ ...x, text: `${x.t} ${x.alias || ''}` }));
  const claudeNew = canLaunch(current()) ? S.projects.filter(p => p.exists).map(p => ({ glyph: '✦', t: `New Claude chat in ${p.name}`, s: `as ${current().name}`, run: () => ChatUI.open({ cwd: p.cwd, mode: 'new' }), text: `new chat claude ${p.name}` })) : [];
  const pinItems = S.projects.map(p => ({ glyph: '★', t: `${S.pins.has(p.cwd) ? 'Unpin' : 'Pin'} ${p.name}`, s: 'in the sidebar', run: () => togglePin(p.cwd), text: `pin unpin favorite ${p.name}` }));
  const folders = S.projects.map(p => ({ glyph: glyphFor(p.name), t: p.name, s: `${plural(p.sessions.length, 'chat')}`, run: () => go('folder', p.cwd), text: `${p.name} ${p.cwd}` }));
  const chats = allSessions().sort((x, y) => y[0].updated - x[0].updated).map(([s, p]) => ({ glyph: '❝', t: s.title, s: `${p.name} · ${agoL(s.updated)}`, run: () => (liveOf(s.id) ? ChatUI.open({ sessionId: s.id }) : isRunning(s.id) ? ChatUI.watch({ sessionId: s.id, source: 'terminal' }) : inApp() ? ChatUI.open({ sessionId: s.id }) : openDrawer(s.id)), text: `${s.title} ${p.name} ${s.firstPrompt || ''}` }));
  const cxNew = codexReady() ? S.projects.filter(p => p.exists).map(p => ({ glyph: '✥', t: `New Codex chat in ${p.name}`, s: 'Codex', run: () => ChatUI.open({ cwd: p.cwd, mode: 'new', provider: 'codex' }), text: `codex new ${p.name}` })) : [];
  // Prompts, in the project you're looking at first, then in every project.
  const here = S.view === 'folder' ? S.projects.find(p => p.cwd === S.folder) : null;
  const worldsFor = here ? [here, ...S.projects.filter(p => p !== here)] : S.projects;
  const prompts = worldsFor.filter(p => p.exists).flatMap(p => S.prompts.map(pr => ({ glyph: '❡', t: `${pr.title} in ${p.name}`, s: pr.provider === 'codex' ? 'Codex' : 'prompt', run: () => startWithPrompt(p.cwd, pr), text: `${pr.title} ${p.name} prompt start` })));
  const docs = Object.values(S.worlds).flatMap(w => { const p = S.projects.find(x => x.cwd === w.cwd); return p ? w.docs.slice(0, 60).map(d => ({ glyph: '❧', t: d.name, s: `${p.name} · ${agoL(d.mtime)}`, run: () => Viewer.open({ path: d.path, cwd: p.cwd }), text: `${d.rel} ${p.name}` })) : []; });
  const models = window.ChatUI && ChatUI.modelItems ? ChatUI.modelItems() : [];
  // The chat you're in: find, export, pin.
  const inChat = window.ChatUI && ChatUI.isOpen();
  const sid = inChat && ChatUI.sessionId ? ChatUI.sessionId() : null;
  const chatActs = inChat ? [
    { glyph: '⌕', t: 'Find in this chat', s: 'Ctrl F', run: () => ChatUI.find(), text: 'find search this chat' },
    { glyph: '❧', t: 'Export this chat as Markdown', run: () => ChatUI.exportChat(), text: 'export save download markdown chat' },
    ...(sid ? [{ glyph: '★', t: isFav(sid) ? 'Unpin this chat from the sidebar' : 'Pin this chat to the sidebar', run: () => toggleFav(sid), text: 'pin favorite star this chat' }] : []),
  ] : [];
  if (!q) {
    add('This chat', chatActs);
    add('Running now', run);
    if (here) add(`Start ${here.name} with a prompt`, prompts.slice(0, S.prompts.length));
    add('Recent chats', chats.slice(0, 6));
    add('Projects', folders.slice(0, 6));
    add('Actions', acts);
    return out;
  }
  const rank = list => list.map(x => ({ x, s: score(x.text, q) })).filter(r => r.s >= 0).sort((a, b) => b.s - a.s).map(r => r.x);
  add('Running now', rank(run).slice(0, 5));
  add('Chats', rank(chats).slice(0, 8));
  add('Projects', rank(folders).slice(0, 5));
  add('Documents', rank(docs).slice(0, 5));
  add('Start with a prompt', rank(prompts).slice(0, 4));
  add('Actions', rank(acts).slice(0, 5));
  add('This chat', rank(chatActs).slice(0, 3));
  add('Switch model in this chat', rank(models).slice(0, 6));
  add('Start a chat', rank([...claudeNew, ...cxNew]).slice(0, 4));
  add('Pin', rank(pinItems).slice(0, 3));
  out.push({ g: 'Inside every message' }, { glyph: '❝', t: `Search every message for “${q}”`, s: 'full text', run: () => runSearch(q) });
  return out;
}
function renderPal() {
  const q = $('palQ').value.trim();
  Pal.items = palItems(q);
  const picks = Pal.items.filter(x => !x.g);
  Pal.sel = Math.min(Pal.sel, Math.max(0, picks.length - 1));
  let n = -1;
  $('palList').innerHTML = Pal.items.map(x => {
    if (x.g) return `<li class="pal-g" role="presentation">${esc(x.g)}</li>`;
    n++;
    return `<li class="pal-i" role="option" id="pal-${n}" data-n="${n}" aria-selected="${n === Pal.sel}"><span class="glyph" aria-hidden="true">${esc(x.glyph || '·')}</span><span class="pi-t">${esc(x.t)}</span>${x.s ? `<span class="pi-s">${esc(x.s)}</span>` : ''}</li>`;
  }).join('') || '<li class="pal-empty">Nothing here yet.</li>';
  $('palQ').setAttribute('aria-activedescendant', `pal-${Pal.sel}`);
  $('palList').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
let palReturn = null;
function openPalette(prefill = '') {
  closeMenu();
  if ($('palette').hidden) palReturn = document.activeElement;
  $('palette').hidden = false; $('palQ').value = prefill; Pal.sel = 0; renderPal(); $('palQ').focus();
}
function closePalette() {
  $('palette').hidden = true;
  if (palReturn && document.contains(palReturn) && palReturn.focus) palReturn.focus({ preventScroll: true });
  palReturn = null;
}
function pickPal(n) { const x = Pal.items.filter(i => !i.g)[n]; if (!x) return; closePalette(); wrap(x.run)(); }
$('palQ').addEventListener('input', () => { Pal.sel = 0; renderPal(); });
$('palQ').addEventListener('keydown', e => {
  const count = Pal.items.filter(x => !x.g).length;
  if (e.key === 'ArrowDown') { Pal.sel = (Pal.sel + 1) % Math.max(1, count); renderPal(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { Pal.sel = (Pal.sel - 1 + count) % Math.max(1, count); renderPal(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); pickPal(Pal.sel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palList').addEventListener('mousemove', e => { const i = e.target.closest('.pal-i'); if (i && +i.dataset.n !== Pal.sel) { Pal.sel = +i.dataset.n; renderPal(); } });
$('palList').addEventListener('click', e => { const i = e.target.closest('.pal-i'); if (i) pickPal(+i.dataset.n); });
$('palette').addEventListener('mousedown', e => { if (e.target === $('palette')) closePalette(); });

let searchSeq = 0;
async function runSearch(q) {
  S.q = q; S.hits = null; go('search');
  const seq = ++searchSeq;
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq || S.view !== 'search') return;
  S.hits = r; renderSearch();
  if (!r.progress.ready) setTimeout(() => { if (S.view === 'search' && S.q === q) wrap(runSearch)(q); }, 1500);
}

/* ---------- the file viewer: open what a chat links to ---------- */
const Viewer = (() => {
  const V = { ctx: {}, stack: [], cur: null, raw: false, list: null, idx: -1 };
  const dlg = () => $('viewer');
  function ensure() {
    if ($('viewer')) return;
    document.body.insertAdjacentHTML('beforeend', `<dialog id="viewer" class="wide viewer" aria-labelledby="vTitle"><div class="v-wrap"><div class="v-head" id="vHead"></div><div class="v-body" id="vBody"></div></div></dialog>`);
    dlg().addEventListener('click', wrap(onClick));
    dlg().addEventListener('close', () => { V.stack = []; V.list = null; });
    // In a project's gallery, ← and → step through its pictures.
    dlg().addEventListener('keydown', e => {
      if (!V.list || !V.cur || V.cur.kind !== 'image' || e.target.closest('input, textarea')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); wrap(step)(e.key === 'ArrowRight' ? 1 : -1); }
    });
  }
  const sizeOf = n => (n === null || n === undefined ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function joinPath(dir, rel) {
    if (/^([A-Za-z]:[\\/]|\/|~)/.test(rel)) return rel;
    const sep = dir.includes('\\') ? '\\' : '/';
    const parts = dir.split(/[\\/]+/);
    for (const seg of rel.split(/[\\/]+/)) { if (!seg || seg === '.') continue; if (seg === '..') { if (parts.length > 1) parts.pop(); } else parts.push(seg); }
    return parts.join(sep) || sep;
  }
  function crumbs(p) {
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.split(/[\\/]+/).filter((x, i) => x || i === 0);
    let acc = '';
    return parts.map((seg, i) => {
      acc = i === 0 ? (seg || sep) : `${acc}${acc.endsWith(sep) ? '' : sep}${seg}`;
      if (i === 0 && /^[A-Za-z]:$/.test(seg)) acc = `${seg}${sep}`;
      const last = i === parts.length - 1;
      const label = seg || sep;
      const el = last ? `<span class="v-crumb cur">${esc(label)}</span>` : `<button class="v-crumb" data-v="go" data-path="${esc(acc)}">${esc(label)}</button>`;
      return i === 0 || (i === 1 && !parts[0]) ? el : `<span class="v-sep">${esc(sep)}</span>${el}`;
    }).join('');
  }
  function render() {
    const f = V.cur;
    const kind = f.kind === 'dir' ? 'Folder' : f.kind === 'image' ? 'Image' : f.kind === 'text' ? (f.lang || 'text') : f.kind === 'video' ? 'Video' : f.kind === 'audio' ? 'Sound' : f.kind === 'pdf' ? 'PDF' : 'File';
    const meta = [kind, f.kind === 'dir' ? plural(f.entries.length, 'item') : sizeOf(f.size), f.mtime ? `changed ${agoL(f.mtime)}` : ''].filter(Boolean).join(' · ');
    $('vHead').innerHTML = `
      <div class="v-t">
        <p class="eyebrow">${esc(meta)}</p>
        <h3 id="vTitle">${V.stack.length ? '<button class="icon v-back" data-v="back" aria-label="Back">←</button>' : ''}${esc(f.name)}</h3>
        <p class="v-path">${crumbs(f.path)}</p>
      </div>
      <div class="v-act">
        ${f.kind === 'text' && f.markdown ? `<div class="seg" role="group" aria-label="View"><button class="${V.raw ? '' : 'on'}" data-v="rendered" aria-pressed="${!V.raw}">Formatted</button><button class="${V.raw ? 'on' : ''}" data-v="raw" aria-pressed="${V.raw}">Markdown</button></div>` : ''}
        ${f.kind === 'text' ? `<button class="btn prime sm" data-v="copy">Copy ${f.markdown ? 'markdown' : 'text'}</button>` : ''}
        ${inGallery() ? `<span class="v-step"><button class="icon" data-v="prev" aria-label="Previous picture" ${V.idx > 0 ? '' : 'disabled'}>‹</button><span class="count">${V.idx + 1} of ${V.list.length}</span><button class="icon" data-v="next" aria-label="Next picture" ${V.idx < V.list.length - 1 ? '' : 'disabled'}>›</button></span>
          ${isBanner() ? '<span class="tag gilt">Banner</span>' : '<button class="btn sm" data-v="banner">Use as banner</button>'}` : ''}
        <button class="btn sm" data-v="copypath">Copy path</button>
        <button class="btn quiet sm" data-v="reveal">Show in folder</button>
        <button class="icon" data-v="close" aria-label="Close">✕</button>
      </div>`;
    let body = '';
    if (f.kind === 'dir') {
      body = f.entries.length ? `<ul class="v-dir">${f.entries.map(e => `<li><button data-v="open" data-name="${esc(e.name)}"><span class="glyph" aria-hidden="true">${e.dir ? '❖' : '✧'}</span><span class="vd-n">${esc(e.name)}${e.dir ? '/' : ''}</span><span class="vd-s">${e.dir ? '' : esc(sizeOf(e.size))}</span><span class="vd-m">${e.mtime ? esc(agoL(e.mtime)) : ''}</span></button></li>`).join('')}</ul>${f.more ? '<p class="v-note">Showing the first 1,000 items.</p>' : ''}` : '<p class="v-note">This folder is empty.</p>';
    } else if (f.kind === 'image') body = `<div class="v-img"><img src="${esc(f.src)}" alt="${esc(f.name)}"></div>`;
    else if (f.kind === 'video') body = `<div class="v-media"><video controls autoplay preload="metadata" src="${esc(mediaSrc(f.path))}"></video></div>`;
    else if (f.kind === 'audio') body = `<div class="v-media audio"><audio controls preload="metadata" src="${esc(mediaSrc(f.path))}"></audio></div>`;
    else if (f.kind === 'pdf') body = `<iframe class="v-pdf" title="${esc(f.name)}" src="${esc(mediaSrc(f.path))}"></iframe>`;
    else if (f.kind === 'text') {
      body = (f.markdown && !V.raw ? `<article class="md v-md">${ChatUI.md(f.text)}</article>` : `<pre class="v-raw">${esc(f.text)}</pre>`) + (f.truncated ? '<p class="v-note">Only the first 2 MB are shown.</p>' : '');
    } else body = `<p class="v-note">${esc(f.note || 'This file can’t be shown here.')}</p>`;
    $('vBody').innerHTML = body;
    $('vBody').scrollTop = 0;
  }
  function mediaSrc(p) {
    const q = new URLSearchParams({ token: TOKEN, path: p });
    for (const k of ['key', 'session', 'cwd']) if (V.ctx[k]) q.set(k, V.ctx[k]);
    return `/api/media?${q}`;
  }
  async function load(pathArg, { push = true } = {}) {
    const params = new URLSearchParams({ path: pathArg });
    for (const k of ['key', 'session', 'cwd']) if (V.ctx[k]) params.set(k, V.ctx[k]);
    const f = await api(`/api/file?${params}`);
    if (push && V.cur) V.stack.push(V.cur.path);
    V.cur = f; V.raw = false; render();
  }
  const inGallery = () => !!(V.list && V.cur && V.cur.kind === 'image' && V.idx >= 0 && !V.stack.length);
  const isBanner = () => { const w = V.ctx.cwd && S.worlds[V.ctx.cwd]; return !!(w && w.banner === V.list[V.idx]); };
  async function step(d) {
    const j = V.idx + d; if (!V.list || j < 0 || j >= V.list.length) return;
    V.idx = j; await load(V.list[j], { push: false });
  }
  async function open({ path: p, key = null, session = null, cwd = null, list = null }) {
    ensure();
    V.ctx = { key, session, cwd }; V.stack = []; V.cur = null;
    V.list = list && list.length ? list : null; V.idx = V.list ? V.list.indexOf(p) : -1;
    $('vHead').innerHTML = ''; $('vBody').innerHTML = '<p class="loading">Opening…</p>';
    if (!dlg().open) dlg().showModal();
    try { await load(p, { push: false }); }
    catch (err) { $('vHead').innerHTML = `<div class="v-t"><p class="eyebrow">Couldn’t open</p><h3 id="vTitle">${esc(String(p).split(/[\\/]/).filter(Boolean).pop() || p)}</h3></div><div class="v-act"><button class="icon" data-v="close" aria-label="Close">✕</button></div>`; $('vBody').innerHTML = `<p class="v-note">${esc(err.message)}</p>`; }
  }
  async function onClick(e) {
    const fl = e.target.closest('.flink[data-path]'); if (fl) { e.preventDefault(); return load(joinPath(V.cur.dir, fl.dataset.path)); }
    const a = e.target.closest('.v-md a[href]');
    if (a && /^#/.test(a.getAttribute('href') || '')) { e.preventDefault(); return undefined; }
    const b = e.target.closest('[data-v]'); if (!b) { if (e.target === dlg()) dlg().close(); return undefined; }
    const f = V.cur;
    switch (b.dataset.v) {
      case 'close': return dlg().close();
      case 'back': { const p = V.stack.pop(); if (p) await load(p, { push: false }); return undefined; }
      case 'go': return load(b.dataset.path);
      case 'open': return load(joinPath(f.path, b.dataset.name));
      case 'prev': return step(-1);
      case 'next': return step(1);
      case 'banner': {
        const w = await api('/api/project/banner', { cwd: V.ctx.cwd, path: V.list[V.idx] });
        S.worlds[V.ctx.cwd] = { ...w, at: Date.now() };
        toast('Banner updated.', 2000); render();
        if (S.view === 'folder' && S.folder === V.ctx.cwd) renderFolder();
        return undefined;
      }
      case 'rendered': V.raw = false; return render();
      case 'raw': V.raw = true; return render();
      case 'copy': try { await navigator.clipboard.writeText(f.text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = `Copy ${f.markdown ? 'markdown' : 'text'}`; }, 1600); } catch { toast('Couldn’t copy. Select the text and press Ctrl+C instead.'); } return undefined;
      case 'copypath': try { await navigator.clipboard.writeText(f.path); toast('Copied the path.', 2000); } catch { prompt('Copy this path:', f.path); } return undefined;
      case 'reveal': { const r = await api('/api/reveal', { path: f.path, ...V.ctx }); if (r.dryRun) toast(`Would run: ${r.script}`); return undefined; }
      default: return undefined;
    }
  }
  return { open, joinPath };
})();

/* ---------- clicks ---------- */
$('nav').addEventListener('click', wrap(async e => {
  const seal = e.target.closest('#seal'); if (seal) return seal.getAttribute('aria-expanded') === 'true' ? closeMenu() : sealMenu(seal);
  const f = e.target.closest('[data-fold]');
  if (f) { const id = f.dataset.fold; if (S.navFold.has(id)) S.navFold.delete(id); else S.navFold.add(id); store('navFold', JSON.stringify([...S.navFold])); return renderNav(); }
  const nc = e.target.closest('[data-navchat]'); if (nc) { document.body.classList.remove('nav-open'); return openChatFromNav(nc.dataset.navchat); }
  const b = e.target.closest('[data-view]'); if (!b) return;
  if (b.dataset.view === 'palette') { document.body.classList.remove('nav-open'); return openPalette(); }
  if (b.dataset.view === 'newproject') { document.body.classList.remove('nav-open'); return openNewProject(); }
  go(b.dataset.view, b.dataset.cwd, b.dataset.prov);
}));
$('brand').addEventListener('click', () => go('hub'));
$('pulse').addEventListener('click', () => hubTo(awaiting().length ? 'secAwait' : 'secWork'));
$('usechip').addEventListener('click', e => { e.stopPropagation(); return $('acctPop').hidden ? openAcctPop() : closeAcctPop(); });

/* ---------- the account dropdown (top bar) ---------- */
function acctBars(id) {
  const u = usageOf(id), d = u && u.data && u.data.available ? u.data : null;
  if (!d) return `<span class="ap-none">${u && u.error ? 'Usage unavailable' : u && u.checking ? 'Checking…' : 'No usage yet'}</span>`;
  const bar = (label, w) => { if (!w) return ''; const l = leftOf(w); return `<span class="ap-bar ${hot(l) ? 'hot' : ''}" title="${esc(label)}: ${l}% left${w.resetsAt ? `, resets ${esc(when(w.resetsAt))}` : ''}"><small>${label}</small><i><b style="width:${l}%"></b></i><em>${l}%</em></span>`; };
  return bar('5h', d.fiveHour) + bar('Week', d.week);
}
function openAcctPop() {
  const pop = $('acctPop');
  const inChat = !!(window.ChatUI && ChatUI.isOpen());
  const chatAcct = inChat && ChatUI.accountId ? ChatUI.accountId() : null;
  const row = a => {
    const on = a.id === S.acct;
    const runs = chatAcct === a.id;
    const status = !a.signedIn ? 'Not signed in' : a.lock && !a.lock.ok ? 'Locked to another plan' : `${a.email || 'Signed in'}${a.plan ? ` · ${a.plan}` : ''}`;
    return `<button type="button" class="ap-row ${on ? 'on' : ''}" data-ap="${esc(a.id)}" style="--ring:${ringById(a.id)}" ${a.signedIn ? '' : 'aria-disabled="true"'}>
      <span class="ap-dial">${miniDial(a.id, 34)}</span>
      <span class="ap-t"><b>${esc(a.name)}${runs ? ' <span class="tag">this chat</span>' : ''}${on ? ' <span class="tag gold">new chats</span>' : ''}</b><small>${esc(status)}</small><span class="ap-bars">${acctBars(a.id)}</span></span></button>`;
  };
  const many = codexAccts().length > 1;
  const cxRow = x => `<button type="button" class="ap-row codex ${many && x.id === S.codex.id ? 'on' : ''}" data-ap="${esc(x.id)}" style="--ring:${codexRing(x.id)}">
      <span class="ap-dial">${miniDial(x.id, 34)}</span>
      <span class="ap-t"><b>${esc(x.name || 'Codex')}${chatAcct === x.id ? ' <span class="tag codex">this chat</span>' : ''}${many && x.id === S.codex.id ? ' <span class="tag gold">new Codex chats</span>' : ''}</b><small>${esc(x.signedIn ? `${x.email || 'Signed in'}${x.plan ? ` · ${x.plan}` : ''}` : x.kind === 'ollama' ? 'Ollama app not running' : 'Not signed in')}</small><span class="ap-bars">${x.signedIn && x.kind !== 'ollama' ? acctBars(x.id) : ''}</span></span></button>`;
  const cx = S.codex && S.codex.enabled ? `<p class="ap-h">${many ? 'Codex: new Codex chats open as' : 'Codex'}</p>${codexAccts().map(cxRow).join('')}` : '';
  pop.innerHTML = `<p class="ap-h">${inChat && chatAcct ? 'Pick the account new chats open as. This chat keeps its own.' : 'New chats open as'}</p>
    <div class="ap-list">${S.accounts.map(row).join('')}</div>${cx}
    <div class="ap-act">
      <button type="button" class="btn sm" data-apx="add">Add an account</button>
      <button type="button" class="btn quiet sm" data-apx="usage">Check usage</button>
      <button type="button" class="btn quiet sm" data-apx="web">Open claude.ai</button>
      <button type="button" class="btn quiet sm" data-apx="hub">All accounts on the hub</button>
    </div>`;
  pop.hidden = false;
  placeAt(pop, $('usechip'));
  $('usechip').setAttribute('aria-expanded', 'true');
  pop.querySelector('.ap-row.on, .ap-row')?.focus();
}
function closeAcctPop() { if ($('acctPop').hidden) return; $('acctPop').hidden = true; $('usechip').setAttribute('aria-expanded', 'false'); }
$('acctPop').addEventListener('click', wrap(async e => {
  const r = e.target.closest('[data-ap]');
  if (r) {
    const id = r.dataset.ap;
    closeAcctPop();
    if (codexAcct(id)) {
      const many = codexAccts().length > 1;
      await setCodexActive(id);
      if (!S.codex.signedIn) return S.codex.kind === 'ollama' ? hubTo('secAccounts') : codexSignIn();
      return many ? toast(`New Codex chats open as ${S.codex.name}.`, 2500) : hubTo('secAccounts');
    }
    const a = S.accounts.find(x => x.id === id);
    if (a && !a.signedIn) { S.acct = id; store('acct', id); renderAll(); return accountAction(a.expectEmail ? 'signin-direct' : 'signin', id); }
    return useAccount(id);
  }
  const x = e.target.closest('[data-apx]'); if (!x) return undefined;
  closeAcctPop();
  if (x.dataset.apx === 'add') return addAccount();
  if (x.dataset.apx === 'usage') { toast('Checking usage for every account…', 2500); return refreshUsage(); }
  if (x.dataset.apx === 'web') return openWeb(current().id);
  if (ChatUI.isOpen()) ChatUI.close();
  return hubTo('secAccounts');
}));
document.addEventListener('mousedown', e => { if (!$('acctPop').hidden && !(e.target.closest && e.target.closest('#acctPop, #usechip'))) closeAcctPop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('acctPop').hidden) { closeAcctPop(); $('usechip').focus(); e.stopPropagation(); } }, true);
window.addEventListener('resize', closeAcctPop);
$('seek').addEventListener('click', () => openPalette());
$('setupBtn').addEventListener('click', openSetup);
$('navBack').addEventListener('click', () => { document.body.classList.remove('nav-open'); $('navToggle').setAttribute('aria-expanded', 'false'); });
$('navToggle').addEventListener('click', () => { const on = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', on); $('navToggle').setAttribute('aria-expanded', String(on)); });

const pageClicks = wrap(async e => {
  const t = e.target;
  // Cards on the hub.
  const card = t.closest('.omen, .qchip');
  const ab = t.closest('[data-a]');
  if (card && ab && card.dataset.k && ab.tagName !== 'FORM') {
    const x = findActivity(card.dataset.k); if (!x) return;
    const p = (x.pending || [])[0];
    switch (ab.dataset.a) {
      case 'open': return openActivity(x);
      case 'seen': markSeen(x); return toast('Marked as read.', 1800);
      case 'resume': markSeen(x); return ChatUI.open({ sessionId: x.sessionId });
      case 'allow': case 'always': case 'deny':
        ab.disabled = true;
        await api('/api/chat/permission', { key: x.key, requestId: p.requestId, decision: ab.dataset.a, message: '' });
        return toast(ab.dataset.a === 'deny' ? `Denied. ${x.title || 'The chat'} will try something else.` : `Allowed. ${x.title || 'The chat'} carries on.`, 2500);
      default: return;
    }
  }
  const wd = t.closest('.w-art[data-world]'); if (wd) return openWorld(wd.dataset.world, wd);
  const ct = t.closest('[data-continue]'); if (ct) { const [cs] = sessionById(ct.dataset.continue); if (cs && isRunning(cs.id) && !liveOf(cs.id)) return ChatUI.watch({ sessionId: cs.id, source: 'terminal' }); return ChatUI.open({ sessionId: ct.dataset.continue }); }
  const dc = t.closest('[data-doc]'); if (dc) return Viewer.open({ path: dc.dataset.doc, cwd: S.folder });
  const gi = t.closest('[data-img]'); if (gi) { const w = S.worlds[S.folder]; return Viewer.open({ path: gi.dataset.img, cwd: S.folder, list: w ? w.images.map(x => x.path) : null }); }
  const wp = t.closest('[data-wprov]'); if (wp) { S.prov = wp.dataset.wprov === 'all' ? null : wp.dataset.wprov; renderNav(); return renderFolder(); }
  const bn = t.closest('[data-banner]'); if (bn) { const w = await api('/api/project/banner', { cwd: S.folder, path: bn.dataset.banner === '-' ? null : bn.dataset.banner }); S.worlds[S.folder] = { ...w, at: Date.now() }; toast(bn.dataset.banner === '-' ? 'Banner reset to the automatic pick.' : 'Banner updated.', 2000); return renderFolder(); }
  const tb = t.closest('[data-wtab]'); if (tb) { S.worldTab = tb.dataset.wtab; return renderWorldBody(); }
  const sp = t.closest('[data-prompt]'); if (sp) { const pr = S.prompts.find(x => x.id === sp.dataset.prompt); if (pr) return startWithPrompt(S.folder, pr); return; }
  const ch = t.closest('[data-chat]');
  if (ch) {
    if (S.drawerId) closeDrawer();
    const q = S.view === 'search' && S.q ? S.q : null;
    const [ocs, ocp] = sessionById(ch.dataset.chat);
    if (ocs && isOpenClaw(ocs)) { await ChatUI.openOc({ id: ocs.id, sessionId: ocs.sessionId, title: ocs.title, agent: ocs.agent, cwd: ocs.cwd, folder: ocp ? ocp.name : null }); if (q && ChatUI.isOpen()) ChatUI.find(q); return undefined; }
    await ChatUI.open({ sessionId: ch.dataset.chat });
    if (q && ChatUI.isOpen()) ChatUI.find(q);
    return undefined;
  }
  const wt = t.closest('[data-watch]'); if (wt) { if (S.drawerId) closeDrawer(); return ChatUI.watch({ sessionId: wt.dataset.watch, source: 'terminal' }); }
  const o = t.closest('[data-open]'); if (o) return resume(o.dataset.open, 'resume');
  const m = t.closest('[data-more]'); if (m) return m.getAttribute('aria-expanded') === 'true' ? closeMenu() : chatMenu(m, m.dataset.more);
  const pv = t.closest('[data-preview]'); if (pv) return openDrawer(pv.dataset.preview);
  if (t.closest('[data-dclose]')) return closeDrawer();
  const hero = t.closest('[data-hero]');
  if (hero) {
    if (hero.dataset.hero === 'first') return openActivity(awaiting()[0]);
    if (hero.dataset.hero === 'switch') return useAccount(hero.dataset.acct);
    if (hero.dataset.hero === 'latest') return ChatUI.open({ sessionId: hero.dataset.sid });
  }
  const v = t.closest('[data-view]'); if (v) return go(v.dataset.view, v.dataset.cwd, v.dataset.prov);
  const rf = t.closest('[data-recent]'); if (rf) { S.recentProv = rf.dataset.recent; store('recentProv', S.recentProv); return renderRecent(); }
  const b = t.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'acct-more') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : accountMenu(b, b.dataset.acct);
  if (act === 'add') return addAccount();
  if (act === 'usage-all') return refreshUsage();
  if (act === 'search-again') return openPalette(S.q);
  if (b.dataset.acct || ['signin', 'signin-direct', 'lock', 'unlock'].includes(act)) return accountAction(act, b.dataset.acct);
  const a = current();
  if (act === 'new') return reportLaunch(await api('/api/new', { account: a.id, cwd: S.folder }), `Starting a new chat as ${a.name}`);
  if (act === 'newchat') return ChatUI.open({ cwd: S.folder, mode: 'new' });
  if (act === 'newcodex') return ChatUI.open({ cwd: S.folder, mode: 'new', provider: 'codex' });
  if (act === 'newcodex-term') return reportLaunch(await api('/api/new', { provider: 'codex', cwd: S.folder }), 'Starting a new Codex chat');
  if (b.dataset.acct && act.startsWith('codex-')) await setCodexActive(b.dataset.acct);
  if (act === 'codex-signin') return codexSignIn();
  if (act === 'codex-check') { const r = await api('/api/codex/check', {}); S.codex = r.codex; S.usage = r.usage || S.usage; renderAll(); return toast(S.codex.signedIn ? `${S.codex.name} is ready.` : (S.codex.error || 'Still not ready.'), 4000); }
  if (act === 'codex-install') return codexInstall();
  if (act === 'codex-more') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : codexMenu(b);
  if (act === 'codex-new') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : codexNewMenu(b);
  if (act === 'world-new') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : worldNewMenu(b, b.dataset.cwd);
  if (act === 'world-prompt') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : promptMenu(b, S.folder);
  if (act === 'project-new') return openNewProject();
  if (act === 'world-more') return b.getAttribute('aria-expanded') === 'true' ? closeMenu() : worldMenu(b);
  if (act === 'reveal') { const r = await api('/api/reveal', { cwd: S.folder }); if (r.dryRun) toast(`Would run: ${r.script}`); return; }
  if (act === 'browse') return Viewer.open({ path: S.folder, cwd: S.folder });
  if (act === 'pin') { S.pins.has(S.folder) ? S.pins.delete(S.folder) : S.pins.add(S.folder); savePins(); renderNav(); renderPage(); }
});
$('page').addEventListener('click', pageClicks);
$('drawer').addEventListener('click', pageClicks);

// Quick replies from the hub: type on the card, Enter sends, without opening the chat.
async function sendQuick(form) {
  const card = form.closest('.omen'); const x = card && findActivity(card.dataset.k);
  const ta = form.querySelector('textarea'); const text = ta.value.trim();
  if (!x || !text) return;
  form.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
  try {
    await api('/api/chat/send', { key: x.key, text });
    ta.value = ''; markSeen(x);
    toast(`Sent to ${x.title || 'the chat'}.`, 2200);
  } finally { form.querySelectorAll('button, textarea').forEach(el => { el.disabled = false; }); }
}
$('page').addEventListener('submit', e => { const f = e.target.closest('form.qr'); if (!f) return; e.preventDefault(); wrap(sendQuick)(f); });
$('page').addEventListener('keydown', e => {
  if (e.target.matches('form.qr textarea')) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); wrap(sendQuick)(e.target.closest('form')); }
    return;
  }
  if (e.target.matches('.wt') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const tabs = [...document.querySelectorAll('.wtabs .wt')], i = tabs.indexOf(e.target);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); S.worldTab = tabs[j].dataset.wtab; renderWorldBody(); tabs[j].focus(); return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const row = document.activeElement.closest('.row'); if (!row) return;
  const btns = [...$('page').querySelectorAll('.r-title')];
  const i = btns.indexOf(row.querySelector('.r-title'));
  btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); e.preventDefault();
});
$('page').addEventListener('input', e => { if (e.target.id === 'docFilter') { S.docFilter = e.target.value; return filterDocs(); } if (e.target.matches('form.qr textarea')) { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; } });

document.addEventListener('keydown', e => {
  const typing = e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return $('palette').hidden ? openPalette() : closePalette(); }
  if (!$('palette').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === '/' && !typing && !document.body.classList.contains('chat-open')) { e.preventDefault(); return openPalette(); }
  if (e.key === 'Escape') {
    if (document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); return; }
    if (!$('drawer').hidden && $('menu').hidden) { const id = S.drawerId; closeDrawer(); document.querySelector(`[data-preview="${CSS.escape(id || '')}"]`)?.focus(); }
  }
});

/* ---------- live updates ---------- */
let es = null, sessTimer = null;
// Pages behind the chat window, a dialog or a menu wait until they're visible again.
const idle = () => !document.hidden && !document.body.classList.contains('chat-open') && !document.querySelector('dialog[open]') && $('menu').hidden;
function connectLive() {
  try { es = new EventSource(`/api/events?token=${TOKEN}`); } catch { return; }
  es.onopen = () => { S.connected = true; renderLivePill(); Promise.all([loadActivity(), loadUsage()]).then(() => { watchActivity(); renderLive(); }).catch(() => {}); };
  es.onerror = () => { S.connected = false; renderLivePill(); setTimeout(() => api('/api/state').catch(() => {}), 4000); };
  es.addEventListener('sessions', () => {
    clearTimeout(sessTimer);
    sessTimer = setTimeout(wrap(async () => {
      await loadSessions(); renderNav();
      if (window.ChatUI && ChatUI.sessionsChanged) ChatUI.sessionsChanged();
      if (S.view === 'search') return;
      if (S.view === 'hub') { if ($('recentList') || !S.projects.length) renderHubLists(); else renderHub(); renderLive(); } else renderPage();
      if (S.drawerId) openDrawer(S.drawerId, true);
    }), 300);
  });
  es.addEventListener('accounts', wrap(async () => { await loadState(); renderNav(); if (S.view === 'hub') renderLive(); else renderPage(); codexLoginProgress(); if (window.ChatUI && ChatUI.refreshCrew) ChatUI.refreshCrew(); }));
  es.addEventListener('running', e => { try { S.running = JSON.parse(e.data); } catch { /* keep */ } if (S.view !== 'hub' && S.view !== 'search' && idle()) renderPage(); renderNav(); });
  es.addEventListener('live', e => { try { S.live = JSON.parse(e.data); } catch { /* keep */ } if (S.view !== 'hub' && S.view !== 'search' && idle()) renderPage(); });
  es.addEventListener('activity', e => { try { S.activity = JSON.parse(e.data).list || []; } catch { return; } watchActivity(); renderLive(); renderNav(); });
  es.addEventListener('usage', e => { try { S.usage = JSON.parse(e.data) || {}; } catch { return; } renderLive(); renderNav(); if (window.ChatUI && ChatUI.refreshUsage) ChatUI.refreshUsage(); });
}
setInterval(() => { if (idle() && S.view === 'hub' && !document.activeElement.closest('form.qr')) renderLive(true); else renderBar(); }, 60000);
window.addEventListener('focus', () => { watchActivity(); renderLive(); });

/* ---------- confirmations ---------- */
// Asks before something that's hard to undo. The first paragraph is the question; the rest explains.
function appConfirm(text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  let d = $('confirmDlg');
  if (!d) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="confirmDlg" class="confirm-dlg"><form method="dialog"><h3 id="cfQ"></h3><p id="cfX"></p><div class="d-row"><button class="btn" value="cancel" id="cfNo"></button><button class="btn prime" value="ok" id="cfYes"></button></div></form></dialog>`);
    d = $('confirmDlg');
    // The answer is taken the moment it's given, so a question asked right after can't pick up this one's.
    const answer = v => { const r = d._resolve; d._resolve = null; if (r) r(v); };
    d.querySelector('form').addEventListener('submit', e => answer(e.submitter?.value === 'ok'));
    // Esc answers this question only, never the dialog underneath it.
    d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(false); d.close('cancel'); } });
    d.addEventListener('close', () => { if (!d.open) answer(d.returnValue === 'ok'); });
  }
  const [q, ...rest] = String(text).split(/\n\n/);
  $('cfQ').textContent = q; $('cfX').textContent = rest.join('\n\n'); $('cfX').hidden = !rest.length;
  $('cfYes').textContent = ok; $('cfNo').textContent = cancel;
  $('cfYes').className = `btn ${danger ? 'danger-prime' : 'prime'}`;
  d.returnValue = '';
  if (d._resolve) d._resolve(false);
  return new Promise(resolve => {
    d._resolve = resolve;
    if (!d.open) d.showModal();
    $(danger ? 'cfNo' : 'cfYes').focus();
  });
}
window.appConfirm = appConfirm;
async function quitApp() {
  if (!(await appConfirm('Quit Session Switcher?\n\nChats in terminals keep running; chats in its window stop. Start it again from its shortcut.', { ok: 'Quit', danger: true }))) return;
  await api('/api/quit', {}); document.body.innerHTML = '<p style="padding:40px;font-family:var(--f-body)">Session Switcher has quit. You can close this window.</p>';
}

/* ---------- right-click (and long-press on a phone) ---------- */
// Every chat, project, card and picture has its own menu; empty space gets the app's menu.
// Shift+right-click still opens the browser's own menu, and text boxes keep theirs.
async function copyText(text, what = 'Copied.') {
  try { await navigator.clipboard.writeText(text); toast(what, 1600); } catch { prompt('Copy this:', text); }
}
function projectItems(cwd) {
  const p = S.projects.find(x => x.cwd === cwd); if (!p) return [];
  const a = current();
  return [
    { glyph: '❖', label: `Open ${p.name}`, run: () => go('folder', cwd) },
    { glyph: S.pins.has(cwd) ? '☆' : '★', label: S.pins.has(cwd) ? 'Unpin from the sidebar' : 'Pin to the sidebar', run: () => togglePin(cwd) },
    ...(p.sessions[0] && p.exists ? [{ glyph: '❝', label: 'Continue the latest chat', hint: p.sessions[0].title, run: () => ChatUI.open({ sessionId: p.sessions[0].id }) }] : []),
    '-',
    { glyph: '✦', label: 'New Claude chat', hint: `as ${a.name}`, disabled: !canLaunch(a) || !p.exists, why: a.lockMessage || 'Sign in first', run: () => ChatUI.open({ cwd, mode: 'new' }) },
    ...(S.codex && S.codex.enabled ? [{ glyph: '◆', label: 'New Codex chat', disabled: !codexReady() || !p.exists, why: 'Sign in to Codex first', run: () => ChatUI.open({ cwd, mode: 'new', provider: 'codex' }) }] : []),
    ...(S.prompts.length ? [{ glyph: '❡', label: 'Start with a prompt…', disabled: !p.exists, run: () => showMenu(Ctx.at, worldNewItems(cwd).filter(x => x !== '-' && /^Start with|Edit prompts/.test(x.label || ''))) }] : []),
    '-',
    { label: S.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer', disabled: !p.exists || window.REMOTE, why: window.REMOTE ? 'Only on the PC' : 'The folder is gone', run: async () => { const r = await api('/api/reveal', { cwd }); if (r.dryRun) toast(`Would run: ${r.script}`); } },
    { label: 'Browse files', disabled: !p.exists, run: () => Viewer.open({ path: cwd, cwd }) },
    { label: 'Copy folder path', run: () => copyText(cwd) },
    ...(p.added && !p.sessions.length ? ['-', { label: 'Remove from the list', hint: 'the folder itself stays', danger: true, run: async () => { await api('/api/project/forget', { cwd }); await loadSessions(); renderAll(); } }] : []),
  ];
}
function activityItems(x) {
  const st = statusOf(x);
  return [
    { glyph: '❝', label: x.source === 'app' ? 'Open the chat' : x.source === 'terminal' ? 'Watch it live' : 'Read it here', run: () => { markSeen(x); return openActivity(x); } },
    ...(st === 'reply' ? [{ glyph: '✓', label: 'Mark as read', run: () => { markSeen(x); renderLive(true); renderNav(); } }] : []),
    ...(x.source === 'app' && x.key && x.phase !== 'ended' ? [{ label: 'Stop this chat', danger: true, run: () => api('/api/chat/stop', { key: x.key }) }] : []),
    ...(x.sessionId && !x.parentKey ? ['-', favItem(x.sessionId), ...chatItems(x.sessionId).filter(i => i === '-' || !/^(Return|Open in the chat window)/.test(i.label))] : []),
    ...(x.sessionId ? ['-', { label: 'Copy chat ID', run: () => copyText(x.sessionId) }] : []),
  ];
}
function appItems() {
  const light = Look.isLight();
  return [
    { glyph: '✦', label: 'Search everything', keys: 'Ctrl K', run: () => openPalette() },
    { glyph: '+', label: 'New project', run: () => openNewProject() },
    { glyph: '◉', label: 'The hub', run: () => go('hub') },
    { glyph: '✧', label: 'Recent chats', run: () => go('recent') },
    '-',
    { glyph: light ? '☾' : '☀', label: light ? 'Dark mode' : 'Light mode', run: () => Look.set({ mode: light ? 'dark' : 'light' }) },
    { glyph: '◐', label: 'Appearance…', run: () => openSetup('look') },
    { glyph: '⚙', label: 'Setup', run: () => openSetup() },
    { glyph: '?', label: 'Keyboard shortcuts', keys: '?', run: () => openShortcuts() },
    '-',
    { label: 'Reload the window', keys: 'F5', run: () => location.reload() },
  ];
}
function linkItems(a) {
  const url = a.href;
  return [
    { glyph: '↗', label: 'Open link', hint: a.host, run: () => window.open(url, '_blank', 'noopener') },
    { label: 'Copy link', run: () => copyText(url) },
  ];
}
const Ctx = { at: null };
function contextItems(t) {
  // The chat window knows its own pieces (replies, code, pictures, files, the crew).
  if (window.ChatUI && ChatUI.isOpen() && t.closest('#chat')) { const it = ChatUI.contextItems(t, Ctx.at); if (it) return it; }
  const withFav = id => [favItem(id), '-', ...chatItems(id), '-', { label: 'Copy chat ID', run: () => copyText(id) }];
  const nc = t.closest('[data-navchat]'); if (nc) return [{ glyph: '❝', label: 'Open', run: () => openChatFromNav(nc.dataset.navchat) }, ...withFav(nc.dataset.navchat)];
  const row = t.closest('[data-row]'); if (row) return withFav(row.dataset.row);
  const pv = t.closest('[data-preview], [data-continue]'); if (pv) return withFav(pv.dataset.preview || pv.dataset.continue);
  const card = t.closest('#awaitList > [data-k], #board > [data-k], #quietList > [data-k], #cRailList > [data-k]');
  if (card) { const x = findActivity(card.dataset.k); if (x) return activityItems(x); }
  const world = t.closest('#atlas > [data-k], [data-world], .nav-i[data-cwd]');
  if (world) { const cwd = world.dataset.world || world.dataset.cwd || (world.dataset.k !== '+new' ? world.dataset.k : null); if (cwd) return projectItems(cwd); }
  const acct = t.closest('[data-acct-card], [data-acct]'); const aid = acct && (acct.dataset.acctCard || acct.dataset.acct); if (aid && S.accounts.some(a => a.id === aid)) return accountItems(aid);
  if (t.closest('.codex-card')) return null;
  if (t.closest('#usechip')) { openAcctPop(); return []; }
  const link = t.closest('a[href^="http"]'); if (link) return linkItems(link);
  if (t.closest('dialog[open], .palette:not([hidden]), #acctPop')) return null;
  return appItems();
}
document.addEventListener('contextmenu', e => {
  if (e.shiftKey || e.defaultPrevented) return;
  const t = e.target;
  if (!(t instanceof Element) || t.closest('input, textarea, select, [contenteditable="true"]')) return;
  const coarse = matchMedia('(pointer: coarse)').matches;
  // On a phone, a long press on text is for selecting it; only cards, pictures and controls get a menu.
  if (coarse && !t.closest('[data-row], [data-k], [data-world], .world, .gen, .thumb, .crew, .ri, .af-file, .umsg, .turn .who, .tool > summary, .nav-i')) return;
  if (e.button !== 2 && !e.clientX && !e.clientY) { const r = t.getBoundingClientRect(); Ctx.at = { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height, 28) }; }
  else Ctx.at = { x: e.clientX, y: e.clientY };
  const items = contextItems(t);
  if (items === null) return;
  e.preventDefault();
  if (items.length) showMenu(Ctx.at, items);
});

/* ---------- keyboard shortcuts sheet (press ?) ---------- */
function openShortcuts() {
  let d = $('keysDlg');
  if (!d) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="keysDlg" class="keys-dlg" aria-labelledby="keysTitle"><div class="setup-head"><h3 id="keysTitle">Keyboard shortcuts</h3><button class="icon" data-keys-close aria-label="Close">✕</button></div>
      <div class="keys-body">${[
        ['Anywhere', [['Ctrl K', 'Search chats, projects, documents, prompts and actions'], ['?', 'This list'], ['Right-click', 'Options for whatever you clicked (Shift for the browser’s menu)'], ['Esc', 'Close what’s open']]],
        ['In a chat', [['Enter', 'Send'], ['Shift Enter', 'New line'], ['Ctrl F', 'Find in this chat'], ['Ctrl .', 'Write to Claude or Codex'], ['@codex', 'Send one message to Codex'], ['/model sonnet', 'Switch model'], ['/effort high', 'Switch effort'], ['/', 'Pick a saved prompt'], ['Esc', 'Stop the one you’re writing to'], ['Alt ↑ Alt ↓', 'Switch between running chats'], ['End', 'Jump to the latest message']]],
        ['Pictures', [['← →', 'Step through a project’s pictures']]],
      ].map(([h, rows]) => `<section><p class="d-h">${esc(h)}</p><dl>${rows.map(([k, v]) => `<dt><kbd class="kbd">${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`).join('')}</div></dialog>`);
    d = $('keysDlg');
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-keys-close]')) d.close(); });
  }
  d.showModal();
}
document.addEventListener('keydown', e => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault(); openShortcuts();
});

// On a phone (through phone access), hide what only makes sense at the PC.
if (window.REMOTE) document.body.classList.add('remote');
if (window.Android || / SessionSwitcherAndroid\//.test(navigator.userAgent)) document.body.classList.add('android');
// iPhone and iPad (Safari or the Home Screen app): same touch tweaks as the Android app.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) document.body.classList.add('android', 'ios');
// The Android app's Back button: close whatever is on top. Returns true if something closed.
window.__mobileBack = () => {
  if (!$('cLight')?.hidden) { $('cLight').hidden = true; return true; }
  if (!$('menu').hidden) { closeMenu(); return true; }
  if (!$('acctPop').hidden) { closeAcctPop(); return true; }
  if (!$('palette').hidden) { closePalette(); return true; }
  for (const d of document.querySelectorAll('dialog[open]')) { d.close(); return true; }
  if (!$('drawer').hidden) { closeDrawer(); return true; }
  if (window.ChatUI && ChatUI.back()) return true;
  if (document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); return true; }
  if (S.view !== 'hub') { go('hub'); return true; }
  return false;
};

applyMotion();
petals();
renderLivePill();
wrap(async () => { await Promise.all([reload(), loadPrompts()]); connectLive(); watchActivity(); loadHealth(false).catch(() => {}); })();
