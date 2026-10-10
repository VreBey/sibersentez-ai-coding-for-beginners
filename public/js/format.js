// @ts-check
// Formatting, colors and labels (the UI's shared vocabulary). Labels come from the i18n tables (strings/common.js).
import { t, language } from './i18n.js';

// A table entry whose label `l` is looked up on every read, so a language change shows without rebuilding the table
const labelled = (key, props) => Object.defineProperty({ ...props }, 'l', { get: () => t(key), enumerable: true });

// Locale of number and date formatting follows the page language
export const locale = () => (language() === 'tr' ? 'tr-TR' : 'en-US');

export const CAT = {
  read: labelled('fmtCat_read', { c: '#5cb8ff' }),
  write: labelled('fmtCat_write', { c: '#ffb454' }),
  shell: labelled('fmtCat_shell', { c: '#5ee39a' }),
  web: labelled('fmtCat_web', { c: '#c08bff' }),
  agent: labelled('fmtCat_agent', { c: '#ff7ab6' }),
  skill: labelled('fmtCat_skill', { c: '#ffd66b' }),
  workflow: labelled('fmtCat_workflow', { c: '#3fe0cc' }),
  mcp: labelled('fmtCat_mcp', { c: '#8fa3bf' }),
  other: labelled('fmtCat_other', { c: '#8a93a6' }),
};

const PROJECT_PALETTE = ['#7c9cff', '#ff7ab6', '#3fe0cc', '#ffb454', '#c08bff', '#5ee39a', '#ff8a65', '#5cb8ff', '#e6d06b', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#38bdf8'];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const colorCache = new Map();
export function projectColor(id) {
  if (!id) return '#8a93a6';
  let c = colorCache.get(id);
  if (!c) colorCache.set(id, (c = PROJECT_PALETTE[hash(id) % PROJECT_PALETTE.length]));
  return c;
}

const AGENT_COLORS = {
  'general-purpose': '#a78bfa',
  Explore: '#5cb8ff',
  Plan: '#7c9cff',
  'web-fetch': '#c08bff',
  fork: '#ffb454',
  'workflow-subagent': '#3fe0cc',
  'claude-code-guide': '#8fa3bf',
  claude: '#a78bfa',
};
export function agentColor(type) {
  if (!type) return '#a78bfa';
  if (AGENT_COLORS[type]) return AGENT_COLORS[type];
  if (/denet|review|qa|critic|verify|audit/i.test(type)) return '#ff8a65';
  return projectColor('agent:' + type);
}

export const STATUS = {
  busy: labelled('fmtSt_busy', { c: '#5ee39a' }),
  idle: labelled('fmtSt_idle', { c: '#ffcf6b' }),
  closed: labelled('fmtSt_closed', { c: '#5b6477' }),
  // A session of a tool whose live state the app does not read (attention.js liveKnown)
  unknown: labelled('fmtSt_unknown', { c: '#5b6477' }),
  running: labelled('fmtSt_running', { c: '#7c9cff' }),
  done: labelled('fmtSt_done', { c: '#5ee39a' }),
  stopped: labelled('fmtSt_stopped', { c: '#ff7a7a' }),
  completed: labelled('fmtSt_completed', { c: '#5ee39a' }),
  failed: labelled('fmtSt_failed', { c: '#ff7a7a' }),
  cancelled: labelled('fmtSt_cancelled', { c: '#8a93a6' }),
};

export const KIND = {
  prompt: labelled('fmtKind_prompt', { c: '#e8ebf2', i: 'prompt' }),
  command: labelled('fmtKind_command', { c: '#9fb4ff', i: 'command' }),
  agent_start: labelled('fmtKind_agent_start', { c: '#ff7ab6', i: 'agent' }),
  agent_done: labelled('fmtKind_agent_done', { c: '#5ee39a', i: 'check' }),
  skill: labelled('fmtKind_skill', { c: '#ffd66b', i: 'skill' }),
  workflow_start: labelled('fmtKind_workflow_start', { c: '#3fe0cc', i: 'workflow' }),
  workflow_done: labelled('fmtKind_workflow_done', { c: '#3fe0cc', i: 'check' }),
  commit: labelled('fmtKind_commit', { c: '#ffb454', i: 'commit' }),
  live: labelled('fmtKind_live', { c: '#8a93a6', i: 'pulse' }),
  compact: labelled('fmtKind_compact', { c: '#8a93a6', i: 'compress' }),
  title: labelled('fmtKind_title', { c: '#8a93a6', i: 'title' }),
};

// Source labels live in one table (rosterModel.js); re-exported so existing imports keep working
export { SOURCE, sourceLabel } from './rosterModel.js';

// 'hub': the fixed hub project older servers added (current servers do not)
const PROJECT_KIND = {
  get hub() {
    return t('fmtProj_hub');
  },
  get registered() {
    return t('fmtProj_registered');
  },
  get adhoc() {
    return t('fmtProj_adhoc');
  },
};

// A project's kind as the person reads it: a folder they added through "New project" (via 'sibersentez', found by no tool
// before) says "Added by you", not "Found automatically" (the first test drive's card)
export function projectKindText(p) {
  if (p?.kind === 'adhoc' && Array.isArray(p.via) && p.via.includes('sibersentez')) return PROJECT_KIND.registered;
  return PROJECT_KIND[p?.kind] || '';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const nfs = new Map();
export function num(n) {
  const loc = locale();
  if (!nfs.has(loc)) nfs.set(loc, new Intl.NumberFormat(loc));
  return nfs.get(loc).format(Math.round(n || 0));
}

export function tok(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toLocaleString(locale(), { maximumFractionDigits: n >= 1e7 ? 1 : 2 }) + ' M';
  if (n >= 1e4) return Math.round(n / 1e3).toLocaleString(locale()) + ' ' + t('fmtThousand');
  return num(n);
}

export function ago(time, now = Date.now()) {
  if (!time) return '—';
  const s = Math.max(0, (now - time) / 1000);
  if (s < 10) return t('fmtAgoNow');
  if (s < 60) return t('fmtAgoSec', { n: Math.floor(s) });
  if (s < 3600) return t('fmtAgoMin', { n: Math.floor(s / 60) });
  if (s < 86400) return t('fmtAgoHour', { n: Math.floor(s / 3600) });
  const d = Math.floor(s / 86400);
  return d === 1 ? t('fmtYesterday') : t('fmtAgoDays', { n: d });
}

// The "what is it doing now" line: a tool name becomes a short verb (string ids)
const ACTION_VERB = {
  Read: 'fmtVerb_read',
  Edit: 'fmtVerb_edit',
  MultiEdit: 'fmtVerb_edit',
  Write: 'fmtVerb_write',
  NotebookEdit: 'fmtVerb_edit',
  Bash: 'fmtVerb_shell',
  PowerShell: 'fmtVerb_shell',
  Grep: 'fmtVerb_grep',
  Glob: 'fmtVerb_glob',
  WebFetch: 'fmtVerb_webFetch',
  WebSearch: 'fmtVerb_webSearch',
  Agent: 'fmtVerb_agent',
  Task: 'fmtVerb_agent',
  SendMessage: 'fmtVerb_message',
  Skill: 'fmtVerb_skill',
  Workflow: 'fmtVerb_workflow',
  ToolSearch: 'fmtVerb_toolSearch',
};
function actionVerb(a) {
  if (!a) return '';
  return ACTION_VERB[a.tool] ? t(ACTION_VERB[a.tool]) : String(a.tool).startsWith('mcp__') ? 'MCP' : a.tool;
}
// Plain text (for the canvas)
export function actionPlain(a) {
  if (!a) return '';
  return a.text ? `${actionVerb(a)} · ${a.text}` : actionVerb(a);
}
// HTML (escaped)
export function actionLine(a) {
  if (!a) return '';
  return `<b>${esc(actionVerb(a))}</b>${a.text ? ' ' + esc(a.text) : ''}`;
}

// Suggested registry id: fold Turkish letters, lower case, hyphenated
export function trSlug(s) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };
  return String(s || '')
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => map[c])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Replaces an element's content after cancelling the CSS animations inside it. A removed row whose animation was
// still running (the rows' entry, the busy dots' endless ping) stayed in the document's animation timeline, and with
// it the whole old row: a soak test grew by tens of thousands of detached nodes in minutes. Lists that redraw use this.
export function replaceHtml(el, html) {
  for (const a of el.getAnimations?.({ subtree: true }) || []) a.cancel();
  el.innerHTML = html;
}

// Relative times are written into the HTML as an empty <time data-ago="…"> and filled in here: so even
// though "12 s ago" changes every second, the content comparison (setHtml) does not rewrite the DOM
export function agoTag(t, tag = 'time') {
  return `<${tag} data-ago="${Number(t) || 0}"></${tag}>`;
}
export function fillAgo(root = document) {
  const now = Date.now();
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-ago]'))) {
    const text = ago(Number(el.dataset.ago), now);
    if (el.textContent !== text) el.textContent = text;
  }
}

export function clock(t) {
  return t ? new Date(t).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '—';
}

export function dayTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  if (d.toDateString() === y.toDateString()) return t('fmtYesterdayAt', { time });
  return `${d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} ${time}`;
}

export function dur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} ${t('fmtUnitSec')}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${t('fmtUnitMin')} ${s % 60 ? (s % 60) + ' ' + t('fmtUnitSec') : ''}`.trim();
  const h = Math.floor(m / 60);
  return `${h} ${t('fmtUnitHour')} ${m % 60 ? (m % 60) + ' ' + t('fmtUnitMin') : ''}`.trim();
}

export function modelName(m) {
  if (!m) return '—';
  const x = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(m);
  if (!x) return esc(m); // it goes into HTML, so the raw value is escaped
  const fam = x[1][0].toUpperCase() + x[1].slice(1);
  const ver = x[3] && x[3].length <= 2 ? `${x[2]}.${x[3]}` : x[2];
  return `${fam} ${ver}`;
}

export function initials(name) {
  const w = String(name || '?')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toLocaleUpperCase(locale());
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Fixed texts the server writes into data in English (docs/tool-view.md is unrelated; see the language pass): shown in
// the page's language. A live event is told from its meta (status, prev); "Waiting for you: <what>" keeps its <what>.
export function eventText(e) {
  if (e?.kind === 'compact') return t('evCompacted');
  if (e?.kind === 'live' && e.meta && typeof e.meta.status === 'string') {
    const st = e.meta.status;
    if (st === 'closed') return t('evSessionClosed');
    if (!e.meta.prev) return t('evSessionOpen');
    if (st === 'busy') return t('evWorking');
    if (st === 'waiting') {
      const m = /^Waiting for you: ([\s\S]*)$/.exec(String(e.text || ''));
      return m ? t('evWaitingFor', { what: waitPhrase(m[1]) }) : t('evWaiting');
    }
    return t('evTurnDone');
  }
  return String(e?.text ?? '');
}

// A project's description; the two fixed notes the server writes for a project found in tool records or added in
// SiberSentez (server/catalog.mjs) are shown in the page's language, anything else as it is
export function projectDescription(desc) {
  const s = String(desc || '');
  if (s === 'Not in the registry; found in AI tool records.') return t('evProjectFound');
  if (s === 'Added in SiberSentez as a new project.') return t('evProjectAdded');
  if (s === 'Only seen in temporary (scratchpad) folders; the real folder is not known yet.') return t('evProjectScratch');
  return s;
}

// The description a card or a drawer shows: the catalog's two standing notes ("found in AI tool records", "added in
// SiberSentez") say what the kind line above them already says (Found automatically / Yours), so they are not
// repeated (2026-10-02); any other description, the temporary-folder note included, is shown as projectDescription has it
export function shownDescription(desc) {
  const s = String(desc || '');
  if (s === 'Not in the registry; found in AI tool records.' || s === 'Added in SiberSentez as a new project.') return '';
  return projectDescription(s);
}

// An SiberSentez kit item is described by its short summary in the page's language (strings/kit.js); the SKILL.md
// description is written for the AI. fromKit: the description shown is the kit's copy. Other items as they are.
export function kitSummary(kind, name, desc, fromKit) {
  if (!fromKit) return desc;
  const key = `kitSum_${kind}_${name}`;
  const s = t(key);
  return s && s !== key ? s : desc;
}

// The English descriptions of Claude Code's built-in agent types (server/adapters/claude-code.mjs BUILTIN_AGENTS) ->
// their key in strings/events.js; test/i18n-server.test.mjs keeps the two lists equal
export const BUILTIN_AGENT_KEYS = Object.freeze({
  'General-purpose agent: research, search, multi-step work.': 'general-purpose',
  'Explore agent: read-only broad search, returns only the conclusion.': 'Explore',
  'Planning agent: implementation plan and architecture options.': 'Plan',
  'Web reading agent: fetches and summarizes pages.': 'web-fetch',
  "Fork: a copy that inherits the main session's context.": 'fork',
  'Workflow worker: one step of a multi-agent script.': 'workflow-subagent',
  'Claude Code guide: questions about features and settings.': 'claude-code-guide',
  'Status line setup.': 'statusline-setup',
  'General Claude agent.': 'claude',
});

// A roster item's description; an agent seen only in the logs carries "Last task: <text>"; a built-in agent's fixed
// description is shown in the page's language
export function itemDescription(desc) {
  const s = String(desc || '');
  if (Object.prototype.hasOwnProperty.call(BUILTIN_AGENT_KEYS, s)) return t(`evBuiltin_${BUILTIN_AGENT_KEYS[s]}`);
  const m = /^Last task: ([\s\S]*)$/.exec(s);
  return m ? t('evLastTask', { text: m[1] }) : s;
}

// Names to show for projects (pure): two folders with the same name (a project moved to another drive leaves its old
// folder behind) get where they are, "arena (D:\Work)" and "arena (C:\…\Desktop)". Returns Map id -> name.
export function projectNames(projects) {
  const count = new Map();
  for (const p of projects) count.set(p.name, (count.get(p.name) || 0) + 1);
  const where = (dir) => {
    const parts = String(dir || '').split(/[\\/]+/).filter(Boolean);
    parts.pop();
    if (!parts.length) return '';
    return parts.length <= 2 ? parts.join('\\') : `${parts[0]}\\…\\${parts[parts.length - 1]}`;
  };
  return new Map(
    projects.map((p) => {
      const w = count.get(p.name) > 1 ? where(p.path || p.dir) : '';
      return [p.id, w ? `${p.name} (${w})` : p.name];
    }),
  );
}

// Why a session waits, in the page's language (docs/attention.md): its plan or its question (the tool it called last:
// Claude Code's plan mode, a question with choices), else what Claude Code said ("dialog open", "input needed",
// "permission prompt" since 2.1.29x; known phrases translated, others as they are). '' when nothing is known.
const WAIT_PHRASES = Object.freeze({ 'dialog open': 'waitDialog', 'input needed': 'waitInput', 'permission prompt': 'waitPermission' });
export function waitPhrase(text) {
  const w = String(text || '').trim();
  const key = WAIT_PHRASES[w.toLowerCase()];
  return key ? t(key) : w;
}
export function waitWhat(s) {
  const tool = s?.lastAction?.tool;
  if (tool === 'ExitPlanMode') return t('waitPlan');
  if (tool === 'AskUserQuestion') return t('waitQuestion');
  return waitPhrase(s?.live?.waitingFor);
}
