// @ts-check
// The project drawer's "Skills for this project" section and the idea box (docs/auto-skills.md §4), moved out of
// views/drawer.js (docs/internal/module-split-plan.md D1). Builders of their arguments (the AI start part also
// reads the tools state); drawer.js wires them and re-exports what tests import from it.
import { esc, num, kitSummary } from '../format.js';
import { icon } from '../icons.js';
import { t, tOs } from '../i18n.js';
import { SKILL_TARGETS, skillErrorText, planRows, MAX_SKILL_ITEMS } from '../contextmenu.js';
import { toolsState, needTools, aiStartSectionHtml, ideaPref } from './tools.js';
import { argvSummary } from '../actions.js';

// The project idea: at most this many characters are sent (the server reads as many)
export const IDEA_MAX = 300;

// The idea as it is sent and stored: controls out, spaces collapsed, at most IDEA_MAX characters, trimmed
export function cleanIdea(text) {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, IDEA_MAX).join('').trim();
}

// Plan entries as a list: operation, name, kind and target, reason, destination
export function planList(plan) {
  const rows = planRows(plan);
  if (!rows.length) return '';
  return `<ul class="plan-list">${rows
    .map(
      (r) =>
        `<li class="plan-row op-${esc(r.op)}"><span class="plan-op">${esc(r.opText)}</span><span class="plan-name" translate="no">${esc(r.name)}</span><span class="plan-meta">${esc([r.kindText, r.target || r.category].filter(Boolean).join(' · '))}</span><span class="plan-why">${esc(r.reasonText)}</span>${r.path ? `<code class="plan-path" translate="no">${esc(r.path)}</code>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

// The fit section keeps the targets folded under "Advanced": they follow the project's tools by themselves. The fold
// opens by itself while none is chosen (the install button then waits for one).
function targetFold(st, busy) {
  const chosen = SKILL_TARGETS.filter((x) => st.targets?.has(x)).map((x) => t(`skTarget_${x}`));
  const open = st.folds?.where ?? !chosen.length;
  return `<details class="fit-fold fit-where" data-fit-fold="where"${open ? ' open' : ''}><summary>${esc(t('fitWhereAdv', { where: chosen.join(', ') || '—' }))}</summary>${targetPicker(st, busy)}</details>`;
}

// Where to install (skills): Claude Code's .claude and the shared .agents folder
export function targetPicker(st, busy) {
  return `<fieldset class="sk-targets"><legend>${esc(t('skTargets'))}</legend>${SKILL_TARGETS.map(
    (x) => `<label><input type="checkbox" data-flow-target="${x}" data-fk="flow-target:${x}"${st.targets?.has(x) ? ' checked' : ''}${busy ? ' disabled' : ''}><span>${esc(t(`skTarget_${x}`))}</span></label>`,
  ).join('')}</fieldset>`;
}

// ---------- Skills for this project (docs/auto-skills.md §4) ----------
// The project drawer's top section: the project's tags, the fit's candidates with the automatic selection checked
// and a localized reason under each, weak fits behind "show more", already active items and left-out items folded,
// one primary button (live: install the selected, after a confirmation; preview: show what would be installed) and
// Try. The pure helpers below are exported for test/fit-ui.test.mjs; every text goes through esc().

const FIT_BANDS = Object.freeze(['high', 'medium', 'low']);

// Text of an id, or the fallback when the table has none
function tOr(key, fallback) {
  const v = t(key);
  return v === key ? fallback : v;
}

const kindText = (kind) => t(`skKind_${kind === 'skill' || kind === 'agent' ? kind : 'unknown'}`);
// A candidate the user may select: installable and not in the project yet
const selectable = (c) => !!c && c.installable === true && !c.installed;

// Name of a tag (stack or topic) in the page language; an unknown tag shows its id
export function fitTagLabel(id) {
  return tOr(`fitTag_${id}`, String(id ?? ''));
}

// The words of an idea that named a tag, for "your idea mentions ...": a stack tag by its name (Unity, Next.js), a
// topic by the words as typed ("oyunu"); the tag's name when the idea list does not have it. idea: the fit's
// project.idea.tags ([{ id, type, word } | { id, type, via }]).
export function ideaWordOf(id, idea) {
  const x = (Array.isArray(idea) ? idea : []).find((g) => g && g.id === id);
  if (!x || x.type === 'stack' || typeof x.word !== 'string' || !x.word.trim()) return fitTagLabel(id);
  return x.word;
}

// One reason code of a candidate as text: stack:<tag>, topic:<tag>, idea:<tag>, idea-word:<word>,
// installed-in:<project id>, used-in:<project id>. nameOf(id) gives a project's name (the id when it is unknown); idea:
// the fit's idea tags. Any other code without an argument reads from its own string fitReason_<code> (e.g.
// fitReason_empty-folder, public/js/strings/kit.js); a code the page has no text for reads as a general line
// (fitReason_other). A raw code never reaches the screen.
const ARG_REASONS = new Set(['stack', 'topic', 'idea', 'idea-word', 'installed-in', 'used-in']);
export function fitReasonText(code, nameOf = (id) => id, idea = []) {
  const s = String(code ?? '');
  if (!s) return '';
  const i = s.indexOf(':');
  const kind = i > 0 ? s.slice(0, i) : s;
  const arg = i > 0 ? s.slice(i + 1) : '';
  if ((kind === 'stack' || kind === 'topic') && arg) return t(`fitReason_${kind}`, { tag: fitTagLabel(arg) });
  if (kind === 'idea' && arg) return t('startReasonIdea', { word: ideaWordOf(arg, idea) });
  if (kind === 'idea-word' && arg) return t('startReasonIdea', { word: arg });
  if ((kind === 'installed-in' || kind === 'used-in') && arg) return t(`fitReason_${kind}`, { project: nameOf(arg) || arg });
  const general = t('fitReason_other');
  // Only a plain code has a text of its own; one that needs an argument and has none is no reason to show
  if (i !== -1 || ARG_REASONS.has(s) || !/^[a-z][a-z0-9-]{0,40}$/.test(s)) return general;
  const own = tOr(`fitReason_${s}`, general);
  return /\{\w+\}/.test(own) ? general : own;
}

// The reasons of a candidate on one line (a text two codes share, such as the general line, once)
export function fitReasonsText(reasons, nameOf, idea = []) {
  return [...new Set((Array.isArray(reasons) ? reasons : []).map((r) => fitReasonText(r, nameOf, idea)).filter(Boolean))].join(' · ');
}

// The idea tags of a fit (project.idea.tags), or []
const ideaOf = (fit) => (Array.isArray(fit?.project?.idea?.tags) ? fit.project.idea.tags.filter((g) => g && typeof g === 'object') : []);

// Why nothing can be installed into the project (the fit's problem code) as text
export function fitProblemText(code) {
  const c = String(code ?? '');
  return tOr(`fitProblem_${c}`, tOr(`skErr_${c}`, t('skErr_unknown', { code: c })));
}

// Why one candidate cannot be installed (its blocked code) as text
export function fitBlockedText(code) {
  const c = String(code ?? '');
  return tOr(`fitBlocked_${c}`, tOr(`skReason_${c}`, tOr(`skErr_${c}`, c)));
}

// Installed straight from where it is (SiberSentez's own kit or the library); anything else is imported into the library
// first (the "imports" of a plan)
const installableSource = (c) => Array.isArray(c?.sources) && (c.sources.includes('kit') || c.sources.includes('library'));

// Where a candidate comes from: SiberSentez's own kit, the library, or the first other project it was found in
export function fitSourceText(sources, nameOf = (id) => id) {
  const list = Array.isArray(sources) ? sources.map(String) : [];
  if (list.includes('kit')) return t('fitFromKit');
  if (list.includes('library')) return t('fitFromLibrary');
  const proj = list.find((s) => s.startsWith('project:'));
  if (!proj) return '';
  const id = proj.slice('project:'.length);
  return t('fitFromProject', { project: nameOf(id) || id });
}

// The server's automatic selection: the candidates it marked selected that can still be installed
export function autoSelection(fit) {
  return new Set((Array.isArray(fit?.candidates) ? fit.candidates : []).filter((c) => c?.selected === true && selectable(c)).map((c) => String(c.key)));
}

// What the selection depends on: the candidates, their state and the server's choice. The same signature keeps the
// user's own selection when the fit is loaded again; a new one (say, after an install) starts from the automatic one.
export function fitSignature(fit) {
  return (Array.isArray(fit?.candidates) ? fit.candidates : []).map((c) => `${c?.key}${c?.installed ? '!' : ''}${c?.installable === true ? '' : '#'}${c?.selected ? '*' : ''}`).join('|');
}

// st.sel from the automatic selection when there is none yet or the fit changed; returns true when it was reset
export function ensureFitSelection(st) {
  const sig = fitSignature(st?.data);
  if (st.sel && st.selSig === sig) return false;
  st.sel = autoSelection(st?.data);
  st.selSig = sig;
  return true;
}

// How many fits the list shows before "show more" (docs/direction.md §3.2: a newcomer weighs three to five)
export const FIT_MAIN_MAX = 5;

// Section state (pure). fit: the GET /api/projects/<id>/fit answer; st: { sel: Set of keys, targets: Set, busy,
// showLow, showOthers }; mode: 'off'|'dry'|'live'. main: at most FIT_MAIN_MAX strong and possible fits not in the
// project yet (in the server's order; a selected one is always there); low: the other strong ones, then the weak
// fits (behind "show more"); others: fits found only in the person's other projects, left out of both unless
// showOthers; installed and active: folded as already active.
export function fitView(fit, st, mode, { turnOn = false } = {}) {
  const cands = (Array.isArray(fit?.candidates) ? fit.candidates : []).filter((c) => c && typeof c === 'object');
  const problem = typeof fit?.problem === 'string' && fit.problem ? fit.problem : null;
  const all = cands.filter((c) => !c.installed);
  const fits = (c) => c.confidence === 'high' || c.confidence === 'medium' || !(Number(c.score) <= 0);
  // Only in other projects: English, made for that project, copied into the library first. Behind one switch.
  const others = all.filter((c) => !installableSource(c) && fits(c));
  const showOthers = !!st?.showOthers;
  const open = showOthers ? all : all.filter(installableSource);
  const strong = open.filter((c) => c.confidence === 'high' || c.confidence === 'medium');
  const main = [];
  const rest = [];
  // A row that cannot be installed (a name clash, too large...) never takes one of the places
  for (const c of strong) ((selectable(c) && main.length < FIT_MAIN_MAX) || st?.sel?.has(c.key) ? main : rest).push(c);
  // Weak fits: those that share at least something (a score of 0 matches nothing, so it is no fit at all)
  const low = [...rest, ...open.filter((c) => c.confidence !== 'high' && c.confidence !== 'medium' && !(Number(c.score) <= 0))];
  const installed = cands.filter((c) => c.installed);
  const active = (Array.isArray(fit?.active) ? fit.active : []).filter((a) => a && typeof a === 'object');
  const ex = fit?.excluded && typeof fit.excluded === 'object' ? fit.excluded : {};
  const sample = (Array.isArray(ex.sample) ? ex.sample : []).filter((x) => x && typeof x === 'object');
  const excluded = { count: Math.max(Number(ex.count) || 0, sample.length), sample };
  const listed = [...main, ...low];
  const sel = problem ? [] : listed.filter((c) => selectable(c) && st?.sel?.has(c.key));
  const targets = SKILL_TARGETS.filter((x) => st?.targets?.has(x));
  const busy = !!st?.busy;
  const on = mode === 'dry' || mode === 'live';
  // Off in the desktop app: the primary button turns actions on and installs, after one question (docs/direction.md §3.2)
  const oneStep = mode === 'off' && !!turnOn;
  const tooMany = sel.length > MAX_SKILL_ITEMS;
  const needTargets = sel.some((c) => c.kind === 'skill') && !targets.length;
  // Try copies items into a trial folder from where they are, like an install: the library or SiberSentez's own kit (the
  // server's planTrial finds a kit item after the library); an item only in other projects cannot be tried
  const tryItems = sel.filter(installableSource).map((c) => ({ kind: c.kind, name: c.name }));
  const applyDisabled = (!on && !oneStep) || busy || !!problem || !sel.length || tooMany || needTargets;
  const tryDisabled = !on || busy || !!problem || !tryItems.length || tooMany;
  // Why the button does what it does: off says nothing can be installed; preview always says that it copies nothing
  // (and how to really install), then what the selection lacks; on says what happens or what the selection lacks
  const lack = !sel.length ? t('skWhySelect') : tooMany ? t('skWhyTooMany', { max: MAX_SKILL_ITEMS }) : needTargets ? t('skWhyTargets') : '';
  const why = oneStep ? (problem ? '' : lack || t('fitWhyTurnOn')) : !on ? t('startWhyOff') : problem ? '' : mode === 'dry' ? [t('startWhyDry'), lack].filter(Boolean).join(' ') : lack || t('startWhyLive');
  return {
    problem,
    main,
    low,
    showLow: !!st?.showLow,
    others: others.length,
    showOthers,
    oneStep,
    installed,
    active,
    excluded,
    sel,
    keys: sel.map((c) => String(c.key)),
    imports: sel.filter((c) => !installableSource(c)).length,
    targets,
    busy,
    on,
    tooMany,
    needTargets,
    applyDisabled,
    tryItems,
    tryDisabled,
    tryWhy: on && !busy && !problem && sel.length && !tryItems.length ? t('fitWhyTryKit') : '',
    selectable: listed.some(selectable),
    // Nothing strong or possible to propose: what fits is installed here already ('new'), only other projects have
    // some ('others', while they are hidden), everything that fits is active everywhere ('new'), or nothing fits
    empty: main.length ? null : installed.length ? 'new' : !showOthers && others.length ? 'others' : active.length ? 'new' : 'none',
    why,
  };
}

// The request of a section button: skills-apply with the keys on screen (never without keys: that would be the
// server's automatic selection, which may differ from what the user sees), or skills-trial with the library items
export function fitRequestBody(projectId, act, v) {
  if (act === 'try') return { action: 'skills-trial', projectId, items: v.tryItems };
  const body = { action: 'skills-apply', projectId, keys: [...v.keys] };
  if (v.sel.some((c) => c.kind === 'skill') && v.targets.length) body.targets = [...v.targets];
  return body;
}

// Same keys and targets give the same key, whatever the order (a confirmation holds for exactly that)
export function fitRequestKey(v) {
  return `${[...v.keys].sort().join(',')}|${[...v.targets].sort().join(',')}`;
}

// A skills-apply plan counted by item (kind and name): installed (a copy or an update in some target), imported into
// the library, skipped (in the plan, nothing copied)
export function planCounts(plan) {
  const done = { skill: new Set(), agent: new Set() };
  const seen = new Set();
  const imports = new Set();
  for (const e of Array.isArray(plan) ? plan : []) {
    if (!e || typeof e !== 'object') continue;
    const k = `${String(e.kind ?? '')}:${String(e.name ?? '').toLowerCase()}`;
    seen.add(k);
    if ((e.op === 'copy' || e.op === 'update') && (e.kind === 'skill' || e.kind === 'agent')) done[e.kind].add(k);
    else if (e.op === 'import') imports.add(k);
  }
  const installed = new Set([...done.skill, ...done.agent]);
  return { skills: done.skill.size, agents: done.agent.size, skipped: [...seen].filter((k) => !installed.has(k)).length, imports: imports.size };
}

// "8 skills", "1 agent", "8 skills and 1 agent"
function whatText(c) {
  const parts = [];
  if (c.skills || !c.agents) parts.push(t('fitWhatSkills', { count: num(c.skills) }));
  if (c.agents) parts.push(t('fitWhatAgents', { count: num(c.agents) }));
  return parts.length === 2 ? t('fitWhatAnd', { a: parts[0], b: parts[1] }) : parts[0];
}

export function fitBusyText(busy) {
  return busy === 'try' ? t('skBusy_try') : busy === 'apply' ? t('fitBusy_apply') : busy === 'turn-on' ? t('fitBusy_turnOn') : t('fitBusy_plan');
}

// What a section button did, in plain words (pure). act: 'apply'|'try'; r: runAction's answer.
// Returns { tone: 'dry'|'ok'|'none'|'err', head, detail, text } (text = head and detail, for the toast and the
// status region). Preview mode always says that nothing was copied.
export function fitOutcome(act, r) {
  if (!r || !r.ok) {
    const text = skillErrorText(r);
    return { tone: 'err', head: text, detail: '', text };
  }
  if (act === 'try') {
    const text = r.mode === 'dry' ? t('skDryNote') : t('skDone_try');
    return { tone: r.mode === 'dry' ? 'dry' : 'ok', head: text, detail: '', text };
  }
  const c = planCounts(r.plan);
  if (r.mode !== 'live' || r.reason === 'preview-mode' || r.result?.executed === false) {
    const head = t('startDryBanner');
    const detail = [t('fitDryWould', { what: whatText(c), skipped: num(c.skipped) }), c.imports ? t('fitDryImports', { count: num(c.imports) }) : ''].filter(Boolean).join(' ');
    return { tone: 'dry', head, detail, text: `${head} ${detail}` };
  }
  if (r.applied === false) {
    const text = r.reason === 'nothing-selected' ? t('fitDone_nothing-selected') : t('fitDone_nothing-to-do', { skipped: num(c.skipped) });
    return { tone: 'none', head: text, detail: '', text };
  }
  const imported = Number(r.result?.imported) || 0;
  const head = t('fitDone', { what: whatText(c), skipped: num(c.skipped) });
  const detail = [imported ? t('fitDoneImported', { count: num(imported) }) : '', r.result?.catalogError ? t('fitCatalogError') : ''].filter(Boolean).join(' ');
  return { tone: 'ok', head, detail, text: detail ? `${head} ${detail}` : head };
}

// Button of the section: aria-disabled keeps it focusable; while disabled a screen reader hears why
function fitBtn(act, label, off, cls = '') {
  const why = off && (act === 'apply' || act === 'try') ? ' aria-describedby="fitWhy"' : '';
  return `<button type="button" class="act-btn ${cls}" data-fit-act="${act}" data-fk="fit:${act}"${off ? ' aria-disabled="true"' : ''}${why}>${esc(label)}</button>`;
}

// The tags found in the project's folder: stack tags first as the server sorts them; the evidence in the tooltip
function fitTagsHtml(project) {
  const tags = (Array.isArray(project?.tags) ? project.tags : []).filter((g) => g && typeof g === 'object');
  const chips = tags.map((g) => `<li class="fit-tag ${g.type === 'stack' ? 'stack' : 'topic'}"${g.from ? ` title="${esc(t('fitTagFrom', { from: String(g.from) }))}"` : ''}>${esc(fitTagLabel(g.id))}</li>`).join('');
  const list = chips ? `<ul class="fit-tag-list" aria-label="${esc(t('startFolderTags'))}">${chips}</ul>` : `<span class="small muted">${esc(t('startFolderEmpty'))}</span>`;
  return `<div class="fit-tags"><span class="fit-tags-l" aria-hidden="true">${esc(t('startFolderTags'))}</span>${list}</div>${project?.truncated ? `<p class="small muted fit-note">${esc(t('fitTruncated'))}</p>` : ''}`;
}

// The idea box (docs/start-flow.md): the question, the text box with its button, a hint, examples while the box is
// empty, then what the idea gave (ideaStateHtml). st: the section state ({ idea, ideaWanted, dataIdea, loading,
// loadingIdea, error, errorIdea, data }).
export function ideaBoxHtml(st) {
  const text = String(st?.idea ?? '');
  const examples = cleanIdea(text)
    ? ''
    : `<p class="idea-ex"><span class="idea-ex-l">${esc(t('startExamples'))}</span>${[1, 2, 3]
        .map((i) => {
          const ex = t(`startExample${i}`);
          return `<button type="button" class="idea-chip" data-fit-act="example" data-fk="fit:example${i}" data-idea-example="${esc(ex)}">${esc(ex)}</button>`;
        })
        .join('')}</p>`;
  // The idea is kept in this browser only (ideaKeptAnswer 'local-only'): one plain line under the box
  const local = st?.ideaLocalOnly ? `<p class="small muted idea-local" id="fitIdeaLocal">${esc(t('startIdeaLocalOnly'))}</p>` : '';
  return `<div class="idea"><label class="idea-l" for="fitIdea">${esc(t('startIdeaLabel'))}</label><div class="idea-row"><input type="text" id="fitIdea" class="idea-in" data-idea data-fk="fit:idea" value="${esc(text)}" maxlength="${IDEA_MAX}" placeholder="${esc(t('startIdeaPlaceholder'))}" autocomplete="off" spellcheck="true" aria-describedby="fitIdeaHint${local ? ' fitIdeaLocal' : ''} fitIdeaState"><button type="button" class="act-btn idea-go" data-fit-act="find" data-fk="fit:find">${esc(t('startIdeaFind'))}</button></div>${local}<p class="small muted idea-hint" id="fitIdeaHint">${esc(t('startIdeaHint'))}</p>${examples}<div class="idea-state" id="fitIdeaState">${ideaStateHtml(st)}</div></div>`;
}

// Kinds offered when the idea names nothing known ("uygulama geliştirme"). A kind adds its words (startKindAdd_<id>,
// words the server's dictionary knows) to the idea and asks again; "not sure yet" asks nothing (docs/start-flow.md §7)
export const IDEA_KINDS = Object.freeze(['web', 'mobile', 'desktop', 'game', 'bot', 'data']);
// Tools offered when the idea names a topic but no tool; the first is the recommended one (why: startStackWhy_<why>)
export const STACK_CHOICES = Object.freeze([
  Object.freeze({ topics: ['gamedev'], stacks: ['Unity', 'Godot'], why: 'game' }),
  Object.freeze({ topics: ['mobile'], stacks: ['Expo', 'Flutter'], why: 'mobile' }),
  Object.freeze({ topics: ['desktop'], stacks: ['Electron'], why: 'desktop' }),
  // A shop, a blog or a server first: Next.js. Any other web idea (a small tool, one page) starts with plain files
  // that need no install; Next.js stays the second choice (the first test drive: a to-do list was offered Next.js)
  Object.freeze({ topics: ['ecommerce', 'content', 'backend'], stacks: ['Next.js'], why: 'web' }),
  Object.freeze({ topics: ['web'], stacks: ['HTML + JavaScript', 'Next.js'], why: 'webSimple' }),
  Object.freeze({ topics: ['bot', 'automation', 'scraping', 'data', 'ai'], stacks: ['Python'], why: 'python' }),
]);

// The tool choice for the topics an idea named (tag objects), or null when no group fits
export function stackChoiceFor(tags) {
  const ids = new Set((tags || []).map((g) => g?.id));
  return STACK_CHOICES.find((c) => c.topics.some((x) => ids.has(x))) || null;
}

// The idea with more words at its end, within the length the server reads
export function ideaWith(idea, add) {
  return cleanIdea(`${cleanIdea(idea)} ${String(add || '')}`);
}

const refineChip = (label, add, fk, cls = '') => `<button type="button" class="idea-chip${cls}" data-fit-act="refine" data-fk="${fk}" data-idea-add="${esc(add)}">${esc(label)}</button>`;

// What the idea gave: searching, "press Enter" while the box differs from the list, the tags the idea named ("From
// your idea: Unity, game development"), the tool question when it names no tool, or the kind question when it named
// nothing known
export function ideaStateHtml(st) {
  const typed = cleanIdea(st?.idea);
  if (st?.loading && st.loadingIdea) return `<p class="small muted">${esc(t('startIdeaSearching'))}</p>`;
  if (st?.error && st.errorIdea === typed && st.errorIdea && st.data) return `<p class="small idea-warn">${esc(t('startIdeaFailed'))}</p>`;
  const shown = st?.dataIdea ?? '';
  if (st?.data && typed !== shown && (typed || shown)) return `<p class="small muted">${esc(t('startIdeaPending'))}</p>`;
  if (!st?.data || !shown) return '';
  const tags = ideaOf(st.data);
  const named = tags.filter((g) => !g.via);
  if (!named.length) {
    const unsure = st.ideaUnsure === shown;
    const kinds = IDEA_KINDS.map((k) => refineChip(t(`startKind_${k}`), t(`startKindAdd_${k}`), `fit:kind-${k}`)).join('');
    const ask = unsure ? `<p class="small idea-tip">${esc(t('startUnsureNote'))}</p>` : `<p class="small idea-ask">${esc(t('startIdeaNone'))}</p>`;
    const notSure = unsure ? '' : `<button type="button" class="idea-chip idea-unsure" data-fit-act="unsure" data-fk="fit:unsure">${esc(t('startKindUnsure'))}</button>`;
    return `${ask}<p class="idea-ex idea-kinds" role="group" aria-label="${esc(t('startIdeaNone'))}">${kinds}${notSure}</p>`;
  }
  const chips = named.map((g) => `<li class="fit-tag ${g.type === 'stack' ? 'stack' : 'topic'} idea" title="${esc(t('startReasonIdea', { word: ideaWordOf(g.id, tags) }))}">${esc(fitTagLabel(g.id))}</li>`).join('');
  const found = `<div class="fit-tags idea-found"><span class="fit-tags-l">${esc(t('startIdeaFound'))}</span><ul class="fit-tag-list" aria-label="${esc(t('startIdeaFound'))}">${chips}</ul></div>`;
  if (tags.some((g) => g.type === 'stack')) return found;
  const choice = stackChoiceFor(named);
  if (!choice) return `${found}<p class="small idea-tip">${esc(t('startIdeaNoStack'))}</p>`;
  const stacks = choice.stacks
    .map((name, i) => refineChip(i === 0 ? t('startStackRec', { name }) : name, t('startStackAdd', { name }), `fit:stack-${i}`, i === 0 ? ' rec' : ''))
    .join('');
  return `${found}<p class="small idea-ask">${esc(t('startIdeaNoStack'))}</p><p class="idea-ex idea-stacks" role="group" aria-label="${esc(t('startIdeaNoStack'))}">${stacks}</p><p class="small muted idea-why">${esc(t(`startStackWhy_${choice.why}`))}</p>`;
}

// One candidate: checkbox, name, kind, source and band, the reasons, and why it cannot be installed when it cannot
function fitRowHtml(c, st, busy, nameOf) {
  const can = selectable(c);
  const band = FIT_BANDS.includes(c.confidence) ? c.confidence : 'low';
  const meta = [kindText(c.kind), fitSourceText(c.sources, nameOf), t(`startBand_${band}`)].filter(Boolean).join(' · ');
  const why = fitReasonsText(c.reasons, nameOf, ideaOf(st?.data));
  const blocked = !can && c.blocked ? `<span class="fit-blocked">${esc(fitBlockedText(c.blocked))}</span>` : '';
  const key = String(c.key ?? '');
  return `<label class="fit-row b-${band}${can ? '' : ' off'}"><input type="checkbox" data-flow-item="${esc(key)}" data-fk="fit-item:${esc(key)}"${can && st?.sel?.has(key) ? ' checked' : ''}${can && !busy ? '' : ' disabled'}><span class="fit-name" translate="no">${esc(c.name)}</span><span class="fit-meta">${esc(meta)}</span>${why ? `<span class="fit-why">${esc(why)}</span>` : ''}${c.description ? `<span class="fit-desc">${esc(kitSummary(c.kind, c.name, c.description, Array.isArray(c.sources) && c.sources.includes('kit')))}</span>` : ''}${blocked}</label>`;
}

// Already active: installed in this project, or active in every project (personal, claude.ai, plugins, built-in)
function fitActiveHtml(v, st, nameOf) {
  const n = v.installed.length + v.active.length;
  if (!n) return '';
  const row = (name, meta, why) => `<li class="fit-arow"><span class="fit-name" translate="no">${esc(name)}</span><span class="fit-meta">${esc(meta)}</span>${why ? `<span class="fit-why">${esc(why)}</span>` : ''}</li>`;
  const idea = ideaOf(st?.data);
  const inst = v.installed.map((c) => row(c.name, [kindText(c.kind), t('fitActiveInstalled')].join(' · '), fitReasonsText(c.reasons, nameOf, idea)));
  const act = v.active.map((a) => row(a.name, [kindText(a.kind), t('fitActiveEverywhere'), tOr(`fitSrc_${a.source}`, String(a.source ?? '')), a.plugin ? String(a.plugin) : ''].filter(Boolean).join(' · '), fitReasonsText(a.reasons, nameOf, idea)));
  return `<details class="fit-fold" data-fit-fold="active"${st?.folds?.active ? ' open' : ''}><summary>${esc(t('fitActive', { count: num(n) }))}</summary><ul class="fit-flist">${[...inst, ...act].join('')}</ul></details>`;
}

// Left out: items made for other kinds of projects (a React Native skill for a Unity project); a sample on request
function fitExcludedHtml(v, st) {
  if (!v.excluded.count) return '';
  const rows = v.excluded.sample
    .map((x) => {
      const stacks = (Array.isArray(x.stacks) ? x.stacks : []).map(fitTagLabel).join(', ');
      return `<li class="fit-arow"><span class="fit-name" translate="no">${esc(x.name)}</span><span class="fit-meta">${esc([kindText(x.kind), stacks ? t('fitExcludedFor', { stacks }) : ''].filter(Boolean).join(' · '))}</span></li>`;
    })
    .join('');
  const rest = v.excluded.count - v.excluded.sample.length;
  const more = rest > 0 ? `<li class="fit-arow muted">${esc(t('fitExcludedMore', { count: num(rest) }))}</li>` : '';
  return `<details class="fit-fold fit-excl" data-fit-fold="excluded"${st?.folds?.excluded ? ' open' : ''}><summary>${esc(t('fitExcluded', { count: num(v.excluded.count) }))}</summary><ul class="fit-flist">${rows}${more}</ul></details>`;
}

// The last run of a section button. Preview: a clear banner ("nothing was copied") with the actions chooser button
// and the plan open. Live: one result line and the plan folded. Try: its line and the command.
export function fitOutcomeHtml(st) {
  if (!st?.out) return '';
  const { act, r } = st.out;
  const o = fitOutcome(act, r);
  const folds = st.folds || {};
  const plan = act === 'apply' && Array.isArray(r?.plan) && r.plan.length ? planList(r.plan) : '';
  if (act === 'apply' && o.tone === 'dry') {
    return `<div class="fit-banner dry"><p><b>${esc(o.head)}</b> ${esc(o.detail)} <span class="fit-dry-how">${esc(t('startDryHow'))}</span></p>${fitBtn('chooser', t('fitChooser'), false)}</div>${plan ? `<details class="fit-fold fit-plan" data-fit-fold="planDry"${folds.planDry === false ? '' : ' open'}><summary>${esc(t('fitPlanDry'))}</summary>${plan}</details>` : ''}`;
  }
  const line = `<p class="fit-result ${o.tone}">${esc(o.head)}${o.detail ? ` <span>${esc(o.detail)}</span>` : ''}</p>`;
  if (act === 'try') {
    const cmd = Array.isArray(r?.argv) ? `<span class="small muted">${esc(t('skCommand'))}</span><pre class="brief" tabindex="0" translate="no">${esc(argvSummary(r.argv, 4000))}</pre>` : '';
    return `${line}${cmd ? `<div class="flow-out">${cmd}</div>` : ''}`;
  }
  return `${line}${plan ? `<details class="fit-fold fit-plan" data-fit-fold="planLive"${folds.planLive ? ' open' : ''}><summary>${esc(t('fitPlanLive'))}</summary>${plan}</details>` : ''}`;
}

// The whole section (pure apart from starting st.sel from the automatic selection). p: the project; st: its flow
// state ({ data, error, sel, targets, busy, confirm, out, showLow, folds, idea, ideaWanted, dataIdea }); nameOf(id): a
// project's name. Order: title, one sentence on what happens, the idea box, the folder's tags, the list, the buttons.
// startTool: the first AI tool found on this computer ({ id, name }) or null; with it, live mode offers "Install and
// start", and the confirmation can start that tool in the project right after the install.
export function fitSectionHtml(p, st, mode, nameOf = (id) => id, startTool = null, { turnOn = false } = {}) {
  const fkey = `fit:${p.id}`;
  const badge = mode === 'dry' ? `<span class="cm-badge">${esc(t('skDryBadge'))}</span>` : '';
  const wrap = (inner, count = 0, idea = true) =>
    `<section class="dr-sec flow fit" data-sec="skills" data-flow="${esc(fkey)}" data-fk="fit:sec" aria-labelledby="fitH" tabindex="-1">
    <h3 id="fitH">${icon('grid')} ${esc(t('startTitle'))}${count ? ` <span>${esc(t('fitSelected', { count: num(count) }))}</span>` : ''}${badge}</h3>
    <p class="muted small">${esc(t('startIntro'))}</p>${idea ? ideaBoxHtml(st) : ''}${inner}</section>`;
  if (!st?.data) return wrap(`<p class="small muted">${esc(st?.error ? t('fitLoadFailed') : t('fitLoading'))}</p>`);
  ensureFitSelection(st);
  const tags = fitTagsHtml(st.data.project);
  const v = fitView(st.data, st, mode, { turnOn });
  // Nothing can be installed here: the idea box would not help
  if (v.problem) return wrap(`${tags}<p class="fit-problem">${esc(fitProblemText(v.problem))}</p>${fitOutcomeHtml(st)}`, 0, false);
  const shown = [...v.main, ...(v.showLow ? v.low : [])];
  const rows = shown.map((c) => fitRowHtml(c, st, v.busy, nameOf)).join('');
  // Nothing to propose: all there already; an empty folder and no idea yet (write one); or nothing fits
  const blank = !(Array.isArray(st.data.project?.tags) && st.data.project.tags.length) && !st.dataIdea;
  const emptyKey = v.empty === 'others' ? 'fitOnlyOthers' : v.empty === 'new' ? 'fitNothingNew' : blank ? 'startWriteIdea' : 'startNothingFound';
  const empty = v.empty ? `<p class="fit-empty">${esc(t(emptyKey))}</p>` : '';
  const list = rows ? `<fieldset class="fit-list"><legend class="sr-only">${esc(t('startTitle'))}</legend>${rows}</fieldset>` : '';
  const more = v.low.length ? `<button type="button" class="fit-more" data-fit-act="more" data-fk="fit:more" aria-expanded="${v.showLow}">${esc(v.showLow ? t('fitShowLess') : t('startShowMore', { count: num(v.low.length) }))}</button>` : '';
  const othersBtn = v.others ? `<button type="button" class="fit-more fit-others" data-fit-act="others" data-fk="fit:others" aria-expanded="${v.showOthers}">${esc(v.showOthers ? t('fitOthersHide') : t('fitOthersShow', { count: num(v.others) }))}</button>` : '';
  const fromProjects = shown.some((c) => selectable(c) && !installableSource(c)) ? `<p class="small muted fit-note">${esc(t('fitFromProjectNote'))}</p>` : '';
  // Off and preview: "Change actions" next to the buttons (the preview banner carries its own after a run)
  const dryBanner = st.out?.act === 'apply' && fitOutcome('apply', st.out.r).tone === 'dry';
  let actions = '';
  if (v.selectable || v.busy) {
    const agentsOnly = v.sel.length > 0 && v.sel.every((c) => c.kind === 'agent');
    // Live with an AI tool found: one "Install and start"; the confirmation still lets the user only install
    const andStart = mode === 'live' && startTool ? startTool : null;
    const ask = [t('skAskInstall', { count: num(v.sel.length), project: p.name }), v.imports ? t('fitAskImports', { count: num(v.imports) }) : '', andStart ? t('fitAskStart', { tool: andStart.name }) : ''].filter(Boolean).join(' ');
    const yes = andStart ? `${fitBtn('confirm-start', t('fitConfirmStart', { tool: andStart.name }), false, 'primary')}${fitBtn('confirm', t('fitConfirmOnly'), false)}` : fitBtn('confirm', t('skConfirmInstall'), false, 'primary');
    // Off: one question says what On does (the switch's own words) and what is installed; "Yes" does both
    const turnOnAsk = [tOs('actionsSwitchConfirmBody'), t('skAskInstall', { count: num(v.sel.length), project: p.name }), v.imports ? t('fitAskImports', { count: num(v.imports) }) : ''].filter(Boolean).join(' ');
    const confirm = st.confirm === 'turn-on' && v.oneStep ? `<div class="flow-confirm" role="group" aria-labelledby="fitQ"><p id="fitQ"><b>${esc(t('actionsSwitchConfirmTitle'))}</b> ${esc(turnOnAsk)}</p><div class="flow-btns">${fitBtn('confirm-on', t('fitTurnOnYes'), false, 'primary')}${fitBtn('cancel', t('skCancel'), false)}</div></div>` : st.confirm === 'apply' ? `<div class="flow-confirm" role="group" aria-labelledby="fitQ"><p id="fitQ">${esc(ask)}</p><div class="flow-btns">${yes}${fitBtn('cancel', t('skCancel'), false)}</div></div>` : '';
    // Off: no target picker and no chooser here; the drawer's one banner says it and carries the button
    const where = mode === 'off' ? '' : agentsOnly ? `<p class="small muted sk-targets">${esc(t('skAgentsClaudeOnly'))}</p>` : targetFold(st, v.busy);
    const applyLabel = v.oneStep ? t('fitTurnOnInstall') : mode === 'dry' ? t('fitApplyDry') : andStart ? t('fitInstallStart') : t('fitApplyLive');
    actions = `<div class="flow-btns">${fitBtn('apply', applyLabel, v.applyDisabled, 'primary')}${fitBtn('try', t('fitTry'), v.tryDisabled)}${mode !== 'dry' || dryBanner ? '' : fitBtn('chooser', t('fitChooser'), false)}</div>
    <p class="small muted flow-why" id="fitWhy">${esc([v.why, v.tryWhy].filter(Boolean).join(' '))}</p>
    ${where}
    ${confirm}`;
  }
  const status = st.busy ? `<p class="flow-status small">${esc(fitBusyText(st.busy))}</p>` : '';
  return wrap(`${tags}${empty}${list}${more}${othersBtn}${fromProjects}${actions}${status}${fitOutcomeHtml(st)}${fitActiveHtml(v, st, nameOf)}${fitExcludedHtml(v, st)}`, v.sel.length);
}

// Off mode, said once at the top of a project drawer with the one button that opens the actions switch; the sections
// below only point here (pure; exported for the tests). Nothing in the other modes.
export function offBannerHtml(mode) {
  if (mode !== 'off') return '';
  return `<div class="dr-off" role="note"><p><b>${esc(t('offTitle'))}</b> ${esc(t('offBody'))}</p><button type="button" class="act-btn primary" data-fit-act="chooser" data-fk="off:chooser">${esc(t('offOpen'))}</button></div>`;
}

// "Then: start with AI" (docs/ai-start.md; before: "Then: open a terminal", docs/start-flow.md step 2), under "Skills
// that fit this project": always there for a project whose folder exists. One button per AI tool found on this
// computer (the context menu's start-ai items), "Start with my idea" when the project has a saved idea, and the plain
// terminal (the context menu's "Open terminal"). The tools are asked for on first need (needTools: only in the
// browser). Off and preview say why nothing opens and carry "Change actions". After a live install one line says what
// was installed. st: the fit section's state (its last run); mode: 'off' | 'dry' | 'live'; tools: the tools state.
export function startNextHtml(p, st, mode, tools = toolsState()) {
  if (!p || !p.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  const out = st?.out?.act === 'apply' && st.out.r ? fitOutcome('apply', st.out.r) : null;
  const done = out?.tone === 'ok' ? `<p class="start-done" role="status">${esc(t('startAfterInstall', { what: whatText(planCounts(st.out.r.plan)) }))}</p>` : '';
  needTools();
  return aiStartSectionHtml(p, { mode, done, tools, withIdea: ideaPref(p.id) });
}
