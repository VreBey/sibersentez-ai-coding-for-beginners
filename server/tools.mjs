// @ts-check
// AI tool detection (docs/ai-start.md): which AI command-line tools are on this computer, their version, how each
// was installed and, for Claude Code and Codex, whether the user is signed in.
//
// Runs only when asked (GET /api/tools, the start-ai action), never when the server starts; the answer is cached for
// five minutes and "check again" (?refresh=1) is throttled. Finding a tool is a plain file look-up in the PATH folders
// (plus the folders the official installers use, so a tool installed after SiberSentez started is found too): no process
// runs for it. A process runs only for the version and the sign-in check, and only programs this look-up found, by
// absolute path, with fixed arguments, a hidden window, no input, a time limit and the tool's own folder as working
// directory. An npm shim (.cmd) goes through cmd.exe explicitly (Node refuses to spawn a .cmd without a shell).
// The sign-in check keeps the exit code only: its output (Claude Code prints the account's e-mail) is never read.
//
// What leaves this module for the page (publicTools): tool id, name, installed or not, version, install kind
// (native, npm, winget, scoop, store, other), sign-in state (yes, no, unknown), the number of installs and the other
// installs' kind and version. Never a path: a path holds the user name.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { PLATFORM, installerDirs, homeOf, isLocalAbsolute, isWindowsDriveFromWsl } from './platform.mjs';
import { jobArgs, versionAtLeast } from './launch.mjs';

// Tools SiberSentez can start (docs/ai-start.md, "Tools"). commands: file names looked up in PATH order (first found
// wins; for Cursor the specific name first, so an unrelated "agent" program is not preferred). version: arguments
// that print the version. ready: arguments whose exit code 0 means signed in (null: the tool has no such command);
// readyOut: for a tool whose command answers 0 either way (Cursor's `status`), what its output must say as well: the
// output is looked at for that and dropped, never kept or logged (it holds the account's e-mail). The tools without
// such a command are read from their own settings files (fileReady, review F2).
// prompt: how the first message is passed when the tool starts interactively ('arg': as the first argument, or the
// option that takes it). A one-shot mode (-p, exec) is never used. plan: the arguments that start it in its own plan
// mode, where it reads and plans first and asks the person to approve the plan (checked against each tool's own --help
// and package, 2026-10-07: Claude Code --permission-mode plan; Gemini CLI 0.61 --approval-mode plan with its
// exit_plan_mode question "Ready to start implementation?"); absent: no such mode known. planMin: the oldest version
// the plan arguments were checked on; an older or unknown version starts as usual (an option it does not know would
// stop it from starting at all). Qwen Code 0.25 --approval-mode plan and Cursor CLI 2026.10.01 --plan were checked
// the same way, and GitHub Copilot CLI 1.0.93 --plan ("Start in plan mode", it asks to approve the plan itself) on
// 2026-10-08 (roadmap F4). Not used: Codex CLI has no plan mode (its read-only sandbox cannot go on with the work once a
// plan is approved); OpenCode's `--agent plan` plans and stops, and going on needs Tab to its build agent, which a
// beginner would not know, so a job would stand still. Both start as usual. resume: the arguments before a session id that continue that session where it stopped (each tool's
// --help, 2026-10-07: claude --resume <id>, codex resume <id>, gemini --resume <uuid>, copilot --resume=<id> (as it
// prints it itself: its value is optional, a trailing "=" joins the id, launch.mjs resumeArgs), cursor
// --resume <chatId>, qwen --resume <id>, opencode --session <id>); resumeMin as planMin.
export const TOOLS = Object.freeze([
  Object.freeze({ id: 'claude', name: 'Claude Code', commands: ['claude'], version: ['--version'], ready: ['auth', 'status'], prompt: 'arg', plan: Object.freeze(['--permission-mode', 'plan']), resume: Object.freeze(['--resume']) }),
  Object.freeze({ id: 'codex', name: 'Codex CLI', commands: ['codex'], version: ['--version'], ready: ['login', 'status'], prompt: 'arg', appPackage: /^OpenAI\.Codex_/i, resume: Object.freeze(['resume']), resumeMin: '0.160.0' }),
  Object.freeze({ id: 'gemini', name: 'Gemini CLI', commands: ['gemini'], version: ['--version'], ready: null, prompt: '-i', plan: Object.freeze(['--approval-mode', 'plan']), planMin: '0.61.0', resume: Object.freeze(['--resume']), resumeMin: '0.61.0' }),
  Object.freeze({ id: 'copilot', name: 'GitHub Copilot CLI', commands: ['copilot'], version: ['version'], ready: null, prompt: '-i', plan: Object.freeze(['--plan']), planMin: '1.0.93', resume: Object.freeze(['--resume=']), resumeMin: '1.0.92' }),
  // `agent` is a generic name: another program could carry it, so it counts only when its folder or its version output
  // says Cursor (generic)
  Object.freeze({ id: 'cursor', name: 'Cursor CLI', commands: ['cursor-agent', 'agent'], generic: Object.freeze({ agent: /cursor/i }), version: ['--version'], ready: ['status'], readyOut: (out) => /logged in/i.test(out) && !/not logged in/i.test(out), prompt: 'arg', plan: Object.freeze(['--plan']), planMin: '2026.10.01', resume: Object.freeze(['--resume']), resumeMin: '2026.10.01' }),
  Object.freeze({ id: 'qwen', name: 'Qwen Code', commands: ['qwen'], version: ['--version'], ready: null, prompt: 'arg', plan: Object.freeze(['--approval-mode', 'plan']), planMin: '0.25.0', resume: Object.freeze(['--resume']), resumeMin: '0.25.0' }),
  Object.freeze({ id: 'opencode', name: 'OpenCode', commands: ['opencode'], version: ['--version'], ready: null, prompt: '--prompt', resume: Object.freeze(['--session']), resumeMin: '1.18.35' }),
]);
export const TOOL_IDS = Object.freeze(TOOLS.map((t) => t.id));

// The versions SiberSentez was checked with, per tool (independent review of 0.18.0 §11): from the oldest the app's
// start options were checked on (planMin, resumeMin; for Claude Code the oldest log the result card's reading was
// checked against, 2.1.283) to the newest that passed tools/check-tool-flags.mjs, and when. The release checklist
// (docs/release.md) moves "to" and "at" when the check passes on a newer version; the tools panel says where the
// installed version stands (toolTested). Checked 2026-10-10 on the owner's computer: every tool "ok".
export const TOOL_CHECKED = Object.freeze({
  claude: Object.freeze({ from: '2.1.283', to: '2.1.296', at: '2026-10-10' }),
  codex: Object.freeze({ from: '0.160.0', to: '0.160.1', at: '2026-10-10' }),
  gemini: Object.freeze({ from: '0.61.0', to: '0.63.0', at: '2026-10-10' }),
  copilot: Object.freeze({ from: '1.0.92', to: '1.0.93', at: '2026-10-10' }),
  cursor: Object.freeze({ from: '2026.10.01', to: '2026.10.01', at: '2026-10-10' }),
  qwen: Object.freeze({ from: '0.25.0', to: '0.25.0', at: '2026-10-10' }),
  opencode: Object.freeze({ from: '1.18.35', to: '1.18.35', at: '2026-10-10' }),
});

// Where a version stands against what was checked (pure): 'in' (within the range), 'newer' (past it: not checked yet,
// it may well work), 'older' (before it: a start option may be missing) or 'unknown' (no version read)
export function toolTested(id, version) {
  const c = TOOL_CHECKED[id];
  if (!c) return null;
  const fit = !version ? 'unknown' : !versionAtLeast(version, c.from) ? 'older' : versionAtLeast(c.to, version) ? 'in' : 'newer';
  return { from: c.from, to: c.to, at: c.at, fit };
}

// What SiberSentez does with each tool (plan D4), in one place, each 'yes' | 'no' | 'unknown': plan (a job starts in
// the tool's plan mode), resume (a stopped session goes on where it stopped), live (its session shows working or
// waiting as it happens: only Claude Code writes the session files live.mjs reads), usage (its tokens are counted:
// Cursor's logs carry none, toolLogs.mjs), signIn (whether it is signed in can be checked: the tool has a status
// command; 'file': its settings files say, often not for sure: fileReady). A version below planMin or resumeMin starts as usual; the panel says
// the minimum. observe: what a job's result card observes in its log (server/jobCommands.mjs, jobReviewers.mjs: the
// commands and how they ended, a separate reviewer agent): Claude Code's only.
const LIVE_TOOLS = new Set(['claude']);
// The tools whose logs a job's result card reads for commands and reviewer agents (server/jobCommands.mjs COMMAND_TOOLS,
// server/jobReviewers.mjs REVIEWER_TOOLS take it from here, so the capability line and the card never disagree)
// (one shared Set: nothing adds to it at run time)
export const OBSERVED_TOOLS = new Set(['claude']);
const NO_TOKENS = new Set(['cursor']);
export function capabilities(t) {
  if (!t) return null;
  return {
    plan: t.plan ? 'yes' : 'no',
    planMin: t.plan && t.planMin ? t.planMin : null,
    resume: t.resume ? 'yes' : 'no',
    resumeMin: t.resume && t.resumeMin ? t.resumeMin : null,
    live: LIVE_TOOLS.has(t.id) ? 'yes' : 'no',
    usage: NO_TOKENS.has(t.id) ? 'no' : 'yes',
    signIn: t.ready ? 'yes' : FILE_READY.has(t.id) ? 'file' : 'unknown',
    observe: OBSERVED_TOOLS.has(t.id) ? 'yes' : 'no',
  };
}
// One tool of TOOLS, its optional fields said (the table is a list of different literals)
/** @typedef {{ id: string, name: string, commands: string[], version: string[], ready: string[] | null, readyOut?: (out: string) => boolean, prompt: string, plan?: readonly string[], planMin?: string, resume?: readonly string[], resumeMin?: string, appPackage?: RegExp, generic?: Readonly<Record<string, RegExp>> }} ToolDef */
/** @type {(id: string) => ToolDef | null} */
export const toolById = (id) => TOOLS.find((t) => t.id === id) || null;

// Node.js: the npm installs need it (shown as a prerequisite in the tools panel)
const NODE = Object.freeze({ id: 'node', commands: ['node'], version: ['--version'] });

// Runnable file types come from the platform (platform.mjs runnable): on Windows cmd's PATHEXT order, .exe .bat .cmd
// (.ps1 may be blocked by the execution policy, an extensionless file is npm's shell script for Git Bash); elsewhere a
// plain executable file.
const INSTALL_KINDS = Object.freeze(['native', 'npm', 'winget', 'scoop', 'store', 'brew', 'other']);
const READY_STATES = Object.freeze(['yes', 'no', 'unknown']);
export const PATH_DIRS = Object.freeze(['localBin', 'npm', 'winget', 'scoop', 'brew', 'system', 'nvm', 'own']);
const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;
const MAX_INSTALLS = 3; // installs of one tool that get a version check
const MAX_OUTPUT = 4096;
// A file path that may go on cmd.exe's command line inside quotes: cmd expands % even inside quotes, a quote would
// end the quoting, control characters never belong in a path
const CMD_UNSAFE_RE = /["%\u0000-\u001f\u007f]/;

const TTL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 10 * 1000;
const VERSION_TIMEOUT_MS = 8000;
export const READY_TIMEOUT_MS = 10000;

// An environment variable by name, any letter case (a copied process.env is case-sensitive)
export function envValue(env, name) {
  if (!env) return '';
  if (typeof env[name] === 'string') return env[name];
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k && typeof env[k] === 'string' ? env[k] : '';
}

// Folders to look in (pure): PATH in order, then the folders the official installers put their commands in (native
// Claude Code, npm, winget, scoop) when PATH does not list them yet (a tool installed after SiberSentez started: this
// process still has the old PATH; platform.mjs installerDirs). Each folder once, compared without trailing separator
// and, where the file system has none (Windows, macOS), without letter case.
export function searchDirs(env, plat = PLATFORM, listDir = defaultReadDirNames) {
  const p = plat.path;
  const out = [];
  const seen = new Set();
  const add = (raw, extra, key) => {
    const d = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
    if (!d) return;
    // No relative or network folder
    if (plat.windows ? !p.isAbsolute(d) || /^[\\/]{2}/.test(d) : !isLocalAbsolute(d, plat)) return;
    // Inside WSL, Windows' own PATH folders hold Windows programs, never this computer's tools
    if (isWindowsDriveFromWsl(d, env, plat)) return;
    let n = p.normalize(d);
    if (plat.windows ? n.length > 3 : n.length > 1) n = n.replace(plat.windows ? /\\+$/ : /\/+$/, '');
    const k = plat.caseless ? n.toLowerCase() : n;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(key ? { dir: n, extra, key } : { dir: n, extra });
  };
  for (const d of envValue(env, 'PATH').split(plat.listSep)) add(d, false);
  for (const x of installerDirs(env, plat, listDir)) add(x.dir, true, x.key);
  return out;
}

// Installs of a tool (pure apart from the injected isFile): one per folder, the first command name and file type that
// exists there, in folder order. [{ dir, file, ext, extra, key? }] (key: which installer folder, for an extra one)
export function findInstalls(commands, dirs, isFile, plat = PLATFORM) {
  const out = [];
  for (const { dir, extra, key } of dirs) {
    let hit = null;
    for (const name of commands) {
      for (const ext of plat.runnable) {
        const file = plat.path.join(dir, name + ext);
        if (isFile(file)) {
          hit = key ? { dir, file, ext, extra, key } : { dir, file, ext, extra };
          break;
        }
      }
      if (hit) break;
    }
    if (hit) out.push(hit);
  }
  return out;
}

// How a file was installed, from its path alone (pure; hasNodeModules(dir) tells an npm shim folder). Linux and macOS:
// npm's folders (a global npm command is a link into node_modules), Homebrew's, ~/.local/bin (the native installers)
/** @param {string} file @param {(dir: string) => boolean} [hasNodeModules] @param {any} [plat] */
export function installKind(file, hasNodeModules = (_dir) => false, plat = PLATFORM) {
  if (!plat.windows) {
    const f = String(file || '');
    if (/\/node_modules\/|\/\.npm-global\/|\/\.nvm\//.test(f)) return 'npm';
    if (/^\/opt\/homebrew\/|^\/usr\/local\/Cellar\/|\/\.linuxbrew\//.test(f) || (plat.mac && f.startsWith('/usr/local/bin/'))) return 'brew';
    if (/\/\.local\/bin\/[^/]+$/.test(f)) return 'native';
    return 'other';
  }
  const f = String(file || '').toLowerCase();
  if (f.includes('\\microsoft\\winget\\')) return 'winget';
  if (f.includes('\\scoop\\')) return 'scoop';
  if (f.includes('\\microsoft\\windowsapps\\')) return 'store';
  if (f.includes('\\node_modules\\') || f.includes('\\npm\\')) return 'npm';
  if (/\.(cmd|bat)$/.test(f)) return hasNodeModules(path.win32.dirname(String(file))) ? 'npm' : 'other';
  if (f.endsWith('.exe')) return 'native';
  return 'other';
}

// Version from a tool's output (pure): the first dotted number, at most 40 characters of a safe alphabet
export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text || ''));
  return m ? m[0].slice(0, 40) : null;
}

// argv that runs a found file with fixed arguments (pure). An .exe (or, on Linux and macOS, a plain executable: ext '')
// is run directly; a .cmd or .bat through cmd.exe
// (/d: no AutoRun commands, /v:off: no delayed expansion, /s /c "<quoted file> <args>") with the arguments verbatim.
// Returns null when the file cannot go on cmd's command line safely.
export function runArgv(file, ext, args, cmdExe) {
  if (ext === '.exe' || ext === '') return { cmd: file, args: [...args], verbatim: false };
  if (CMD_UNSAFE_RE.test(file) || args.some((a) => !/^[A-Za-z0-9-]+$/.test(a))) return null;
  return { cmd: cmdExe, args: ['/d', '/v:off', '/s', '/c', `""${file}"${args.length ? ' ' + args.join(' ') : ''}"`], verbatim: true };
}

// taskkill.exe by absolute path (%SystemRoot%\System32), never looked up on PATH or in a working folder
export function taskkillPath(env = process.env) {
  const root = envValue(env, 'SystemRoot');
  return path.win32.join(/^[A-Za-z]:\\[^%"]*$/.test(root) ? root : 'C:\\Windows', 'System32', 'taskkill.exe');
}

// Ends a process and every process it started. child.kill() ends only the process itself: cmd.exe running an npm
// shim leaves its node.exe running, git leaves git-remote-https. On Windows: taskkill /T /F /PID <pid> (absolute path,
// hidden window, no shell); anywhere else, or when that cannot start, child.kill().
export function killTree(spawn, child, { env = process.env, platform = process.platform } = {}) {
  const pid = child?.pid;
  const plain = () => {
    try {
      child?.kill();
    } catch {
      // already gone
    }
  };
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return plain();
  try {
    const k = spawn(taskkillPath(env), ['/T', '/F', '/PID', String(pid)], { windowsHide: true, shell: false, stdio: 'ignore' });
    k?.on?.('error', plain);
  } catch {
    plain();
  }
}

// Runs a program hidden with no input and a time limit. capture: keep up to 4 KB of standard output (never the
// error output). killTree(child): how a program past its time limit is ended (with the processes it started).
// Resolves { code, out, timedOut, error }; never rejects.
export function runQuiet(spawn, argv, { cwd, env, timeoutMs, capture, killTree: kill = (c) => killTree(spawn, c, { env }) }) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let out = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, out, timedOut: false, error: null, ...r });
    };
    const timer = setTimeout(() => {
      try {
        kill(child);
      } catch {
        // already gone
      }
      finish({ timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(argv.cmd, argv.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: argv.verbatim,
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch (e) {
      return finish({ error: typeof e?.code === 'string' ? e.code : 'spawn' });
    }
    if (!child || typeof child.on !== 'function') return finish({ error: 'spawn' });
    if (capture && child.stdout) {
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', (c) => {
        if (out.length < MAX_OUTPUT) out += String(c).slice(0, MAX_OUTPUT - out.length);
      });
    }
    child.on('error', (e) => finish({ error: typeof e?.code === 'string' ? e.code : 'error' }));
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : null }));
  });
}

export function defaultIsFile(p) {
  // Linux and macOS: a command is an executable file (a link to one counts: npm's global commands are links); a plain
  // file or a broken link is not (review G: the Windows fallback below took them for installed)
  if (!PLATFORM.windows) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }
  try {
    return fs.statSync(p).isFile();
  } catch {
    // An app execution alias (WindowsApps) cannot be followed by stat but can be started
    try {
      const l = fs.lstatSync(p);
      return l.isSymbolicLink() || l.isFile();
    } catch {
      return false;
    }
  }
}

// Folder names (nvm's versions), [] when it cannot be read
function defaultReadDirNames(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// A settings or sign-in file a tool wrote (not a command): any plain file
function defaultExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A small JSON settings file of a tool, or null (missing, too large, not JSON)
function defaultReadJson(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Whether a tool without a sign-in command is set up to sign in, from its own files (review F2, the setup wizard):
// 'yes' | 'no' | 'unknown'. Only the names of fields and whether a file or a variable exists are looked at; no key, token
// or account name is ever read into an answer. Gemini CLI: the sign-in type it chose (settings.json security.auth), its
// Google sign-in file, or GEMINI_API_KEY. Qwen Code: its sign-in type, and for a provider the variable its key comes
// from (envKey) or a key field. OpenCode: a provider in its credentials file, or a variable of a provider it reads.
const OPENCODE_ENV_KEYS = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY']);
export function fileReady(id, { env = process.env, readJson = defaultReadJson, isFile = defaultExists, plat = PLATFORM } = {}) {
  const home = plat.windows ? envValue(env, 'USERPROFILE') : homeOf(env, plat);
  if (!home) return 'unknown';
  const join = plat.path.join;
  const has = (name) => !!envValue(env, name);
  const typeOf = (s) => {
    const t = s?.security?.auth?.selectedType ?? s?.selectedAuthType;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  };
  if (id === 'gemini') {
    // The chosen type alone is no sign-in (review 2026-10-08): Google sign-in needs its file, a key its variable. The key
    // can also come from a .env file Gemini CLI reads (in the project or the home folder): not looked for, so unknown
    const s = readJson(join(home, '.gemini', 'settings.json'));
    const google = isFile(join(home, '.gemini', 'oauth_creds.json'));
    const type = typeOf(s);
    // Since 2026-06-18 Google serves Gemini CLI's Google sign-in only with a Gemini Code Assist licence (Google's own
    // announcement): its sign-in file alone no longer says the tool can work, so it is "not known" (a key still is)
    if (!type) return has('GEMINI_API_KEY') ? 'yes' : google ? 'unknown' : 'no';
    if (type === 'oauth-personal') return google && has('GOOGLE_CLOUD_PROJECT') ? 'yes' : google ? 'unknown' : 'no';
    if (type === 'gemini-api-key') return has('GEMINI_API_KEY') ? 'yes' : 'unknown';
    if (type === 'vertex-ai') return has('GOOGLE_API_KEY') || has('GOOGLE_CLOUD_PROJECT') ? 'yes' : 'unknown';
    return 'unknown';
  }
  if (id === 'qwen') {
    const s = readJson(join(home, '.qwen', 'settings.json'));
    const type = typeOf(s);
    if (!type) return has('OPENAI_API_KEY') || has('DASHSCOPE_API_KEY') ? 'yes' : 'no';
    if (type === 'qwen-oauth') return isFile(join(home, '.qwen', 'oauth_creds.json')) ? 'yes' : 'no';
    const providers = s?.modelProviders && typeof s.modelProviders === 'object' ? Object.values(s.modelProviders).flat() : [];
    const keyed = providers.some((p) => p && typeof p === 'object' && ((typeof p.envKey === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(p.envKey) && has(p.envKey)) || (typeof p.apiKey === 'string' && p.apiKey.length > 0)));
    return keyed || has('OPENAI_API_KEY') ? 'yes' : 'no';
  }
  if (id === 'opencode') {
    const data = envValue(env, 'XDG_DATA_HOME') || join(home, '.local', 'share');
    const a = readJson(join(data, 'opencode', 'auth.json'));
    if (a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length) return 'yes';
    return OPENCODE_ENV_KEYS.some(has) ? 'yes' : 'no';
  }
  return 'unknown';
}
const FILE_READY = new Set(['gemini', 'qwen', 'opencode']);

function defaultIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// Git for Windows (the setup check, docs/ai-start.md): a file look-up only, no process. PATH first, then the folders
// its installer uses (for all users, for one user). onPath false: installed but a terminal would not find `git`.
export function detectGit(dirs, env, isFile, plat = PLATFORM) {
  if (!plat.windows) {
    const found = findInstalls(['git'], dirs, isFile, plat)[0];
    return { installed: !!found, onPath: !!found && !found.extra };
  }
  const extra = [];
  for (const [root, sub] of /** @type {[string, string[]][]} */ ([
    [envValue(env, 'ProgramFiles'), ['Git', 'cmd']],
    [envValue(env, 'LOCALAPPDATA'), ['Programs', 'Git', 'cmd']],
  ])) {
    if (root && path.win32.isAbsolute(root)) extra.push({ dir: path.win32.join(root, ...sub), extra: true });
  }
  const seen = new Set(dirs.map((d) => d.dir.toLowerCase()));
  const found = findInstalls(['git'], [...dirs, ...extra.filter((d) => !seen.has(d.dir.toLowerCase()))], (f) => f.toLowerCase().endsWith('.exe') && isFile(f), plat)[0];
  return { installed: !!found, onPath: !!found && !found.extra };
}

// Environment variables that change how a tool bills or signs in; presence only, never the value
export function envFlags(env) {
  return { anthropicKey: envValue(env, 'ANTHROPIC_API_KEY').trim() !== '' };
}

// The detector. Everything that touches the system is injected (tests pass fakes and never start a program).
// detect({ refresh }) -> Promise<{ at, tools: [record], node }>; one detection at a time; cached for ttlMs; a refresh
// within minRefreshMs of the last detection returns that one. A record (server only, it holds paths):
//   { id, name, installed, installs: [{ file, ext, extra, via, version }], chosen, version, via, ready, app }
export function createToolDetector({
  env = process.env,
  spawn = nodeSpawn,
  isFile = defaultIsFile,
  // A settings file (Linux and macOS: not a command, so not an executable one)
  exists = defaultExists,
  isDir = defaultIsDir,
  readDir = defaultReadDir,
  readJson = defaultReadJson,
  now = Date.now,
  ttlMs = TTL_MS,
  minRefreshMs = MIN_REFRESH_MS,
  versionTimeoutMs = VERSION_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  cmdExe = path.win32.join(envValue(process.env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe'),
  plat = PLATFORM,
} = {}) {
  let last = null; // { at, tools, node }
  let startedAt = 0;
  let running = null;
  const stats = { detections: 0 };

  // The tool's own environment without variables that change how Electron's or Node's programs start, and with
  // NoDefaultCurrentDirectoryInExePath: cmd (and CreateProcess's search) never looks a bare name up in the working
  // folder (docs/ai-start.md, the launcher's first line)
  function childEnv() {
    const e = { ...env };
    for (const k of Object.keys(e)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NoDefaultCurrentDirectoryInExePath)$/i.test(k)) delete e[k];
    e.NO_UPDATE_NOTIFIER = '1';
    e.NoDefaultCurrentDirectoryInExePath = '1';
    return e;
  }

  async function run(install, args, timeoutMs, capture) {
    const argv = runArgv(install.file, install.ext, args, cmdExe);
    if (!argv) return { code: null, out: '', timedOut: false, error: 'unsafe' };
    // Working folder: the tool's own folder, never a project. cmd looks a bare name up in the working folder before
    // PATH, and an npm shim calls a bare `node` (after its own %~dp0\node.exe): from the tool's folder that first look
    // can only find what the shim already trusts. The environment switches the look off as well (childEnv).
    return runQuiet(spawn, argv, { cwd: plat.path.dirname(install.file), env: childEnv(), timeoutMs, capture, killTree: (child) => killTree(spawn, child, { env, platform: plat.id }) });
  }

  async function detectTool(tool, dirs) {
    const found = findInstalls(tool.commands, dirs, isFile, plat);
    const installs = found.map((f) => ({ ...f, via: installKind(f.file, (d) => isDir(plat.path.join(d, 'node_modules')), plat), version: null }));
    await Promise.all(
      installs.slice(0, MAX_INSTALLS).map(async (i) => {
        const r = await run(i, tool.version, versionTimeoutMs, true);
        i.version = r.code === 0 || r.out ? parseVersion(r.out) : null;
        i.said = String(r.out || '');
      }),
    );
    // A generic command name is kept only when its folder or what it printed names the tool
    const kept = installs.filter((i) => {
      const rx = tool.generic?.[plat.path.basename(i.file).replace(/\.[^.]+$/, '').toLowerCase()];
      return !rx || rx.test(i.file) || rx.test(i.said || '');
    });
    for (const i of kept) delete i.said;
    installs.length = 0;
    installs.push(...kept);
    const chosen = installs[0] || null;
    let ready = 'unknown';
    if (chosen && tool.ready) {
      // Exit code only: the output is not even read (it can hold the account's e-mail). readyOut: looked at once for its
      // words and dropped
      const r = await run(chosen, tool.ready, readyTimeoutMs, !!tool.readyOut);
      ready = r.timedOut || r.error || r.code === null ? 'unknown' : r.code === 0 && (!tool.readyOut || tool.readyOut(String(r.out || ''))) ? 'yes' : 'no';
    } else if (chosen && FILE_READY.has(tool.id)) ready = fileReady(tool.id, { env, readJson, isFile: plat.windows ? isFile : exists, plat });
    let app = false;
    if (tool.appPackage && plat.windows) {
      const local = envValue(env, 'LOCALAPPDATA');
      app = !!local && readDir(path.win32.join(local, 'Packages')).some((n) => tool.appPackage.test(n));
    }
    return { id: tool.id, name: tool.name, installed: !!chosen, installs, chosen, version: chosen?.version || null, via: chosen?.via || null, ready, app };
  }

  async function detectNode(dirs) {
    const found = findInstalls(NODE.commands, dirs, isFile, plat)[0];
    if (!found) return { installed: false, version: null };
    const r = await run(found, NODE.version, versionTimeoutMs, true);
    return { installed: true, version: parseVersion(r.out) };
  }

  async function runDetection() {
    stats.detections++;
    startedAt = now();
    const dirs = searchDirs(env, plat, readDir);
    const [tools, node] = await Promise.all([Promise.all(TOOLS.map((t) => detectTool(t, dirs))), detectNode(dirs)]);
    last = { at: now(), tools, node, git: detectGit(dirs, env, isFile, plat), env: envFlags(env) };
    return last;
  }

  function detect({ refresh = false } = {}) {
    if (running) return running;
    const fresh = last && now() - last.at < ttlMs;
    const throttled = last && now() - startedAt < minRefreshMs;
    if (last && (refresh ? throttled : fresh)) return Promise.resolve(last);
    running = runDetection().finally(() => {
      running = null;
    });
    return running;
  }

  return { detect, cached: () => last, busy: () => !!running, stats };
}

// What the page gets (pure): no path, no output of any tool, only known words
export function publicTools(result) {
  const clean = (v) => (typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : null);
  const kind = (v) => (INSTALL_KINDS.includes(v) ? v : 'other');
  const tools = (result?.tools || []).map((t) => ({
    id: t.id,
    name: t.name,
    installed: !!t.installed,
    version: clean(t.version),
    via: t.installed ? kind(t.via) : null,
    ready: READY_STATES.includes(t.ready) ? t.ready : 'unknown',
    installs: (t.installs || []).length,
    others: (t.installs || []).slice(1, MAX_INSTALLS).map((i) => ({ via: kind(i.via), version: clean(i.version) })),
    onPath: t.installed ? !t.chosen?.extra : false,
    // Which installer folder PATH is missing (a known word: the page shows the fix, never the folder itself)
    pathDir: t.installed && t.chosen?.extra && PATH_DIRS.includes(t.chosen.key) ? t.chosen.key : null,
    app: !!t.app,
    // What SiberSentez does with it (the one table above)
    caps: capabilities(toolById(t.id)),
    // Whether a job with the version installed starts in the tool's plan mode (launch.mjs jobArgs: a version below
    // planMin starts as usual): the Start sentence promises a plan first only then
    planNow: !!t.installed && jobArgs(toolById(t.id), clean(t.version)).length > 0,
    // The versions SiberSentez was checked with, and where the installed one stands (TOOL_CHECKED)
    tested: toolTested(t.id, t.installed ? clean(t.version) : null),
    // The command's name only (no folder), for the setup wizard's sign-in line ("agent login")
    cmd: t.installed && t.chosen?.file && /^[a-z][a-z0-9-]{0,30}$/i.test(path.win32.basename(t.chosen.file).replace(/\.[^.]+$/, '')) ? path.win32.basename(t.chosen.file).replace(/\.[^.]+$/, '').toLowerCase() : null,
  }));
  return {
    at: Number(result?.at) || 0,
    tools,
    node: { installed: !!result?.node?.installed, version: clean(result?.node?.version) },
    git: { installed: !!result?.git?.installed, onPath: !!result?.git?.onPath },
    env: { anthropicKey: result?.env?.anthropicKey === true },
  };
}

// One detector for the server: GET /api/tools and the start-ai action share its cache
let shared = null;
export function sharedToolDetector() {
  if (!shared) shared = createToolDetector();
  return shared;
}

// GET /api/tools (?refresh=1: check again). Read-only; answers { ok, tools, node, at }.
export async function toolsAnswer(detector, { refresh = false } = {}) {
  try {
    const r = await detector.detect({ refresh });
    // platform: which install commands and folders the page shows (plan G4)
    return { status: 200, body: { ok: true, platform: PLATFORM.id, ...publicTools(r) } };
  } catch {
    return { status: 500, body: { ok: false, error: 'detection-failed' } };
  }
}
