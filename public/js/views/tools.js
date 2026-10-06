// "Start with AI" on the page (docs/ai-start.md): the AI tools this computer has (GET /api/tools), the project drawer's
// "Then: start with AI" section and the context menu's items (both pure), the result notice (pure) and the tools panel
// (a dialog: what is installed, and how to install the rest).
// Tools are looked for on first need only (the drawer section or the context menu of a project), never when the page
// loads. The module touches neither the DOM nor the network while loading (node tests import it); requests start only
// after bindAiStart() (the drawer, in the browser) switched them on.
import { esc, ago, num } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { argvSummary } from '../actions.js';
import { ADAPTER_OF_TOOL } from '../toolTags.js';
import { store } from '../store.js';
import { setupCheckHtml, errorBoxHtml, matchError } from '../setupCheck.js';

// What the page knows about each tool: how to install it (the official commands; SiberSentez never runs them), what
// account it needs, and whether an install command needs Node.js (node: 'npm' = only the npm command).
export const TOOL_INFO = Object.freeze({
  claude: Object.freeze({
    name: 'Claude Code',
    install: [
      { how: 'powershell', cmd: 'irm https://claude.ai/install.ps1 | iex' },
      { how: 'winget', cmd: 'winget install Anthropic.ClaudeCode' },
    ],
    docs: 'https://code.claude.com/docs/en/setup',
  }),
  codex: Object.freeze({
    name: 'Codex CLI',
    install: [
      { how: 'powershell', cmd: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
      { how: 'npm', cmd: 'npm i -g @openai/codex' },
    ],
    docs: 'https://github.com/openai/codex',
  }),
  gemini: Object.freeze({ name: 'Gemini CLI', install: [{ how: 'npm', cmd: 'npm install -g @google/gemini-cli' }], docs: 'https://geminicli.com/docs/get-started/installation' }),
  copilot: Object.freeze({
    name: 'GitHub Copilot CLI',
    install: [
      { how: 'winget', cmd: 'winget install GitHub.Copilot' },
      { how: 'npm', cmd: 'npm install -g @github/copilot' },
    ],
    docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  }),
  cursor: Object.freeze({ name: 'Cursor CLI', install: [{ how: 'powershell', cmd: "irm 'https://cursor.com/install?win32=true' | iex" }], docs: null }),
  qwen: Object.freeze({ name: 'Qwen Code', install: [{ how: 'npm', cmd: 'npm i -g @qwen-code/qwen-code@latest' }], docs: null }),
  opencode: Object.freeze({ name: 'OpenCode', install: [{ how: 'npm', cmd: 'npm i -g opencode-ai' }], docs: null }),
});
export const TOOL_ORDER = Object.freeze(Object.keys(TOOL_INFO));
const VIAS = new Set(['native', 'npm', 'winget', 'scoop', 'store', 'other']);
const READY = new Set(['yes', 'no', 'unknown']);
const PATH_DIRS = new Set(['localBin', 'npm', 'winget', 'scoop']);
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const STALE_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;

// ---------------- state: GET /api/tools ----------------

// status: 'idle' (never asked), 'loading' (first answer pending), 'ready', 'error'; checking: a request is running
let state = Object.freeze({ status: 'idle', tools: [], node: null, at: 0, checking: false, failedAt: 0 });
let fetchImpl = (...a) => globalThis.fetch(...a);
let inflight = null;
let auto = false;
const listeners = new Set();

export function toolsState() {
  return state;
}

export function onToolsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(next) {
  state = Object.freeze({ ...state, ...next });
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (e) {
      console.error(e);
    }
  }
}

// The server's answer, kept to known ids and words (pure)
export function normalizeTools(d) {
  const list = Array.isArray(d?.tools) ? d.tools : [];
  const tools = [];
  for (const id of TOOL_ORDER) {
    const x = list.find((y) => y && y.id === id);
    if (!x) continue;
    const version = typeof x.version === 'string' && VERSION_RE.test(x.version) ? x.version : null;
    tools.push({
      id,
      name: TOOL_INFO[id].name,
      installed: x.installed === true,
      version,
      via: VIAS.has(x.via) ? x.via : x.installed === true ? 'other' : null,
      ready: READY.has(x.ready) ? x.ready : 'unknown',
      installs: Number.isInteger(x.installs) && x.installs > 0 ? x.installs : 0,
      others: (Array.isArray(x.others) ? x.others : []).slice(0, 4).map((o) => ({ via: VIAS.has(o?.via) ? o.via : 'other', version: typeof o?.version === 'string' && VERSION_RE.test(o.version) ? o.version : null })),
      onPath: x.onPath !== false,
      pathDir: PATH_DIRS.has(x.pathDir) ? x.pathDir : null,
      app: x.app === true,
    });
  }
  const node = d?.node && typeof d.node === 'object' ? { installed: d.node.installed === true, version: typeof d.node.version === 'string' && VERSION_RE.test(d.node.version) ? d.node.version : null } : null;
  // git and env are absent from an older server's answer: null (the setup check says nothing about them)
  const git = d?.git && typeof d.git === 'object' ? { installed: d.git.installed === true, onPath: d.git.onPath === true } : null;
  const env = d?.env && typeof d.env === 'object' ? { anthropicKey: d.env.anthropicKey === true } : null;
  return { tools, node, git, env, at: Number(d?.at) || 0 };
}

// GET /api/tools (refresh: ?refresh=1, check again). One request at a time; resolves to the new state.
export function loadTools({ refresh = false } = {}) {
  if (inflight) return inflight;
  // The request exists before any listener hears of it: a listener that asks again (the Today checklist calls
  // needTools on every render) gets this one. With setState first, a five-minute-old answer made loadTools and the
  // checklist call each other without end: the window froze and the app grew to gigabytes (owner's machine, 0.7.2).
  const run = (async () => {
    await null;
    try {
      const res = await fetchImpl(`/api/tools${refresh ? '?refresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const d = normalizeTools(await res.json());
      // at: when the server looked (shown as "checked … ago"); gotAt: when this page got it (what "five minutes old"
      // counts from, so a server answer that is already old is not asked for again at once)
      setState({ status: 'ready', tools: d.tools, node: d.node, git: d.git, env: d.env, at: d.at || Date.now(), gotAt: Date.now(), checking: false, failedAt: 0 });
    } catch {
      setState({ status: state.status === 'ready' ? 'ready' : 'error', checking: false, failedAt: Date.now() });
    } finally {
      if (inflight === run) inflight = null;
    }
    return state;
  })();
  inflight = run;
  setState({ status: state.status === 'ready' ? 'ready' : 'loading', checking: true });
  return run;
}

// First need (the drawer section, the context menu): ask once, again when the answer is five minutes old, and 30 s
// after a failure. Nothing happens until bindAiStart() switched requests on (never in node tests).
export function needTools(now = Date.now()) {
  if (!auto || inflight) return;
  // A failed request waits RETRY_MS in every status: a stale "ready" answer whose refresh failed (the server
  // restarting, a 500) was asked for again on every render
  if (state.failedAt && now - state.failedAt < RETRY_MS) return;
  if (state.status === 'idle' || (state.status === 'ready' && now - (state.gotAt || state.at) > STALE_MS) || (state.status === 'error' && now - state.failedAt > RETRY_MS)) loadTools();
}

export const installedTools = (st = state) => (st.status === 'ready' ? st.tools.filter((x) => x.installed) : []);

// ---------------- the idea as first message: a choice per project ----------------
const IDEA_PREF_PREFIX = 'sibersentez.aiIdea.';
const ideaPrefs = new Map();

// "Start with my idea" is on unless the person switched it off for this project (kept in this browser)
export function ideaPref(projectId) {
  const id = String(projectId ?? '');
  if (ideaPrefs.has(id)) return ideaPrefs.get(id);
  let on = true;
  try {
    on = globalThis.localStorage?.getItem(IDEA_PREF_PREFIX + id) !== '0';
  } catch {
    // storage blocked: on
  }
  ideaPrefs.set(id, on);
  return on;
}

export function setIdeaPref(projectId, on) {
  const id = String(projectId ?? '');
  ideaPrefs.set(id, !!on);
  try {
    if (on) globalThis.localStorage?.removeItem(IDEA_PREF_PREFIX + id);
    else globalThis.localStorage?.setItem(IDEA_PREF_PREFIX + id, '0');
  } catch {
    // storage blocked: kept until a reload
  }
}

// ---------------- the context menu (pure) ----------------

// Items for a project or a session menu. payload: { projectId } or { sessionId }; ctx: { name (for the notice),
// projectId (the project whose idea and drawer count), hasIdea }. While tools were never asked for: nothing (the menu
// asks when it opens). While they are being looked for, or none is installed: one item that opens the project drawer
// at "Then: start with AI". Otherwise one item per installed tool, sending start-ai with ids, the tool id and the
// idea choice only.
export function aiStartMenuItems(payload, { name = '', projectId = null, hasIdea = false } = {}, st = state) {
  if (!st || st.status === 'idle') return [];
  const open = projectId ? { type: 'project', id: projectId, section: 'terminal' } : null;
  const tools = installedTools(st);
  if (!tools.length) {
    if (!open) return [];
    const hint = st.status === 'ready' ? t('aiMenuNoneHint') : t('aiMenuStartHint');
    return [{ id: 'start-ai', label: t('aiMenuStart'), hint, icon: 'spark', open }];
  }
  const withIdea = !!hasIdea && !!projectId && ideaPref(projectId);
  return tools.map((x) => ({
    id: `start-ai:${x.id}`,
    label: t('aiStartWith', { tool: x.name }),
    hint: withIdea ? t('aiMenuHintIdea') : x.ready === 'yes' ? t('aiMenuHintFolder') : t('aiMenuHintLogin'),
    icon: 'spark',
    action: 'start-ai',
    payload: { ...payload, tool: x.id, withIdea },
    name: String(name || ''),
    toolName: x.name,
  }));
}

// ---------------- the result notice (pure) ----------------

const hasText = (key) => t(key) !== key;

// res: the start-ai reply; item: the menu item that sent it; fallbackText(res): the menu's general error text
export function aiStartToast(res, item, fallbackText = () => '') {
  const r = res || {};
  const tool = item?.toolName || TOOL_INFO[r.tool]?.name || TOOL_INFO[item?.payload?.tool]?.name || 'AI';
  const name = String(item?.name || '');
  const file = r.firstMessage?.file ? String(r.firstMessage.file) : '';
  if (r.ok && r.mode === 'dry') {
    return { tone: 'dry', title: t('aiToastDryTitle', { tool }), body: [file && r.firstMessage.op === 'create' ? t('aiToastDryFirst', { file }) : '', t('aiToastDryBody')].filter(Boolean).join(' '), code: argvSummary(r.argv) || '—' };
  }
  if (r.ok) {
    const parts = [];
    // "Do a job" sends a job, not the idea: the notice says which one the tool reads
    if (file) parts.push(t(item?.payload?.job ? 'aiToastFirstJob' : r.firstMessage.op === 'same' ? 'aiToastFirstSame' : 'aiToastFirstCreate', { file }));
    if (r.terminal === 'cmd') parts.push(t('aiToastFallback'));
    if (r.terminal === 'dock') parts.push(t('aiToastInDock'));
    // A resumed session already went through the folder trust and the sign-in
    if (!item?.payload?.resume) parts.push(t('aiToastNext'));
    // The start went on without a restore point (docs/restore.md: a problem never stops the start): say so first, so
    // nobody counts on an undo that does not exist
    const problem = r.restorePoint && typeof r.restorePoint.problem === 'string' ? r.restorePoint.problem : '';
    if (problem) {
      const why = hasText(`aiNoPoint_${problem}`) ? t(`aiNoPoint_${problem}`) : t('aiNoPoint_other');
      parts.unshift(t('aiToastNoPoint', { why }));
    }
    // A lean point (a big project, docs/restore.md §7): what it left out is said too
    const left = r.restorePoint?.scope === 'lean' && Number.isInteger(r.restorePoint.leftOut) ? r.restorePoint.leftOut : 0;
    if (!problem && left > 0) parts.push(t('aiToastLeanPoint', { count: left }));
    return { tone: problem ? 'warn' : 'ok', title: name ? t('aiToastOpened', { tool, name }) : t('aiToastOpenedPlain', { tool }), body: parts.join(' ') };
  }
  const code = String(r.error || '');
  const malformed = ['unexpected-field', 'missing-field', 'bad-field'].includes(code);
  let body = malformed ? t('skErr_malformed') : /^[a-z][a-z-]*$/.test(code) && hasText(`aiErr_${code}`) ? t(`aiErr_${code}`) : fallbackText(r);
  const written = Array.isArray(r.result?.written) ? r.result.written : Array.isArray(r.written) ? r.written : [];
  if (written.length) body = `${body} ${t('aiToastWritten', { files: written.join(', ') })}`;
  return { tone: 'err', title: t('aiToastFailTitle', { tool }), body };
}

// ---------------- the drawer section (pure) ----------------

// "Then: start with AI" (under "Skills that fit this project"). p: the project; opts: { mode, done (the line after an
// install, HTML), tools (the state), withIdea (the choice for this project) }. Buttons send through the context
// menu's model (data-menu-act), so the drawer and the menu send the same request.
export function aiStartSectionHtml(p, { mode = 'off', done = '', tools = state, withIdea = true } = {}) {
  const on = mode === 'dry' || mode === 'live';
  const dis = on ? '' : ' aria-disabled="true"';
  const pid = esc(p.id);
  const found = installedTools(tools);
  const hasIdea = typeof p.idea === 'string' && p.idea.trim() !== '';
  const toolBtns = found
    .map((x, i) => `<button type="button" class="act-btn${i === 0 ? ' primary' : ''}" data-menu-act="start-ai:${esc(x.id)}" data-menu-type="project" data-menu-id="${pid}" data-fk="ai:${esc(x.id)}" aria-describedby="nextWhy"${dis}>${icon('spark')}<span>${esc(t('aiStartWith', { tool: x.name }))}</span></button>`)
    .join('');
  const plain = `<button type="button" class="act-btn${found.length ? '' : ' primary'}" data-menu-act="terminal" data-menu-type="project" data-menu-id="${pid}" data-fk="next:terminal" aria-describedby="nextWhy"${dis}>${icon('command')}<span>${esc(t('aiPlainTerminal'))}</span></button>`;
  // Off: the drawer's banner carries the one button
  const chooser = mode !== 'dry' ? '' : `<button type="button" class="act-btn" data-fit-act="chooser" data-fk="next:chooser">${esc(t('fitChooser'))}</button>`;
  const idea = found.length
    ? hasIdea
      ? `<label class="ai-idea"><input type="checkbox" data-ai-idea="${pid}" data-fk="ai:idea"${withIdea ? ' checked' : ''}><span>${esc(t('aiIdeaToggle'))}</span></label><p class="small muted ai-idea-hint">${esc(t('aiIdeaHint'))}</p>`
      : `<p class="small muted ai-idea-hint">${esc(t('aiNoIdea'))}</p>`
    : '';
  const notes = found
    .filter((x) => x.ready !== 'yes')
    .map((x) => `<li>${esc(t(x.ready === 'no' ? 'aiNotSignedNote' : 'aiLoginNote', { tool: x.name }))}</li>`)
    .join('');
  let status = '';
  if (tools.status === 'loading' || tools.status === 'idle') status = `<p class="small ai-status" role="status">${esc(t('aiLoading'))}</p>`;
  else if (tools.status === 'error') status = `<p class="small ai-status warn" role="status">${esc(t('aiLoadFailed'))}</p>`;
  else if (!found.length) status = `<div class="ai-none"><p class="small">${esc(t('aiNone'))}</p><button type="button" class="act-btn primary" data-ai-act="tools" data-fk="ai:install">${icon('plugin')}<span>${esc(t('aiInstallOne'))}</span></button></div>`;
  const why = mode === 'live' ? t('aiWhyLive') : mode === 'dry' ? t('startNextDry') : t('startNextOff');
  const links = `<p class="ai-links small"><button type="button" class="ai-link" data-ai-act="tools" data-fk="ai:tools">${esc(t('aiToolsLink'))}</button><span aria-hidden="true">·</span><button type="button" class="ai-link" data-ai-act="recheck" data-fk="ai:recheck"${tools.checking ? ' disabled' : ''}>${esc(tools.checking && tools.status === 'ready' ? t('aiChecking') : t('aiRecheck'))}</button></p>`;
  return `<section class="dr-sec start-next ai-start" data-sec="terminal" aria-labelledby="nextH"><h3 id="nextH">${icon('spark')} ${esc(t('aiStartTitle'))}</h3>${done}${idea}<div class="flow-btns">${toolBtns}${plain}${chooser}</div>${notes ? `<ul class="ai-notes small">${notes}</ul>` : ''}${status}<p class="small muted flow-why" id="nextWhy">${esc(why)}</p>${links}</section>`;
}

// ---------------- the tools panel (pure HTML) ----------------

function viaText(via) {
  return t(`aiVia_${VIAS.has(via) ? via : 'other'}`);
}

// What the tool's own traces show here (docs/tool-view.md): the adapter reading the same tool, from the snapshot
// An installed tool always gets the line (also "nothing found yet"); one not installed only when it left traces
function seenLine(x, seen = []) {
  const a = seen.find((r) => r.id === ADAPTER_OF_TOOL[x.id]);
  const any = !!a && (a.projects || a.skills || a.agents) > 0;
  if (!a || (!any && !x.installed)) return '';
  return `<p class="small ai-seen${any ? '' : ' muted'}">${esc(any ? t('tvSeesCounts', { projects: num(a.projects), skills: num(a.skills), agents: num(a.agents) }) : t('tvSeesNothing'))}</p>`;
}

function toolCardHtml(x, node, seen = []) {
  const info = TOOL_INFO[x.id];
  const head = `<div class="ai-card-head"><b translate="no">${esc(info.name)}</b>${
    x.installed
      ? `<span class="ai-chip ok">${esc(t('aiInstalled'))}${x.version ? ` · <span translate="no">${esc(x.version)}</span>` : ''} · ${esc(viaText(x.via))}</span><span class="ai-chip ready-${esc(x.ready)}">${esc(t(`aiReady_${x.ready}`))}</span>`
      : `<span class="ai-chip off">${esc(t('aiNotInstalled'))}</span>`
  }</div>`;
  const lines = [];
  const seenHtml = seenLine(x, seen);
  if (seenHtml) lines.push(seenHtml);
  if (x.installed && x.installs > 1) {
    const first = [viaText(x.via), x.version].filter(Boolean).join(' ');
    const others = x.others.map((o) => [viaText(o.via), o.version].filter(Boolean).join(' ')).join(', ') || '—';
    lines.push(`<p class="small ai-warn">${esc(t('aiMulti', { count: x.installs, first, others }))}</p>`);
  }
  if (x.installed && !x.onPath) lines.push(`<p class="small muted">${esc(t('aiNotOnPath'))}</p>`);
  if (!x.installed && x.app) lines.push(`<p class="small ai-warn">${esc(t('aiCodexApp'))}</p>`);
  if (!x.installed) {
    const cmds = info.install
      .map((c) => `<li class="ai-cmd"><span class="ai-how">${esc(t(`aiHow_${c.how}`))}</span><code translate="no">${esc(c.cmd)}</code><button type="button" class="act-btn ai-copy" data-ai-copy>${icon('copy')}<span>${esc(t('aiCopy'))}</span></button></li>`)
      .join('');
    const npm = info.install.some((c) => c.how === 'npm');
    const nodeState = node?.installed ? t('aiNodeHave', { version: node.version ? `Node.js ${node.version}` : 'Node.js' }) : t('aiNodeMissing');
    lines.push(`<p class="small ai-how-h">${esc(t('aiHowInstall'))}</p><ul class="ai-cmds">${cmds}</ul>`);
    lines.push(`<p class="small"><span class="muted">${esc(t('aiAccount'))}:</span> ${esc(t(`aiAcct_${x.id}`))}</p>`);
    if (npm) lines.push(`<p class="small muted">${esc(t('aiNeedsNode', { state: nodeState }))} ${esc(t('aiPolicyTip'))}</p>`);
    if (info.docs) lines.push(`<p class="small"><a href="${esc(info.docs)}" target="_blank" rel="noopener noreferrer">${esc(t('aiDocs'))}</a></p>`);
  }
  return `<li class="ai-card${x.installed ? ' on' : ''}" data-ai-tool="${esc(x.id)}">${head}${lines.join('')}</li>`;
}

// The panel's content (pure): state -> HTML. Installed tools first, then the others, each in the fixed order.
export function toolsPanelHtml(st = state, now = Date.now(), seen = store.tools, errText = '') {
  let list = '';
  if (st.status === 'ready') {
    const known = TOOL_ORDER.map((id) => st.tools.find((x) => x.id === id) || { id, installed: false, installs: 0, others: [], ready: 'unknown', app: false, onPath: false });
    const sorted = [...known.filter((x) => x.installed), ...known.filter((x) => !x.installed)];
    list = `<ul class="ai-cards">${sorted.map((x) => toolCardHtml(x, st.node, seen)).join('')}</ul>`;
  } else if (st.status === 'error') list = `<p class="ai-status warn" role="status">${esc(t('aiLoadFailed'))}</p>`;
  else list = `<p class="ai-status" role="status">${esc(t('aiLoading'))}</p>`;
  const checked = st.status === 'ready' && st.at ? `<span class="small muted">${esc(t('aiPanelChecked', { when: ago(st.at, now) }))}</span>` : '';
  const recheck = `<button type="button" class="act-btn" data-ai-act="recheck"${st.checking ? ' disabled' : ''}>${icon('replay')}<span>${esc(st.checking ? t('aiChecking') : t('aiRecheck'))}</span></button>`;
  return `<header class="ai-panel-head"><h2 id="aiPanelH">${icon('spark')} ${esc(t('aiPanelTitle'))}</h2><button type="button" class="icon-btn ai-panel-close" data-ai-act="close" aria-label="${esc(t('aiPanelClose'))}" title="${esc(t('aiPanelClose'))}">${icon('close')}</button></header>
    <p class="ai-panel-intro">${esc(t('aiPanelIntro'))}</p>
    <div class="ai-panel-bar">${recheck}${checked}</div>
    ${setupCheckHtml(st)}
    ${list}
    ${errorBoxHtml(errText)}
    <p class="small muted ai-panel-foot">${esc(t('aiFirstRun'))} ${esc(t('aiAfterInstall'))}</p>
    <p class="sr-only" role="status" data-ai-live></p>`;
}

// ---------------- DOM: the drawer hook and the panel ----------------

let panel = null;

// "Type in terminal" beside every command of the panel (install commands, setup fixes), in the desktop app with the
// terminal dock (docs/embedded-terminal.md, "Setup terminal"): main.js hands the dock's typeSetup in. The command goes
// into a plain terminal of the home folder without Enter; the person reads it and runs it.
let setupTyper = null;
export function setSetupTyper(fn) {
  setupTyper = typeof fn === 'function' ? fn : null;
}
function addTypeButtons(root) {
  if (!setupTyper || !root) return;
  for (const li of root.querySelectorAll('li.ai-cmd')) {
    if (li.querySelector('[data-ai-type]')) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act-btn ai-type';
    b.dataset.aiType = '';
    b.innerHTML = `${icon('prompt')}<span>${esc(t('aiType'))}</span>`;
    li.insertBefore(b, li.querySelector('[data-ai-copy]'));
    li.classList.add('can-type');
  }
}

// Opens the tools panel (a modal dialog over the page); asks for the tools when they are not known yet. Esc, the close
// button or a click outside closes it; focus goes back to where it was.
export function openToolsPanel() {
  if (typeof document === 'undefined') return;
  if (!panel) panel = createPanel();
  panel.open();
  needTools();
}

function createPanel() {
  const scrim = document.createElement('div');
  scrim.className = 'ai-panel-scrim';
  scrim.hidden = true;
  const box = document.createElement('section');
  box.className = 'ai-panel';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'aiPanelH');
  box.tabIndex = -1;
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  let back = null;
  let off = null;
  const draw = () => {
    const focusAct = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset?.aiAct : null;
    // The pasted error survives a redraw (the tools answering while the panel is open); it is never stored
    const ta = box.querySelector('[data-sc-text]');
    const text = ta ? ta.value : '';
    const pos = ta && document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : null;
    const errOpen = !!box.querySelector('.sc-err')?.open;
    box.innerHTML = toolsPanelHtml(state, Date.now(), store.tools, text);
    addTypeButtons(box);
    if (errOpen) box.querySelector('.sc-err')?.setAttribute('open', '');
    if (pos) {
      const nt = box.querySelector('[data-sc-text]');
      nt?.focus({ preventScroll: true });
      nt?.setSelectionRange(pos[0], pos[1]);
    }
    if (focusAct) box.querySelector(`[data-ai-act="${focusAct}"]`)?.focus({ preventScroll: true });
  };
  const say = (text) => {
    const live = box.querySelector('[data-ai-live]');
    if (live) {
      live.textContent = '';
      setTimeout(() => (live.textContent = text), 60);
    }
  };
  function open() {
    if (!scrim.hidden) return box.focus({ preventScroll: true });
    back = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    draw();
    scrim.hidden = false;
    off = onToolsChange(draw);
    (box.querySelector('[data-ai-act="close"]') || box).focus({ preventScroll: true });
  }
  function close() {
    if (scrim.hidden) return;
    scrim.hidden = true;
    box.innerHTML = ''; // the pasted error goes with the panel
    off?.();
    off = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }
  // The error box: results follow the text as it is typed or pasted; nothing leaves the page
  scrim.addEventListener('input', (e) => {
    const ta = e.target.closest?.('[data-sc-text]');
    if (!ta) return;
    const out = box.querySelector('[data-sc-results]');
    const html = errorBoxHtml(ta.value, matchError(ta.value));
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = tmp.querySelector('[data-sc-results]');
    if (out && fresh) {
      out.replaceWith(fresh);
      addTypeButtons(fresh);
    }
  });
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) return close();
    const act = e.target.closest('[data-ai-act]')?.dataset.aiAct;
    if (act === 'close') return close();
    if (act === 'recheck') return loadTools({ refresh: true });
    const tb = e.target.closest('[data-ai-type]');
    if (tb && setupTyper) {
      const text = tb.parentElement.querySelector('code')?.textContent || '';
      tb.disabled = true;
      // The panel closes so the terminal below is seen; a refusal (actions off, ...) is the dock's own notice
      Promise.resolve(setupTyper(text))
        .then((r) => (r?.ok ? close() : say(t('aiTypeFailed'))))
        .catch(() => say(t('aiTypeFailed')))
        .finally(() => (tb.disabled = false));
      return;
    }
    const cp = e.target.closest('[data-ai-copy]');
    if (cp) {
      const text = cp.parentElement.querySelector('code')?.textContent || '';
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .then(
          () => {
            cp.dataset.done = '1';
            setTimeout(() => delete cp.dataset.done, 1500);
            say(t('aiCopied'));
          },
          () => say(t('aiCopyFailed')),
        );
    }
  });
  // Keys stay in the dialog: Esc closes it (not the drawer behind), Tab cycles inside, page shortcuts do not fire
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button:not([disabled]), a[href], summary, textarea, [tabindex="0"]')];
      if (f.length) {
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    }
    e.stopPropagation();
  });
  return { open, close, isOpen: () => !scrim.hidden };
}

// Hooks the project drawer (called once by createDrawer): switches tool requests on, keeps the idea choice, opens
// the panel, checks again, and redraws the drawer when the tools answer while "Then: start with AI" is on screen.
// QA only (?qa=1): &aitools=1 opens the panel once the page settled; &aistart=1 scrolls the open drawer to the section.
export function bindAiStart(bodyEl, { rerender = () => {} } = {}) {
  auto = true;
  bodyEl.addEventListener('change', (e) => {
    const box = e.target.closest?.('[data-ai-idea]');
    if (box) setIdeaPref(box.dataset.aiIdea, box.checked);
  });
  bodyEl.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-ai-act]')?.dataset.aiAct;
    if (act === 'tools') openToolsPanel();
    else if (act === 'recheck') loadTools({ refresh: true });
  });
  onToolsChange(() => {
    if (bodyEl.querySelector('[data-sec="terminal"]')) rerender();
  });
  try {
    const q = new URLSearchParams(globalThis.location?.search || '');
    if (q.has('qa') && q.get('aitools') === '1') setTimeout(openToolsPanel, 1500);
    if (q.has('qa') && q.get('aistart') === '1') setTimeout(() => bodyEl.querySelector('[data-sec="terminal"]')?.scrollIntoView({ block: 'start' }), 1500);
  } catch {
    // no location: nothing to do
  }
}

// Tests: back to the first state (and a fake fetch)
export function _resetToolsForTest({ fetch, autoLoad = false } = {}) {
  state = Object.freeze({ status: 'idle', tools: [], node: null, at: 0, checking: false, failedAt: 0 });
  inflight = null;
  auto = autoLoad;
  listeners.clear();
  ideaPrefs.clear();
  fetchImpl = fetch || ((...a) => globalThis.fetch(...a));
}
