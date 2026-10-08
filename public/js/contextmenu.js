// Context menu.
// 1) menuModel(): which items for which target: a pure function without the DOM, tested in node.
// 2) createContextMenu(): the accessible DOM menu (role="menu", up/down, Home/End, Enter/Space, Esc,
//    first-letter jump), flipped to fit the screen, returns focus to the trigger when it closes.
// The module does not touch the DOM while loading.
import { esc } from './format.js';
import { icon } from './icons.js';
import { runAction, actionsState, argvSummary } from './actions.js';
import { isLibraryItem } from './rosterModel.js';
import { isHiddenProject, setProjectHidden } from './hiddenProjects.js';
import { t, language } from './i18n.js';
import { sessionTool, sessionToolName, canContinueTool } from './jobId.js';
// "Start with AI" items, their notice, and asking for the tools on first need (docs/ai-start.md)
import { aiStartMenuItems, aiStartToast, needTools } from './views/tools.js';

// Server actions the context menu sends itself (contract §5). The skill flow items of the menu ("Suggested skills…",
// "Install into a project…") send nothing: they open the drawer section where the flow runs (docs/skills-flow.md §5).
// A new session is opened with "Open terminal" (docs/terminal.md): the user starts the AI tool of their choice there,
// or with "Start with <tool>" (start-ai, docs/ai-start.md) for a tool SiberSentez found on this computer.
// The server still has 'new' (a Claude Code session) for the skill trial; the menu never sends it.
export const MENU_ACTIONS = Object.freeze(['resume', 'fork', 'terminal', 'explorer', 'vscode', 'start-ai']);
// Sent on window after an AI tool started in a project ({ projectId })
export const AI_STARTED_EVENT = 'sibersentez:ai-started';
const MODES = new Set(['off', 'dry', 'live']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Project kind and roster kind names, read when the menu is built (the language is chosen after this module loads)
const kindLabel = (kind) => ({ hub: t('shKindHub'), registered: t('shKindRegistered'), adhoc: t('shKindAdhoc') })[kind];
const rosterKindLabel = (kind) => ({ skill: t('shKindSkill'), agent: t('shKindAgent'), plugin: t('shKindPlugin') })[kind];
// Locale of the page language, for case folding
const loc = () => (language() === 'tr' ? 'tr-TR' : 'en-US');

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

// A Map, an array or a plain object: the store's Maps and the tests' plain objects both work
function get(coll, id) {
  if (!coll || id == null) return undefined;
  if (coll instanceof Map) return coll.get(id);
  if (Array.isArray(coll)) return coll.find((x) => x && x.id === id);
  return coll[id];
}
function values(coll) {
  if (!coll) return [];
  if (coll instanceof Map) return [...coll.values()];
  if (Array.isArray(coll)) return coll;
  return Object.values(coll);
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function sessionTitle(s) {
  if (!s) return '';
  return s.title || s.lastPrompt || s.firstPrompt || s.live?.name || t('shSessionNew');
}

// The project's latest session (by last activity; the status time of an open session counts too); tool: only that AI
// tool's sessions, or a test of the tool id (a session of a tool that cannot continue must not hide one that can)
export function latestSession(data, projectId, tool = null) {
  const takes = typeof tool === 'function' ? (s) => tool(s.tool || 'claude') : tool ? (s) => (s.tool || 'claude') === tool : () => true;
  let best = null;
  let bt = -1;
  for (const s of values(data?.sessions)) {
    if (!s || s.projectId !== projectId || !takes(s)) continue;
    const t = Math.max(s.lastAt || 0, s.live?.since || 0);
    if (t > bt) {
      bt = t;
      best = s;
    }
  }
  return best;
}

// Whether an action can be taken on a session: the server accepts only a UUID id with a known folder
function sessionActionable(s) {
  return !!(s && UUID_RE.test(String(s.id)) && s.cwd);
}

// For an open session: its copy (fork) instead of "continue"; a second client is not attached to an open session.
// Copy and Windows Terminal work with Claude Code sessions only, and their labels say so (strings/terminal.js).
// Another tool's session (Codex, Gemini CLI, Qwen Code: server/toolLogs.mjs) continues with that tool's own resume
// arguments through the checked launcher (start-ai with resume, server/tools.mjs resume), never with Claude's.
function continueItem(s, where) {
  if (sessionTool(s) !== 'claude') {
    if (!canContinueTool(sessionTool(s)) || s.live) return [];
    return [{ id: 'resume', label: t('termResumeTool', { tool: sessionToolName(s) }), hint: where === 'project' ? clip(sessionTitle(s), 30) : dockOpen && !dockFull?.() ? t('termResumeDockHint') : 'Windows Terminal', icon: 'play', action: 'start-ai', payload: { sessionId: s.id, tool: sessionTool(s), resume: true } }];
  }
  if (s.live) {
    return {
      id: 'fork',
      label: t(where === 'agent' ? 'termForkParent' : 'termFork'),
      hint: where === 'project' ? clip(sessionTitle(s), 30) : t('termLiveHint'),
      icon: 'fork',
      action: 'fork',
      payload: { sessionId: s.id },
    };
  }
  const outside = {
    id: 'resume',
    label: t(where === 'agent' ? 'termResumeParent' : 'termResume'),
    hint: where === 'session' ? 'Windows Terminal' : clip(sessionTitle(s), 30),
    icon: 'play',
    action: 'resume',
    payload: { sessionId: s.id },
  };
  // With the terminal dock: the same session continues in it (start-ai with resume: the checked launcher, docs/ai-start.md)
  // and Windows Terminal is the second item
  if (!dockOpen || dockFull?.()) return outside;
  return [
    { ...outside, hint: where === 'project' ? outside.hint : t('termResumeDockHint'), action: 'start-ai', payload: { sessionId: s.id, tool: 'claude', resume: true } },
    { ...outside, id: 'resume-outside', label: t('termResumeOutside'), hint: 'Windows Terminal' },
  ];
}

// Last segment of a folder path (the name a terminal toast shows when the session has no project name)
function folderName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// "Open terminal" (docs/terminal.md): a plain terminal in the folder, no AI command. `name` is for the result
// notice only; the request carries the id alone.
function terminalItem(payload, name, here) {
  return { id: 'terminal', label: t(here ? 'termOpenHere' : 'termOpen'), hint: t(here ? 'termOpenHereHint' : 'termOpenHint'), icon: 'terminal', action: 'terminal', payload, name: String(name || '') };
}

// The terminal dock (docs/embedded-terminal.md): main.js hands its opener in, in the SiberSentez window only. Then "Open
// terminal" opens in the dock and Windows Terminal is the second item; without it (a plain browser) nothing changes.
let dockOpen = null;
let dockFull = null; // () => true when no more terminals can open
export function setDockOpener(fn, isFull = null) {
  dockOpen = typeof fn === 'function' ? fn : null;
  dockFull = dockOpen && typeof isFull === 'function' ? isFull : null;
}
function terminalItems(payload, name, here) {
  const outside = terminalItem(payload, name, here);
  if (!dockOpen) return [outside];
  return [
    { id: 'terminal-dock', label: outside.label, hint: outside.hint, icon: 'terminal', dock: payload, name: outside.name },
    { ...outside, label: t('termOpenOutside'), hint: t('termOpenOutsideHint') },
  ];
}

function header(label, hint, mode, note, pathHint = false) {
  const h = { id: 'header', header: true, label: label || '—', hint: hint || '' };
  if (pathHint) h.pathHint = true;
  if (mode === 'dry') h.badge = t('shCmDryBadge');
  if (mode === 'off') {
    h.note = t('shCmOffNote');
    // One line on how to switch them on (docs/actions-toggle.md §3.5, §3a): the header indicator or the tray menu
    h.tip = t('actionsOffMenuTip');
  } else if (note) h.note = note;
  return h;
}

const SEP = () => ({ id: 'sep', sep: true });

// Drop leading, trailing and repeated separators; make the separator ids unique
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (it.sep) {
      const prev = out[out.length - 1];
      if (!prev || prev.sep || prev.header) continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  let n = 0;
  for (const it of out) if (it.sep) it.id = `sep-${++n}`;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Menu model (pure)
// target = { type: 'project'|'session'|'agent'|'roster', id }
// data   = { projects, sessions, agents, roster } (the store, or plain objects in a test)
// mode   = 'off' | 'dry' | 'live'
// Returns the header first ({ header:true, label, hint, badge?, note?, tip? }), then
//        [{ id, label, hint?, icon?, action?, payload?, flow?, copy?, open?, disabled?, danger?, sep? }]
// An item with `action` sends that server action (MENU_ACTIONS only). An item with `flow` ({ type, id }) sends
// nothing: it opens the drawer section of the skill flow (preview, try, install). Neither kind is made while off.
// ---------------------------------------------------------------------------------------------
export function menuModel(target, data, mode = 'off') {
  mode = MODES.has(mode) ? mode : 'off';
  const on = mode !== 'off';
  const tg = target || {};
  const d = data || {};
  if (tg.type === 'project') return projectMenu(tg.id, d, mode, on);
  if (tg.type === 'session') return sessionMenu(tg.id, d, mode, on);
  if (tg.type === 'agent') return agentMenu(tg.id, d, mode, on);
  if (tg.type === 'roster') return rosterMenu(tg.id, d, mode, on);
  return [header(t('shCmUnknown'), '', mode)];
}

// A project that gets the "Suggested skills" drawer section (and so the menu item that opens it): a listed project
// with an existing local folder, not broad, not only seen in a temp folder, not an old hub entry. The server refuses
// the others too (server/install.mjs resolveProject).
export function suggestable(p) {
  return !!p && !!p.path && p.exists !== false && !p.broad && !p.tmpOnly && p.kind !== 'hub';
}

function projectMenu(id, d, mode, on) {
  const p = get(d.projects, id);
  if (!p) return tidy([header(t('shCmProjectNotFound'), '', mode), { id: 'open', label: t('shCmOpenDetail'), icon: 'detail', open: { type: 'project', id } }]);
  const folderOk = !!p.path && p.exists !== false;
  const note = p.broad ? t('shCmBroad') : !folderOk ? t('shCmFolderMissing') : null;
  const items = [header(p.name, p.path || kindLabel(p.kind) || '', mode, note, !!p.path)];
  if (on && !p.broad && folderOk) {
    // "Start with <tool>" for each AI tool found (docs/ai-start.md), then the AI-agnostic plain terminal;
    // continuing a Claude Code session follows when the project has one
    items.push(...aiStartMenuItems({ projectId: p.id }, { name: p.name, projectId: p.id, hasIdea: !!p.idea }));
    items.push(...terminalItems({ projectId: p.id }, p.name, false));
    // The newest session the menu can continue (any tool that can), never hidden by a newer one of a tool that cannot
    const s = latestSession(d, p.id, canContinueTool);
    if (s && sessionActionable(s)) items.push(...[].concat(continueItem(s, 'project')));
    items.push(SEP());
    items.push({ id: 'explorer', label: t('shCmOpenFolder'), hint: t('shCmExplorer'), icon: 'folder', action: 'explorer', payload: { projectId: p.id } });
    items.push({ id: 'vscode', label: t('shCmVscode'), icon: 'code', action: 'vscode', payload: { projectId: p.id } });
    items.push(SEP());
    if (suggestable(p)) items.push({ id: 'skills', label: t('skMenuSuggest'), hint: t('skMenuSuggestHint'), icon: 'grid', flow: { type: 'project', id: p.id } });
  }
  items.push(SEP());
  if (p.path) items.push({ id: 'copy-path', label: t('shCopyPath'), icon: 'copy', copy: p.path });
  // Hide it from the lists, or show it again (this browser only; nothing on disk changes)
  const hidden = isHiddenProject(p.id);
  items.push({ id: hidden ? 'unhide' : 'hide', label: t(hidden ? 'prjUnhide' : 'prjHide'), hint: t('prjHideHint'), icon: 'list', hide: { id: p.id, hidden: !hidden } });
  items.push({ id: 'open', label: t('shCmOpenDetail'), icon: 'detail', open: { type: 'project', id: p.id } });
  return tidy(items);
}

function sessionMenu(id, d, mode, on) {
  const s = get(d.sessions, id);
  const tail = [SEP(), { id: 'copy-id', label: t('shCmCopyId'), icon: 'copy', copy: String(id) }, { id: 'open', label: t('shCmOpenDetail'), icon: 'detail', open: { type: 'session', id } }];
  if (!s) return tidy([header(t('shCmSession'), String(id).slice(0, 8), mode), ...tail]);
  const p = get(d.projects, s.projectId);
  const items = [header(clip(sessionTitle(s), 60), p?.name || '', mode, s.cwd ? null : t('shCmSessionNoFolder'))];
  if (on && sessionActionable(s)) {
    items.push(...[].concat(continueItem(s, 'session')));
    // "Start with <tool>" in the session's folder (docs/ai-start.md); the idea is the session's project's
    items.push(...aiStartMenuItems({ sessionId: s.id }, { name: p?.name || folderName(s.cwd), projectId: suggestable(p) ? p.id : null, hasIdea: !!p?.idea }));
    items.push(...terminalItems({ sessionId: s.id }, p?.name || folderName(s.cwd), true));
    items.push({ id: 'explorer', label: t('shCmOpenFolder'), hint: t('shCmExplorer'), icon: 'folder', action: 'explorer', payload: { sessionId: s.id } });
  }
  return tidy([...items, ...tail]);
}

function agentMenu(id, d, mode, on) {
  const a = get(d.agents, id);
  const open = { id: 'open', label: t('shCmOpenDetail'), icon: 'detail', open: { type: 'agent', id } };
  if (!a) return tidy([header(t('shCmAgent'), '', mode), open]);
  const p = get(d.projects, a.projectId);
  const s = get(d.sessions, a.sessionId);
  const items = [header(clip(a.label || a.type, 60), [a.type, p?.name].filter(Boolean).join(' · '), mode)];
  if (on && sessionActionable(s)) items.push(...[].concat(continueItem(s, 'agent')));
  items.push(SEP(), open);
  return tidy(items);
}

function rosterMenu(id, d, mode, on) {
  const r = values(d.roster).find((x) => x && x.id === id);
  const open = { id: 'open', label: t('shCmOpenDetail'), icon: 'detail', open: { type: 'roster', id } };
  if (!r) return tidy([header(t('shCmRosterItem'), '', mode), open]);
  const items = [header(r.name, [rosterKindLabel(r.kind), r.category].filter(Boolean).join(' · '), mode)];
  // Same rule as the drawer's "Install into a project" section: a library skill or agent the server accepts
  if (on && libraryInstallable(r)) {
    const n = (r.installedIn || []).length;
    items.push({ id: 'install-item', label: t('skMenuInstall'), hint: n ? t('skMenuInstallHintIn', { count: n }) : t('skMenuInstallHintLib'), icon: 'install', flow: { type: 'roster', id: r.id } });
  }
  items.push(SEP(), open);
  return tidy(items);
}

// Whether the "Install" button can open (pure): only after a successful preview that was made in the CURRENT mode
// and with the SAME selection. If the server goes from dry to live without a page reload, the old trial no longer
// counts (so installation never opens before a real -Try has run). Never in off mode.
// st: the flow state ({ preview: { ok, key, mode } }), key: the selection key, mode: 'off'|'dry'|'live'
export function previewValid(st, key, mode) {
  const p = st?.preview;
  if (!p || p.ok !== true) return false;
  if (mode !== 'dry' && mode !== 'live') return false;
  return p.mode === mode && p.key === key && typeof key === 'string' && key.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Skill flow (docs/skills-flow.md §5): suggested skills in the project drawer, install into a project in the
// roster drawer, import in the roster tab. Pure helpers (tested in node); requests go through runAction (actions.js).
// ---------------------------------------------------------------------------------------------
export const SKILL_TARGETS = Object.freeze(['claude', 'agents']);
export const MAX_SKILL_ITEMS = 25;
export const LIBRARY_CATEGORIES = Object.freeze(['web', 'mobile', 'desktop', 'game', 'data', 'ai', 'devops', 'testing', 'security', 'design', 'docs', 'general']);
// The server's item name pattern (a trailing dot is refused there too)
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENTS_TOOLS = ['codex', 'gemini-cli', 'antigravity'];

// Default targets from a project's tools (the server applies the same rule when no target is sent)
export function skillTargets(via) {
  const v = new Set(Array.isArray(via) ? via : []);
  const agents = AGENTS_TOOLS.some((x) => v.has(x));
  const out = [];
  if (v.has('claude-code') || !agents) out.push('claude');
  if (agents) out.push('agents');
  return out;
}

// A library skill or agent whose name the server accepts
export function libraryInstallable(r) {
  const name = String(r?.name ?? '');
  return isLibraryItem(r) && (r.kind === 'skill' || r.kind === 'agent') && SKILL_NAME_RE.test(name) && !name.endsWith('.');
}

export const skillKey = (it) => `${it.kind}:${it.name}`;

// Same project, items and targets give the same key, whatever the order
export function selectionKey(projectId, items, targets) {
  return [String(projectId ?? ''), [...(items || [])].map(skillKey).sort().join(','), [...(targets || [])].sort().join(',')].join('|');
}

// Text of an id, or the fallback when the table has none
function tOr(key, fallback) {
  const v = t(key);
  return v === key ? fallback : v;
}

export const categoryLabel = (c) => tOr(`skCat_${c}`, String(c ?? ''));
// A skip reason; an error code in a plan (library-adopt names why an item could not be taken) reads as its error text
export const reasonText = (code) => tOr(`skReason_${code}`, tOr(`skErr_${code}`, String(code ?? '')));

// Short reason of a suggestion: "package.json: react", "registry package: web"
export function suggestReasonText(reason) {
  if (!reason || typeof reason !== 'object') return '';
  return t('skSuggestReason', { from: reason.from === 'registry' ? t('skFromRegistry') : String(reason.from ?? ''), signal: String(reason.signal ?? '') });
}

// First suggestions not installed yet (at most 5) are selected when the list first arrives
export function defaultSuggestSelection(items, max = 5) {
  return new Set((items || []).filter((it) => !it.installed).slice(0, max).map(skillKey));
}

function whyFlow(installEnabled, st, key, mode) {
  if (installEnabled) return t('skWhyReady');
  const p = st?.preview;
  if (p?.ok && p.key === key && p.mode !== mode) return t('skWhyMode');
  return t('skWhyPreview');
}

// "Suggested skills" section state (pure). data: the suggestions answer; st: { sel: Set of item keys, targets: Set,
// busy, preview }. Install opens only after a successful preview in the same mode with the same selection.
export function suggestFlowView(p, data, st, mode) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const sel = items.filter((it) => st?.sel?.has(skillKey(it)));
  const targets = SKILL_TARGETS.filter((x) => st?.targets?.has(x));
  const key = selectionKey(p?.id, sel, targets);
  const busy = !!st?.busy;
  const tooMany = sel.length > MAX_SKILL_ITEMS;
  const needTargets = sel.some((it) => it.kind === 'skill') && !targets.length;
  const blocked = busy || !sel.length || tooMany || needTargets;
  const installEnabled = !blocked && previewValid(st, key, mode);
  const why = !sel.length ? t('skWhySelect') : tooMany ? t('skWhyTooMany', { max: MAX_SKILL_ITEMS }) : needTargets ? t('skWhyTargets') : whyFlow(installEnabled, st, key, mode);
  return { items, sel, targets, key, busy, previewDisabled: blocked, tryDisabled: busy || !sel.length || tooMany, installEnabled, why };
}

// Projects a library item can be installed into (pure): suggestable ones (see suggestable), registered projects
// first, then the folders found in the tools' records, each group by name.
export function installTargets(projects) {
  const rank = (p) => (p.kind === 'registered' ? 0 : 1);
  return values(projects)
    .filter(suggestable)
    .sort((a, b) => rank(a) - rank(b) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'tr'));
}

// "Install into a project" section of a library item (pure). projects: the projects it can go into; st: { proj,
// targets: Set, busy, preview }. No project is chosen for the user: until st.proj names a listed project, proj is
// null and Preview and Install stay disabled. An agent always goes to .claude.
export function itemInstallView(r, projects, st, mode) {
  const list = values(projects);
  const installed = new Set(r?.installedIn || []);
  const proj = st?.proj && list.some((p) => p.id === st.proj) ? st.proj : null;
  const project = list.find((p) => p.id === proj) || null;
  const targets = r?.kind === 'agent' ? ['claude'] : SKILL_TARGETS.filter((x) => st?.targets?.has(x));
  const key = selectionKey(proj, r ? [r] : [], targets);
  const busy = !!st?.busy;
  const blocked = busy || !proj || !targets.length;
  const installEnabled = !blocked && previewValid(st, key, mode);
  const here = !!proj && installed.has(proj);
  const why = !list.length ? t('skNoProjects') : !proj ? t('skWhyPickProject') : !targets.length ? t('skWhyTargets') : whyFlow(installEnabled, st, key, mode);
  return { proj, project, installed, here, targets, key, busy, previewDisabled: blocked, installEnabled, removeEnabled: !blocked && here, why };
}

// Plan entries as rows with localized words (pure)
export function planRows(plan) {
  return (Array.isArray(plan) ? plan : []).map((e) => ({
    op: String(e?.op ?? ''),
    opText: tOr(`skOp_${e?.op}`, String(e?.op ?? '')),
    kind: String(e?.kind ?? ''),
    kindText: tOr(`skKind_${e?.kind}`, String(e?.kind ?? '')),
    name: String(e?.name ?? ''),
    target: e?.target ? tOr(`skTarget_${e.target}`, String(e.target)) : '',
    category: e?.category ? categoryLabel(e.category) : '',
    reason: String(e?.reason ?? ''),
    reasonText: reasonText(e?.reason),
    path: typeof e?.path === 'string' ? e.path : '',
  }));
}

// Error of a skill action as text (the server sends English codes)
export function skillErrorText(r) {
  if (!r) return t('skErr_internal');
  if (r.modeChanged) return t('skErr_mode-changed');
  if (r.busy) return t('skErr_in-flight');
  const e = String(r.error || '').trim();
  if (e === 'actions-off') return t('actionsOffError');
  if (r.status === 429) return t('skErr_repeat');
  if (r.status === 403) return t('skErr_rejected');
  if (['unexpected-field', 'missing-field', 'bad-field', 'bad-project-id', 'unknown-action'].includes(e)) return t('skErr_malformed');
  if (!e || e === 'bad-response') return t('skErr_unknown', { code: String(r.status ?? '?') });
  return tOr(`skErr_${e}`, t('skErr_unknown', { code: e }));
}

// Import picks in batches that fit the server's body limit (4096 bytes) and item limit
export function importBatches(source, picks, { maxItems = MAX_SKILL_ITEMS, maxBytes = 3800 } = {}) {
  const out = [];
  let cur = [];
  const size = (items) => new TextEncoder().encode(JSON.stringify({ action: 'library-import', source, items })).length;
  for (const p of picks || []) {
    if (cur.length && (cur.length >= maxItems || size([...cur, p]) > maxBytes)) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Fit the menu box on screen: if it overflows right or bottom, flip it to the other side of the pointer; if it
// still does not fit, push it against the edge. If the height exceeds the screen, maxHeight is returned (the list
// scrolls inside itself).
export function fitMenu(x, y, w, h, vw, vh, margin = 8) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let left = x;
  let top = y;
  if (left + w > vw - margin) left = x - w;
  if (top + h > vh - margin) top = y - h;
  left = clamp(left, margin, Math.max(margin, vw - margin - w));
  top = clamp(top, margin, Math.max(margin, vh - margin - h));
  const maxHeight = h > vh - margin * 2 ? vh - margin * 2 : null;
  return { left: Math.round(left), top: Math.round(top), maxHeight };
}

// Arrow keys, Home/End: wrapping navigation
export function nextIndex(count, cur, key) {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return cur < 0 ? 0 : (cur + 1) % count;
  if (key === 'ArrowUp') return cur < 0 ? count - 1 : (cur - 1 + count) % count;
  return cur;
}

// Turn an action result into a short notice (pure). In dry mode the command summary is shown.
// Actions that have a "done" title of their own (string ids shDone_<action>)
const DONE = new Set(['resume', 'fork', 'new', 'explorer', 'vscode', 'skills-preview', 'skills-install']);
// item: the menu item that sent the action ({ action, name }); a failed reply does not name its action.
export function resultToast(label, r, item = null) {
  const res = r || {};
  if ((res.action || item?.action) === 'terminal') return terminalToast(label, res, String(item?.name || ''));
  // start-ai (docs/ai-start.md): its own notice and error texts (aiErr_*), the general ones as the fallback
  if ((res.action || item?.action) === 'start-ai') return aiStartToast(res, item, errorText);
  if (res.ok) {
    if (res.mode === 'dry') return { tone: 'dry', title: t('shToastDryTitle', { label }), body: t('shToastDryBody'), code: argvSummary(res.argv) || '—' };
    // "Open in browser" runs the explorer action on the project's index.html: the page opens, not the folder (seen when
    // using the app, 2026-10-08: it said "Opening the folder in Explorer")
    const page = res.action === 'explorer' && item?.payload?.open === 'index.html';
    return { tone: 'ok', title: page ? t('shDone_openPage') : DONE.has(res.action) ? t(`shDone_${res.action}`) : label, body: res.sessionId ? t('shToastSession', { id: String(res.sessionId).slice(0, 8) }) : '' };
  }
  return { tone: 'err', title: t('shToastFail', { label }), body: errorText(res) };
}

// Result notice of "Open terminal" (pure): which terminal opened, and what to do next
function terminalToast(label, res, name) {
  if (res.ok && res.mode === 'dry') return { tone: 'dry', title: t('termDryTitle', { label }), body: t('termDryBody'), code: argvSummary(res.argv) || '—' };
  if (res.ok) {
    const fallback = res.terminal === 'powershell';
    const body = fallback ? tOr(`termToastFallback_${res.fallbackReason}`, t('termToastFallback_terminal-failed')) : t('termToastNext');
    return { tone: 'ok', title: name ? t('termToastOpened', { name }) : t('termToastOpenedPlain'), body };
  }
  return { tone: 'err', title: name ? t('termFailTitle', { name }) : t('termFailTitlePlain'), body: errorText(res) };
}

// Error text and what can be done about it (the server sends English codes)
export function errorText(r) {
  const e = String(r?.error || '').trim();
  if (r?.modeChanged) return t('shErrModeChanged');
  if (r?.hint === 'fork') return t('termErrOpenFork', { label: t('termFork') });
  // English error codes of the terminal action (server/actions.mjs openTerminal)
  if (/^[a-z][a-z-]*$/.test(e)) {
    const code = tOr(`termErr_${e}`, '');
    if (code) return code;
  }
  if (e === 'actions-off') return t('actionsOffError');
  // The other error codes of the action layer (server/actions.mjs, server/app.mjs)
  if (/^[a-z][a-z-]*$/.test(e)) {
    const text = tOr(`err_${e}`, '');
    if (text) return text;
  }
  if (r?.busy) return t('shErrBusy');
  if (r?.status === 429) return t('shErrRepeat');
  if (r?.status === 409 && /lock/i.test(e)) return t('shErrLock');
  if (r?.status === 501) return t('shErrProgramMissing');
  if (r?.status === 403) return t('shErrRejected');
  // Local error codes of runAction (actions.js)
  if (e === 'network') return t('skErr_network');
  if (e === 'unknown-action') return t('skErr_malformed');
  if (e === 'bad-response') return t('skErr_unknown', { code: String(r?.status ?? '?') });
  return e ? t('shErrUnknown', { code: e }) : t('shErrUnknownPlain');
}

// ---------------------------------------------------------------------------------------------
// The DOM menu
// ---------------------------------------------------------------------------------------------

// A few icons of the menu's own (the ones the shared set lacks); the rest come from icons.js
const LOCAL_ICONS = {
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M13 15h4"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v1.5a3 3 0 003 3h6a3 3 0 003-3V7M12 11.5V17"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  code: '<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>',
  detail: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M14 4v16M16.5 8.5h1.5M16.5 12h1.5"/>',
  install: '<path d="M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14"/>',
};
function mIcon(name) {
  if (LOCAL_ICONS[name]) return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOCAL_ICONS[name]}</svg>`;
  return icon(name || 'spark');
}

export function focusKeyOf(el) {
  for (const a of ['data-session', 'data-agent', 'data-roster', 'data-project']) if (el?.hasAttribute?.(a)) return [a, el.getAttribute(a)];
  return null;
}

// Whether it can take focus and is visible (not in a closed/inert drawer, not hidden)
export function focusableVisible(el) {
  return !!(el && el.isConnected && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert],[hidden],[aria-hidden="true"]'));
}

// The trigger's container: the fallback search runs inside it first (so that, instead of a drawer row, the same
// session row of a card behind the scrim is not picked)
const SCOPES = '#drawer, .rail, .panels, .topbar, .stage-wrap';
export function focusScopeOf(el) {
  return el?.closest?.(SCOPES) || null;
}
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]';

// The visible, focusable element that carries the same data attribute in place of a redrawn trigger.
// First inside the container and with the same tag name; with no container and an open drawer, only in the drawer.
// If none is found, the container's first focusable element.
export function findFocusTarget(key, tag, scope = null) {
  const live = scope && scope.isConnected && focusableScope(scope) ? scope : null;
  const openDrawer = document.querySelector('.drawer.open:not([inert])');
  if (key) {
    let pool = [...document.querySelectorAll(`[${key[0]}="${CSS.escape(key[1])}"]`)].filter(focusableVisible);
    if (live) pool = pool.filter((e) => live.contains(e));
    else if (openDrawer) pool = pool.filter((e) => openDrawer.contains(e));
    const hit = pool.find((e) => e.tagName === tag) || pool[0];
    if (hit) return hit;
  }
  if (live) return [...live.querySelectorAll(FOCUSABLE)].find(focusableVisible) || null;
  return null;
}
function focusableScope(el) {
  return !el.closest('[inert],[hidden]');
}

// What a menu item does: copy, open details, the skill flow, or a server action.
// ctx = { openDrawer, openSkills, toast }. A flow item opens its drawer section (openSkills maps a project to
// "Suggested skills" and a roster item to "Install into a project") and sends nothing.
export async function runMenuItem(it, { openDrawer, openSkills, toast } = {}) {
  if (!it || it.disabled || it.sep || it.header) return;
  if (it.copy != null) return copyText(it.copy, it.id === 'copy-id' ? t('shCmCopiedId') : t('shCmCopiedPath'), toast);
  if (it.hide) {
    setProjectHidden(it.hide.id, it.hide.hidden);
    toast?.({ tone: 'ok', title: t(it.hide.hidden ? 'prjHidden' : 'prjShown'), body: it.hide.hidden ? t('prjHiddenBody') : '' });
    return;
  }
  if (it.open) return openDrawer?.(it.open);
  if (it.flow) return openSkills?.({ type: it.flow.type, id: it.flow.id });
  if (it.dock) return dockOpen?.(it.dock);
  if (it.action) {
    // Start with AI in the dock when there is one (the owner's decision, docs/embedded-terminal.md §5): the server
    // writes the launcher and answers a one-time id, which the dock redeems through the shell
    // (a full dock: Windows Terminal, so no launcher waits for a terminal that cannot open)
    const inDock = it.action === 'start-ai' && !!dockOpen && !dockFull?.();
    const r = await runAction({ action: it.action, ...it.payload, ...(inDock ? { inDock: true } : {}) });
    if (inDock && r?.ok && r.terminal === 'dock' && typeof r.launchId === 'string') await dockOpen({ launchId: r.launchId });
    toast?.(resultToast(it.label, r, it));
    // A tool started in a project: the drawer asks again for its restore points and changes
    if (it.action === 'start-ai' && r?.ok && it.payload?.projectId) {
      // with what the start's restore point holds (the job box says it next to the job, restore.js startPointText)
      globalThis.dispatchEvent?.(new CustomEvent(AI_STARTED_EVENT, { detail: { projectId: it.payload.projectId, restorePoint: r.restorePoint || null, jobId: r.jobId || null } }));
    }
    return r;
  }
}

async function copyText(text, title, toast) {
  try {
    await navigator.clipboard.writeText(text);
    toast?.({ tone: 'ok', title, code: text });
  } catch {
    toast?.({ tone: 'err', title: t('shCmCopyFailed'), body: t('shCmCopyFailedBody') });
  }
}

// { openDrawer(target), openSkills(target), toast({tone,title,body,code}), getData() → store, qa }
export function createContextMenu({ openDrawer, openSkills, toast, getData, qa = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-menu';
  wrap.hidden = true;
  wrap.innerHTML = `<div class="cm-head" id="cmHead"></div><div class="cm-list" role="menu" id="cmList" aria-labelledby="cmHead" tabindex="-1"></div>`;
  document.body.appendChild(wrap);
  const headEl = wrap.querySelector('.cm-head');
  const list = wrap.querySelector('.cm-list');
  let model = [];
  let target = null;
  let returnFocus = null;
  let returnKey = null; // if the trigger is redrawn, it is found again by the same data attribute
  let returnTag = null;
  let returnScope = null;

  const buttons = () => [...list.querySelectorAll('[role=menuitem]')];
  const enabled = (b) => b && b.getAttribute('aria-disabled') !== 'true';

  function render() {
    const h = model[0]?.header ? model[0] : null;
    headEl.innerHTML = h
      ? `<span class="cm-title"><b>${esc(h.label)}</b>${h.badge ? `<span class="cm-badge">${esc(h.badge)}</span>` : ''}</span>${h.hint ? `<span class="cm-sub${h.pathHint ? ' mono' : ''}" translate="no" title="${esc(h.hint)}">${esc(h.hint)}</span>` : ''}${h.note ? `<span class="cm-note">${esc(h.note)}</span>` : ''}${h.tip ? `<span class="cm-tip">${esc(h.tip)}</span>` : ''}`
      : '';
    list.innerHTML = model
      .filter((x) => !x.header)
      .map((it, i) =>
        it.sep
          ? '<div role="separator" class="cm-sep"></div>'
          : `<button type="button" role="menuitem" tabindex="-1" class="cm-item${it.danger ? ' danger' : ''}" data-id="${esc(it.id)}" aria-labelledby="cmL${i}"${it.hint ? ` aria-describedby="cmH${i}"` : ''}${it.disabled ? ' aria-disabled="true"' : ''}>${mIcon(it.icon)}<span class="cm-label" id="cmL${i}">${esc(it.label)}</span>${it.hint ? `<span class="cm-hint" id="cmH${i}">${esc(it.hint)}</span>` : ''}</button>`,
      )
      .join('');
  }

  function place(x, y) {
    wrap.style.left = '0px';
    wrap.style.top = '0px';
    wrap.style.maxHeight = '';
    // offset* sizes: unaffected by the scale() transform of the opening animation (a rect would measure smaller)
    const pos = fitMenu(x, y, wrap.offsetWidth, wrap.offsetHeight, window.innerWidth, window.innerHeight);
    wrap.style.left = pos.left + 'px';
    wrap.style.top = pos.top + 'px';
    if (pos.maxHeight) wrap.style.maxHeight = pos.maxHeight + 'px';
  }

  function openAt(x, y, t, anchorEl) {
    if (!wrap.hidden) close(false);
    target = t;
    // A project or session menu is the first need of the AI tools (docs/ai-start.md): asked for once, in the background
    if (t?.type === 'project' || t?.type === 'session') needTools();
    model = menuModel(t, getData ? getData() : {}, actionsState().mode);
    returnFocus = anchorEl || (document.activeElement !== document.body ? document.activeElement : null);
    returnKey = focusKeyOf(returnFocus);
    returnTag = returnFocus?.tagName || null;
    returnScope = focusScopeOf(returnFocus);
    render();
    wrap.hidden = false;
    document.body.classList.add('cm-open');
    place(x, y);
    const first = buttons().find(enabled) || buttons()[0];
    (first || list).focus({ preventScroll: true });
    document.addEventListener('pointerdown', onOutside, true);
    if (!qa) {
      // In QA, headless Chrome re-lays out at capture time: keep the menu open
      window.addEventListener('resize', onDismiss);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('blur', onDismiss);
    }
  }

  function close(restore = true) {
    if (wrap.hidden) return;
    wrap.hidden = true;
    document.body.classList.remove('cm-open');
    list.innerHTML = '';
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', onDismiss);
    let back = returnFocus;
    const key = returnKey;
    const tag = returnTag;
    const scope = returnScope;
    returnFocus = null;
    returnKey = null;
    returnTag = null;
    returnScope = null;
    target = null;
    if (!restore) return;
    if (!focusableVisible(back)) back = findFocusTarget(key, tag, scope);
    if (back) back.focus({ preventScroll: true });
  }

  function onOutside(e) {
    if (!wrap.contains(e.target)) close(false);
  }
  function onDismiss() {
    close(wrap.contains(document.activeElement));
  }
  function onScroll(e) {
    if (!wrap.contains(e.target)) close(wrap.contains(document.activeElement));
  }

  async function activate(btn) {
    const it = model.find((x) => x.id === btn?.dataset.id);
    if (!it || it.disabled || it.sep || it.header) return;
    const t = target;
    close(true);
    return runMenuItem(it, { target: t, openDrawer, openSkills, toast });
  }

  // First-letter jump (by the labels of the menu buttons)
  function typeahead(ch) {
    const btns = buttons();
    if (!btns.length) return;
    const cur = btns.indexOf(document.activeElement);
    const c = ch.toLocaleLowerCase(loc());
    for (let k = 1; k <= btns.length; k++) {
      const b = btns[(cur + k) % btns.length];
      if (b.querySelector('.cm-label')?.textContent.trim().toLocaleLowerCase(loc()).startsWith(c)) return b.focus();
    }
  }

  wrap.addEventListener('keydown', (e) => {
    const btns = buttons();
    const cur = btns.indexOf(document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        e.preventDefault();
        btns[nextIndex(btns.length, cur, e.key)]?.focus();
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        close(true);
        break;
      case 'F10':
      case 'ContextMenu':
        // The menu is already open: do not reopen it
        e.preventDefault();
        break;
      case 'Enter':
      case ' ':
        // The button's own activation (click) runs; it just must not leak to the page shortcuts
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) typeahead(e.key);
    }
    // While the menu is open the page shortcuts (1–4, R, space…) must not run
    e.stopPropagation();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[role=menuitem]');
    if (b) activate(b);
  });
  // The item under the mouse takes focus: keyboard and mouse share the same highlight
  list.addEventListener('pointermove', (e) => {
    const b = e.target.closest('[role=menuitem]');
    if (b && document.activeElement !== b) b.focus({ preventScroll: true });
  });
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());

  // Activate by id (a QA hook and for tests; the menu must be open)
  function activateById(id) {
    const b = list.querySelector(`[role=menuitem][data-id="${CSS.escape(id)}"]`);
    if (b) activate(b);
  }

  return { openAt, close, activateById, isOpen: () => !wrap.hidden, element: wrap };
}
