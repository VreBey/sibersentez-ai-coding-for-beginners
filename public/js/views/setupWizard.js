// @ts-check
// The setup wizard (roadmap F2, 2026-10-08): getting an AI tool ready, one step at a time, for someone who never used
// a terminal: pick a tool -> what it needs (Git, Node.js) -> install it -> sign in -> ready. It lives in the AI tools
// panel (views/tools.js) and works on the panel's state (GET /api/tools). Commands are the tools' official ones; the
// wizard never runs them: "Type in terminal" writes one into SiberSentez's setup terminal without Enter, the person
// reads it and runs it (docs/embedded-terminal.md, "Setup terminal"), and "Check again" asks the tools again.
import { t, tOs } from '../i18n.js';
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { installsFor, platformOfState } from './tools.js';

// The order the wizard offers the tools in: a beginner's usual first choices first, then the one that can start free
// (October 2026, the tools' own pages: GitHub Copilot's free plan includes its CLI). Gemini CLI moved down: since
// 2026-06-18 it serves paid API keys only (Google moved its free and Google-account use to Antigravity CLI)
export const WIZARD_TOOLS = Object.freeze(['claude', 'copilot', 'codex', 'cursor', 'gemini', 'qwen', 'opencode']);
// The tool whose free plan includes its CLI (checked 2026-10-09; free allowances change: the note says so)
const FREE_START = 'copilot';

// What a tool needs before its install command: Git for Windows (Claude Code runs its commands through Git Bash; on
// Windows only) and Node.js for a tool whose only install command is npm's. Per platform (plan G4, 2026-10-09): Linux
// git from the distribution (git-scm.com's line), Node.js through nvm (its README's install line, then an LTS);
// macOS through Homebrew (git: git-scm.com; node: Homebrew's formula, not checked on a Mac: macOS is experimental).
export const PREREQS = Object.freeze({
  git: Object.freeze({ cmd: 'winget install --id Git.Git -e --source winget', how: 'winget' }),
  node: Object.freeze({ cmd: 'winget install --id OpenJS.NodeJS.LTS -e --source winget', how: 'winget' }),
});
export const PREREQS_ON = Object.freeze({
  linux: Object.freeze({
    git: Object.freeze({ cmd: 'sudo apt-get install git', how: 'apt' }),
    node: Object.freeze({ cmd: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install 24', how: 'shell' }),
  }),
  darwin: Object.freeze({
    git: Object.freeze({ cmd: 'brew install git', how: 'brew' }),
    node: Object.freeze({ cmd: 'brew install node', how: 'brew' }),
  }),
});
export const prereqFor = (id, platform = 'win32') => PREREQS_ON[platform]?.[id] || PREREQS[id];
const NEEDS_GIT = new Set(['claude']);

// The sign-in line of each tool, from its own --help (2026-10-08): {cmd} is the command's name as found (Cursor's is
// "agent" or "cursor-agent"). Gemini CLI and Qwen Code ask how to sign in the first time they open.
const SIGN_IN = Object.freeze({
  claude: '{cmd} auth login',
  codex: '{cmd} login',
  gemini: '{cmd}',
  copilot: '{cmd} login',
  cursor: '{cmd} login',
  qwen: '{cmd}',
  opencode: '{cmd} auth login',
});
const DEFAULT_CMD = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', cursor: 'cursor-agent', qwen: 'qwen', opencode: 'opencode' });
const CMD_RE = /^[a-z][a-z0-9-]{0,30}$/;

export function signInCommand(tool) {
  const cmd = typeof tool?.cmd === 'string' && CMD_RE.test(tool.cmd) ? tool.cmd : DEFAULT_CMD[tool?.id] || '';
  return cmd && SIGN_IN[tool.id] ? SIGN_IN[tool.id].replace('{cmd}', cmd) : '';
}

// The install command the wizard offers (pure): the tool's first command that does not need what is missing; with
// Node.js missing an npm-only tool still gets its npm command (Node.js comes first, as a step of its own)
export function installCommand(info, nodeInstalled, platform = 'win32') {
  const list = installsFor(info, platform);
  return (!nodeInstalled && list.find((c) => c.how !== 'npm')) || list[0] || null;
}

// Where the person is (pure). st: the tools state (views/tools.js normalizeTools, status 'ready'); toolId: the tool
// picked (null: not picked yet); info: TOOL_INFO. Returns { step: 'pick' | 'needs' | 'install' | 'signin' | 'done',
// tool, needs: [{ id: 'git' | 'node', ok }], install, signIn, ready }.
export function wizardState(st, toolId, info) {
  const tools = st?.status === 'ready' && Array.isArray(st.tools) ? st.tools : [];
  if (!toolId || !info?.[toolId]) return { step: 'pick', tool: null, needs: [], install: null, signIn: '', ready: 'unknown' };
  const tool = tools.find((x) => x.id === toolId) || { id: toolId, installed: false, ready: 'unknown' };
  const nodeOk = st?.node?.installed === true;
  const gitOk = st?.git ? st.git.installed === true && st.git.onPath !== false : true;
  const platform = platformOfState(st);
  const install = installCommand(info[toolId], nodeOk, platform);
  const needs = [];
  if (NEEDS_GIT.has(toolId) && platform === 'win32') needs.push({ id: 'git', ok: gitOk });
  if (!tool.installed && install?.how === 'npm') needs.push({ id: 'node', ok: nodeOk });
  const base = { tool, needs, install, signIn: signInCommand(tool), ready: tool.ready || 'unknown' };
  if (needs.some((n) => !n.ok)) return { step: 'needs', ...base };
  if (!tool.installed) return { step: 'install', ...base };
  // Signed in, or a tool whose state cannot be read: the person said it is done (signedIn) or it is
  if (tool.ready === 'no') return { step: 'signin', ...base };
  return { step: 'done', ...base };
}

const STEP_ORDER = ['pick', 'needs', 'install', 'signin', 'done'];
const cmdRow = (cmd, how = '') => `<li class="ai-cmd${how ? '' : ' no-how'}">${how ? `<span class="ai-how">${esc(how)}</span>` : ''}<code translate="no">${esc(cmd)}</code><button type="button" class="act-btn ai-copy" data-ai-copy>${icon('copy')}<span>${esc(t('aiCopy'))}</span></button></li>`;

// The wizard's markup (pure). w: wizardState(...); info: TOOL_INFO; canType: the setup terminal is there (desktop
// app, actions On); seen: whether the person pressed "I signed in" for a tool whose state cannot be read
/** @param {any} w @param {{ info?: any, st?: any, canType?: boolean, signedIn?: boolean }} [options] */
export function wizardHtml(w, { info, st, canType = false, signedIn = false } = {}) {
  const at = STEP_ORDER.indexOf(w.step);
  const dots = ['needs', 'install', 'signin', 'done']
    .map((k, i) => `<li class="${STEP_ORDER.indexOf(k) < at ? 'done' : STEP_ORDER.indexOf(k) === at ? 'now' : ''}"${STEP_ORDER.indexOf(k) === at ? ' aria-current="step"' : ''}><span class="wz-n" aria-hidden="true">${i + 1}</span>${esc(t(`wz_step_${k}`))}</li>`)
    .join('');
  const how = canType ? t('wzTypeHow') : tOs('wzCopyHow', {}, platformOfState(st));
  let body = '';
  if (w.step === 'pick') {
    const tools = st?.status === 'ready' ? st.tools : [];
    const cards = WIZARD_TOOLS.map((id) => {
      const x = tools.find((y) => y.id === id);
      const state = x?.installed ? `<span class="ai-chip ok">${esc(t('aiInstalled'))}</span>` : '';
      return `<li><button type="button" class="wz-tool" data-wz="pick:${esc(id)}"><span class="wz-tool-h"><b translate="no">${esc(info[id].name)}</b>${id === 'claude' ? `<span class="ai-chip chosen">${esc(t('wzBestFit'))}</span>` : ''}${id === FREE_START ? `<span class="ai-chip">${esc(t('wzFreeStart'))}</span>` : ''}${state}</span><span class="small muted">${esc(t(`aiAcct_${id}`))}</span></button></li>`;
    }).join('');
    body = `<h3 class="wz-h">${esc(t('wzPickTitle'))}</h3><p class="small muted">${esc(t('wzPickNote'))}</p><ul class="wz-tools">${cards}</ul>`;
  } else {
    const name = info[w.tool.id].name;
    const head = `<p class="wz-for small muted">${esc(t('wzFor', { name }))} <button type="button" class="linkish" data-wz="repick">${esc(t('wzOther'))}</button></p>`;
    if (w.step === 'needs') {
      const rows = w.needs
        .map((n) => (n.ok ? `<li class="wz-ok">${icon('check')} ${esc(t(`wzNeed_${n.id}_ok`))}</li>` : `<li class="wz-need"><p>${esc(t(`wzNeed_${n.id}`))}</p><ul class="ai-cmds">${cmdRow(prereqFor(n.id, platformOfState(st)).cmd, t(`aiHow_${prereqFor(n.id, platformOfState(st)).how}`))}</ul></li>`))
        .join('');
      body = `${head}<h3 class="wz-h">${esc(t('wzNeedsTitle'))}</h3><ul class="wz-needs">${rows}</ul><p class="small muted">${esc(how)} ${esc(t('wzNeedsAfter'))}</p>`;
    } else if (w.step === 'install') {
      body = `${head}<h3 class="wz-h">${esc(t('wzInstallTitle', { name }))}</h3><p class="small">${esc(t('wzInstallNote'))}</p><ul class="ai-cmds">${w.install ? cmdRow(w.install.cmd, t(`aiHow_${w.install.how}`)) : ''}</ul><p class="small muted">${esc(how)} ${esc(t('wzInstallAfter'))}</p>`;
    } else if (w.step === 'signin') {
      body = `${head}<h3 class="wz-h">${esc(t('wzSignInTitle', { name }))}</h3><p class="small">${esc(t(`wzSignIn_${w.tool.id}`))}</p><ul class="ai-cmds">${cmdRow(w.signIn)}</ul><p class="small muted">${esc(how)} ${esc(t('wzSignInAfter'))}</p><p class="small muted">${esc(t(`aiAcct_${w.tool.id}`))}</p>`;
    } else {
      const unknown = w.ready !== 'yes' && !signedIn;
      // The tool's own sign-in sentence too (review D): Gemini's says a Google account alone no longer works
      const sign = unknown ? `<p class="small">${esc(t('wzDoneUnknown', { name }))}</p><p class="small wz-tool-sign">${esc(t(`wzSignIn_${w.tool.id}`))}</p><ul class="ai-cmds">${cmdRow(w.signIn)}</ul><button type="button" class="act-btn" data-wz="signed">${esc(t('wzSignedIn'))}</button>` : '';
      body = `${head}<h3 class="wz-h">${icon('check')} ${esc(t('wzDoneTitle', { name }))}</h3><p class="small">${esc(t('wzDoneNote'))}</p>${sign}<div class="wz-acts"><button type="button" class="act-btn primary" data-wz="use">${icon('folder')}<span>${esc(t('wzUse'))}</span></button></div>`;
    }
  }
  const nav = `<div class="wz-nav">${w.step !== 'pick' && w.step !== 'done' ? `<button type="button" class="act-btn" data-ai-act="recheck">${icon('replay')}<span>${esc(t('wzCheck'))}</span></button>` : ''}<button type="button" class="linkish" data-wz="list">${esc(t('wzAllTools'))}</button></div>`;
  return `<section class="wz">${w.step === 'pick' ? '' : `<ol class="wz-steps">${dots}</ol>`}${body}${nav}</section>`;
}
