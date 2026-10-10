// @ts-check
// SiberSentez action layer (contract §5, §7; skill flow: docs/skills-flow.md; terminal: docs/terminal.md).
// Starts local actions from the panel's context menu: a plain terminal in a project or session folder (Windows
// Terminal, else Windows PowerShell; no AI command, the user starts the tool of their choice), a Claude Code session
// in Windows Terminal (optionally with per-session --plugin-dir packages from the hub library), Explorer, VS Code.
// The skill flow adds: library-scan and
// library-import (bring skills and agents into the hub library), skills-preview, skills-install and skills-remove
// (library items in a project) and skills-trial (a Claude Code session with a session-only plugin folder). The
// automatic fit (docs/auto-skills.md) adds skills-apply: the automatic selection (or chosen candidates) imported into
// the library when they come from other projects, then installed, in one locked operation.
// OFF BY DEFAULT; enabled with SIBERSENTEZ_ACTIONS=dry|1, sibersentez.json "actions": "dry"|"live" or, in the installed
// app, <hub>\settings.json "actions", which only the desktop shell's tray menu writes (config.mjs,
// docs/actions-toggle.md). Dry: nothing is written or started, the reply carries the plan or the command.
//
// Threat model: the attacker is another page open in the user's browser (CSRF, DNS rebinding, an app on another
// local port). Local processes are out of scope: they can already run commands as the user. Defence layers in
// order: Host (app.mjs) -> Origin -> Sec-Fetch-Site -> Content-Type -> body size -> token -> allow list + id
// validation (no command comes from the browser; project paths are resolved from the registry and the logs; the
// only path a request carries is the folder to import from, checked by library.mjs) -> rate limit -> argument
// array only, shell:false.
//
// Local imports are limited to modules that never import config.mjs (library.mjs, install.mjs and what they use):
// config.mjs imports this module for readActionMode, and app.mjs sets the security headers while routing so that
// app.mjs -> views.mjs -> config.mjs does not form a cycle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { isLegacyHub, listLibrary, findLibraryItem, scanSource, publicScanItems, planImport, executeImport, writeCatalog, publicPlan, normRel, lstat, treeHash, sameHash } from './library.mjs';
import { resolveProject, readInstalls, planInstall, executeInstall, planRemove, executeRemove, planTrial, makeTrial } from './install.mjs';
import { createPointAsync, planRestore, applyRestore, recordJobPoint, listPoints } from './restore.mjs';
import { planRelink, setRelink, removeRelink } from './relinks.mjs';
import { listJobResults } from './jobResults.mjs';
import { createFit, planApplyImports } from './fit.mjs';
// "Start with AI" (docs/ai-start.md)
import { sharedToolDetector, toolById } from './tools.mjs';
import { firstMessageText, jobMessageText, planFirstMessage, writeFirstMessage, launchPrompt, toolArgs, jobArgs, versionAtLeast, resumeArgs, launcherText, pickLaunchDir, buildAiArgv, buildAiFallbackArgv, newLauncherName, cleanupLaunchers, SAFE_LAUNCH_RE, FIRST_DIR, shellLauncherText } from './launch.mjs';
import { newJobId, readCurrentJob, writeCurrentJob, markerError, CURRENT_JOB_FILE } from './job-id.mjs';
import { createGitHub, cleanupIncoming, parseRepoName, describeDownload, planDownloadImport, readSources, findSource, updateSources, sourceRow, diffItems } from './github.mjs';
import { reviewItem } from './review.mjs';
import { PROJECT_ID_RE, normPath, slugify } from './util.mjs';
import { PLATFORM, appDataDir, terminalShell, editorCandidates, homeOf } from './platform.mjs';
import { readKit } from './kit.mjs';
import { createValidators, ACTION_NAMES, UUID_RE, UNSAFE_RE, GITHUB_SET, SKILL_SET, buildArgv, isDir, isFile, reject, GITHUB_ACTIONS } from './actionInput.mjs';
export { LAUNCH_ACTIONS, SKILL_ACTIONS, GITHUB_ACTIONS, ACTION_NAMES, MAX_SKILL_ITEMS, buildArgv } from './actionInput.mjs';


// App folder (parent of server/): working directory of started processes, computed without importing config.mjs.
// In the installed app this is ...\resources\app.asar: realWorkDir turns it into a folder the OS can enter.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';

// A path segment naming an Electron archive (app.asar). Electron's patched fs shows the archive as a folder, but the
// OS cannot enter it: spawn with such a cwd fails (CreateProcess ERROR_DIRECTORY, reported as ENOENT). The unpacked
// sibling (app.asar.unpacked) is a real folder and does not match.
const ASAR_SEGMENT_RE = /(^|[\\/])[^\\/]*\.asar(?=[\\/]|$)/i;
const ASAR_CWD = 'ORK_ASAR_CWD';

export function hasAsarSegment(p) {
  return typeof p === 'string' && ASAR_SEGMENT_RE.test(p);
}

// Pure: the working directory for started processes. A path inside an archive becomes the folder that holds the
// archive (in the installed app: the program's resources folder, a real folder that belongs to the app, so a bare
// program name is still never looked up in a project folder). Any other path is returned unchanged.
export function realWorkDir(dir) {
  if (typeof dir !== 'string') return dir;
  const m = ASAR_SEGMENT_RE.exec(dir);
  if (!m) return dir;
  const parent = dir.slice(0, m.index);
  if (!parent) return m[1] || dir; // '\app.asar' -> '\'; a bare relative 'app.asar' stays (launch refuses it)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

// A request's body, at most: a job of JOB_MAX characters (fit.mjs, up to 3 bytes each in UTF-8) and the other fields
// fit with room (it was 4096 when a job was 300 characters)
const MAX_BODY = 16384;
const REPEAT_MS = 3000;

// A launcher path cmd may take as its own argument in SiberSentez's terminal: spaces and any letter are fine (node-pty
// hands cmd a Unicode command line), but nothing cmd would expand (%) or treat as an operator
const DOCK_LAUNCHER_RE = /^[A-Za-z]:\\[^%!^&|<>"\u0000-\u001f\u007f]+$/;
const JSON_TYPE_RE = /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i;

const PROGRAM_CODES = { resume: 'wt', fork: 'wt', new: 'wt', explorer: 'explorer', vscode: 'vscode' };

// Actions that write in live mode (one at a time). A GitHub fetch writes the download into the hub's incoming/ folder.
const WRITING = new Set(['library-import', 'library-adopt', 'skills-install', 'skills-remove', 'skills-trial', 'skills-apply', 'restore-apply', 'project-relink', 'project-unlink', ...GITHUB_ACTIONS]);
// Writing actions that may also only plan (plan: true), outside the one-writing-action lock
const PLAN_ONLY_OK = new Set(['skills-remove', 'project-relink', 'project-unlink']);
// Names per list in a restore reply (the counts are whole)
const RESTORE_LIST_MAX = 50;
// HTTP status of a GitHub error code (never 403 or 429: the page reads those as "refused" and "asked again too soon")
const GITHUB_STATUS = { 'not-public': 404, 'ref-not-found': 404, 'path-not-found': 404, 'fetch-missing': 404, 'not-github': 502, 'redirect-refused': 502, network: 502, 'fetch-failed': 502, 'git-failed': 502, 'rate-limited': 503, timeout: 504, 'too-large': 413, 'too-many-files': 413, 'tar-corrupt': 422, 'tar-unsafe-path': 422, 'reparse-point': 409, 'git-missing': 500 };

// What an error log line may carry: the error code (ENOENT, EPERM, reparse-point, ...), never the message, which
// can hold a path with the user name (docs/skills-flow.md §3.9)
export function logCode(e) {
  return typeof e?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.code) ? e.code : 'no-code';
}

// SIBERSENTEZ_ACTIONS -> mode. Any unrecognised value counts as off (the safe side).
export function readActionMode(env = {}) {
  const v = String(env.SIBERSENTEZ_ACTIONS ?? '').trim().toLowerCase();
  if (v === 'dry') return 'dry';
  if (v === '1') return 'live';
  return 'off';
}

// Pure: the terminal action's fallback when Windows Terminal cannot be started: Windows PowerShell in its own
// console window. `start` opens that window: a console program spawned detached gets no console at all (libuv sets
// DETACHED_PROCESS), and one spawned attached would share the server's console and die with it. Nothing from the
// request is on this command line: both programs by absolute path, the folder is the process's working directory,
// the empty argument is start's window title.
export function buildShellFallbackArgv({ cmdExe, powershellExe }) {
  return [cmdExe, '/d', '/c', 'start', '', powershellExe, '-NoExit'];
}

// Short name of the target for the log. An unregistered project id derives from the folder path (it may contain the user name):
// a short digest is written instead. Only the first 8 characters of a session id.
function logTarget(body) {
  const parts = [];
  if (typeof body?.projectId === 'string' && PROJECT_ID_RE.test(body.projectId)) {
    const id = body.projectId;
    parts.push(id.startsWith('x-') ? 'x-#' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 8) : id.slice(0, 40));
  }
  if (typeof body?.sessionId === 'string' && UUID_RE.test(body.sessionId)) parts.push(body.sessionId.slice(0, 8));
  return parts.join('/') || '-';
}

// Reads the body up to `limit` bytes; rejects with TOO_LARGE if exceeded (without reading, when Content-Length says so)
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('body-too-large'), { code: 'TOO_LARGE' });
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) return reject(tooLarge());
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        return reject(tooLarge());
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// spawn and now can be injected: tests never start real processes.
// hubDir: hub folder or null (--plugin-dir packages and the whole skill flow; without a hub, actions without packages
// still work and skill actions answer no-hub).
// workDir: working directory of started processes (the trusted app folder; default is the parent of server/). A path
// inside app.asar (the installed app) is replaced by the folder holding the archive (realWorkDir).
// codeExe is optional (for tests); default %LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe.
// cmdExe, powershellExe: the terminal fallback's programs (for tests); default under %SystemRoot%\System32.
// homeDir, claudeDir: the user's home and personal Claude folder (never an import source root or an install target).
// onChange(): called after a live import, install or remove changed files (the server reloads the catalog).
// fit: the fit service (server/fit.mjs createFit) shared with GET /api/projects/<id>/fit; one is made when absent.
// github: the GitHub download service (server/github.mjs createGitHub; tests inject one with a fake network and a fake
// git); made on first use when absent. Downloads older than seven days in <hub>/incoming are removed when the action
// layer starts (docs/github-import.md §3), whatever the mode: that folder is SiberSentez's own.
/** @param {{ catalog?: any, ingest?: any, mode?: string, port?: number, [key: string]: any }} [options] */
export function createActions({
  catalog,
  ingest,
  mode = 'off',
  port,
  hubDir = null,
  workDir = APP_ROOT,
  spawn = nodeSpawn,
  now = Date.now,
  log = (line) => console.log(line),
  // VS Code's command (platform.mjs editorCandidates): the first that exists, else the most likely one
  codeExe = editorCandidates(process.env).find((p) => isFile(p)) || editorCandidates(process.env)[0],
  cmdExe = path.win32.join(SYSTEM_ROOT, 'System32', 'cmd.exe'),
  powershellExe = path.win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  homeDir = null,
  claudeDir = null,
  onChange = () => {},
  fit = null,
  // start-ai (docs/ai-start.md), for tests: tools (a tool detector, default the shared one), env (paths in the
  // launcher, default process.env), launchDirs (launcher folders, default <hub>\launch, %LOCALAPPDATA%\SiberSentez\launch)
  ai = {},
  github = null,
  // The platform's rules (server/platform.mjs); tests pass another one
  plat = PLATFORM,
} = {}) {
  if (!['off', 'dry', 'live'].includes(mode)) mode = 'off';
  // Every started process runs here (never inside app.asar, never in a project folder unless noted)
  const appCwd = realWorkDir(workDir);
  const fitService = fit || createFit({ catalog, ingest, hubDir, homeDir, claudeDir });
  let githubService = github;
  const gh = () => githubService || (githubService = createGitHub({ hubDir }));
  if (hubDir && isDir(hubDir) && !isLegacyHub(hubDir)) {
    try {
      const r = cleanupIncoming(hubDir, { now: now() });
      if (r.removed) log(`[action] ${new Date(now()).toISOString()} github-cleanup - 200 removed ${r.removed}`);
    } catch (e) {
      console.error('incoming cleanup failed:', logCode(e));
    }
  }
  // The token is regenerated on every start and every mode change, lives only in memory; it never goes to the log or outside a reply
  const newToken = () => (mode === 'off' ? null : crypto.randomBytes(32).toString('hex'));
  let token = newToken();
  let tokenBuf = token ? Buffer.from(token, 'utf8') : null;
  const recent = new Map(); // action|project|session -> time of the last accepted request
  let writing = false; // a live skill action that writes is running
  // Going back now runs without holding the server (review A2): a project being put back takes no AI start, and a
  // project whose start copy is being taken cannot be put back, until the other is done
  const restoring = new Set(); // project ids
  const starting = new Set(); // project ids

  const list = () => (mode === 'off' ? [] : [...ACTION_NAMES]);

  function writeLog(action, target, status, note) {
    try {
      log(`[action] ${new Date(now()).toISOString()} ${action} ${target} ${status} ${note}`);
    } catch {
      /* the request is answered even if the log cannot be written */
    }
  }

  // Origin is required and must be the same name as Host: http://127.0.0.1:<port> or http://localhost:<port>.
  // The host name is case-insensitive: both are lower-cased before comparing.
  function originAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    return String(req.headers.origin || '').toLowerCase() === `http://${host}`;
  }

  function tokenMatches(given) {
    if (typeof given !== 'string' || !tokenBuf) return false;
    const b = Buffer.from(given, 'utf8');
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  }

  // Action and id validation. On success { ok, action, argv, ctx, key }.
  // The request checks (plan D8: server/actionInput.mjs)
  const { validate } = createValidators({ catalog, ingest, hubDir, codeExe, homeDir, claudeDir, appCwd, plat });

  function changed() {
    // Every fit depends on the library and the installs: computed again on the next request
    try {
      fitService.invalidate();
    } catch (e) {
      console.error('fit invalidation failed:', logCode(e));
    }
    try {
      onChange();
    } catch (e) {
      // The error code only: a message can carry a path (contract §3.9)
      console.error('catalog reload failed:', logCode(e));
    }
  }

  const failed = (status, error, note = 'validation', extra = {}) => ({ status, body: { ok: false, mode, error, ...extra }, note });
  const errCode = (e) => (typeof e?.code === 'string' && /^[a-z][a-z-]*$/.test(e.code) ? e.code : 'internal');

  // Runs a validated skill action. Dry: plans only (nothing written, nothing started). Live: one writing action at
  // a time; the plan in the reply shows what was done (an entry that failed turned into a skip with its reason).
  async function executeSkill(v) {
    const { action, ctx } = v;
    const live = mode === 'live';
    if (live && WRITING.has(action) && !(PLAN_ONLY_OK.has(action) && ctx.planOnly)) {
      if (writing) return failed(409, 'busy', 'busy');
      writing = true;
      try {
        return await runSkill(action, ctx, true);
      } finally {
        writing = false;
      }
    }
    return runSkill(action, ctx, false);
  }

  async function runSkill(action, ctx, execute) {
    const base = { ok: true, mode, action };
    try {
      if (action === 'library-scan') {
        const r = scanSource(ctx.source, { hubDir, homeDir });
        if (!r.ok) return failed(r.status, r.error);
        return { status: 200, body: { ...base, plan: [], result: { source: r.source, items: publicScanItems(r.items), truncated: r.truncated } }, note: 'plan' };
      }
      if (action === 'library-import') {
        const p = planImport({ hubDir, homeDir, source: ctx.source, picks: ctx.picks });
        if (!p.ok) return failed(p.status, p.error);
        if (!execute) return { status: 200, body: { ...base, plan: publicPlan(p.plan), result: { executed: false } }, note: 'dry' };
        const r = executeImport({ hubDir, plan: p.plan });
        let catalogError = false;
        if (r.copied || r.updated) {
          try {
            writeCatalog(hubDir, now);
          } catch {
            catalogError = true;
          }
          // A library item replaced from a local folder no longer comes from GitHub: its provenance row goes
          const replaced = p.plan.filter((e) => e.op === 'update').map(({ kind, name }) => ({ kind, name }));
          if (replaced.length) {
            try {
              updateSources(hubDir, { forget: replaced });
            } catch (e) {
              console.error('provenance update failed:', logCode(e));
            }
          }
          changed();
        }
        return { status: 200, body: { ...base, plan: publicPlan(p.plan), result: { executed: true, copied: r.copied, updated: r.updated, catalogError } }, note: 'live' };
      }
      if (action === 'library-adopt') {
        // Each item through the library's own scan and import (the same checks, sizes and copy as a folder import):
        // its folder (a skill) or its agents folder is the source, the scan's category suggestion its category
        const plan = [];
        let copied = 0;
        let updated = 0;
        // An item that cannot be taken is a skip with its reason in the plan, never an early answer: the items
        // before it may already be copied, and the catalog below must learn about them
        const skip = (a, reason) => plan.push({ op: 'skip', kind: a.kind, name: a.name, reason, _error: true });
        const same = (x, a) => x.kind === a.kind && String(x.name).toLowerCase() === a.name.toLowerCase();
        for (const a of ctx.adopt) {
          const s = scanSource(a.source, { hubDir, homeDir });
          if (!s.ok) {
            skip(a, s.error);
            continue;
          }
          // The scan must find the very item the page named (its frontmatter name, at the same place)
          const it = s.items.find((x) => x.path === a.pick && same(x, a));
          if (!it) {
            skip(a, 'item-not-found');
            continue;
          }
          if (it.problems?.length) {
            skip(a, it.problems[0]);
            continue;
          }
          const p = planImport({ hubDir, homeDir, source: a.source, picks: [{ path: a.pick, category: it.category || 'general', replace: false }] });
          if (!p.ok) {
            skip(a, p.error);
            continue;
          }
          if (execute) {
            const r = executeImport({ hubDir, plan: p.plan });
            copied += r.copied || 0;
            updated += r.updated || 0;
          }
          plan.push(...p.plan);
        }
        // A single item that could not be taken at all: its reason is the answer (as an error code)
        if (ctx.adopt.length === 1 && plan.length === 1 && plan[0]._error) {
          const why = plan[0].reason;
          return failed(why === 'item-not-found' || why === 'source-missing' ? 404 : 409, why);
        }
        if (!execute) return { status: 200, body: { ...base, plan: publicPlan(plan), result: { executed: false } }, note: 'dry' };
        let catalogError = false;
        if (copied || updated) {
          try {
            writeCatalog(hubDir, now);
          } catch {
            catalogError = true;
          }
          changed();
        }
        return { status: 200, body: { ...base, plan: publicPlan(plan), result: { executed: true, copied, updated, catalogError } }, note: 'live' };
      }
      if (GITHUB_SET.has(action)) return await runGitHub(action, ctx, execute, base);
      const project = ctx.project;
      if (action === 'skills-preview' || action === 'skills-install') {
        const rec = readInstalls(hubDir);
        if (!rec.ok) return failed(409, 'record-broken');
        const plan = planInstall({ project, dir: ctx.dir, items: ctx.items, targets: ctx.targets, library: listLibrary(hubDir), installs: rec.installs });
        if (!execute) return { status: 200, body: { ...base, targets: ctx.targets, plan: publicPlan(plan), result: { executed: false } }, note: action === 'skills-preview' ? 'plan' : 'dry' };
        const r = executeInstall({ plan, project, hubDir, installs: rec.installs, rows: rec.rows, now });
        if (r.copied || r.updated) changed();
        if (r.recordError) return failed(500, 'record-write-failed', 'record', { action, plan: publicPlan(plan) });
        return { status: 200, body: { ...base, targets: ctx.targets, plan: publicPlan(plan), result: { executed: true, copied: r.copied, updated: r.updated } }, note: 'live' };
      }
      if (action === 'skills-remove') {
        const rec = readInstalls(hubDir);
        if (!rec.ok) return failed(409, 'record-broken');
        const plan = planRemove({ project, dir: ctx.dir, items: ctx.items, targets: ctx.targets, installs: rec.installs });
        if (!execute) return { status: 200, body: { ...base, targets: ctx.targets, plan: publicPlan(plan), result: { executed: false } }, note: ctx.planOnly ? 'plan' : 'dry' };
        const r = executeRemove({ plan, hubDir, installs: rec.installs, rows: rec.rows });
        if (r.removed || r.forgotten) changed();
        if (r.recordError) return failed(500, 'record-write-failed', 'record', { action, plan: publicPlan(plan) });
        return { status: 200, body: { ...base, targets: ctx.targets, plan: publicPlan(plan), result: { executed: true, removed: r.removed, forgotten: r.forgotten } }, note: 'live' };
      }
      if (action === 'skills-apply') return applySkills(ctx, execute, base);
      if (action === 'restore-preview' || action === 'restore-apply') return await runRestore(action, ctx, execute, base);
      if (action === 'project-relink' || action === 'project-unlink') return runRelink(action, ctx, execute, base);
      if (action === 'skills-trial') {
        const t = planTrial({ hubDir, projectId: project.id, items: ctx.items, library: listLibrary(hubDir), via: project.via, now: now() });
        const plan = publicPlan(t.plan);
        if (!t.plan.some((e) => e.op === 'copy')) return failed(409, 'nothing-to-try', 'validation', { action, plan });
        const newSessionId = crypto.randomUUID();
        const argv = buildArgv('new', { dir: ctx.dir, title: ctx.title, projectId: project.id, newSessionId, packageDirs: [t.dir] });
        // Last guard: the trial folder (under the hub) reaches Windows Terminal as an argument
        if (argv.slice(1).some((a) => UNSAFE_RE.test(String(a)))) return failed(409, 'unsafe-path');
        const body = { ...base, plan, argv, sessionId: newSessionId, result: { trialDir: t.dir, executed: false } };
        if (!execute) return { status: 200, body, note: 'dry' };
        try {
          makeTrial({ hubDir, dir: t.dir, plan: t.plan, projectId: project.id, now });
        } catch (e) {
          return failed(409, errCode(e) === 'internal' ? 'trial-failed' : errCode(e), 'trial');
        }
        try {
          await launch(argv, { shell: false, detached: true, stdio: 'ignore', cwd: appCwd });
        } catch (e) {
          fs.rmSync(t.dir, { recursive: true, force: true });
          const why = launchFailure(e, appCwd);
          if (why === 'workdir') return failed(500, 'app-folder-missing', 'workdir');
          return why === 'missing' ? failed(501, 'terminal-missing', 'missing') : failed(500, 'launch-failed', 'launch');
        }
        body.result.executed = true;
        return { status: 200, body, note: 'live' };
      }
      return failed(400, 'unknown-action');
    } catch (e) {
      // The error code only: a message can carry a path (contract §3.9)
      console.error('skill action failed:', logCode(e));
      return failed(500, 'internal', 'error');
    }
  }

  // skills-apply (docs/auto-skills.md §3): the plan is the imports (candidates found only in other projects go into
  // the library first), then the install per target as skills-install plans it. Dry: the whole plan, nothing written,
  // and the reply says so (applied: false, reason: 'preview-mode'). Live (inside the writing lock): the imports run
  // one by one, a failed one skips only its own item; then the install runs for the rest.
  function applySkills(ctx, execute, base) {
    const project = ctx.project;
    const f = fitService.fitOf(project.id);
    if (f.status !== 200) return failed(f.status, f.error);
    const rec = readInstalls(hubDir);
    if (!rec.ok) return failed(409, 'record-broken');
    const part = planApplyImports({ fit: f.fit, keys: ctx.keys, hubDir, homeDir });
    const head = { ...base, targets: ctx.targets, selection: ctx.keys ? 'keys' : 'auto' };
    const plain = (list) => list.map(({ kind, name }) => ({ kind, name }));
    if (!execute) {
      // A planned import stands in for its library item, so the install part shows what would be copied
      const library = [...listLibrary(hubDir), ...part.installItems.filter((i) => i._virtual).map((i) => i._virtual)];
      const install = planInstall({ project, dir: ctx.dir, items: plain(part.installItems), targets: ctx.targets, library, installs: rec.installs });
      return { status: 200, body: { ...head, plan: publicPlan([...part.entries, ...install]), applied: false, reason: 'preview-mode', result: { executed: false, imported: 0, copied: 0, updated: 0 } }, note: 'dry' };
    }
    let imported = 0;
    const notImported = new Set();
    for (const im of part.imports) {
      const r = executeImport({ hubDir, plan: im.plan });
      const e = im.plan[0];
      if (e.op === 'skip') {
        im.entry.op = 'skip';
        im.entry.reason = e.reason;
        notImported.add(`${im.item.kind}:${im.item.name}`.toLowerCase());
      } else imported += r.copied + r.updated;
    }
    let catalogError = false;
    if (imported) {
      try {
        writeCatalog(hubDir, now);
      } catch {
        catalogError = true;
      }
    }
    const items = plain(part.installItems.filter((i) => !(i._virtual && notImported.has(`${i.kind}:${i.name}`.toLowerCase()))));
    // The library is read again: the imported items are in it now
    const install = planInstall({ project, dir: ctx.dir, items, targets: ctx.targets, library: listLibrary(hubDir), installs: rec.installs });
    const r = executeInstall({ plan: install, project, hubDir, installs: rec.installs, rows: rec.rows, now });
    const plan = publicPlan([...part.entries, ...install]);
    if (imported || r.copied || r.updated) changed();
    if (r.recordError) return failed(500, 'record-write-failed', 'record', { action: 'skills-apply', plan });
    const applied = imported + r.copied + r.updated > 0;
    const reason = applied ? {} : { reason: plan.length ? 'nothing-to-do' : 'nothing-selected' };
    return { status: 200, body: { ...head, plan, applied, ...reason, result: { executed: true, imported, copied: r.copied, updated: r.updated, catalogError } }, note: 'live' };
  }

  // ---------------- GitHub import (docs/github-import.md §6) ----------------

  const ghFailed = (e, note = 'github') => {
    const code = errCode(e) === 'internal' ? 'fetch-failed' : errCode(e);
    return failed(GITHUB_STATUS[code] || 502, code, note);
  };

  // execute: live mode (inside the writing lock). Preview mode never reaches the network: github-fetch and
  // github-check-update answer what they would do, github-import plans from a download that is already there,
  // github-discard names what it would delete.
  // Restore points (docs/restore.md). Preview (any mode) and a dry apply plan only: nothing is written. A live apply
  // keeps the present as a point first, then goes back. The lists in the reply are cut at RESTORE_LIST_MAX names each;
  // the counts are whole.
  async function runRestore(action, ctx, execute, base) {
    const args = { hubDir, projectId: ctx.project.id, dir: ctx.dir, id: ctx.pointId, now };
    // An AI session still working in the project would write while the files are put back; so would one starting
    if (action === 'restore-apply' && execute && (aiActiveIn(ctx.project.id) || starting.has(ctx.project.id))) return failed(409, 'ai-working', 'restore');
    const plan = planRestore(args);
    if (!plan.ok) return failed(plan.problem === 'point-missing' ? 404 : 409, plan.problem, 'restore');
    // The project's own files first, the team's notes (.sibersentez/) after them, counted apart: the page names the
    // files the person made and folds the notes (seen when using the app, 2026-10-08: style.css was one line among
    // eleven notes, and a long list of notes could push the project's files past the cut)
    const isNote = (rel) => rel.toLowerCase().startsWith(`${FIRST_DIR}/`);
    const cut = (list) => [...list.filter((r) => !isNote(r)), ...list.filter(isNote)].slice(0, RESTORE_LIST_MAX);
    const notes = (list) => list.filter(isNote).length;
    const summary = { point: plan.point, planId: plan.planId, changed: cut(plan.changed), missing: cut(plan.missing), added: cut(plan.added), counts: { changed: plan.changed.length, missing: plan.missing.length, added: plan.added.length }, notes: { changed: notes(plan.changed), missing: notes(plan.missing), added: notes(plan.added) } };
    if (action === 'restore-preview' || !execute) return { status: 200, body: { ...base, ...summary, result: { executed: false } }, note: action === 'restore-preview' ? 'plan' : 'dry' };
    restoring.add(ctx.project.id);
    let r;
    try {
      r = await applyRestore({ ...args, planId: ctx.planId });
    } finally {
      restoring.delete(ctx.project.id);
    }
    if (!r.ok) return failed(r.problem === 'point-missing' ? 404 : 409, r.problem, 'restore', summary);
    return { status: 200, body: { ...base, ...summary, before: r.before, result: { executed: true, restored: r.restored, removed: r.removed, failed: r.failed.slice(0, RESTORE_LIST_MAX) } }, note: r.failed.length ? 'partial' : 'live' };
  }

  // A moved project linked to its new folder (docs/internal/project-relink-plan.md, server/relinks.mjs). Dry mode, and
  // live mode with plan: true (the preview), answer what it would do (relinks.mjs planRelink: what joins, what stays,
  // or why not) and write nothing. Live mode writes the link only with the preview's planId, and only while the plan
  // still has it (plan-changed otherwise), in the hub's own memory, and reloads the catalog (onChange), which moves the
  // sessions and books the new folder's hours under the kept project (index.mjs followLinks). Undoing the link keeps
  // the hours joined so far with the kept project (relinks.mjs removeRelink). Nothing else is written, moved or deleted.
  function runRelink(action, ctx, execute, base) {
    const { projectId } = ctx.relink;
    if (action === 'project-unlink') {
      const p = catalog?.getProject?.(projectId);
      if (!p?.linked) return failed(409, 'not-linked', 'relink');
      if (!execute || ctx.planOnly) return { status: 200, body: { ...base, projectId, linked: p.linked, result: { executed: false } }, note: 'dry' };
      // A link made to a folder that was not listed: the id that folder takes again (made from its path)
      const n = normPath(p.path);
      const folderId = p.linked.from ? null : catalog.adhocIdFor?.(n, slugify(n).toLowerCase()) || null;
      if (!removeRelink(hubDir, projectId, now(), { folderId })) return failed(500, 'record-write-failed', 'record');
      changed();
      return { status: 200, body: { ...base, projectId, result: { executed: true } }, note: 'live' };
    }
    const counts = (id) => ({ points: listPoints({ hubDir, projectId: id }).length, jobs: listJobResults({ hubDir, projectId: id }).length });
    const sessions = (id) => ingest?.projectSessions?.get(id)?.size || 0;
    const plan = planRelink({ catalog, projectId, folder: ctx.relink.folder, from: ctx.relink.from, appDir: appCwd, counts, sessions });
    if (!plan.ok) return failed(plan.problem === 'not-a-project' ? 404 : 409, plan.problem, 'relink');
    const summary = { planId: plan.planId, kept: plan.kept, folder: plan.folder, joining: plan.joining };
    if (!execute || ctx.planOnly) return { status: 200, body: { ...base, ...summary, result: { executed: false } }, note: 'plan' };
    if (ctx.relink.planId !== plan.planId) return failed(409, 'plan-changed', 'relink', summary);
    const link = { id: plan.kept.id, path: plan.folder, oldPath: plan.kept.oldPath, from: plan.from, at: now() };
    if (!setRelink(hubDir, plan.kept.id, link)) return failed(500, 'record-write-failed', 'record');
    changed();
    return { status: 200, body: { ...base, ...summary, result: { executed: true } }, note: 'live' };
  }

  // A restore point before an AI tool starts in a live mode (docs/restore.md): the project of the start (a session's
  // project for a session). It never stops the start: a problem is only reported ({ problem }). The answer says what
  // the point holds, so the page can tell a full copy from a lean one (big files and logs left out, docs/restore.md §7).
  async function takeStartPoint(projectId, label = '', jobId = null) {
    if (!projectId) return null;
    // No hub, or a hub of the old layout (copies are kept only in the new one): said, not silent
    if (!hubDir || !isDir(hubDir)) return { problem: 'no-hub' };
    if (isLegacyHub(hubDir)) return { problem: 'legacy-hub' };
    let r = null;
    let point;
    try {
      r = resolveProject({ catalog, projectId, hubDir, homeDir, claudeDir });
      if (!r.ok) return { problem: r.error };
      const p = await createPointAsync({ hubDir, projectId: r.project.id, dir: r.dir, reason: 'ai-start', now, label });
      point = p.ok ? { id: p.id, reused: p.reused, scope: p.scope === 'lean' ? 'lean' : 'full', leftOut: Number.isInteger(p.leftOut) ? p.leftOut : 0, files: p.files, bytes: p.bytes } : { problem: p.problem };
    } catch (e) {
      console.error('restore point failed:', logCode(e));
      point = { problem: 'copy-failed' };
    }
    // Kept for the job too (an app job only): the job box says it after a reload or in another window
    if (jobId && r?.ok) recordJobPoint({ hubDir, projectId: r.project.id, jobId, point, now });
    return point;
  }

  async function runGitHub(action, ctx, execute, base) {
    if (action === 'github-fetch') {
      const plan = gh().plan(ctx.repo);
      if (!execute) return { status: 200, body: { ...base, plan: [], result: { executed: false, ...plan } }, note: 'dry' };
      let got;
      try {
        got = await gh().fetch(ctx.repo);
      } catch (e) {
        return ghFailed(e, 'fetch');
      }
      const d = describeDownload({ hubDir, repoDir: got.dir, sub: ctx.repo.path, kit: readKit(catalog?.kitDir ?? null), roster: catalog?.roster, projectsFor: (items) => (typeof fitService.projectsFor === 'function' ? fitService.projectsFor(items) : []) });
      if (!d.ok) {
        gh().discard(got.id);
        return failed(d.status, d.error);
      }
      return {
        status: 200,
        body: { ...base, plan: [], result: { executed: true, fetchId: got.id, repo: ctx.repo.name, ref: ctx.repo.ref, path: ctx.repo.path, commit: got.commit, committedAt: got.committedAt || null, method: got.method, license: d.license, counts: d.counts, truncated: d.truncated, items: d.items } },
        note: 'live',
      };
    }
    if (action === 'github-discard') {
      if (!execute) return { status: 200, body: { ...base, plan: [{ op: 'remove', kind: 'download', name: ctx.fetchId, reason: 'discard' }], result: { executed: false } }, note: 'dry' };
      return { status: 200, body: { ...base, plan: [], result: { executed: true, removed: gh().discard(ctx.fetchId) } }, note: 'live' };
    }
    if (action === 'github-import') {
      const hit = gh().dirOf(ctx.fetchId);
      if (!hit) return failed(404, 'fetch-missing');
      const p = planDownloadImport({ hubDir, repoDir: hit.dir, picks: ctx.picks });
      if (!p.ok) return failed(p.status, p.error);
      if (!execute) return { status: 200, body: { ...base, plan: publicPlan(p.plan), result: { executed: false } }, note: 'dry' };
      // The provenance record must be writable before anything is copied (a broken one is never replaced)
      if (!readSources(hubDir).ok) return failed(409, 'record-broken');
      const r = executeImport({ hubDir, plan: p.plan });
      let catalogError = false;
      let recordError = false;
      if (r.copied || r.updated) {
        try {
          writeCatalog(hubDir, now);
        } catch {
          catalogError = true;
        }
        const add = p.plan.filter((e) => e.op === 'copy' || e.op === 'update').map((e) => sourceRow({ entry: e, marker: hit.marker, hash: treeHash(e.path), now }));
        try {
          updateSources(hubDir, { add });
        } catch {
          recordError = true;
        }
        changed();
      }
      return { status: 200, body: { ...base, plan: publicPlan(p.plan), result: { executed: true, copied: r.copied, updated: r.updated, catalogError, recordError } }, note: 'live' };
    }
    // github-check-update: for each library item that came from GitHub, is there a newer commit of its repository and
    // ref, and which of its files changed. Nothing in the library changes; an update is applied with github-import
    // (replace) once the person agrees.
    const src = readSources(hubDir);
    if (!src.ok) return failed(409, 'record-broken');
    const library = listLibrary(hubDir);
    if (!execute) {
      const plan = ctx.checks.map(({ kind, name }) => {
        const row = findSource(src.sources, kind, name);
        return row ? { op: 'check', kind, name, reason: 'from-github', repo: row.source.repo, ref: row.source.ref ?? null, commit: String(row.source.commit || '').slice(0, 7) } : { op: 'skip', kind, name, reason: 'not-from-github' };
      });
      return { status: 200, body: { ...base, plan, result: { executed: false } }, note: 'dry' };
    }
    const latest = new Map();
    const downloads = new Map();
    const needed = new Set();
    const items = [];
    for (const { kind, name } of ctx.checks) {
      const row = findSource(src.sources, kind, name);
      if (!row) {
        items.push({ kind, name, status: 'not-from-github' });
        continue;
      }
      const lib = findLibraryItem(library, kind, name);
      if (!lib) {
        items.push({ kind, name, status: 'not-in-library' });
        continue;
      }
      const parsed = /** @type {any} */ (parseRepoName(row.source.repo, row.source.ref ?? null));
      const rel = normRel(row.source.path);
      if (!parsed || !rel) {
        items.push({ kind, name, status: 'error', error: 'bad-record' });
        continue;
      }
      const key = `${parsed.name}|${parsed.ref || ''}`;
      const localChanged = !sameHash(treeHash(lib.path), row.hash);
      let commit = latest.get(key);
      try {
        if (!commit) {
          commit = await gh().latestCommit(parsed);
          latest.set(key, commit);
        }
      } catch (e) {
        items.push({ kind, name, status: 'error', error: errCode(e) === 'internal' ? 'fetch-failed' : errCode(e) });
        continue;
      }
      const base2 = { kind, name, repo: parsed.name, commit: commit.slice(0, 7), localChanged };
      if (commit === row.source.commit) {
        items.push({ ...base2, status: 'up-to-date' });
        continue;
      }
      let dl = downloads.get(key);
      try {
        if (!dl) {
          dl = await gh().fetch(parsed, { known: commit });
          downloads.set(key, dl);
        }
      } catch (e) {
        items.push({ ...base2, status: 'error', error: errCode(e) === 'internal' ? 'fetch-failed' : errCode(e) });
        continue;
      }
      const newPath = rel === '.' ? dl.dir : path.join(dl.dir, ...rel.split('/'));
      const st = lstat(newPath);
      if (!st || st.isSymbolicLink() || st.isDirectory() !== (kind === 'skill')) {
        items.push({ ...base2, status: 'gone', fetchId: dl.id });
        continue;
      }
      const changes = diffItems(lib.path, newPath);
      if (!changes.length) {
        items.push({ ...base2, status: 'unchanged', fetchId: dl.id });
        continue;
      }
      needed.add(dl.id);
      const review = reviewItem(newPath);
      items.push({ ...base2, status: 'update', fetchId: dl.id, path: rel, category: lib.category, changes: changes.slice(0, 50), more: Math.max(0, changes.length - 50), review: { level: review.level, reasons: review.reasons } });
    }
    // A download no update needs is deleted at once
    for (const dl of downloads.values()) if (!needed.has(dl.id)) gh().discard(dl.id);
    return { status: 200, body: { ...base, plan: [], result: { executed: true, items } }, note: 'live' };
  }

  // Starts the process detached; resolved on the 'spawn' event, rejected on 'error' (e.g. ENOENT).
  // The exit code is not awaited (explorer returns 1 even on success; that is not an error).
  // A working directory inside an archive is refused before spawn: the OS cannot enter it.
  /** @returns {Promise<void>} */
  function launch(argv, opts) {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      if (hasAsarSegment(opts?.cwd)) return reject(Object.assign(new Error('working directory inside an archive'), { code: ASAR_CWD }));
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), opts);
      } catch (e) {
        return reject(e);
      }
      if (!child || typeof child.on !== 'function') return resolve();
      let settled = false;
      child.on('error', (e) => {
        if (settled) return; // later errors are swallowed; an 'error' with no listener must not kill the process
        settled = true;
        reject(e);
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        try {
          child.unref?.();
        } catch {
          /* yoksay */
        }
        resolve();
      });
    });
  }

  // Why a launch failed: 'workdir' (the working directory cannot be entered), 'missing' (the program was not found)
  // or 'failed'. libuv reports ENOENT for a missing program and for a working directory CreateProcess cannot enter
  // alike, so ENOENT names the program only when the working directory is a real folder.
  function launchFailure(e, cwd) {
    if (e?.code === ASAR_CWD) return 'workdir';
    if (e?.code === 'ENOENT') return !hasAsarSegment(cwd) && isDir(cwd) ? 'missing' : 'workdir';
    return 'failed';
  }

  // "Open terminal" (docs/terminal.md): a plain shell in the folder, no AI command; the user starts the tool they
  // want. Windows Terminal first (a new tab in the "sibersentez" window, default profile); when wt.exe cannot be started
  // from the app folder, Windows PowerShell in its own console window. Dry: both commands in the reply, nothing runs.
  async function openTerminal(argv, ctx, base) {
    const fallback = buildShellFallbackArgv({ cmdExe, powershellExe });
    if (mode === 'dry') return { status: 200, body: { ...base, fallbackArgv: fallback }, note: 'dry' };
    const fail = (status, error, note) => failed(status, error, note, { action: 'terminal' });
    let first;
    try {
      await launch(argv, { shell: false, detached: true, stdio: 'ignore', cwd: appCwd });
      return { status: 200, body: { ...base, terminal: 'wt' }, note: 'live' };
    } catch (e) {
      first = launchFailure(e, appCwd);
    }
    // The app folder failed, not Windows Terminal: no fallback under a wrong "not found"
    if (first === 'workdir') return fail(500, 'app-folder-missing', 'workdir');
    if (fallback.some((a) => UNSAFE_RE.test(String(a))) || !isFile(cmdExe) || !isFile(powershellExe)) return fail(501, 'no-terminal', 'missing');
    try {
      // The folder is the working directory; both programs have absolute paths, so nothing is looked up in it
      await launch(fallback, { shell: false, detached: true, stdio: 'ignore', cwd: ctx.dir });
    } catch (e) {
      const why = launchFailure(e, ctx.dir);
      if (why === 'workdir') return fail(404, 'folder-missing', 'folder');
      return why === 'missing' ? fail(501, 'no-terminal', 'missing') : fail(500, 'launch-failed', 'launch');
    }
    return { status: 200, body: { ...base, argv: fallback, terminal: 'powershell', fallbackReason: first === 'missing' ? 'terminal-missing' : 'terminal-failed' }, note: 'fallback' };
  }

  // ---------------- start-ai: an AI tool in a terminal (docs/ai-start.md) ----------------
  // Body: projectId or sessionId, tool (an id of server/tools.mjs), withIdea (boolean, optional; absent = false),
  // resume (boolean, optional): continue a closed session of that tool (its resume arguments, server/tools.mjs: claude
  // --resume <id>, codex resume <id>...) through the same launcher, so it can run in the dock too; only a tool that
  // can, with a session of that very tool and a sessionId, never with an idea.
  // The folder, the tab title and the ids pass exactly the terminal action's checks. No text of the request reaches
  // any command line: the tool comes from detection (an absolute path), the prompt is a fixed ASCII sentence naming
  // the first-message file, and wt.exe only ever gets cmd.exe and the launcher (server/launch.mjs).
  // job (string, optional): "Do a job" (docs/kit-in-app.md), the job the person typed; the first message then asks for
  // the kit's team flow. Never with withIdea or resume.
  const toolDetector = () => ai.tools || sharedToolDetector();
  const aiEnv = () => ai.env || process.env;
  // Exists at all (an app execution alias in WindowsApps cannot be followed by stat)
  const present = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  async function startAi(v) {
    const { ctx } = v;
    const tool = toolById(ctx.tool);
    const base = { ok: true, mode, action: 'start-ai', tool: tool.id };
    const fail = (status, error, note, extra = {}) => failed(status, error, note, { action: 'start-ai', tool: tool.id, ...extra });

    // 1. The tool must be installed. Detection is cached for five minutes; a file that vanished since is looked for
    // once more (throttled like "check again").
    let rec;
    try {
      const pick = (r) => (r?.tools || []).find((x) => x.id === tool.id) || null;
      rec = pick(await toolDetector().detect());
      if (rec?.installed && !present(rec.chosen?.file)) rec = pick(await toolDetector().detect({ refresh: true }));
    } catch (e) {
      console.error('tool detection failed:', logCode(e));
      return fail(500, 'detection-failed', 'detection');
    }
    if (!rec?.installed || !rec.chosen || !present(rec.chosen.file)) return fail(409, 'tool-missing', 'tool-missing');
    // Its resume arguments were checked from a version on (server/tools.mjs resumeMin): an older one may not know them
    if (ctx.resume && tool.resumeMin && !versionAtLeast(rec.version, tool.resumeMin)) return fail(409, 'resume-version', 'resume-version');
    // A record without resume arguments would quietly start a new session instead: refused (review 2026-10-07)
    if (ctx.resume && !resumeArgs(tool, ctx.sessionId).length) return fail(409, 'resume-not-supported', 'resume-not-supported');

    // 2. Where the launcher goes, and whether wt can take its path as it is (server/launch.mjs)
    const env = aiEnv();
    // Linux and macOS (plan G1): no Windows Terminal, the tool starts in SiberSentez's own terminal only
    if (!plat.windows && !ctx.inDock) return fail(501, 'no-terminal', 'missing');
    const appData = appDataDir(env, plat);
    const candidates = ai.launchDirs || [hubDir ? path.join(hubDir, 'launch') : null, appData ? plat.path.join(appData, 'launch') : null];
    const where = pickLaunchDir(candidates.filter(Boolean), (d) => UNSAFE_RE.test(d), plat);
    if (!where.ok || (plat.windows && !SAFE_LAUNCH_RE.test(cmdExe))) return fail(409, 'launch-path-unsafe', 'launch-path');

    // 3. The first message: planned read-only here, written only in live mode
    const jobId = ctx.job ? newJobId() : null;
    if (jobId) base.jobId = jobId;
    const text = ctx.job ? jobMessageText(ctx.job, jobId) : ctx.idea ? firstMessageText(ctx.idea) : null;
    let first = null;
    if (text) {
      first = planFirstMessage(ctx.dir, text, fs, jobId);
      if (!first.ok) return fail(409, first.error, 'first-message');
      if (jobId) {
        // An unknown marker (a small plain file) is set aside by the live start; a link, a folder or a file that
        // cannot be read just now stops the start with its own reason
        const markerErr = markerError(readCurrentJob(path.join(ctx.dir, FIRST_DIR)));
        if (markerErr) return fail(409, markerErr, 'job-identity');
      }
    }
    const launcher = newLauncherName(undefined, plat);
    // In SiberSentez's own terminal the pseudo console starts in the project folder itself and cmd gets the launcher by
    // its full path (no Windows Terminal argument in between): relative mode needs no cd line there, so a project folder
    // with Turkish letters starts too (docs/ai-start.md). A launcher path cmd would expand stays on the old way.
    const direct = ctx.inDock && (!plat.windows || DOCK_LAUNCHER_RE.test(path.join(where.dir, launcher)));
    const toolArgsFor = (file) => (ctx.resume ? resumeArgs(tool, ctx.sessionId) : [...(ctx.job ? jobArgs(tool, rec.version) : []), ...toolArgs(tool, file ? launchPrompt(file) : null)]);
    const shell = plat.windows ? null : terminalShell(env, plat, (p) => fs.existsSync(p));
    const makeLauncher = (file) =>
      !plat.windows
        ? shellLauncherText({ toolName: tool.name, file: rec.chosen.file, args: toolArgsFor(file), shell })
        : launcherText({ toolName: tool.name, file: rec.chosen.file, ext: rec.chosen.ext, args: toolArgsFor(file), cdDir: where.mode === 'relative' && !direct ? ctx.dir : null, env });
    let lt = makeLauncher(first?.file);
    if (!lt.ok) return fail(409, lt.error, 'launcher');
    // Linux and macOS: sh runs the launcher by its full path; nothing parses the argument
    const shArgv = ['/bin/sh', plat.path.join(where.dir, launcher)];
    const argv = plat.windows ? buildAiArgv({ mode: where.mode, dir: ctx.dir, launchDir: where.dir, launcher, title: ctx.title, cmdExe }) : shArgv;
    const fallbackArgv = plat.windows ? buildAiFallbackArgv({ mode: where.mode, launchDir: where.dir, launcher, cmdExe }) : shArgv;
    // Last guard: nothing that reaches Windows Terminal carries a separator, a quote or a control character
    if (plat.windows && argv.slice(1).some((a) => UNSAFE_RE.test(String(a)))) return fail(409, 'launch-path-unsafe', 'launch-path');
    const about = { name: tool.name, via: rec.via || null, version: rec.version || null, ready: rec.ready || 'unknown' };
    const firstInfo = (f) => (f ? { file: `.sibersentez/${f.file}`, op: f.op, gitignore: f.gitignore } : null);
    if (base.mode === 'dry') {
      return { status: 200, body: { ...base, argv, fallbackArgv, about, launcher: { mode: where.mode, text: lt.text }, firstMessage: firstInfo(first), result: { executed: false, written: [] } }, note: 'dry' };
    }

    // 4. Live: a restore point of the project, the first message, the launcher, then the terminal. Not while the
    // project is being put back (its files are half old, half new until that is done)
    const pid = ctx.pointProjectId;
    if (pid && restoring.has(pid)) return fail(409, 'restore-running', 'restore-running');
    if (pid) starting.add(pid);
    let restorePoint;
    try {
      restorePoint = await takeStartPoint(pid, ctx.job || '', jobId);
    } finally {
      if (pid) starting.delete(pid);
    }
    const written = [];
    if (text) {
      const w = writeFirstMessage(ctx.dir, text, fs, jobId);
      if (!w.ok) return fail(w.error === 'first-message-failed' ? 500 : 409, w.error, 'first-message');
      if (w.folder === 'create') written.push('.sibersentez/');
      if (w.gitignore === 'create') written.push('.sibersentez/.gitignore');
      if (w.op === 'create') written.push(`.sibersentez/${w.file}`);
      // Another start may have taken the planned name meanwhile: the prompt names the file really written
      if (w.file !== first.file) lt = makeLauncher(w.file);
      first = w;
    }
    if (jobId) {
      const active = writeCurrentJob(path.join(ctx.dir, FIRST_DIR), jobId, fs, { tool: tool.id });
      if (!active.ok) return fail(active.error === 'first-message-failed' ? 500 : 409, active.error, 'job-identity', { written });
      written.push(`.sibersentez/${CURRENT_JOB_FILE}`);
    }
    const launcherFile = plat.path.join(where.dir, launcher);
    try {
      fs.mkdirSync(where.dir, { recursive: true });
      cleanupLaunchers(where.dir, { now: now() });
      // The cmd launcher is ASCII (launcherText checks it); the sh one UTF-8, readable by its owner only
      fs.writeFileSync(launcherFile, lt.text, plat.windows ? { encoding: 'ascii', flag: 'wx' } : { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (e) {
      console.error('launcher could not be written:', logCode(e));
      return fail(500, 'launcher-failed', 'launcher', { written });
    }
    const body = { ...base, argv, about, launcher: { mode: where.mode }, firstMessage: firstInfo(first), restorePoint, result: { executed: true, written } };
    const dropLauncher = () => fs.rmSync(launcherFile, { force: true });
    const fallbackCwd = where.mode === 'absolute' ? ctx.dir : where.dir;
    // In SiberSentez's own terminal (docs/embedded-terminal.md): nothing starts here. The page gets a one-time id; the
    // desktop shell redeems it (terminalTarget) and runs the same launcher in a pseudo console, as the Command Prompt
    // fallback would (fallbackArgv without its "start")
    if (ctx.inDock) {
      const program = !plat.windows ? { file: '/bin/sh', args: [launcherFile] } : direct ? { file: cmdExe, args: ['/d', '/v:off', '/k', launcherFile] } : { file: fallbackArgv[5], args: fallbackArgv.slice(6) };
      const launchId = rememberDockLaunch({ dir: direct ? ctx.dir : fallbackCwd, title: ctx.title, projectId: ctx.pointProjectId || ctx.projectId || null, program, launcherFile, tool: tool.id, jobId });
      return { status: 200, body: { ...body, argv: [program.file, ...program.args], terminal: 'dock', launchId }, note: 'live' };
    }
    let why;
    try {
      await launch(argv, { shell: false, detached: true, stdio: 'ignore', cwd: appCwd });
      return { status: 200, body: { ...body, terminal: 'wt' }, note: 'live' };
    } catch (e) {
      why = launchFailure(e, appCwd);
    }
    if (why === 'workdir') {
      dropLauncher();
      return fail(500, 'app-folder-missing', 'workdir', { written });
    }
    if (!isFile(cmdExe)) {
      dropLauncher();
      return fail(501, 'no-terminal', 'missing', { written });
    }
    try {
      await launch(fallbackArgv, { shell: false, detached: true, stdio: 'ignore', cwd: fallbackCwd });
    } catch (e) {
      dropLauncher();
      const w = launchFailure(e, fallbackCwd);
      if (w === 'workdir') return fail(404, 'folder-missing', 'folder', { written });
      return w === 'missing' ? fail(501, 'no-terminal', 'missing', { written }) : fail(500, 'launch-failed', 'launch', { written });
    }
    return { status: 200, body: { ...body, argv: fallbackArgv, terminal: 'cmd', fallbackReason: why === 'missing' ? 'terminal-missing' : 'terminal-failed' }, note: 'fallback' };
  }

  async function execute(v) {
    if (v.skill) return executeSkill(v);
    if (v.aiStart) return startAi(v);
    const { action, argv, ctx } = v;
    const base = { ok: true, mode, action, argv };
    if (action === 'new') base.sessionId = ctx.newSessionId;
    if (action === 'terminal') return openTerminal(argv, ctx, base);
    if (mode === 'dry') return { status: 200, body: base, note: 'dry' };

    // Search path: libuv looks up a bare program name in the working directory first. The trusted app folder is
    // used instead of the project folder (it may be a cloned foreign repo); wt gets the tab folder through -d.
    const opts = { shell: false, detached: true, stdio: 'ignore', cwd: appCwd };
    if (action === 'explorer' && plat.windows) opts.windowsVerbatimArguments = true;
    if (action === 'vscode') {
      // when ELECTRON_RUN_AS_NODE is set, Code.exe takes the folder for a Node script
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      opts.env = env;
    }
    try {
      await launch(argv, opts);
    } catch (e) {
      const why = launchFailure(e, appCwd);
      if (why === 'workdir') return { status: 500, body: { ok: false, error: 'app-folder-missing' }, note: 'workdir' };
      if (why === 'missing') return { status: 501, body: { ok: false, error: action === 'explorer' && !plat.windows ? 'file-manager-missing' : `${PROGRAM_CODES[action]}-missing` }, note: 'missing' };
      return { status: 500, body: { ok: false, error: 'launch-failed' }, note: 'launch' };
    }
    return { status: 200, body: base, note: 'live' };
  }

  // GET /api/actions: mode, token and action list. Same origin only.
  function handleGet(req, res) {
    if (mode === 'off') return send(res, 404, { error: 'actions-off' });
    if (req.headers['sec-fetch-site'] !== 'same-origin') {
      writeLog('list', '-', 403, 'fetch-site');
      return send(res, 403, { error: 'cross-site' });
    }
    // A same-origin GET carries no Origin in most browsers; if it does, it must be right
    if (req.headers.origin !== undefined && !originAllowed(req)) {
      writeLog('list', '-', 403, 'origin');
      return send(res, 403, { error: 'origin-rejected' });
    }
    writeLog('list', '-', 200, mode);
    return send(res, 200, { mode, token, actions: list() });
  }

  // POST /api/action: checked in order Origin -> Sec-Fetch-Site -> Content-Type -> size -> JSON -> token -> validation; stops at the first failure.
  async function handlePost(req, res) {
    if (mode === 'off') return send(res, 404, { error: 'actions-off' });
    let act = '-';
    let target = '-';
    const reply = (status, body, note, headers) => {
      writeLog(act, target, status, note);
      send(res, status, body, headers);
    };
    try {
      if (!originAllowed(req)) return reply(403, { ok: false, error: 'origin-rejected' }, 'origin');
      if (req.headers['sec-fetch-site'] !== 'same-origin') return reply(403, { ok: false, error: 'cross-site' }, 'fetch-site');
      if (!JSON_TYPE_RE.test(String(req.headers['content-type'] || ''))) return reply(415, { ok: false, error: 'json-only' }, 'content-type');
      let raw;
      try {
        raw = await readBody(req, MAX_BODY);
      } catch (e) {
        // The rest of the body is not read; the connection closes after the reply
        if (e.code === 'TOO_LARGE') return reply(413, { ok: false, error: 'body-too-large' }, 'size', { Connection: 'close' });
        return reply(400, { ok: false, error: 'body-unreadable' }, 'body');
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { ok: false, error: 'bad-json' }, 'json');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'body-not-object' }, 'json');
      act = typeof body.action === 'string' && ACTION_NAMES.includes(body.action) ? body.action : '?';
      target = logTarget(body);
      // Log notes are English (the launch actions used to keep their own; now one value)
      const note = (skill, launch) => (SKILL_SET.has(act) ? skill : launch);
      if (!tokenMatches(req.headers['x-sibersentez-token'])) return reply(403, { ok: false, error: 'bad-token' }, note('token', 'token'));
      // The mode this request runs in is the one its token belongs to (setMode may change it while the request
      // awaits): every decision reads it synchronously at the start of the handler (base.mode), and the reply says it
      const accepted = mode;

      const v = validate(body);
      if (!v.ok) return reply(v.status, v.body, note('validation', 'validation'));

      const t = now();
      for (const [k, at] of recent) if (t - at >= REPEAT_MS) recent.delete(k);
      if (recent.has(v.key)) return reply(429, { ok: false, error: 'repeat' }, note('repeat', 'repeat'));
      recent.set(v.key, t);

      const r = await execute(v);
      if (r.body && typeof r.body === 'object' && 'mode' in r.body) r.body.mode = accepted;
      return reply(r.status, r.body, r.note);
    } catch (e) {
      // The error code only: a message can carry a path
      console.error('action failed:', logCode(e));
      return reply(500, { ok: false, error: 'internal' }, 'error');
    }
  }

  // Wrong method on an action path: 405 and a single log line (in off mode the path does not exist: 404, no log)
  function rejectMethod(req, res, route) {
    if (mode === 'off') return send(res, 404, { error: 'actions-off' });
    const isList = route === '/api/actions';
    writeLog(isList ? 'list' : '-', '-', 405, 'method');
    return send(res, 405, { error: isList ? 'get-only' : 'post-only' }, { Allow: isList ? 'GET, HEAD' : 'POST' });
  }

  // A new mode without a restart (docs/actions-toggle.md §3.5): a new token, so a page that still holds the old one is
  // refused (403) and must ask GET /api/actions again, where it learns the new mode; no answer is ever re-sent under a
  // mode it was not asked in. The repeat guard starts over. A request already accepted finishes under the mode it was
  // accepted in (handlePost: accepted; startAi reads base.mode after its awaits).
  function setMode(next) {
    const m = ['off', 'dry', 'live'].includes(next) ? next : 'off';
    if (m === mode) return { changed: false, mode };
    mode = m;
    token = newToken();
    tokenBuf = token ? Buffer.from(token, 'utf8') : null;
    recent.clear();
    writeLog('mode', '-', 200, mode);
    return { changed: true, mode };
  }

  // The embedded terminal (docs/embedded-terminal.md): the desktop shell asks over the server's own channel where a
  // terminal for a project or a session opens. The same checks as the terminal action (catalog or logs, broad folder,
  // the folder exists, unsafe characters in the folder or the title); only in live mode. The page sends ids, never a
  // path; the answer goes to the shell only.
  // A start-ai in the dock leaves its launcher here under a one-time id: 96 random bits, two minutes, redeemed once
  // by the shell (never by the page, which only passes the id on); an unredeemed launcher is removed when it expires
  const dockLaunches = new Map();
  const DOCK_LAUNCH_MS = 120000;
  function sweepDockLaunches() {
    for (const [id, x] of dockLaunches) {
      if (now() - x.at < DOCK_LAUNCH_MS) continue;
      dockLaunches.delete(id);
      fs.rmSync(x.launcherFile, { force: true });
    }
  }
  function rememberDockLaunch(x) {
    sweepDockLaunches();
    const id = `L${crypto.randomBytes(12).toString('hex')}`;
    dockLaunches.set(id, { ...x, at: now() });
    return id;
  }

  // What runs in the embedded terminals (the desktop shell tells it after every change, electron/terminals.mjs): AI
  // starts of any tool and plain shells, by project. Only the shell's own channel reaches this; every field is checked.
  // Each report carries the whole list, so the last one wins; the one that ended is the page's to show (its tab).
  // Counted: the app's own AI starts. A tool typed into a plain shell or started in Windows Terminal is not seen.
  let dockRunning = [];
  const DOCK_ID = /^t[1-9][0-9]{0,6}$/;
  const DOCK_TOOL = /^[a-z][a-z0-9-]{1,30}$/;
  const DOCK_JOB = /^J[0-9a-f]{32}$/;
  const dockItem = (x) => {
    if (!x || typeof x !== 'object' || !DOCK_ID.test(x.id || '')) return null;
    const projectId = typeof x.projectId === 'string' && x.projectId.length <= 200 ? x.projectId : null;
    // running: false once the tab's AI tool ended and only its shell stays (a shell of an older version says nothing:
    // still running, the safe side)
    return { id: x.id, projectId, ai: x.ai === true, tool: DOCK_TOOL.test(x.tool || '') ? x.tool : null, jobId: DOCK_JOB.test(x.jobId || '') ? x.jobId : null, startedAt: Number.isFinite(x.startedAt) ? x.startedAt : null, running: x.running !== false };
  };
  /** @param {{ sessions?: any[] }} [state] */
  function terminalState({ sessions } = {}) {
    if (!Array.isArray(sessions) || sessions.length > 100) return { ok: false, reason: 'invalid' };
    dockRunning = sessions.map(dockItem).filter(Boolean);
    return { ok: true, reason: 'saved' };
  }
  const dockSessions = () => dockRunning.map((x) => ({ ...x }));
  // An AI tool works in the project: a live Claude session (its logs) or an AI start still running in the dock (its
  // tool not ended: a shell left open after the tool does not block going back)
  const aiActiveIn = (projectId) => [...(ingest?.sessions?.values?.() || [])].some((s) => s?.live && s.projectId === projectId) || dockRunning.some((x) => x.ai && x.running && x.projectId === projectId);

  function terminalTarget(req) {
    if (mode !== 'live') return { ok: false, reason: mode === 'dry' ? 'preview' : 'off' };
    if (req?.launchId !== undefined) {
      sweepDockLaunches();
      const x = typeof req.launchId === 'string' ? dockLaunches.get(req.launchId) : undefined;
      if (!x) return { ok: false, reason: 'refused', status: 404 };
      dockLaunches.delete(req.launchId);
      return { ok: true, dir: x.dir, title: x.title, projectId: x.projectId, program: x.program, tool: x.tool || undefined, jobId: x.jobId || undefined };
    }
    // The setup terminal (installing an AI tool from the tools panel): a plain shell in the user's home folder, no
    // program, no project. Only this exact request; the home folder must be a real local folder.
    if (req?.setup !== undefined) {
      // The platform's home folder (USERPROFILE, HOME; platform.mjs), a local absolute one
      const home = homeOf(ai.env || process.env, plat);
      if (req.setup !== true || Object.keys(req).length !== 1 || !home) return { ok: false, reason: 'refused', status: 400 };
      try {
        if (!fs.statSync(home).isDirectory()) return { ok: false, reason: 'refused', status: 404 };
      } catch {
        return { ok: false, reason: 'refused', status: 404 };
      }
      return { ok: true, dir: home, title: 'Setup', projectId: null };
    }
    const body = { action: 'terminal' };
    if (typeof req?.projectId === 'string') body.projectId = req.projectId;
    if (typeof req?.sessionId === 'string') body.sessionId = req.sessionId;
    // SiberSentez's own terminal: the terminal action's folder and title checks, not Windows Terminal's platform rule
    const v = validate(body, true);
    if (!v.ok) return { ok: false, reason: 'refused', status: v.status };
    return { ok: true, dir: v.ctx.dir, title: v.ctx.title, projectId: v.ctx.projectId || null };
  }

  return {
    get mode() {
      return mode;
    },
    terminalTarget,
    terminalState,
    dockSessions,
    get token() {
      return token;
    },
    setMode,
    list,
    handleGet,
    handlePost,
    rejectMethod,
  };
}
