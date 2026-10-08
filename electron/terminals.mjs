// Embedded terminals (docs/embedded-terminal.md): pseudo consoles in the shell's main process, shown in the window's
// dock. The page reaches them only through the preload bridge of the SiberSentez window (never over HTTP), sends ids and
// keystrokes, never a path or a command line: the folder comes from the server's own checks (terminal-target), the
// program is fixed here. Pure over its parts (spawn, send, log) so the tests run it with a fake pty.
import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL_IPC = Object.freeze({
  open: 'sibersentez:term-open',
  write: 'sibersentez:term-write',
  resize: 'sibersentez:term-resize',
  close: 'sibersentez:term-close',
  list: 'sibersentez:term-list',
  data: 'sibersentez:term-data',
  exit: 'sibersentez:term-exit',
  toolEnd: 'sibersentez:term-tool-end',
});
// The mark a launcher leaves next to itself when its tool ended (server/launch.mjs ENDED_SUFFIX): the tab's shell stays
// open, the AI does not run any more. Looked for this often while an AI tab waits for it.
export const ENDED_SUFFIX = '.ended';
export const TOOL_CHECK_MS = 1500;
export const MAX_TERMINALS = 8;
export const MAX_WRITE = 64 * 1024; // one write from the page (a paste included)
export const MAX_BUFFER = 256 * 1024; // kept per terminal, so a reloaded page shows what was there
export const BATCH_MS = 32; // pty output is sent to the window at most this often (one message per window)
export const HIGH_WATER = 128 * 1024; // bytes waiting for the next send; above it the pty is paused until the window passes
export const COLS = Object.freeze([2, 500]);
export const ROWS = Object.freeze([2, 200]);
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERM_ID = /^t[1-9][0-9]{0,6}$/;
// A tool id of the tools list (server/tools.mjs) and an app job id (server/job-id.mjs); anything else is dropped
const TOOL_ID = /^[a-z][a-z0-9-]{1,30}$/;
const JOB_ID = /^J[0-9a-f]{32}$/;
const LAUNCH_ID = /^L[0-9a-f]{24}$/;

// The shell every terminal starts: Windows PowerShell by its full path (the install commands the AI tools document are
// PowerShell); no profile-independent switches beyond -NoLogo, so the person's own profile still applies
export function terminalProgram(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return { file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
}

// node-pty's kill() on Windows (ConPTY without its DLL) forks conpty_console_list_agent.js to list the console's
// processes. The packaged app has runAsNode off, so that fork starts SiberSentez.exe itself: a "second launch" in the log
// and a 5 s wait each time a terminal closes. Instead the shell and what it started end by taskkill /T /F of the shell
// (killPid). A pty without that agent is left as it is.
export function avoidForkOnKill(pty, killPid) {
  const agent = pty?._agent;
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return pty;
  agent._getConsoleProcessList = () => {
    const pid = agent._innerPid;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        killPid(pid);
      } catch {
        // already gone
      }
    }
    return Promise.resolve([]);
  };
  return pty;
}

// taskkill /T /F of one process by the absolute path of taskkill.exe, hidden, no shell (spawn: node's)
export function taskkillTree(spawn, pid, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const root = /^[A-Za-z]:\\[^%"]*$/.test(systemRoot) ? systemRoot : 'C:\\Windows';
  const k = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true, shell: false, stdio: 'ignore' });
  k?.on?.('error', () => {});
}

// What an AI tool's session leaves in the environment of what it starts. SiberSentez started from inside one would pass
// them on and a Claude Code in the dock would take itself for that session's child (it stops saving its transcript,
// so the panel never sees it). The person's own settings (CLAUDE_CODE_GIT_BASH_PATH, ANTHROPIC_API_KEY...) stay.
const SESSION_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
]);

// The child's environment: the person's, without what only SiberSentez's own processes should see
export function terminalEnv(env = {}) {
  const out = {};
  const fromSession = typeof env.CLAUDECODE === 'string';
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    // SiberSentez's own variables, under the new name and the old one (renamed 2026-09-30)
    if (/^(ELECTRON_|SIBERSENTEZ_|ORKESTRA_)/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    if (SESSION_MARKERS.has(k.toUpperCase())) continue;
    // A session sets GIT_EDITOR=true so git never waits on an editor; in a person's terminal that silently skips commit messages
    if (fromSession && k.toUpperCase() === 'GIT_EDITOR' && v === 'true') continue;
    out[k] = v;
  }
  out.COLORTERM = 'truecolor';
  return out;
}

// What the page may ask to open: exactly one of a project id or a session id, or the one-time id of a start-ai the
// server accepted (the server holds the launcher; the page never sees its path)
export function termOpenRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, reason: 'invalid' };
  const keys = Object.keys(req);
  if (keys.length === 1 && keys[0] === 'launchId') return typeof req.launchId === 'string' && LAUNCH_ID.test(req.launchId) ? { ok: true, target: { launchId: req.launchId } } : { ok: false, reason: 'invalid' };
  // A plain terminal for installing an AI tool (docs/embedded-terminal.md, "Setup terminal"): no project, no program
  if (keys.length === 1 && keys[0] === 'setup') return req.setup === true ? { ok: true, target: { setup: true } } : { ok: false, reason: 'invalid' };
  if (keys.some((k) => k !== 'projectId' && k !== 'sessionId')) return { ok: false, reason: 'invalid' };
  const p = req.projectId;
  const s = req.sessionId;
  if ((p === undefined) === (s === undefined)) return { ok: false, reason: 'invalid' };
  if (p !== undefined && (typeof p !== 'string' || !PROJECT_ID.test(p))) return { ok: false, reason: 'invalid' };
  if (s !== undefined && (typeof s !== 'string' || !SESSION_ID.test(s))) return { ok: false, reason: 'invalid' };
  return { ok: true, target: p !== undefined ? { projectId: p } : { sessionId: s } };
}

// The newest `max` characters of the output as a list of chunks: a push never copies what is already kept, and going
// over the limit drops chunks from the front (the oldest first), cutting only the first one that remains.
export function createChunkBuffer(max = MAX_BUFFER) {
  let chunks = [];
  let size = 0;
  return {
    push(s) {
      if (!s) return;
      if (s.length >= max) {
        chunks = [s.slice(-max)];
        size = chunks[0].length;
        return;
      }
      chunks.push(s);
      size += s.length;
      let drop = 0;
      while (size - chunks[drop].length >= max) size -= chunks[drop++].length;
      if (drop) chunks = chunks.slice(drop);
      if (size > max) {
        chunks[0] = chunks[0].slice(size - max);
        size = max;
      }
    },
    toString: () => chunks.join(''),
    get length() {
      return size;
    },
    get chunks() {
      return chunks.length;
    },
  };
}

// Output batching and back-pressure for one terminal (pure over its parts, tested with a fake clock).
// The first output after a quiet window goes out at once (a keystroke's echo stays instant); output that follows within
// `windowMs` is joined into one message sent when the window ends. When more than `highWater` characters wait, they go
// out now and pause() stops the pty until the window has passed, then resume() lets it go on: a program printing without
// pause (yes, a big log) is throttled at the source instead of queuing IPC messages and xterm writes.
export function createOutputBatcher({ send, pause = () => {}, resume = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, windowMs = BATCH_MS, highWater = HIGH_WATER } = {}) {
  let parts = [];
  let waiting = 0;
  let lastSent = -Infinity;
  let timer = null;
  let paused = false;

  function flush() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (!waiting) return;
    const text = parts.join('');
    parts = [];
    waiting = 0;
    lastSent = now();
    send(text);
  }

  function onTimer() {
    timer = null;
    flush();
    if (paused) {
      paused = false;
      resume();
    }
  }

  function arm() {
    if (timer) return;
    const t = setTimer(onTimer, Math.max(0, lastSent + windowMs - now()));
    t?.unref?.();
    timer = t;
  }

  return {
    push(s) {
      if (!s) return;
      parts.push(s);
      waiting += s.length;
      if (waiting >= highWater) {
        flush();
        if (!paused) {
          paused = true;
          pause();
        }
        arm(); // resume once the window has passed
        return;
      }
      if (!timer && now() - lastSent >= windowMs) flush();
      else arm();
    },
    flush, // e.g. before the exit message, so the last output is not lost
    // the terminal closed: what waits is dropped, nothing is sent afterwards
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      parts = [];
      waiting = 0;
    },
    get pending() {
      return waiting;
    },
    get paused() {
      return paused;
    },
  };
}

const intIn = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

// spawn(file, args, { cwd, cols, rows, env }) -> { onData(cb), onExit(cb), write(s), resize(c, r), kill(), pid }
// clock/setTimer/clearTimer: the output batching's time (fakes in tests)
// send(channel, ...args): to the window (the caller sends only while the window shows the app)
// onChange(ended): after a terminal opened or ended (ended: { id, projectId, tool, jobId, exitCode } of the one that
// ended, else null); the shell tells the server what runs (sessions()) so a restore sees AI tools of every kind
// exists/every/stopEvery: the ended-mark check (fs.existsSync, setInterval, clearInterval; fakes in tests)
export function createTerminals({ spawn, send = () => {}, onChange = () => {}, log = () => {}, env = {}, program = terminalProgram(), now = Date.now, clock = Date.now, max = MAX_TERMINALS, setTimer = setTimeout, clearTimer = clearTimeout, batchMs = BATCH_MS, highWater = HIGH_WATER, exists = (p) => fs.existsSync(p), every = setInterval, stopEvery = clearInterval, checkMs = TOOL_CHECK_MS } = {}) {
  const terms = new Map(); // id -> { pty, title, projectId, startedAt, buffer, ai, tool, jobId, endedMark, toolEnded }
  const changed = (ended = null) => {
    try {
      onChange(ended);
    } catch {
      // the server learns it on the next change
    }
  };
  let seq = 0;

  // The AI tabs whose tool has not ended yet are checked for their launcher's mark; the check stops when none waits
  let checker = null;
  const waiting = () => [...terms].filter(([, t]) => t.endedMark && !t.toolEnded);
  function checkEnded() {
    const list = waiting();
    let ended = false;
    for (const [id, t] of list) {
      let there = false;
      try {
        there = exists(t.endedMark);
      } catch {
        // not readable just now: asked again next time
      }
      if (!there) continue;
      t.toolEnded = true;
      ended = true;
      send(TERMINAL_IPC.toolEnd, id);
      log(`terminal ${id}: the tool ended, the shell stays`);
    }
    if (!waiting().length && checker) {
      stopEvery(checker);
      checker = null;
    }
    if (ended) changed();
  }
  function watchEnded() {
    if (checker || !waiting().length) return;
    checker = every(checkEnded, checkMs);
    checker?.unref?.();
  }

  // launch: the server's program for a start-ai in the dock (its launcher in a Command Prompt); else the fixed shell
  // tool, jobId: the AI tool and the app job of a start-ai (the server's launch record); a plain shell has neither
  function open({ dir, title, projectId = null, cols = 100, rows = 30, launch = null, tool = null, jobId = null }) {
    if (terms.size >= max) return { ok: false, reason: 'too-many' };
    if (typeof dir !== 'string' || !dir) return { ok: false, reason: 'no-folder' };
    const prog = launch && typeof launch.file === 'string' && Array.isArray(launch.args) && launch.args.every((a) => typeof a === 'string') ? launch : program;
    const id = `t${++seq}`;
    let pty;
    try {
      pty = spawn(prog.file, prog.args, { cwd: dir, cols: intIn(cols, COLS) ? cols : 100, rows: intIn(rows, ROWS) ? rows : 30, env: terminalEnv(env) });
    } catch (e) {
      log(`terminal could not start (${e?.code || 'error'})`);
      return { ok: false, reason: 'spawn-failed' };
    }
    // ai: an AI tool runs in it (the page tells a plain shell apart, docs/embedded-terminal.md)
    const ai = prog !== program;
    // The launcher's ended mark (an AI start: the last argument is its .cmd, absolute or relative to the folder)
    const last = ai ? prog.args.at(-1) : null;
    const endedMark = typeof last === 'string' && /\.cmd$/i.test(last) ? path.win32.resolve(dir, last) + ENDED_SUFFIX : null;
    const t = { pty, title: String(title || '').slice(0, 60), projectId, startedAt: now(), buffer: createChunkBuffer(MAX_BUFFER), ai, tool: ai && TOOL_ID.test(tool || '') ? tool : null, jobId: ai && JOB_ID.test(jobId || '') ? jobId : null, endedMark, toolEnded: false };
    // a pty without pause/resume (or one that throws) just goes unthrottled
    const safe = (name) => () => {
      try {
        pty[name]?.();
      } catch {
        // already gone
      }
    };
    t.out = createOutputBatcher({ send: (text) => send(TERMINAL_IPC.data, id, text), pause: safe('pause'), resume: safe('resume'), now: clock, setTimer, clearTimer, windowMs: batchMs, highWater });
    terms.set(id, t);
    pty.onData((chunk) => {
      if (!terms.has(id)) return; // late output of a closed terminal
      const s = String(chunk);
      t.buffer.push(s);
      t.out.push(s);
    });
    pty.onExit(({ exitCode } = {}) => {
      if (!terms.has(id)) return;
      t.out.flush();
      terms.delete(id);
      const code = Number.isInteger(exitCode) ? exitCode : null;
      send(TERMINAL_IPC.exit, id, code);
      changed({ id, projectId: t.projectId, tool: t.tool, jobId: t.jobId, ai: t.ai, exitCode: code });
    });
    log(`terminal ${id} opened (${terms.size} running)`);
    changed();
    watchEnded();
    return { ok: true, id, title: t.title, projectId, ai: t.ai, tool: t.tool, jobId: t.jobId };
  }

  const get = (id) => (typeof id === 'string' && TERM_ID.test(id) ? terms.get(id) : undefined);

  function write(id, data) {
    const t = get(id);
    if (!t || typeof data !== 'string' || !data || data.length > MAX_WRITE) return false;
    t.pty.write(data);
    return true;
  }

  function resize(id, cols, rows) {
    const t = get(id);
    if (!t || !intIn(cols, COLS) || !intIn(rows, ROWS)) return false;
    try {
      t.pty.resize(cols, rows);
      return true;
    } catch {
      return false; // it exited in the meantime
    }
  }

  function close(id) {
    const t = get(id);
    if (!t) return false;
    terms.delete(id);
    t.out.cancel();
    try {
      t.pty.kill();
    } catch {
      // already gone
    }
    send(TERMINAL_IPC.exit, id, null);
    log(`terminal ${id} closed (${terms.size} running)`);
    changed({ id, projectId: t.projectId, tool: t.tool, jobId: t.jobId, ai: t.ai, exitCode: null });
    return true;
  }

  function closeAll() {
    for (const id of [...terms.keys()]) close(id);
  }

  // A (re)loaded page asks what runs, with what each one showed so far
  const list = () => [...terms].map(([id, t]) => ({ id, title: t.title, projectId: t.projectId, startedAt: t.startedAt, buffer: t.buffer.toString(), ai: t.ai, tool: t.tool, jobId: t.jobId, toolEnded: t.toolEnded }));
  // What runs, for the server (no buffer, no title): the terminals of AI starts and plain shells, with their project;
  // running: false once an AI tab's tool ended (its shell may stay open for a long time)
  const sessions = () => [...terms].map(([id, t]) => ({ id, projectId: t.projectId, ai: t.ai, tool: t.tool, jobId: t.jobId, startedAt: t.startedAt, running: !t.toolEnded }));

  return { open, write, resize, close, closeAll, list, sessions, count: () => terms.size };
}

// Quitting while terminals run asks first (the owner's decision, docs/embedded-terminal.md §5): true when the program
// may quit. Never a dialog in QA (the terminals are closed without asking); a failing dialog keeps the program running.
export const QUIT_CONFIRM_OK = 0;
export async function confirmQuitWithTerminals({ count = 0, S, qa = false, parent = null, showMessageBox }) {
  if (!count || qa) return true;
  const options = {
    type: 'question',
    buttons: [S.termQuitYes, S.termQuitNo],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: S.termQuitTitle,
    message: S.termQuitMessage.replace('{count}', String(count)),
    detail: S.termQuitDetail,
  };
  try {
    const r = parent ? await showMessageBox(parent, options) : await showMessageBox(options);
    return r?.response === QUIT_CONFIRM_OK;
  } catch {
    return false;
  }
}
