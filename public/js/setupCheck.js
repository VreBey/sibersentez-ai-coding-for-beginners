// The setup check of the tools panel (docs/ai-start.md, "Setup check"): what stands between this computer and a
// working AI tool, each with a plain reason and, where one exists, a command to copy. SiberSentez never runs these
// commands. Two parts, both pure (tested in node, no DOM, no network):
//   diagnose(state)  -> the problems the detection shows (GET /api/tools: tools, node, git, env)
//   matchError(text) -> what an error message the user pasted means; the text never leaves the page
import { esc } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

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
export const TOOL_COMMANDS = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', cursor: 'agent', qwen: 'qwen', opencode: 'opencode' });

// Installer folders a tool may sit in while PATH lacks it (server/tools.mjs PATH_DIRS), as a PowerShell expression
const PATH_DIR_EXPR = Object.freeze({
  localBin: "(Join-Path $env:USERPROFILE '.local\\bin')",
  npm: "(Join-Path $env:APPDATA 'npm')",
  winget: "(Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links')",
  scoop: "(Join-Path $env:USERPROFILE 'scoop\\shims')",
});
export const MIN_NODE_MAJOR = 20;
export const MAX_ERROR_TEXT = 4000;
// First words of a question or a greeting written to a plain shell as if it were the AI (lower case, both languages)
const QUESTION_WORDS = new Set(['nasil', 'ne', 'neden', 'niye', 'nerede', 'hangi', 'merhaba', 'selam', 'yardim', 'lutfen', 'bu', 'bunu', 'how', 'what', 'why', 'where', 'which', 'help', 'hello', 'hi', 'hey', 'please', 'can', 'could']);

export const FIX = Object.freeze({
  git: 'winget install --id Git.Git -e --source winget',
  node: 'winget install --id OpenJS.NodeJS.LTS -e --source winget',
  apiKeyOff: "[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')",
  policy: 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
  tls: '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
});

// The PowerShell line that adds an installer folder to the user's PATH (pure); null for an unknown folder
export function pathFix(dirKey) {
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
  const out = [];
  const tools = Array.isArray(st.tools) ? st.tools : [];
  const installed = tools.filter((x) => x.installed);
  const npmTools = installed.filter((x) => x.via === 'npm');
  if (!installed.length) out.push({ id: 'noTool', level: 'info', vars: {}, fixes: [] });
  // Node.js: an npm install does not start without it
  if (npmTools.length) {
    const names = npmTools.map((x) => x.name).join(', ');
    if (!st.node?.installed) out.push({ id: 'nodeMissing', level: 'warn', vars: { tools: names }, fixes: [{ how: 'winget', cmd: FIX.node }] });
    else if (major(st.node.version) !== null && major(st.node.version) < MIN_NODE_MAJOR) out.push({ id: 'nodeOld', level: 'warn', vars: { tools: names, version: st.node.version, min: MIN_NODE_MAJOR }, fixes: [{ how: 'winget', cmd: FIX.node }] });
  }
  // Git for Windows
  if (st.git && !st.git.installed) out.push({ id: 'noGit', level: installed.some((x) => x.id === 'claude') ? 'warn' : 'info', vars: {}, fixes: [{ how: 'winget', cmd: FIX.git }] });
  else if (st.git && !st.git.onPath) out.push({ id: 'gitOffPath', level: 'info', vars: {}, fixes: [] });
  // "is not recognized": installed in an installer folder PATH does not list
  for (const x of installed) {
    if (x.onPath !== false) continue;
    const cmd = pathFix(x.pathDir);
    out.push({ id: 'notOnPath', level: 'warn', tool: x.id, vars: { tool: x.name, command: TOOL_COMMANDS[x.id] || x.id }, fixes: cmd ? [{ how: 'powershell', cmd }] : [] });
  }
  // Several installs where one is an npm copy: the old copy is often the one a terminal starts
  for (const x of installed) {
    if (x.installs < 2 || !NPM_PACKAGES[x.id]) continue;
    const vias = [x.via, ...(x.others || []).map((o) => o.via)];
    if (!vias.includes('npm') || vias.every((v) => v === 'npm')) continue;
    out.push({ id: 'multiNpm', level: 'warn', tool: x.id, vars: { tool: x.name, count: x.installs }, fixes: [{ how: 'npm', cmd: `npm uninstall -g ${NPM_PACKAGES[x.id]}` }] });
  }
  // An API key in the environment: Claude Code bills the key, not the subscription
  if (st.env?.anthropicKey) out.push({ id: 'apiKey', level: installed.some((x) => x.id === 'claude') ? 'warn' : 'info', vars: {}, fixes: [{ how: 'powershell', cmd: FIX.apiKeyOff }] });
  // Not signed in: the tool asks when it opens
  for (const x of installed) if (x.ready === 'no') out.push({ id: 'notSigned', level: 'info', tool: x.id, vars: { tool: x.name, command: TOOL_COMMANDS[x.id] || x.id }, fixes: [] });
  return out;
}

// Known error messages (English and Turkish Windows), most specific first. A pattern is tried on the text in lower case.
const ERRORS = [
  { id: 'errPolicy', re: /running scripts is disabled|execution polic|unauthorizedaccess|betik çalıştırma|komut dosyalarının çalıştırılması/, fixes: [{ how: 'powershell', cmd: FIX.policy }] },
  { id: 'errGitBash', re: /git-?bash|git for windows|claude_code_git_bash_path/, fixes: [{ how: 'winget', cmd: FIX.git }] },
  { id: 'errNode', re: /'node'|"node"|\bnode(\.exe)?: (not found|command not found)|ebadengine|unsupported engine|requires node|node\.js \d+ or (later|higher)|cannot find module/, fixes: [{ how: 'winget', cmd: FIX.node }] },
  { id: 'errNotRecognized', re: /is not recognized as|not recognized as an internal or external command|tanınmıyor|command not found|komut bulunamadı|the term '[^']+' is not/, fixes: [] },
  { id: 'errTls', re: /could not establish trust|ssl\/tls|unable_to_get_issuer|self[_ -]signed|certificate|sertifika|tls/, fixes: [{ how: 'powershell', cmd: FIX.tls }] },
  { id: 'errAuth', re: /invalid api key|authentication_error|\b401\b|not logged in|please run \/login|credit balance is too low|oauth token|unauthorized/, fixes: [] },
  { id: 'errLimit', re: /rate.?limit|\b429\b|usage limit|limit reached|overloaded|\b529\b|resource_exhausted|quota/, fixes: [] },
  { id: 'errPerm', re: /\beperm\b|\beacces\b|operation not permitted|access is denied|erişim engellendi|erişim reddedildi/, fixes: [] },
  { id: 'errNetwork', re: /enotfound|econnrefused|etimedout|econnreset|getaddrinfo|network error|unable to connect/, fixes: [] },
];

// What a pasted error means (pure): [{ id, vars, fixes }], at most three, or [{ id: 'errUnknown' }] for text that
// matches nothing; [] for empty text. Only the first MAX_ERROR_TEXT characters are read.
export function matchError(text) {
  const s = String(text || '').slice(0, MAX_ERROR_TEXT).toLowerCase();
  if (!s.trim()) return [];
  const hits = ERRORS.filter((e) => e.re.test(s)).slice(0, 3);
  if (!hits.length) return [{ id: 'errUnknown', vars: {}, fixes: [] }];
  // The command a "not recognized" message names, when it is one of the tools' (shown in the text, never anything else)
  const named = /(?:the term |^|\s)'([a-z0-9-]{1,20})'/.exec(s)?.[1];
  const command = named && (Object.values(TOOL_COMMANDS).includes(named) || named === 'node' || named === 'git' || named === 'npm') ? named : '';
  // A sentence typed into a plain shell ("nasıl çalıştırılır"): the shell took its first word for a command. Not a
  // missing tool, so the PATH advice would mislead.
  const typed = !command && /(?:the term |^|\s)'([^'\n]{1,40})'/.exec(s)?.[1];
  const sentence = typed && (/[^\x20-\x7e]/.test(typed) || /\?$/.test(typed) || QUESTION_WORDS.has(typed));
  return hits.map((e) => (e.id === 'errNotRecognized' && sentence ? { id: 'errNotACommand', vars: {}, fixes: [] } : { id: e.id, vars: { command: command || t('scThisCommand'), min: MIN_NODE_MAJOR }, fixes: e.fixes }));
}

// ---------------- HTML (pure) ----------------

function fixesHtml(fixes) {
  if (!fixes.length) return '';
  return `<ul class="ai-cmds sc-fixes">${fixes
    .map((c) => `<li class="ai-cmd"><span class="ai-how">${esc(t(`aiHow_${c.how}`))}</span><code translate="no">${esc(c.cmd)}</code><button type="button" class="act-btn ai-copy" data-ai-copy>${icon('copy')}<span>${esc(t('aiCopy'))}</span></button></li>`)
    .join('')}</ul>`;
}

function itemHtml(p, prefix = 'sc') {
  return `<li class="sc-item ${p.level === 'warn' ? 'warn' : 'info'}" data-sc="${esc(p.id)}"><b>${esc(t(`${prefix}_${p.id}`, p.vars))}</b><p class="small">${esc(t(`${prefix}Why_${p.id}`, p.vars))}</p>${fixesHtml(p.fixes)}</li>`;
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
  return `<section class="sc" aria-labelledby="scH"><h3 id="scH">${esc(t('scTitle'))}</h3>${head}${list.length ? `<ul class="sc-list">${list.map((p) => itemHtml(p)).join('')}</ul>` : ''}<p class="small muted">${esc(t('scNeverRuns'))}</p></section>`;
}

// "Got an error?": a text box whose content stays on the page
export function errorBoxHtml(text = '', results = matchError(text)) {
  const out = results.length ? `<ul class="sc-list" data-sc-results>${results.map((r) => itemHtml({ ...r, level: r.id === 'errUnknown' ? 'info' : 'warn' }, 'sc')).join('')}</ul>` : '<ul class="sc-list" data-sc-results></ul>';
  return `<details class="sc-err"${text ? ' open' : ''}><summary>${esc(t('scErrTitle'))}</summary><p class="small muted">${esc(t('scErrIntro'))}</p><textarea class="sc-text" data-sc-text rows="4" maxlength="${MAX_ERROR_TEXT}" spellcheck="false" aria-label="${esc(t('scErrTitle'))}" placeholder="${esc(t('scErrPlaceholder'))}">${esc(text)}</textarea>${out}</details>`;
}
