// @ts-check
// The checks of an action request (plan D8: from createActions in actions.mjs): the body's fields, the ids, the
// folders and the skill flow's items, before anything is planned or started. createValidators gets what createActions
// fixes when it is made (the catalog, the hub, the clock...), never the mode, the token or what is running, so a check
// answers the same as before the split. Same import rule as actions.mjs: nothing here imports config.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLegacyHub, validName, CATEGORY_RE, MAX_REL_PATH } from './library.mjs';
import { TARGETS, defaultTargets, resolveProject } from './install.mjs';
import { POINT_ID_RE } from './restore.mjs';
import { KEY_RE, normalizeJob } from './fit.mjs';
import { toolById, TOOL_IDS } from './tools.mjs';
import { parseGitHubUrl, FETCH_ID_RE } from './github.mjs';
import { PROJECT_ID_RE } from './util.mjs';
import { PLATFORM, fileManager, isLocalAbsolute, normalizeDir } from './platform.mjs';

// 'new' (a new Claude Code session) stays for the server and the skill trial; the context menu offers 'terminal'
export const LAUNCH_ACTIONS = Object.freeze(['resume', 'fork', 'new', 'terminal', 'explorer', 'vscode']);

export const SKILL_ACTIONS = Object.freeze(['library-scan', 'library-import', 'library-adopt', 'skills-preview', 'skills-install', 'skills-remove', 'skills-trial', 'skills-apply', 'restore-preview', 'restore-apply', 'project-relink', 'project-unlink']);

// An AI tool started in a terminal, with the project's idea as its first message (docs/ai-start.md)
const AI_ACTIONS = Object.freeze(['start-ai']);

// Bringing skills and agents from GitHub (docs/github-import.md): the only actions that reach the internet, and only in
// live mode
export const GITHUB_ACTIONS = Object.freeze(['github-fetch', 'github-import', 'github-discard', 'github-check-update']);

export const ACTION_NAMES = Object.freeze([...LAUNCH_ACTIONS, ...SKILL_ACTIONS, ...AI_ACTIONS, ...GITHUB_ACTIONS]);

const MAX_PACKAGES = 10;

const MAX_TITLE = 40;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PACKAGE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// The project id goes into argv (-n): it starts with a letter or digit so it is never read as an option
// Windows Terminal treats ';' as a command separator even inside quotes and does not escape '"'; explorer gets the path
// verbatim, quoted. Control characters (C0, DEL, C1, line separators) must not appear in any argument.
export const UNSAFE_RE = /[;"\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Required and allowed body fields per action; any other field is rejected
const FIELDS = {
  resume: { required: ['sessionId'], optional: ['projectId', 'packages'] },
  fork: { required: ['sessionId'], optional: ['projectId', 'packages'] },
  new: { required: ['projectId'], optional: ['packages'] },
  terminal: { required: [], optional: ['projectId', 'sessionId'] },
  // open: 'index.html' opens the project's own web page in the default browser instead of the folder (docs/run-hint.md)
  explorer: { required: [], optional: ['projectId', 'sessionId', 'open'] },
  vscode: { required: [], optional: ['projectId', 'sessionId'] },
};

// Actions whose arguments reach Windows Terminal (tab title and last guard apply)
const TERMINAL_ACTIONS = new Set(['resume', 'fork', 'new', 'terminal']);

const TARGET_ACTIONS = new Set(['terminal', 'explorer', 'vscode']); // projectId or sessionId, one of them

// Skill flow bodies (docs/skills-flow.md §4). Error codes are English; the page maps them to text.
const SKILL_FIELDS = {
  'library-scan': { required: ['source'], optional: [] },
  'library-import': { required: ['source', 'items'], optional: [] },
  // A listed skill or agent into the library, from where it lives on this disk (docs/skills-flow.md §5.1)
  'library-adopt': { required: ['items'], optional: [] },
  'skills-preview': { required: ['projectId', 'items'], optional: ['targets'] },
  'skills-install': { required: ['projectId', 'items'], optional: ['targets'] },
  'skills-remove': { required: ['projectId', 'items'], optional: ['targets', 'plan'] },
  'skills-trial': { required: ['projectId', 'items'], optional: [] },
  'skills-apply': { required: ['projectId'], optional: ['keys', 'targets'] },
  // Restore points (docs/restore.md): what going back would do, and going back
  'restore-preview': { required: ['projectId', 'pointId'], optional: [] },
  'restore-apply': { required: ['projectId', 'pointId'], optional: ['planId'] },
  // A moved project linked to its new folder (docs/internal/project-relink-plan.md): a picked folder, or the listed
  // project whose folder it is; and the link undone
  'project-relink': { required: ['projectId'], optional: ['folder', 'from', 'plan', 'planId'] },
  'project-unlink': { required: ['projectId'], optional: ['plan'] },
  // GitHub import (docs/github-import.md §6)
  'github-fetch': { required: ['url'], optional: [] },
  'github-import': { required: ['fetchId', 'items'], optional: [] },
  'github-discard': { required: ['fetchId'], optional: [] },
  'github-check-update': { required: ['items'], optional: [] },
};

export const GITHUB_SET = new Set(GITHUB_ACTIONS);

// The skill flow and the GitHub import: English error codes and log notes, one shared validation
export const SKILL_SET = new Set([...SKILL_ACTIONS, ...GITHUB_ACTIONS]);

export const MAX_SKILL_ITEMS = 25;

const MAX_URL = 500;

// Pure: builds argv from a validated context. Touches neither the file system nor any process.
// ctx: { dir, title, sessionId, newSessionId, projectId, packageDirs (resolved package folders), codeExe, file (explorer: a web page to open instead of the folder) }
export function buildArgv(action, ctx, plat = PLATFORM) {
  const plugins = (ctx.packageDirs || []).flatMap((d) => ['--plugin-dir', d]);
  const terminal = ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ctx.dir, '--title', ctx.title, '--suppressApplicationTitle', 'claude'];
  switch (action) {
    case 'resume':
      return [...terminal, '--resume', ctx.sessionId, ...plugins];
    case 'fork':
      return [...terminal, '--resume', ctx.sessionId, ...plugins, '--fork-session'];
    case 'new':
      return [...terminal, '-n', ctx.projectId, '--session-id', ctx.newSessionId, ...plugins];
    case 'terminal':
      // A new tab with the default profile in the folder; no command, so no AI tool is started
      return ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ctx.dir, '--title', ctx.title];
    case 'explorer':
      // Linux and macOS: the file manager by its full path (xdg-open, open), the path one plain argument
      if (!plat.windows) return [fileManager({}, plat), ctx.file || ctx.dir];
      // explorer splits on commas; the path is passed verbatim, quoted, with windowsVerbatimArguments
      return ['explorer.exe', `"${ctx.file || ctx.dir}"`];
    case 'vscode':
      return [ctx.codeExe, ctx.dir];
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export const reject = (status, error, extra = {}) => ({ ok: false, status, body: { ok: false, error, ...extra } });

// Folder path: character check first (the file system is never touched with an odd path), then whether the folder exists
function checkDir(raw, missing) {
  if (typeof raw !== 'string' || !raw) return reject(404, missing);
  if (UNSAFE_RE.test(raw)) return reject(409, 'folder-path-unsafe');
  // A local absolute folder of the platform (a drive letter on Windows, one leading slash on Linux and macOS)
  if (!isLocalAbsolute(raw)) return reject(409, 'folder-path-unsupported');
  const dir = normalizeDir(raw);
  if (!isDir(dir)) return reject(404, missing);
  return { ok: true, dir };
}

export function createValidators({ catalog, ingest, hubDir, codeExe, homeDir, claudeDir, appCwd, plat = PLATFORM }) {
  // internal: a check made for start-ai (its folder and tab title pass the terminal action's checks): the tool starts in
  // SiberSentez's own terminal there, so Windows Terminal's platform rule does not apply
  function validate(body, internal = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'body-not-object');
    const action = body.action;
    if (typeof action !== 'string' || !ACTION_NAMES.includes(action)) return reject(400, 'unknown-action');
    if (SKILL_SET.has(action)) return validateSkill(body);
    if (action === 'start-ai') return validateAiStart(body);
    const spec = FIELDS[action];
    for (const k of Object.keys(body)) {
      if (k !== 'action' && !spec.required.includes(k) && !spec.optional.includes(k)) return reject(400, 'unexpected-field');
    }
    for (const k of spec.required) if (body[k] === undefined || body[k] === null || body[k] === '') return reject(400, `eksik alan: ${k}`);
    for (const k of ['projectId', 'sessionId']) if (body[k] !== undefined && typeof body[k] !== 'string') return reject(400, 'bad-field');
    if (body.packages !== undefined && (!Array.isArray(body.packages) || body.packages.some((p) => typeof p !== 'string'))) return reject(400, 'bad-field');
    if (body.packages && body.packages.length > MAX_PACKAGES) return reject(400, 'too-many-packages');
    if (TARGET_ACTIONS.has(action) && body.projectId === undefined && body.sessionId === undefined) return reject(400, 'projectId ya da sessionId gerekli');
    // Windows Terminal's actions (a Claude Code session, a plain tab): Windows only. Linux and macOS have SiberSentez's
    // own terminal for both (plan G1)
    if (!internal && !plat.windows && TERMINAL_ACTIONS.has(action)) return reject(501, 'windows-terminal-only');
    const packages = [...new Set(body.packages || [])];

    // Oturum: ingest'te bilinmeli
    let session = null;
    if (body.sessionId !== undefined) {
      if (!UUID_RE.test(body.sessionId)) return reject(400, 'bad-session-id');
      session = ingest?.sessions?.get(body.sessionId) || null;
      if (!session) return reject(404, 'session-not-found');
      if (action === 'resume' && session.live) return reject(409, 'session-live', { hint: 'fork' });
      // Continue and copy run Claude Code's --resume: another tool's session (server/toolLogs.mjs) is not Claude's
      if ((action === 'resume' || action === 'fork') && (session.tool || 'claude') !== 'claude') return reject(400, 'resume-claude-only');
    }

    // Project: must be in the catalog and must not be a broad folder
    let project = null;
    if (body.projectId !== undefined) {
      if (!PROJECT_ID_RE.test(body.projectId)) return reject(400, 'bad-project-id');
      project = catalog?.getProject?.(body.projectId) || null;
      if (!project) return reject(404, 'project-not-found');
      if (project.broad) return reject(409, 'broad-folder');
      if (session && session.projectId !== project.id) return reject(400, 'session-project-mismatch');
    } else if (session?.projectId) {
      project = catalog?.getProject?.(session.projectId) || null; // only for the tab title
    }

    const folder = session ? checkDir(session.cwd, 'folder-missing') : checkDir(project.path, 'folder-missing');
    if (!folder.ok) return folder;

    // Without the working directory spawn fails with ENOENT and a misleading "wt.exe not found": reported separately
    if (!isDir(appCwd)) return reject(500, 'app-folder-missing');

    // Packages (per-session --plugin-dir): accepted only when the hub has that category folder,
    // library/<category> (legacy hub: kutuphane/<category>)
    const packageDirs = [];
    for (const p of packages) {
      if (!PACKAGE_RE.test(p)) return reject(400, 'bad-package-name');
      if (!hubDir || !isDir(hubDir)) return reject(404, 'hub-missing');
      const dir = [path.join(hubDir, 'library', p), path.join(hubDir, 'kutuphane', p)].find(isDir);
      if (!dir) return reject(404, 'package-folder-missing');
      packageDirs.push(dir);
    }

    // External programs
    if (action === 'vscode' && !isFile(codeExe)) return reject(501, 'vscode-missing');

    // "Open in the browser" (docs/run-hint.md): only the literal 'index.html', a plain file at the project's own root
    // (never a link, never a session's folder); explorer opens it with the program Windows has for web pages
    let file = null;
    if (body.open !== undefined) {
      if (action !== 'explorer' || body.open !== 'index.html' || !project || session) return reject(400, 'bad-field');
      const f = path.join(folder.dir, 'index.html');
      let st = null;
      try {
        st = fs.lstatSync(f);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) return reject(404, 'file-missing');
      if (UNSAFE_RE.test(f)) return reject(409, 'command-unsafe');
      file = f;
    }

    const ctx = { dir: folder.dir, sessionId: session?.id, projectId: project?.id, packageDirs, codeExe, file };
    if (action === 'new') ctx.newSessionId = crypto.randomUUID();
    if (TERMINAL_ACTIONS.has(action)) {
      const name = String(project?.name || path.win32.basename(folder.dir) || '').trim();
      const title = Array.from(name).slice(0, MAX_TITLE).join('') || (action === 'terminal' ? 'Terminal' : 'Claude');
      if (UNSAFE_RE.test(title) || title.startsWith('-')) return reject(409, 'project-name-unsafe');
      ctx.title = title;
    }
    const argv = buildArgv(action, ctx, plat);
    // Last guard: no argument passed to Windows Terminal may carry a separator or a quote (hub path included)
    if (TERMINAL_ACTIONS.has(action) && argv.slice(1).some((a) => UNSAFE_RE.test(String(a)))) return reject(409, 'command-unsafe');
    return { ok: true, action, argv, ctx, key: `${action}|${project?.id || ''}|${session?.id || ''}${file ? '|page' : ''}` };
  }

  // ---------------- skill flow (docs/skills-flow.md) ----------------

  // [{ kind, name }] with exactly these keys; duplicates dropped
  function checkItems(items) {
    if (!Array.isArray(items) || !items.length) return reject(400, 'bad-items');
    if (items.length > MAX_SKILL_ITEMS) return reject(400, 'too-many-items');
    const out = [];
    const seen = new Set();
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return reject(400, 'bad-items');
      const keys = Object.keys(it);
      if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('name')) return reject(400, 'bad-items');
      if (it.kind !== 'skill' && it.kind !== 'agent') return reject(400, 'bad-kind');
      if (!validName(it.name)) return reject(400, 'bad-name');
      const k = `${it.kind}:${it.name}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: it.kind, name: it.name });
    }
    return { ok: true, items: out };
  }

  // skills-apply keys: candidate keys of the fit (kind:name or kind:name@label); duplicates dropped
  function checkKeys(keys) {
    if (!Array.isArray(keys) || !keys.length) return reject(400, 'bad-keys');
    if (keys.length > MAX_SKILL_ITEMS) return reject(400, 'too-many-items');
    const out = [];
    for (const k of keys) {
      if (typeof k !== 'string' || !KEY_RE.test(k)) return reject(400, 'bad-keys');
      if (!validName(KEY_RE.exec(k)[2])) return reject(400, 'bad-name');
      if (!out.includes(k)) out.push(k);
    }
    return { ok: true, keys: out };
  }

  // ['claude'|'agents'], returned in a fixed order
  function checkTargets(t) {
    if (!Array.isArray(t) || !t.length || t.length > TARGETS.length) return reject(400, 'bad-targets');
    for (const x of t) if (!TARGETS.includes(x)) return reject(400, 'bad-targets');
    return { ok: true, targets: TARGETS.filter((x) => t.includes(x)) };
  }

  // library-import picks: [{ path (relative, from a scan), category, replace? }]
  function checkPicks(items) {
    if (!Array.isArray(items) || !items.length) return reject(400, 'bad-items');
    if (items.length > MAX_SKILL_ITEMS) return reject(400, 'too-many-items');
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return reject(400, 'bad-items');
      for (const k of Object.keys(it)) if (!['path', 'category', 'replace'].includes(k)) return reject(400, 'bad-items');
      if (typeof it.path !== 'string' || !it.path || it.path.length > MAX_REL_PATH) return reject(400, 'bad-items');
      if (typeof it.category !== 'string' || !CATEGORY_RE.test(it.category)) return reject(400, 'bad-category');
      if (it.replace !== undefined && typeof it.replace !== 'boolean') return reject(400, 'bad-items');
      out.push({ path: it.path, category: it.category, replace: it.replace === true });
    }
    return { ok: true, picks: out };
  }

  // Body shape first (400), then the hub (no-hub, legacy-hub), then the project (resolveProject). On success
  // { ok, skill: true, action, ctx, key }; the key holds a digest of the request so the rate limit stops a repeat,
  // not the next batch.
  function validateSkill(body) {
    const action = body.action;
    const spec = SKILL_FIELDS[action];
    for (const k of Object.keys(body)) if (k !== 'action' && !spec.required.includes(k) && !spec.optional.includes(k)) return reject(400, 'unexpected-field');
    for (const k of spec.required) if (body[k] === undefined || body[k] === null || body[k] === '') return reject(400, 'missing-field');
    const ctx = {};
    if (GITHUB_SET.has(action)) {
      // GitHub import (docs/github-import.md §6): a link, a download id, import picks or library items
      if (action === 'github-fetch') {
        if (typeof body.url !== 'string' || body.url.length > MAX_URL) return reject(400, 'bad-url');
        const p = parseGitHubUrl(body.url);
        if (!p.ok) return reject(p.status, p.error);
        ctx.repo = p;
      } else if (action === 'github-check-update') {
        const items = checkItems(body.items);
        if (!items.ok) return items;
        ctx.checks = items.items;
      } else {
        if (typeof body.fetchId !== 'string' || !FETCH_ID_RE.test(body.fetchId)) return reject(400, 'bad-fetch-id');
        ctx.fetchId = body.fetchId;
        if (action === 'github-import') {
          const picks = checkPicks(body.items);
          if (!picks.ok) return picks;
          ctx.picks = picks.picks;
        }
      }
    } else if (action === 'library-adopt') {
      // Items by kind and name; where each lives is the server's own knowledge (catalog.itemOrigin), never the page's
      const items = checkItems(body.items);
      if (!items.ok) return items;
      const adopt = [];
      for (const it of items.items) {
        const o = typeof catalog?.itemOrigin === 'function' ? catalog.itemOrigin(it.kind, it.name) : null;
        if (!o) return reject(404, 'item-not-found');
        adopt.push({ kind: it.kind, name: it.name, source: o.source, pick: o.pick });
      }
      ctx.adopt = adopt;
    } else if (action === 'library-scan' || action === 'library-import') {
      if (typeof body.source !== 'string' || body.source.length > 260) return reject(400, 'bad-source');
      ctx.source = body.source;
      if (action === 'library-import') {
        const picks = checkPicks(body.items);
        if (!picks.ok) return picks;
        ctx.picks = picks.picks;
      }
    } else {
      if (typeof body.projectId !== 'string' || !PROJECT_ID_RE.test(body.projectId)) return reject(400, 'bad-project-id');
      if (action === 'project-relink') {
        if (body.folder !== undefined && (typeof body.folder !== 'string' || !body.folder || body.folder.length > 1024)) return reject(400, 'bad-folder');
        if (body.from !== undefined && (typeof body.from !== 'string' || !PROJECT_ID_RE.test(body.from))) return reject(400, 'bad-project-id');
        if ((body.folder === undefined) === (body.from === undefined)) return reject(400, 'folder-or-from');
        // The preview's digest: the link is written only while the plan is the one the person saw
        if (body.planId !== undefined && (typeof body.planId !== 'string' || !/^[0-9a-f]{16}$/.test(body.planId))) return reject(400, 'bad-field');
        ctx.relink = { projectId: body.projectId, folder: body.folder ?? null, from: body.from ?? null, planId: body.planId || null };
      } else if (action === 'project-unlink') {
        ctx.relink = { projectId: body.projectId };
      } else if (action === 'restore-preview' || action === 'restore-apply') {
        if (typeof body.pointId !== 'string' || !POINT_ID_RE.test(body.pointId)) return reject(400, 'bad-point-id');
        ctx.pointId = body.pointId;
        // The preview's digest: going back refuses a plan that changed since the person saw it
        if (body.planId !== undefined && (typeof body.planId !== 'string' || !/^[0-9a-f]{16}$/.test(body.planId))) return reject(400, 'bad-field');
        ctx.planId = body.planId || null;
      } else if (action === 'skills-apply') {
        // No keys: the automatic selection of the fit
        ctx.keys = null;
        if (body.keys !== undefined) {
          const k = checkKeys(body.keys);
          if (!k.ok) return k;
          ctx.keys = k.keys;
        }
      } else {
        const items = checkItems(body.items);
        if (!items.ok) return items;
        ctx.items = items.items;
      }
      if (body.targets !== undefined) {
        const t = checkTargets(body.targets);
        if (!t.ok) return t;
        ctx.targets = t.targets;
      }
      if (body.plan !== undefined && typeof body.plan !== 'boolean') return reject(400, 'bad-field');
      ctx.planOnly = body.plan === true;
    }
    if (!hubDir || !isDir(hubDir)) return reject(404, 'no-hub');
    if (isLegacyHub(hubDir)) return reject(409, 'legacy-hub');
    if (ctx.items || action === 'skills-apply' || ctx.pointId) {
      const r = resolveProject({ catalog, projectId: body.projectId, hubDir, homeDir, claudeDir });
      if (!r.ok) return reject(r.status, r.error);
      ctx.project = r.project;
      ctx.dir = r.dir;
      if (!ctx.targets) ctx.targets = defaultTargets(r.project.via);
    }
    if (action === 'skills-trial') {
      if (!isDir(appCwd)) return reject(500, 'app-folder-missing');
      const name = String(ctx.project.name || path.win32.basename(ctx.dir) || '').trim();
      const title = Array.from(name).slice(0, MAX_TITLE).join('') || 'Claude';
      if (UNSAFE_RE.test(title) || title.startsWith('-') || UNSAFE_RE.test(ctx.dir)) return reject(409, 'unsafe-path');
      ctx.title = title;
    }
    const github = ctx.repo ? [ctx.repo.name, ctx.repo.ref, ctx.repo.path] : ctx.fetchId || '';
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([ctx.source || '', ctx.picks || ctx.items || ctx.adopt || ctx.keys || ctx.checks || [], ctx.targets || [], !!ctx.planOnly, github, ctx.pointId || '', ctx.relink || null]))
      .digest('hex')
      .slice(0, 16);
    return { ok: true, skill: true, action, ctx, key: `${action}|${body.projectId || ''}|${digest}` };
  }

  const AI_START_KEYS = ['action', 'tool', 'projectId', 'sessionId', 'withIdea', 'inDock', 'resume', 'job'];

  function validateAiStart(body) {
    for (const k of Object.keys(body)) if (!AI_START_KEYS.includes(k)) return reject(400, 'unexpected-field');
    if (body.tool === undefined || body.tool === null || body.tool === '') return reject(400, 'missing-field');
    if (typeof body.tool !== 'string' || !TOOL_IDS.includes(body.tool)) return reject(400, 'bad-tool');
    if (body.withIdea !== undefined && typeof body.withIdea !== 'boolean') return reject(400, 'bad-field');
    if (body.inDock !== undefined && typeof body.inDock !== 'boolean') return reject(400, 'bad-field');
    if (body.resume !== undefined && typeof body.resume !== 'boolean') return reject(400, 'bad-field');
    const resume = body.resume === true;
    if (resume && !toolById(body.tool)?.resume) return reject(400, 'resume-not-supported');
    if (resume && (typeof body.sessionId !== 'string' || body.withIdea === true)) return reject(400, 'bad-field');
    let job = '';
    if (body.job !== undefined) {
      if (typeof body.job !== 'string' || resume || body.withIdea === true) return reject(400, 'bad-field');
      job = normalizeJob(body.job);
      if (!job) return reject(400, 'bad-field');
    }
    const target = {};
    if (body.projectId !== undefined) target.projectId = body.projectId;
    if (body.sessionId !== undefined) target.sessionId = body.sessionId;
    const t = validate({ action: 'terminal', ...target }, true);
    if (!t.ok) return t;
    // A session that is open cannot be continued a second time (its copy, fork, can)
    if (resume && ingest?.sessions?.get(t.ctx.sessionId)?.live) return reject(409, 'session-live', { hint: 'fork' });
    // The session must be one of the tool that continues it (another tool's log is read too: server/toolLogs.mjs)
    if (resume && (ingest?.sessions?.get(t.ctx.sessionId)?.tool || 'claude') !== body.tool) return reject(400, 'resume-other-tool');
    // The idea saved with the project (docs/start-flow.md); a session uses its project's idea
    const pid = t.ctx.projectId ?? (t.ctx.sessionId ? ingest?.sessions?.get(t.ctx.sessionId)?.projectId : undefined);
    const project = pid ? catalog?.getProject?.(pid) || null : null;
    const idea = body.withIdea === true && typeof project?.idea === 'string' ? project.idea.trim() : '';
    const ctx = { ...t.ctx, tool: body.tool, idea: resume || job ? '' : idea, job, inDock: body.inDock === true, resume, pointProjectId: project ? project.id : null };
    return { ok: true, aiStart: true, action: 'start-ai', ctx, key: `start-ai|${t.ctx.projectId || ''}|${t.ctx.sessionId || ''}|${body.tool}${resume ? '|resume' : ''}` };
  }

  return { validate };
}
