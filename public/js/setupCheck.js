// @ts-check
// The setup check of the tools panel (docs/ai-start.md, "Setup check"): what stands between this computer and a
// working AI tool, each with a plain reason and, where one exists, a command to copy. SiberSentez never runs these
// commands. Two parts, both pure (tested in node, no DOM, no network):
//   diagnose(state)  -> the problems the detection shows (GET /api/tools: tools, node, git, env)
//   matchError(text) -> what an error message the user pasted means; the text never leaves the page
import { esc } from './format.js';
import { icon } from './icons.js';
import { t, tOs, pagePlatformNow } from './i18n.js';

// npm package of each tool that can be installed with npm (to remove an old npm copy)
export const NPM_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  copilot: '@github/copilot',
  qwen: '@qwen-code/qwen-code',
  opencode: 'opencode-ai',
});
// The command each tool is started with (for "type this in a new terminal")
const TOOL_COMMANDS = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', cursor: 'agent', qwen: 'qwen', opencode: 'opencode' });

// Installer folders a tool may sit in while PATH lacks it (server/tools.mjs PATH_DIRS), as a PowerShell expression
const PATH_DIR_EXPR = Object.freeze({
  localBin: "(Join-Path $env:USERPROFILE '.local\\bin')",
  npm: "(Join-Path $env:APPDATA 'npm')",
  winget: "(Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links')",
  scoop: "(Join-Path $env:USERPROFILE 'scoop\\shims')",
});
const MIN_NODE_MAJOR = 20;
const MAX_ERROR_TEXT = 4000;
// First words of a question or a greeting written to a plain shell as if it were the AI (lower case, both languages)
const QUESTION_WORDS = new Set(['nasil', 'ne', 'neden', 'niye', 'nerede', 'hangi', 'merhaba', 'selam', 'yardim', 'lutfen', 'bu', 'bunu', 'how', 'what', 'why', 'where', 'which', 'help', 'hello', 'hi', 'hey', 'please', 'can', 'could']);

export const FIX = Object.freeze({
  git: 'winget install --id Git.Git -e --source winget',
  node: 'winget install --id OpenJS.NodeJS.LTS -e --source winget',
  apiKeyOff: "[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')",
  policy: 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
  tls: '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
});

// Linux and macOS (plan G4): git and Node.js as the setup wizard installs them (views/setupWizard.js PREREQS_ON); an
// API key leaves this shell with unset (it may also sit in the shell's profile, which the person edits)
export const FIX_ON = Object.freeze({
  linux: Object.freeze({ git: { how: 'apt', cmd: 'sudo apt-get install git' }, node: { how: 'shell', cmd: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install 24' }, apiKeyOff: { how: 'shell', cmd: 'unset ANTHROPIC_API_KEY' } }),
  darwin: Object.freeze({ git: { how: 'brew', cmd: 'brew install git' }, node: { how: 'brew', cmd: 'brew install node' }, apiKeyOff: { how: 'shell', cmd: 'unset ANTHROPIC_API_KEY' } }),
});
const WIN_FIX = Object.freeze({ git: { how: 'winget', cmd: FIX.git }, node: { how: 'winget', cmd: FIX.node }, apiKeyOff: { how: 'powershell', cmd: FIX.apiKeyOff } });
const platformOf = (st) => (st?.platform === 'linux' || st?.platform === 'darwin' ? st.platform : 'win32');
const fixOn = (platform, id) => (FIX_ON[platform] || WIN_FIX)[id];
// The installer folders on Linux and macOS a shell's PATH may lack (server/platform.mjs installerDirs)
const POSIX_PATH_DIRS = Object.freeze({ localBin: '$HOME/.local/bin', npm: '$HOME/.npm-global/bin' });

// The line that adds an installer folder to the user's PATH (pure); null for an unknown folder. Windows: PowerShell,
// the user's PATH; Linux and macOS: one line appended to the shell's profile (bash: ~/.bashrc, macOS' zsh: ~/.zshrc)
export function pathFix(dirKey, platform = 'win32') {
  if (platform !== 'win32') {
    const d = POSIX_PATH_DIRS[dirKey];
    return d ? `echo 'export PATH="${d}:$PATH"' >> ${platform === 'darwin' ? '~/.zshrc' : '~/.bashrc'}` : null;
  }
  const dir = PATH_DIR_EXPR[dirKey];
  if (!dir) return null;
  return `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + ${dir}, 'User')`;
}

function major(version) {
  const m = /^v?(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) : null;
}

// Problems from the detection (pure). state: the tools state (status 'ready'); returns
// [{ id, level: 'warn'|'info', tool?, vars, fixes: [{ how, cmd }] }] in the order they should be fixed.
export function diagnose(st) {
  if (!st || st.status !== 'ready') return [];
  const platform = platformOf(st);
  const out = [];
  const tools = Array.isArray(st.tools) ? st.tools : [];
  const installed = tools.filter((x) => x.installed);
  const npmTools = installed.filter((x) => x.via === 'npm');
  if (!installed.length) out.push({ id: 'noTool', level: 'info', vars: {}, fixes: [] });
  // Node.js: an npm install does not start without it
  if (npmTools.length) {
    const names = npmTools.map((x) => x.name).join(', ');
    if (!st.node?.installed) out.push({ id: 'nodeMissing', level: 'warn', vars: { tools: names }, fixes: [fixOn(platform, 'node')] });
    else if (major(st.node.version) !== null && major(st.node.version) < MIN_NODE_MAJOR) out.push({ id: 'nodeOld', level: 'warn', vars: { tools: names, version: st.node.version, min: MIN_NODE_MAJOR }, fixes: [fixOn(platform, 'node')] });
  }
  // Git for Windows (Claude Code needs it there); elsewhere git is useful, never required
  if (st.git && !st.git.installed) out.push({ id: platform === 'win32' ? 'noGit' : 'noGitUnix', level: platform === 'win32' && installed.some((x) => x.id === 'claude') ? 'warn' : 'info', vars: {}, fixes: [fixOn(platform, 'git')] });
  else if (st.git && !st.git.onPath) out.push({ id: 'gitOffPath', level: 'info', vars: {}, fixes: [] });
  // "is not recognized": installed in an installer folder PATH does not list
  for (const x of installed) {
    if (x.onPath !== false) continue;
    // nvm, bun, volta, opencode put their PATH line in the shell's profile themselves; SiberSentez's own terminal reads it
    // (a login shell), an app started from the desktop does not: no line to add, nothing to warn (review G)
    if (platform !== 'win32' && (x.pathDir === 'nvm' || x.pathDir === 'own')) continue;
    const cmd = pathFix(x.pathDir, platform);
    out.push({ id: 'notOnPath', level: 'warn', tool: x.id, vars: { tool: x.name, command: TOOL_COMMANDS[x.id] || x.id }, fixes: cmd ? [{ how: platform === 'win32' ? 'powershell' : 'shell', cmd }] : [] });
  }
  // Several installs where one is an npm copy: the old copy is often the one a terminal starts
  for (const x of installed) {
    if (x.installs < 2 || !NPM_PACKAGES[x.id]) continue;
    const vias = [x.via, ...(x.others || []).map((o) => o.via)];
    if (!vias.includes('npm') || vias.every((v) => v === 'npm')) continue;
    out.push({ id: 'multiNpm', level: 'warn', tool: x.id, vars: { tool: x.name, count: x.installs }, fixes: [{ how: 'npm', cmd: `npm uninstall -g ${NPM_PACKAGES[x.id]}` }] });
  }
  // An API key in the environment: Claude Code bills the key, not the subscription
  if (st.env?.anthropicKey) out.push({ id: 'apiKey', level: installed.some((x) => x.id === 'claude') ? 'warn' : 'info', vars: {}, fixes: [fixOn(platform, 'apiKeyOff')] });
  // Not signed in: the tool asks when it opens
  for (const x of installed) if (x.ready === 'no') out.push({ id: 'notSigned', level: 'info', tool: x.id, vars: { tool: x.name, command: TOOL_COMMANDS[x.id] || x.id }, fixes: [] });
  return out;
}

// Known error messages (English and Turkish), most specific first. A pattern is tried on the text in lower case.
// win: Windows' own (PowerShell's script policy, Git Bash): never matched on Linux and macOS. fixes(platform): the
// platform's commands (review G: a Linux terminal was told to run winget and PowerShell)
const ERRORS = [
  { id: 'errPolicy', win: true, re: /running scripts is disabled|execution polic|unauthorizedaccess|betik çalıştırma|komut dosyalarının çalıştırılması/, fixes: () => [{ how: 'powershell', cmd: FIX.policy }] },
  { id: 'errGitBash', win: true, re: /git-?bash|git for windows|claude_code_git_bash_path/, fixes: () => [{ how: 'winget', cmd: FIX.git }] },
  { id: 'errNode', re: /'node'|"node"|\bnode(\.exe)?: (not found|command not found)|ebadengine|unsupported engine|requires node|node\.js \d+ or (later|higher)|cannot find module/, fixes: (pl) => [fixOn(pl, 'node')] },
  { id: 'errNotRecognized', re: /is not recognized as|not recognized as an internal or external command|tanınmıyor|command not found|komut bulunamadı|the term '[^']+' is not/, fixes: () => [] },
  // The TLS line is Windows PowerShell's; elsewhere the advice alone (the certificate of a company network)
  { id: 'errTls', re: /could not establish trust|ssl\/tls|unable_to_get_issuer|self[_ -]signed|certificate|sertifika|tls/, fixes: (pl) => (pl === 'win32' ? [{ how: 'powershell', cmd: FIX.tls }] : []) },
  { id: 'errAuth', fixes: () => [], re: /invalid api key|authentication_error|\b401\b|not logged in|please run \/login|credit balance is too low|oauth token|unauthorized/ },
  { id: 'errLimit', fixes: () => [], re: /rate.?limit|\b429\b|usage limit|limit reached|overloaded|\b529\b|resource_exhausted|quota/ },
  { id: 'errPerm', fixes: () => [], re: /\beperm\b|\beacces\b|operation not permitted|access is denied|erişim engellendi|erişim reddedildi/ },
  { id: 'errNetwork', fixes: () => [], re: /enotfound|econnrefused|etimedout|econnreset|getaddrinfo|network error|unable to connect/ },
];

// What a pasted error means (pure): [{ id, vars, fixes }], at most three, or [{ id: 'errUnknown' }] for text that
// matches nothing; [] for empty text. Only the first MAX_ERROR_TEXT characters are read.
export function matchError(text, platform = pagePlatformNow()) {
  const s = String(text || '').slice(0, MAX_ERROR_TEXT).toLowerCase();
  if (!s.trim()) return [];
  const pl = platform === 'linux' || platform === 'darwin' ? platform : 'win32';
  const hits = ERRORS.filter((e) => (!e.win || pl === 'win32') && e.re.test(s)).slice(0, 3);
  if (!hits.length) return [{ id: 'errUnknown', vars: {}, fixes: [] }];
  // The command a "not recognized" message names, when it is one of the tools' (shown in the text, never anything else)
  const named = /(?:the term |^|\s)'([a-z0-9-]{1,20})'/.exec(s)?.[1];
  const command = named && (/** @type {string[]} */ (Object.values(TOOL_COMMANDS)).includes(named) || named === 'node' || named === 'git' || named === 'npm') ? named : '';
  // A sentence typed into a plain shell ("nasıl çalıştırılır"): the shell took its first word for a command. Not a
  // missing tool, so the PATH advice would mislead.
  const typed = !command && /(?:the term |^|\s)'([^'\n]{1,40})'/.exec(s)?.[1];
  const sentence = typed && (/[^\x20-\x7e]/.test(typed) || /\?$/.test(typed) || QUESTION_WORDS.has(typed));
  return hits.map((e) => (e.id === 'errNotRecognized' && sentence ? { id: 'errNotACommand', vars: {}, fixes: [] } : { id: e.id, vars: { command: command || t('scThisCommand'), min: MIN_NODE_MAJOR }, fixes: e.fixes(pl) }));
}

// ---------------- HTML (pure) ----------------

function fixesHtml(fixes) {
  if (!fixes.length) return '';
  return `<ul class="ai-cmds sc-fixes">${fixes
    .map((c) => `<li class="ai-cmd"><span class="ai-how">${esc(t(`aiHow_${c.how}`))}</span><code translate="no">${esc(c.cmd)}</code><button type="button" class="act-btn ai-copy" data-ai-copy>${icon('copy')}<span>${esc(t('aiCopy'))}</span></button></li>`)
    .join('')}</ul>`;
}

function itemHtml(p, prefix = 'sc') {
  return `<li class="sc-item ${p.level === 'warn' ? 'warn' : 'info'}" data-sc="${esc(p.id)}"><b>${esc(tOs(`${prefix}_${p.id}`, p.vars))}</b><p class="small">${esc(tOs(`${prefix}Why_${p.id}`, p.vars))}</p>${fixesHtml(p.fixes)}</li>`;
}

// Known errors as a list (matchError's answer), for the note beside the embedded terminal (promptHelp.js)
export function errorItemsHtml(results) {
  return results.length ? `<ul class="sc-list">${results.map((r) => itemHtml({ ...r, level: 'warn' })).join('')}</ul>` : '';
}

// The "Setup check" block at the top of the tools panel
export function setupCheckHtml(st) {
  if (!st || st.status !== 'ready') return '';
  const list = diagnose(st);
  const warn = list.filter((p) => p.level === 'warn').length;
  const head = list.length
    ? `<p class="small ${warn ? 'ai-warn' : 'muted'}">${esc(warn ? t('scFound', { count: warn }) : t('scInfoOnly'))}</p>`
    : `<p class="small sc-ok">${icon('check')} ${esc(t('scAllGood'))}</p>`;
  return `<section class="sc" aria-labelledby="scH"><h3 id="scH">${esc(t('scTitle'))}</h3>${head}${list.length ? `<ul class="sc-list">${list.map((p) => itemHtml(p)).join('')}</ul>` : ''}<p class="small muted">${esc(tOs('scNeverRuns', {}, platformOf(st)))}</p></section>`;
}

// "Got an error?": a text box whose content stays on the page
export function errorBoxHtml(text = '', results = matchError(text)) {
  const out = results.length ? `<ul class="sc-list" data-sc-results>${results.map((r) => itemHtml({ ...r, level: r.id === 'errUnknown' ? 'info' : 'warn' }, 'sc')).join('')}</ul>` : '<ul class="sc-list" data-sc-results></ul>';
  return `<details class="sc-err"${text ? ' open' : ''}><summary>${esc(t('scErrTitle'))}</summary><p class="small muted">${esc(t('scErrIntro'))}</p><textarea class="sc-text" data-sc-text rows="4" maxlength="${MAX_ERROR_TEXT}" spellcheck="false" aria-label="${esc(t('scErrTitle'))}" placeholder="${esc(t('scErrPlaceholder'))}">${esc(text)}</textarea>${out}</details>`;
}
