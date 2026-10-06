// Action client: talks to the server's action endpoints (GET /api/actions, POST /api/action).
// Actions are off by default; if /api/actions answers 404 (or cannot be reached at all) the mode is 'off'
// and the UI behaves like the read-only panel it is today. The token lives in memory only and is written nowhere.
// The module touches neither the DOM nor the network while loading (node tests import it).

const MODES = new Set(['off', 'dry', 'live']);
const TOKEN_RE = /^[0-9a-f]{64}$/;

// The fields each action may carry: the server's allow list (server/actions.mjs FIELDS and SKILL_FIELDS), required
// and optional together. A request body is built from this list only, so no other key (a path, a command, free text)
// ever reaches the server. Launch actions first, then the skill flow (docs/skills-flow.md §4), in the server's order.
export const ACTION_FIELDS = Object.freeze({
  resume: Object.freeze(['sessionId', 'projectId', 'packages']),
  fork: Object.freeze(['sessionId', 'projectId', 'packages']),
  new: Object.freeze(['projectId', 'packages']),
  // A plain terminal in the project or session folder (docs/terminal.md); no command is ever sent
  terminal: Object.freeze(['projectId', 'sessionId']),
  // open: only 'index.html' (the project's own web page in the browser; docs/run-hint.md)
  explorer: Object.freeze(['projectId', 'sessionId', 'open']),
  vscode: Object.freeze(['projectId', 'sessionId']),
  'library-scan': Object.freeze(['source']),
  'library-import': Object.freeze(['source', 'items']),
  // A listed skill or agent into the library by kind and name (docs/skills-flow.md §5.1): the server knows where it lives
  'library-adopt': Object.freeze(['items']),
  'skills-preview': Object.freeze(['projectId', 'items', 'targets']),
  'skills-install': Object.freeze(['projectId', 'items', 'targets']),
  'skills-remove': Object.freeze(['projectId', 'items', 'targets', 'plan']),
  'skills-trial': Object.freeze(['projectId', 'items']),
  // Automatic fit (docs/auto-skills.md §3): candidate keys of the fit; without keys the server applies its automatic selection
  'skills-apply': Object.freeze(['projectId', 'keys', 'targets']),
  // Restore points (docs/restore.md): a project and one of its points by id
  'restore-preview': Object.freeze(['projectId', 'pointId']),
  'restore-apply': Object.freeze(['projectId', 'pointId', 'planId']),
  // An AI tool in a terminal (docs/ai-start.md): a tool id and whether the saved idea becomes its first message
  'start-ai': Object.freeze(['projectId', 'sessionId', 'tool', 'withIdea', 'resume', 'job', 'inDock']),
  // GitHub import (docs/github-import.md §6): a link, a download id, import picks, library items to check
  'github-fetch': Object.freeze(['url']),
  'github-import': Object.freeze(['fetchId', 'items']),
  'github-discard': Object.freeze(['fetchId']),
  'github-check-update': Object.freeze(['items']),
});
// Actions whose items are import picks ({ path, category, replace? }); every other action names items by { kind, name }
const PICK_ACTIONS = new Set(['library-import', 'github-import']);
export const ACTION_NAMES = Object.freeze(Object.keys(ACTION_FIELDS));
const MAX_PACKAGES = 10;

let state = { mode: 'off', token: null };
let fetchImpl = (...a) => globalThis.fetch(...a);
let initPromise = null;
let initSeq = 0; // two quick mode changes: only the latest answer counts
const listeners = new Set();
const inflight = new Set(); // the same action + the same target is not sent a second time before the answer comes

function setState(next) {
  const changed = next.mode !== state.mode || next.token !== state.token;
  state = next;
  if (changed) for (const fn of listeners) {
    try {
      fn(actionsState());
    } catch (e) {
      console.error(e);
    }
  }
}

// Tell the listeners when the mode changes (e.g. the server restarted with actions off)
export function onActionsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// GET /api/actions. 404 → off. An error or network problem → off (the safe side).
// fetch can be injected in a test: initActions({ fetch })
export function initActions(opts = {}) {
  if (opts.fetch) fetchImpl = opts.fetch;
  const seq = ++initSeq;
  const apply = (next) => seq === initSeq && setState(next);
  const run = (async () => {
    try {
      const res = await fetchImpl('/api/actions', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) {
        apply({ mode: 'off', token: null });
      } else {
        const d = await res.json();
        const mode = d && MODES.has(d.mode) && d.mode !== 'off' ? d.mode : 'off';
        const token = d && typeof d.token === 'string' && TOKEN_RE.test(d.token) ? d.token : null;
        apply(mode !== 'off' && token ? { mode, token } : { mode: 'off', token: null });
      }
    } catch {
      apply({ mode: 'off', token: null });
    }
    return actionsState();
  })();
  initPromise = run;
  return run;
}

// For those who want to wait until the first mode answer arrives (QA hooks)
export function actionsReady() {
  return initPromise || Promise.resolve(actionsState());
}

export function actionsState() {
  return { mode: state.mode, token: state.token };
}

async function post(body) {
  const res = await fetchImpl('/api/action', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-SiberSentez-Token': state.token || '' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') data = { ok: false, error: 'bad-response' };
  if (!res.ok && data.ok !== false) data.ok = false;
  data.status = res.status;
  return data;
}

// POST /api/action: the one way the page sends an action (context menu, drawer, roster tab). The body carries the
// action name and only the fields of that action (actionBody). Local errors are English codes the UI maps to text:
// actions-off, unknown-action, in-flight, mode-changed, network, bad-response.
// Always resolves to an object: { ok, mode?, action?, argv?, plan?, result?, sessionId?, error?, hint?, status }
export async function runAction(body) {
  if (state.mode === 'off' || !state.token) return { ok: false, error: 'actions-off', status: 0 };
  const clean = actionBody(body);
  if (!clean) return { ok: false, error: 'unknown-action', status: 0 };
  // The same request (same action and fields) is not sent again before it answers
  const key = JSON.stringify(clean);
  if (inflight.has(key)) return { ok: false, error: 'in-flight', status: 0, busy: true };
  inflight.add(key);
  try {
    let r = await post(clean);
    if (r.status === 404 && r.error === 'actions-off') {
      // The server restarted with actions off ('actions-off' is its error code; a 404 can also mean
      // "project or session not found", which keeps the mode)
      setState({ mode: 'off', token: null });
      return r;
    }
    if (r.status === 403) {
      // A 403 means the request was refused before anything ran; after a restart the token changed, so the mode
      // and token are read again. The request is resent ONLY when the mode stayed the same: a request confirmed in
      // dry mode (say "Yes, install") must never reach a server that restarted live; the user sees the new mode and
      // decides again.
      const beforeToken = state.token;
      const beforeMode = state.mode;
      await initActions();
      if (state.mode !== beforeMode) return { ok: false, status: 409, modeChanged: true, error: 'mode-changed' };
      if (state.mode !== 'off' && state.token && state.token !== beforeToken) r = await post(clean);
    }
    return r;
  } catch {
    return { ok: false, error: 'network', status: 0 };
  } finally {
    inflight.delete(key);
  }
}

// Request body of an action (pure): the action name plus the fields ACTION_FIELDS allows for it, each in its shape.
// Unknown action -> null (nothing is sent). An empty value is left out (the server then names the missing field).
export function actionBody(b) {
  const action = typeof b?.action === 'string' ? b.action : '';
  if (!Object.hasOwn(ACTION_FIELDS, action)) return null;
  const out = { action };
  for (const k of ACTION_FIELDS[action]) {
    const v = b[k];
    if (k === 'projectId' || k === 'sessionId' || k === 'source' || k === 'url' || k === 'fetchId' || k === 'pointId' || k === 'planId') {
      if (v !== undefined && v !== null && v !== '') out[k] = String(v);
    } else if (k === 'packages') {
      if (Array.isArray(v) && v.length) out.packages = v.map(String).slice(0, MAX_PACKAGES);
    } else if (k === 'items') {
      // Import picks are { path, category, replace? }; every other action names items by { kind, name }
      if (Array.isArray(v)) out.items = v.map((it) => (PICK_ACTIONS.has(action) ? importPick(it) : { kind: String(it?.kind ?? ''), name: String(it?.name ?? '') }));
    } else if (k === 'keys') {
      // Candidate keys (kind:name or kind:name@label) as strings. An empty list is sent as it is, never dropped:
      // without keys the server applies its automatic selection, and "nothing chosen" must not turn into that
      // (the server refuses an empty list). Nothing is cut either: the drawer never offers more than the server takes.
      if (Array.isArray(v)) out.keys = v.map(String);
    } else if (k === 'targets') {
      if (Array.isArray(v) && v.length) out.targets = v.map(String);
    } else if (k === 'plan') {
      if (v === true) out.plan = true;
    } else if (k === 'open') {
      // explorer: only the project's own web page (the server takes nothing else)
      if (v === 'index.html') out.open = v;
    } else if (k === 'tool') {
      // start-ai: a tool id (the server checks it against its own list)
      if (typeof v === 'string' && v) out.tool = v;
    } else if (k === 'withIdea') {
      if (typeof v === 'boolean') out.withIdea = v;
    } else if (k === 'resume') {
      // start-ai: continue a closed Claude Code session through the launcher (the dock can run it)
      if (v === true) out.resume = true;
    } else if (k === 'inDock') {
      // start-ai: run in the window's own terminal (the dock); dropping it sent every start to Windows Terminal
      if (v === true) out.inDock = true;
    } else if (k === 'job') {
      // start-ai: "Do a job", the job the person typed (the server cleans it and keeps at most 300 characters)
      if (typeof v === 'string' && v.trim()) out.job = v.slice(0, 1200);
    }
  }
  return out;
}

function importPick(it) {
  const out = { path: String(it?.path ?? ''), category: String(it?.category ?? '') };
  if (it?.replace === true) out.replace = true;
  return out;
}

// Command summary for a notice: argv joined, at most 120 characters.
// If it is long, long paths are shortened (…\last\two) and the program name + a meaningful tail is shown
// (--resume <uuid>, -Project/-Package …): the user sees which session/package would be used.
export function argvSummary(argv, max = 120) {
  if (!Array.isArray(argv) || !argv.length) return '';
  // An argument with spaces is shown in quotes; if it is already quoted (explorer.exe "<folder>") it is not wrapped again.
  // An empty argument (start's window title in the terminal fallback) shows as "" the way the command line gets it.
  const quote = (a) => (a === '' ? '""' : /\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);
  const full = argv.map((a) => quote(String(a))).join(' ');
  if (full.length <= max) return full;
  const shortPath = (a) => {
    const q = /^".*"$/.test(a);
    const raw = q ? a.slice(1, -1) : a;
    if (raw.length <= 32 || !/[\\/]/.test(raw)) return a;
    const segs = raw.split(/[\\/]/).filter(Boolean);
    const out = '…\\' + segs.slice(-2).join('\\');
    return q || /\s/.test(out) ? `"${out}"` : out;
  };
  const parts = argv.map((a) => shortPath(quote(String(a))));
  const s = parts.join(' ');
  if (s.length <= max) return s;
  const head = parts[0];
  const room = max - head.length - 3; // " … "
  const tail = [];
  let len = 0;
  for (let i = parts.length - 1; i > 0; i--) {
    const add = parts[i].length + (tail.length ? 1 : 0);
    if (len + add > room) break;
    tail.unshift(parts[i]);
    len += add;
  }
  if (!tail.length) return s.slice(0, max - 1) + '…';
  return `${head} … ${tail.join(' ')}`;
}

// Reset the state between tests
export function _resetActionsForTest() {
  state = { mode: 'off', token: null };
  initPromise = null;
  inflight.clear();
  listeners.clear();
  fetchImpl = (...a) => globalThis.fetch(...a);
}
