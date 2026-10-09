// SiberSentez panel server. No dependencies; it binds to 127.0.0.1 only.
// Usage: node server/index.mjs [--open]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HOST, PORT, PUBLIC_DIR, HUB_DIR, ACTIONS, APP_DIR, INSTANCE, SESSION_KEY, HOME_DIR, CLAUDE_DIR, PROJECTS_DIR, resolveActionModeNow } from './config.mjs';
import { cleanupTrials, sweepLeftovers } from './install.mjs';
import { Catalog } from './catalog.mjs';
import { Ingest } from './ingest.mjs';
import { GitWatcher } from './git.mjs';
import { readLiveSessions, startLiveVerifier } from './live.mjs';
import { takePatch, projectView, rosterView, hubView, toolsView } from './views.mjs';
import { createHandler } from './app.mjs';
import { createActions, logCode } from './actions.mjs';
import { createFit } from './fit.mjs';
import { createProjectChannel, shellChangeHandler } from './memory.mjs';
import { UsageLedger, scanOlderLogs } from './usage.mjs';
import { envFlags } from './tools.mjs';
import { PLATFORM } from './platform.mjs';

const catalog = new Catalog();
// The projects only: the skills and agents are scanned once the logs are read (reloadCatalog after initialScan below,
// which scans them anyway); scanning them here too held the first answer about a second (measured 2026-10-02)
catalog.load({ roster: false });
// Write pending project memory before the process ends (writes are debounced)
process.on('exit', () => catalog.memory.flush());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
const ingest = new Ingest(catalog);
// Usage ledger (docs/usage.md): <hub>/usage/ledger.json, or memory only without a hub. The log reader hands it every
// assistant line; pending numbers are written before the process ends (writes are debounced).
const ledger = new UsageLedger({ hubDir: HUB_DIR, apiKeyEnv: envFlags(process.env).anthropicKey });
ingest.ledger = ledger;
process.on('exit', () => ledger.flush());
const gitWatcher = new GitWatcher(catalog, ingest);
const clients = new Set();

// A timer's work that throws is logged and tried again on its next turn: an uncaught error would end the server,
// and the shell gives up after five restarts in a row (the same data would throw again each time)
function guarded(label, fn) {
  return () => {
    try {
      fn();
    } catch (e) {
      console.error(`${label} failed:`, e?.stack || e?.message || e);
    }
  };
}
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack || e?.message || e));

// A client that stopped reading (a frozen page) is dropped once this much waits for it; a reconnecting page takes
// a fresh snapshot, so nothing is lost by dropping it, while its buffer would otherwise grow without end
const CLIENT_BACKLOG = 8 * 1024 * 1024;
function sendTo(res, msg) {
  if (res.writableLength > CLIENT_BACKLOG) {
    clients.delete(res);
    res.destroy();
    return;
  }
  res.write(msg);
}

// data: an object or an already serialized JSON string
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) sendTo(res, msg);
}

// Reload registry and roster and publish them (every 60 s and after the first log scan).
// With every plugin item the roster can exceed 1 MB: it is not resent every minute when nothing changed.
// The skills and agents are scanned again every ROSTER_EVERY catalog reloads (5 minutes)
const ROSTER_EVERY = 5;
let lastRoster = '';
function reloadCatalog({ roster = true } = {}) {
  catalog.load({ roster });
  publishCatalog();
}
function publishCatalog() {
  const data = JSON.stringify({ hub: hubView(catalog), tools: toolsView(catalog), roster: rosterView(ingest, catalog), projects: catalog.allProjects().map((p) => projectView(ingest, p, catalog)) });
  if (data === lastRoster) return;
  lastRoster = data;
  broadcast('roster', data);
}

// Action layer: off unless enabled in settings (endpoints 404), the panel stays read-only.
// Started processes run in the app folder. The hub holds the library, the install record and the trial folders;
// after a live import, install or remove the catalog reloads at once, so the counts change without waiting a minute.
// The automatic fit (docs/auto-skills.md §3) is cached per project; one service serves GET /api/projects/<id>/fit and
// skills-apply. It checks the roster, library, usage and project folder itself on every request; after a live
// import, install or remove every cached fit is dropped at once.
const fit = createFit({ catalog, ingest, hubDir: HUB_DIR, homeDir: HOME_DIR, claudeDir: CLAUDE_DIR });
const actions = createActions({
  catalog,
  ingest,
  mode: ACTIONS,
  port: PORT,
  hubDir: HUB_DIR,
  workDir: APP_DIR,
  homeDir: HOME_DIR,
  claudeDir: CLAUDE_DIR,
  fit,
  onChange: () => {
    fit.invalidate();
    reloadCatalog();
  },
});

// Trial folders older than 7 days that carry the trial marker are removed at start (docs/skills-flow.md §3.2).
// Errors are logged by code only: a message can carry a path (§3.9).
try {
  const trials = cleanupTrials(HUB_DIR);
  if (trials.removed) console.log(`Trials: ${trials.removed} old trial folder(s) removed`);
} catch (e) {
  console.error('trial cleanup failed:', logCode(e));
}
// Staging leftovers (.sibersentez-tmp-*, .sibersentez-old-*) of an install or import that could not clean up are removed
// from the recorded project targets and from the library (§3.7)
try {
  const leftovers = sweepLeftovers(HUB_DIR, { claudeDir: CLAUDE_DIR });
  if (leftovers.removed || leftovers.kept) console.log(`Staging leftovers: ${leftovers.removed} removed, ${leftovers.kept} kept`);
} catch (e) {
  console.error('leftover sweep failed:', logCode(e));
}
const ACTION_MODE_TEXT = { off: 'off', dry: 'preview', live: 'on' };

// The desktop shell's requests (docs/start-flow.md, step 2: a new project and its idea) arrive over this process's own
// message channel: process.parentPort when Electron started it as a utilityProcess, the ipc channel of a forked process
// in development. Only the parent process can send on it; a server started on its own (node server/index.mjs) has
// neither and listens to nothing. No HTTP route reaches these writes. After a change, before the answer goes back
// (memory.mjs shellChangeHandler): a new project reloads the catalog (the page gets the new project list) and drops
// every cached fit; a project's idea drops only that project's cached fits (its fit without ?idea, the card's badge and
// skills-apply without keys, reads the saved idea) and sends that project in the next patch, without a catalog reload.
const projectChannel = createProjectChannel({
  catalog,
  appDir: APP_DIR,
  onChange: shellChangeHandler({
    reload: reloadCatalog,
    invalidateFit: (projectId) => fit.invalidate(projectId),
    markProject: (projectId) => ingest.dirty.projects.add(projectId),
  }),
  // A new actions mode without a restart (docs/actions-toggle.md §3.5): read again, applied, and the page told by an
  // `actions` event that carries only the mode (the page asks GET /api/actions for the new token)
  reloadActions: () => {
    const r = actions.setMode(resolveActionModeNow({ env: process.env, appDir: APP_DIR, hub: HUB_DIR, log: (line) => console.warn(line) }));
    if (r.changed) {
      console.log(`Actions: ${ACTION_MODE_TEXT[actions.mode]} (settings changed)`);
      broadcast('actions', { mode: actions.mode });
    }
    return { ok: true, mode: actions.mode, reason: r.changed ? 'applied' : 'same' };
  },
  // Where an embedded terminal opens (docs/embedded-terminal.md): the terminal action's checks, live mode only
  terminalTarget: (req) => actions.terminalTarget(req),
  // What runs in the embedded terminals (an AI tool of any kind keeps a restore from running under it)
  terminalState: (msg) => actions.terminalState(msg),
});
function answerShell(msg, send) {
  const reply = projectChannel.handle(msg);
  if (!reply) return;
  try {
    send(reply);
  } catch (e) {
    console.error('shell reply could not be sent:', logCode(e));
  }
}
if (process.parentPort && typeof process.parentPort.on === 'function') {
  process.parentPort.on('message', (e) => answerShell(e?.data, (reply) => process.parentPort.postMessage(reply)));
} else if (typeof process.send === 'function') {
  process.on('message', (msg) => answerShell(msg, (reply) => process.send(reply)));
}

const server = http.createServer(createHandler({ ingest, catalog, clients, port: PORT, publicDir: PUBLIC_DIR, actions, instance: INSTANCE, sessionKey: SESSION_KEY, fit, usage: ledger }));

function openBrowser(url) {
  try {
    // Linux and macOS: the system's opener by its full path (plan G1)
    if (!PLATFORM.windows) {
      spawn(PLATFORM.mac ? '/usr/bin/open' : '/usr/bin/xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    // cmd.exe by absolute path (review A7), never one found in the working folder
    const cmdExe = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
    spawn(cmdExe, ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* if the browser cannot open, the address is printed to the console */
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`SiberSentez is already running: http://${HOST}:${PORT}/`);
    if (process.argv.includes('--open')) openBrowser(`http://${HOST}:${PORT}/`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`SiberSentez: ${url}`);
  console.log(`Actions: ${ACTION_MODE_TEXT[actions.mode]}`);
  // The hub path is not logged (it holds the user name); only found/none and counts
  console.log(catalog.hub ? `Hub: found (${catalog.hub.projects} registered projects, ${catalog.hub.library} library items)` : 'Hub: none (registry and library empty)');
  if (process.argv.includes('--open')) openBrowser(url);

  // Live sessions at once, the logs in the background
  const pollLive = () => {
    try {
      ingest.setLive(readLiveSessions());
    } catch (e) {
      console.error('could not read the live sessions:', e.message);
    }
  };
  startLiveVerifier();
  pollLive();
  setInterval(pollLive, 1500).unref();

  const t0 = Date.now();
  gitWatcher.start();
  ledger.beginScan();
  await ingest.initialScan((scan) => broadcast('scan', scan));
  console.log(`Logs scanned: ${ingest.scan.done} files, ${ingest.sessions.size} sessions, ${ingest.agents.size} agents, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // The snapshot taken after the scan carries every project's usage: no patch needs to resend them
  ledger.takeTouched();
  // Projects found in the logs are known now: their .claude folders join the roster too
  reloadCatalog();
  broadcast('ready', { t: Date.now() });
  ingest.startWatching();

  // Usage ledger: the log files of its horizon that the reader above skipped (older than its window) are counted in
  // the background; until then the usage numbers say they are still being counted
  const t1 = Date.now();
  scanOlderLogs(ledger, { ingest, catalog, projectsDir: PROJECTS_DIR, before: ingest.cutoff })
    .then((n) => console.log(`Usage: ${n} older log file(s) counted, ${((Date.now() - t1) / 1000).toFixed(1)} s`))
    .catch((e) => console.error('usage scan failed:', e?.code || e?.message))
    .finally(() => ledger.finishScan());
  setInterval(guarded('usage sweep', () => ledger.sweep()), 10 * 60000).unref();

  // Send the changes as a patch every half second
  setInterval(
    guarded('patch', () => {
      const patch = takePatch(ingest, catalog);
      if (patch) broadcast('patch', patch);
    }),
    500,
  ).unref();

  // The registry and the projects may have changed: every minute (about 0.1 s with the views, measured 2026-10-06).
  // The skills and agents every fifth time, in steps that give the loop back between them (catalog.loadRosterInSteps:
  // about 0.45 s of work, never more than one step at once); an action that installs, imports or removes reloads them
  // at once, in one piece, so its answer already counts the change (onChange above)
  let catalogTicks = 0;
  setInterval(
    guarded('catalog reload', () => {
      const roster = ++catalogTicks % ROSTER_EVERY === 0;
      reloadCatalog({ roster: false });
      if (roster) catalog.loadRosterInSteps().then((changed) => changed && publishCatalog()).catch((e) => console.error('roster scan failed:', e?.stack || e?.message || e));
    }),
    60000,
  ).unref();

  // Keep the connection alive
  setInterval(() => {
    for (const res of [...clients]) sendTo(res, ': ping\n\n');
  }, 20000).unref();
});
