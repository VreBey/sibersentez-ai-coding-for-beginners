// The server process: its environment, readiness, the restart supervisor, requests over its message channel and
// stopping it on purpose (plan D8: from helpers.mjs, which re-exports it). Pure, no Electron.
import http from 'node:http';
import path from 'node:path';
import { HOST, INSTANCE_HEADER } from './shell-paths.mjs';

// ---------------------------------------------------------------- server process

// Variables never passed to the server. SIBERSENTEZ_ACTIONS: the installed app takes the actions mode only from the
// hub's settings.json, so this variable cannot switch actions on. That is not a security boundary: SIBERSENTEZ_HUB
// does reach the server and chooses which settings.json is read, and any program running as the same user can edit
// that file (docs/actions-toggle.md). Node/Electron switches and the shell's own QA/data settings do not belong to
// the server either.
const STRIPPED_ENV = ['SIBERSENTEZ_ACTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SIBERSENTEZ_QA_SHOT', 'SIBERSENTEZ_QA_QUIT_MS', 'SIBERSENTEZ_QA_DELAY_MS', 'SIBERSENTEZ_QA_ACTIONS', 'SIBERSENTEZ_QA_HIDDEN', 'SIBERSENTEZ_QA_PROBES', 'SIBERSENTEZ_QA_PROJECT_DIR', 'SIBERSENTEZ_DATA_DIR'];
const SET_ENV = ['SIBERSENTEZ_PORT', 'SIBERSENTEZ_HUB', 'SIBERSENTEZ_INSTANCE', 'SIBERSENTEZ_SESSION_KEY'];

// Environment for the server process. Names are compared case-insensitively (Windows environment).
// sessionKey (optional): the per-launch secret every /api request must carry (server/config.mjs SIBERSENTEZ_SESSION_KEY).
export function buildServerEnv(baseEnv, { port, hubPath, instance, sessionKey }) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    const k = key.toUpperCase();
    // The same variables under the product's old name (renamed 2026-09-30) are dropped too: the server would take
    // them over (server/config.mjs adoptLegacyEnv)
    const bare = k.startsWith('ORKESTRA_') ? 'SIBERSENTEZ_' + k.slice(9) : k;
    if (STRIPPED_ENV.includes(bare) || SET_ENV.includes(bare)) delete env[key];
  }
  env.SIBERSENTEZ_PORT = String(port);
  env.SIBERSENTEZ_INSTANCE = String(instance);
  if (sessionKey) env.SIBERSENTEZ_SESSION_KEY = String(sessionKey);
  if (hubPath) env.SIBERSENTEZ_HUB = hubPath;
  return env;
}

// One readiness probe. Requests the home page with headers that satisfy the server's own access rules
// (Host = 127.0.0.1:<port>, Sec-Fetch-Site = same-origin) and checks the instance header:
//   'ready'   200 and our instance id    'foreign' any answer without our instance id (another server)
//   'down'    no answer yet, or our instance but not 200 yet
export function probeServer(port, { instance, timeoutMs = 1500, host = HOST } = {}) {
  if (typeof instance !== 'string' || !instance) throw new TypeError('probeServer needs the instance id');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get(
      { host, port, path: '/', agent: false, timeout: timeoutMs, headers: { Host: `${host}:${port}`, 'Sec-Fetch-Site': 'same-origin' } },
      (res) => {
        res.resume();
        if (res.headers[INSTANCE_HEADER] !== instance) return finish('foreign');
        finish(res.statusCode === 200 ? 'ready' : 'down');
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish('down');
    });
    req.on('error', () => finish('down'));
  });
}

// Polls until: 'ready' | 'foreign' (another server owns the port; never load it) | 'timeout' | 'stopped'
export async function waitForServer(port, { instance, timeoutMs = 30000, intervalMs = 250, shouldStop = () => false, host = HOST } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (shouldStop()) return 'stopped';
    const r = await probeServer(port, { instance, host });
    if (shouldStop()) return 'stopped';
    if (r !== 'down') return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return 'timeout';
}

// Delay before a restart: 1 s, 2 s, 4 s ... capped at 30 s
export function restartDelay(attempt, { baseMs = 1000, maxMs = 30000 } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(maxMs, baseMs * 2 ** Math.min(n, 20));
}

// Restart supervisor as a pure state machine.
//   state  { failures, readyAt }     events  { type: 'ready', at } | { type: 'failed', at } | { type: 'requested', at }
// A server that stayed up for stableMs earns a fresh start (failures = 0), but that credit is used once:
// readyAt is cleared on every failure, so a later crash loop at startup backs off and finally gives up.
// 'requested' is a restart the shell asks for itself (a server setting changed): it is not a failure, so it never
// raises the count, never waits for a backoff delay and never gives up. A run that was stable by then ends with a
// fresh start, exactly as a later failure would have found it.
export const SUPERVISOR_DEFAULTS = Object.freeze({ maxFailures: 5, stableMs: 60000, baseMs: 1000, maxMs: 30000 });

export function initialSupervisor() {
  return { failures: 0, readyAt: 0 };
}

// After the page's renderer is gone (a crash, out of memory): reload it after 1, 2, 4 s; the third loss within two
// minutes stops reloading, so a page that crashes on load does not start a renderer every second (pure). times: the
// earlier losses (ms); returns { times, delayMs } or { times, delayMs: null } when it stops.
const RENDERER_RELOAD = Object.freeze({ windowMs: 120000, maxLosses: 3, baseMs: 1000 });
export function rendererReloadPlan(times, now, c = RENDERER_RELOAD) {
  const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < c.windowMs).concat(now);
  if (recent.length >= c.maxLosses) return { times: recent, delayMs: null };
  return { times: recent, delayMs: c.baseMs * 2 ** (recent.length - 1) };
}

export function superviseStep(state, event, options = {}) {
  const c = { ...SUPERVISOR_DEFAULTS, ...options };
  const s = state || initialSupervisor();
  if (event?.type === 'ready') return { state: { failures: s.failures, readyAt: event.at }, action: { type: 'none' } };
  if (event?.type === 'requested') {
    const stable = s.readyAt > 0 && event.at - s.readyAt >= c.stableMs;
    return { state: { failures: stable ? 0 : s.failures, readyAt: 0 }, action: { type: 'restart', delayMs: 0, attempt: 0 } };
  }
  if (event?.type !== 'failed') throw new Error(`unknown supervisor event: ${event?.type}`);
  const stable = s.readyAt > 0 && event.at - s.readyAt >= c.stableMs;
  const failures = stable ? 0 : s.failures;
  if (failures >= c.maxFailures) return { state: { failures, readyAt: 0 }, action: { type: 'give-up', failures } };
  return {
    state: { failures: failures + 1, readyAt: 0 },
    action: { type: 'restart', delayMs: restartDelay(failures, c), attempt: failures + 1 },
  };
}

// What to do when a scheduled restart is due. A launch that is still running (e.g. still waiting for the
// server to answer) must not swallow the restart: it is checked again shortly instead of being dropped.
export const RESTART_RECHECK_MS = 250;

export function restartDue({ quitting = false, launching = false, serverAlive = false } = {}) {
  if (quitting) return { type: 'drop', reason: 'quitting' };
  if (launching) return { type: 'wait', delayMs: RESTART_RECHECK_MS };
  if (serverAlive) return { type: 'drop', reason: 'a server is already running' };
  return { type: 'launch' };
}

// What the shell does after it changed a setting the server reads only when it starts (the actions mode):
//   'restart-now'   a server is running: stop it on purpose and start a new one (a 'requested' restart)
//   'after-launch'  a launch is running: its process may have read the old value, restart it once it is ready
//   'next-launch'   no server and no launch (a restart may be scheduled): the next process reads the new value
//   'none'          the app is quitting
export function settingsRestartPlan({ quitting = false, launching = false, serverAlive = false } = {}) {
  if (quitting) return 'none';
  if (launching) return 'after-launch';
  if (serverAlive) return 'restart-now';
  return 'next-launch';
}

// Requests from the shell to its server process over the process's own message channel (utilityProcess:
// postMessage / process.parentPort; the development fallback: child_process ipc). Only the shell can send on it: the
// page reaches it only through the bridge above, and nothing else can reach a child's message channel.
//   call(target, type, fields)  target: the server handle ({ alive, post(msg) }); resolves the server's reply, or
//                               { ok: false, reason: 'no-server' | 'timeout' }
//   receive(target, msg)        a message from a server process; only a reply to a pending call of that very process
//                               settles it (true), anything else is ignored (false)
//   drop(target)                the process is gone: its pending calls settle with 'no-server'
// Messages: { sibersentez: 'shell-call', id, type, ...fields } and back { sibersentez: 'shell-reply', id, ok, ... }.
const SERVER_CALL_TIMEOUT_MS = 15000;

export function createServerCalls({ timeoutMs = SERVER_CALL_TIMEOUT_MS } = {}) {
  let seq = 0;
  const pending = new Map(); // id -> { target, resolve, timer }
  const settle = (id, value) => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
    return true;
  };
  function call(target, type, fields = {}) {
    if (!target || target.alive !== true || typeof target.post !== 'function') return Promise.resolve({ ok: false, reason: 'no-server' });
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: 'timeout' }), timeoutMs);
      timer.unref?.();
      pending.set(id, { target, resolve, timer });
      try {
        target.post({ ...fields, sibersentez: 'shell-call', id, type });
      } catch {
        settle(id, { ok: false, reason: 'no-server' });
      }
    });
  }
  function receive(target, msg) {
    if (!msg || typeof msg !== 'object' || msg.sibersentez !== 'shell-reply' || !Number.isInteger(msg.id)) return false;
    const p = pending.get(msg.id);
    if (!p || p.target !== target) return false;
    return settle(msg.id, msg);
  }
  function drop(target) {
    for (const [id, p] of [...pending]) if (p.target === target) settle(id, { ok: false, reason: 'no-server' });
  }
  return { call, receive, drop, pending: () => pending.size };
}

// Run in the window's page by the shell (webContents.executeJavaScript) when "New project…" is chosen in the tray: the
// page starts its own new-project flow (which asks the shell through the bridge, like the header button) and answers
// true. The script carries no data; anything else (an older page, no bridge, an error) answers false.
export const NEW_PROJECT_SCRIPT = "(() => { try { return window.sibersentezNewProject?.start?.() === true; } catch { return false; } })()";

// How long the shell waits for the page to take "New project…" (a window that is only now loading needs a moment)
export const NEW_PROJECT_HANDOVER_MS = 5000;

// "New project…" in the tray as one flow; main.mjs passes in the Electron parts:
//   windowReady  the window shows the server origin right now (not while the server restarts, not an error page)
//   show()       bring the window up             handOver()  run NEW_PROJECT_SCRIPT in the page; resolves true if taken
//   notify()     a short tray balloon: SiberSentez is getting ready, try again in a few seconds (S.newProjectNotReady*)
// Never silent: a window that cannot take the request yet gets the balloon instead (and is not brought up), a page
// that does not take it within the time limit is logged. Returns 'handed-over' | 'not-taken' | 'not-ready'.
export async function newProjectFromTray({ windowReady = false, show, handOver, notify, log = () => {} }) {
  if (windowReady !== true) {
    log('new project: the window is not ready (server starting or an error page); the tray says so');
    notify();
    return 'not-ready';
  }
  show();
  let took = false;
  try {
    took = (await handOver()) === true;
  } catch {
    took = false;
  }
  if (!took) log('new project: the page did not take the request');
  return took ? 'handed-over' : 'not-taken';
}

// ---------------------------------------------------------------- stopping a server process on purpose

// Resolves true when handle.exited settles within ms, false otherwise
function exitedWithin(handle, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    Promise.resolve(handle.exited).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Stops a server process the shell no longer wants (a requested restart): kill(), wait up to waitMs for its exit,
// then forceKill() and wait again. Resolves 'exited' | 'forced' | 'stuck'; a stuck process stays the caller's to
// stop when the app quits. handle: { alive, exited: Promise, kill(), forceKill() }.
export async function stopServerProcess(handle, { waitMs = 5000 } = {}) {
  if (!handle?.alive) return 'exited';
  try {
    handle.kill();
  } catch {
    /* the force kill below still runs */
  }
  if (await exitedWithin(handle, waitMs)) return 'exited';
  try {
    handle.forceKill();
  } catch {
    /* reported as stuck below */
  }
  return (await exitedWithin(handle, waitMs)) ? 'forced' : 'stuck';
}
