// @ts-check
// "Do a job" in the project drawer (docs/kit-in-app.md): the person writes a job, the AI tool starts with it as its
// first message and runs the kit's team flow (docs/kit-v2.md §3). The progress comes from the team's hand-off files
// through GET /api/projects/<id>/team (read-only). The HTML is pure (tested in node); createJob keeps the answers,
// the text being typed and the team-install step per project.
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { installedTools, toolsState, TOOL_KEY, preferredTool, readTool, saveTool } from './tools.js';
import { sessionState, liveKnown } from '../attention.js';
import { sessionJobId, sessionTool, canContinueTool } from '../jobId.js';
export { sessionJobId };

// The kit's team: what "Install the team" asks for (the server skips what is installed already)
export const TEAM_KEYS = Object.freeze([
  'skill:orchestrate',
  'skill:orchestrate-plan',
  'skill:orchestrate-build',
  'skill:orchestrate-review',
  'skill:orchestrate-wrapup',
  'skill:next-step',
  'skill:verify-before-done',
  'skill:handoff-notes',
  'skill:project-memory',
  'skill:agent-rules',
  'skill:plan-challenge',
  'skill:finish-branch',
  'agent:planner',
  'agent:task-slicer',
  'agent:builder',
  'agent:tester',
  'agent:reviewer',
  'agent:debugger',
  'agent:scout',
]);
// The job box holds several lines (review U06): at most the server's JOB_MAX (server/fit.mjs normalizeJob)
export const JOB_MAX = 2000;
const FIT_READ = 300;
// The count shows its limit near the end of the room only, so it never reads as a goal. It counts as the box's
// maxlength does (UTF-16 units: an emoji takes two), so it reaches the limit where typing stops; the server, counting
// characters, never cuts what the box let through
export const jobCountText = (text) => {
  const n = String(text || '').length;
  return n >= JOB_MAX * 0.8 ? t('jobCount', { n, max: JOB_MAX }) : '';
};
const STEPS = ['plan', 'build', 'check', 'finish'];
// Team states: install (confirm, busy, done, plan, failed) and update (checking, update, updating, updated, current,
// update-failed)
const TEAM_UI = new Set(['', 'confirm', 'busy', 'done', 'plan', 'failed', 'checking', 'update', 'updating', 'updated', 'current', 'update-failed']);

async function fetchTeam(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/team`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Whether the team is in the project, from the drawer's fit answer: true, false, or null while not known
export function teamInstalled(fitData) {
  // The fit's excluded part is a count in its answer, not always a list: only lists are read
  const list = (x) => (Array.isArray(x) ? x : []);
  const all = [...list(fitData?.candidates), ...list(fitData?.excluded)];
  const o = all.find((c) => c?.key === 'skill:orchestrate');
  return o ? !!o.installed : null;
}

// Whether an AI works in the project now (pure; docs/internal/ui-states-plan.md U1): 'busy' (a live session there, one
// with running agents, or an AI tab of it running in SiberSentez's terminal), 'unknown' (a session of a tool whose live
// state the app does not read, attention.js liveKnown, wrote in the last NOT_KNOWN_RECENT_MS: it may run or not; a
// longer quiet one counts as idle, a judgment) or 'idle'
export const NOT_KNOWN_RECENT_MS = 30 * 60 * 1000;
/** @param {{ sessions?: Iterable<any>, projectId?: string, dock?: any[], now?: number }} [options] */
export function aiStateIn({ sessions = [], projectId = undefined, dock = [], now = Date.now() } = {}) {
  if (!projectId) return 'unknown';
  const here = [...sessions].filter((s) => s && s.projectId === projectId);
  if (here.some((s) => s.live || (Number(s.runningAgents) || 0) > 0) || (dock || []).some((x) => x && x.projectId === projectId)) return 'busy';
  return here.some((s) => !liveKnown(s) && now - (Number(s.lastAt) || 0) <= NOT_KNOWN_RECENT_MS) ? 'unknown' : 'idle';
}
// No AI works in the project now, for sure
export const aiIdleIn = (o = {}) => aiStateIn(o) === 'idle';

// One plain sentence for where the job is (pure). idle: no AI works in the project now (aiIdleIn); unknown: whether one
// does is not known (aiStateIn): no sentence then says the AI works
// offline: the page lost its server (the live stream dropped): what it shows is the last state it saw, so a job that is
// not done yet says so instead of "working" (review B8, UX plan §6.3: a lost connection is never a finish), and "the
// tool closed" is never guessed from it
// Problems a check found: being fixed only while an AI works
const reviseKey = (idle, unknown) => (idle ? 'jobNowReviseIdle' : unknown ? 'jobNowReviseUnknown' : 'jobNowRevise');
export function jobNowText(d, { idle = false, unknown = false, offline = false } = {}) {
  if (!d || d.step === 'none') return '';
  if (offline && d.step !== 'done') return t('jobNowOffline');
  const task = d.current ? `${d.current.id} ${d.current.title}`.trim() : '';
  // No plan of this job yet: the AI is still writing it (or asks something in the terminal first, as a tool's "trust
  // this folder?"); "waiting for your approval" then sent the person looking for a plan that was not there (seen when
  // using the app, 2026-10-08). With no AI at work it is not being written either: the tool closed before it began
  // (the trust question cancelled): said so, with what to do. An approved plan without tasks is being cut into tasks.
  if (d.step === 'plan') return t(!d.plan ? (idle ? 'jobNowPlanIdle' : unknown ? 'jobNowPlanUnknown' : 'jobNowPlanWriting') : d.plan.approved ? `jobNowPlanSlicing${idle ? 'Idle' : unknown ? 'Unknown' : ''}` : 'jobNowPlan');
  if (d.step === 'build') {
    // Without a task name (the Building's example, a plan without ids) the sentence leaves it out: "Working on ." before
    const counts = { task, done: d.tasks?.done ?? 0, total: d.tasks?.total ?? 0 };
    const blocked = d.current?.status === 'blocked';
    // With no AI at work no task is being worked on (docs/internal/ui-states-plan.md U1): what is done, and what is next
    const quiet = idle ? 'Idle' : unknown ? 'Unknown' : '';
    const now = blocked ? t(`${task ? 'jobNowBlocked' : 'jobNowBlockedNoTask'}${idle ? 'Idle' : unknown ? 'Unknown' : ''}`, counts) : quiet ? t(`jobNowBuild${quiet}${task ? '' : 'NoTask'}`, counts) : t(task ? 'jobNowBuild' : 'jobNowBuildNoTask', counts);
    // The team may check part of the work before the last task (seen in a real job): a check that asked for fixes is said
    return d.review?.verdict === 'REVISE' && d.review.blockers ? `${now} ${t(reviseKey(idle, unknown), { count: d.review.blockers })}` : now;
  }
  if (d.step === 'check') {
    if (d.reviewIssue === 'job-identity') return t('jobNowIdentity');
    return d.review?.verdict === 'REVISE' ? t(reviseKey(idle, unknown), { count: d.review.blockers || 1 }) : t(idle ? 'jobNowCheckIdle' : unknown ? 'jobNowCheckUnknown' : 'jobNowCheck');
  }
  if (d.step === 'done') return t('jobNowDone');
  return t('jobNowFinish');
}

// The project's last session when none of its sessions runs any more (its terminal was closed, seen 2026-10-01); null
// while one runs, or when there is none (pure apart from the clock). Shared by the Building and the drawer.
// since: when the job last changed (the team's updatedAt); the session must have been at work then, so an older,
// unrelated session of the project is never resumed (seen 2026-10-01: a job run from another folder)
export const JOB_SESSION_SLACK_MS = 15 * 60000;
export function stoppedSession(sessions, projectId, now = Date.now(), since = null) {
  let last = null;
  for (const s of sessions) {
    if (s.projectId !== projectId) continue;
    if (sessionState(s, now) !== 'closed') return null;
    if (!last || (s.lastAt || 0) > (last.lastAt || 0)) last = s;
  }
  if (last && since && (last.lastAt || 0) < since - JOB_SESSION_SLACK_MS) return null;
  return last;
}

// The app job a Claude session was started for: jobId.js sessionJobId (re-exported above)

// The session that can go on with the shown job, or null (docs/internal/development-plan-2026-10-07.md F1). The Building, its
// next step and the drawer ask this one function, so they never disagree.
//   - An AI tool of the project still runs in SiberSentez's terminal (dock: terminalDock.running()): nothing stopped.
//   - The job's own tool (its marker's tool, Claude Code before markers) decides: only that tool's sessions continue
//     it, with that tool's resume; a tool whose sessions are not read (jobId.js canContinueTool) has none.
//   - A session that names this job (its first prompt) is the one; a session that names another job never is.
//   - A session that names no job (started by hand, or a job from before job ids): the last closed one, only when it
//     was at work around the job's last change (stoppedSession's 15-minute rule, the conservative fallback).
// No session of the project may still run (stoppedSession).
/** @param {{ sessions?: Iterable<any>, projectId?: string, now?: number, job?: any, dock?: any[] }} [options] */
export function resumeCandidate({ sessions = undefined, projectId = undefined, now = Date.now(), job = null, dock = [] } = {}) {
  if (!projectId || !job || job.step === 'done') return null;
  if ((dock || []).some((x) => x && x.projectId === projectId && x.ai !== false)) return null;
  const tool = job.tool || 'claude';
  if (!canContinueTool(tool)) return null;
  // The job's own tool's sessions only (server/toolLogs.mjs reads other tools' logs too)
  const own = [...sessions].filter((s) => s.projectId === projectId && sessionTool(s) === tool);
  const last = stoppedSession(own, projectId, now, null);
  if (!last) return null; // one still runs, or none
  if (job.jobId) {
    const named = own.filter((s) => sessionJobId(s) === job.jobId).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
    if (named) return named;
  }
  const loose = own.filter((s) => !sessionJobId(s));
  return stoppedSession(loose, projectId, now, job.updatedAt ?? null);
}

// The session of the shown job in its own tool, live or closed, or null (pure; review U08: "Go to this job's AI
// session").
// A session that names the job is the one; else the project's newest session that names no job, only when it was at
// work around the job's last change (resumeCandidate's rule). A job of a tool whose sessions are not read has none.
export function jobSession({ sessions = undefined, projectId = undefined, job = null } = {}) {
  const tool = job?.tool || 'claude';
  if (!projectId || !job || !canContinueTool(tool)) return null;
  const byNewest = (a, b) => (b.lastAt || 0) - (a.lastAt || 0);
  const own = [...sessions].filter((s) => s.projectId === projectId && sessionTool(s) === tool);
  if (job.jobId) {
    const named = own.filter((s) => sessionJobId(s) === job.jobId).sort(byNewest)[0];
    if (named) return named;
  }
  const loose = own.filter((s) => !sessionJobId(s)).sort(byNewest)[0] || null;
  if (loose && job.updatedAt && (loose.lastAt || 0) < job.updatedAt - JOB_SESSION_SLACK_MS) return null;
  return loose;
}

// The same project somewhere else: a folder with the same name that holds real files (the move's new place)
export function realTwin(projects, p) {
  if (!p) return null;
  const name = String(p.name || '').toLowerCase();
  return [...projects].find((x) => x.id !== p.id && String(x.name || '').toLowerCase() === name && x.exists !== false && !x.toolsOnly && x.path) || null;
}

// A folder with nothing but AI tools' setup in it: said in the drawer, with the real project to open instead (pure)
export function toolsOnlyHtml(p, twin) {
  if (!p?.toolsOnly) return '';
  const go = twin ? `<p class="small">${esc(t('jobToolsOnlyTwin', { path: twin.path }))}</p><button type="button" class="act-btn primary" data-job-act="open-twin" data-job-twin="${esc(twin.id)}" data-fk="job:open-twin">${icon('folder')}<span>${esc(t('jobToolsOnlyOpen'))}</span></button>` : '';
  return `<div class="dr-missing" role="status"><b>${esc(t('jobToolsOnlyTitle'))}</b><p>${esc(t('jobToolsOnlyBody'))}</p>${go}</div>`;
}

// The steps of a job that stopped: where it stopped instead of what is being worked on, and the way on (pure)
export function stoppedStepsHtml(d, session) {
  const steps = stepsHtml(d).replace(/<p class="small job-now"[^>]*>[\s\S]*?<\/p>$/, '');
  const at = d.tasks?.total ? ` ${t('wsJobStoppedAt', { done: d.tasks.done || 0, total: d.tasks.total })}` : '';
  return `${steps}<p class="small job-now" role="status">${esc(t('wsJobStopped') + at)}</p><button type="button" class="act-btn" data-job-act="resume" data-job-session="${esc(session.id)}" data-fk="job:resume">${icon('play')}<span>${esc(t('wsJobResume'))}</span></button>`;
}

// The four steps with done and now marked, and one plain sentence on where the job stands (the drawer and the Building)
export function stepsHtml(d, { idle = false, unknown = false, offline = false } = {}) {
  if (!d || !(STEPS.includes(d.step) || d.step === 'done')) return '';
  // done: the person accepted the result, every step is ticked
  const at = d.step === 'done' ? STEPS.length : STEPS.indexOf(d.step);
  const items = STEPS.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"${i === at ? ' aria-current="step"' : ''}>${esc(t(`jobStep_${s}`))}</li>`).join('');
  return `<ol class="job-steps" aria-label="${esc(t('jobStepsLabel'))}">${items}</ol><p class="small job-now${offline && d.step !== 'done' ? ' warn' : ''}" role="status">${esc(jobNowText(d, { idle, unknown, offline }))}</p>`;
}

// A plan that waits for the person (review B7): approve it or ask for a change from here, as drafts into the AI's tab
// (the drawer: resultAct, never with Enter); the plan itself is the AI's, in its tab and in the session. Pure.
export function planActsHtml(d) {
  if (d?.step !== 'plan' || !d.plan || d.plan.approved) return '';
  return `<div class="jr-acts plan-acts" role="group" aria-label="${esc(t('jobPlanActsLabel'))}"><button type="button" class="act-btn primary" data-jr-act="plan-ok" data-fk="job:plan-ok">${icon('check')}<span>${esc(t('jobPlanOk'))}</span></button><button type="button" class="act-btn" data-jr-act="plan-change" data-fk="job:plan-change">${icon('spark')}<span>${esc(t('jobPlanChange'))}</span></button></div><p class="small muted jr-acts-note">${esc(t('jobPlanNote'))}</p>`;
}

// The team's items as the install request names them ({ kind, name })
export const TEAM_ITEMS = Object.freeze(TEAM_KEYS.map((k) => Object.freeze({ kind: k.slice(0, k.indexOf(':')), name: k.slice(k.indexOf(':') + 1) })));

// Which team items a preview would update (a newer kit copy), from its plan (pure): [{ kind, name }] without repeats
export function teamUpdates(plan) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(plan) ? plan : []) {
    if (e?.op !== 'update' || typeof e.kind !== 'string' || typeof e.name !== 'string') continue;
    const k = `${e.kind}:${e.name}`;
    if (seen.has(k) || !TEAM_KEYS.includes(k)) continue;
    seen.add(k);
    out.push({ kind: e.kind, name: e.name });
  }
  return out;
}

function teamHtml(team, ui, dis, updates = 0) {
  if (ui === 'checking') return `<p class="small job-team" role="status">${esc(t('jobTeamChecking'))}</p>`;
  if (ui === 'updating') return `<p class="small job-team" role="status">${esc(t('jobTeamUpdating'))}</p>`;
  if (ui === 'updated') return `<p class="small job-team ok" role="status">${esc(t('jobTeamUpdated'))}</p>`;
  if (ui === 'current') return `<p class="small job-team ok" role="status">${esc(t('jobTeamCurrent'))}</p>`;
  if (ui === 'update-failed') return `<p class="small job-team warn" role="status">${esc(t('jobTeamUpdateFailed'))}</p>`;
  if (ui === 'update' && updates > 0) {
    return `<div class="job-team flow-confirm" role="group"><p class="small">${esc(t('jobTeamUpdateConfirm', { count: updates }))}</p><div class="flow-btns"><button type="button" class="act-btn primary" data-job-act="team-update-yes" data-fk="job:team-update-yes">${esc(t('jobTeamUpdateYes'))}</button><button type="button" class="act-btn" data-job-act="team-update-no" data-fk="job:team-update-no">${esc(t('jobTeamNo'))}</button></div></div>`;
  }
  if (ui === 'busy') return `<p class="small job-team" role="status">${esc(t('jobTeamBusy'))}</p>`;
  if (ui === 'done') return `<p class="small job-team ok" role="status">${esc(t('jobTeamDone'))}</p>`;
  if (ui === 'plan') return `<p class="small job-team" role="status">${esc(t('jobTeamPlan'))}</p>`;
  if (ui === 'failed') return `<p class="small job-team warn" role="status">${esc(t('jobTeamFailed'))}</p>`;
  // Installed: looking for a newer kit copy is one click (a preview writes nothing)
  if (team === true) return `<div class="job-team"><button type="button" class="act-btn" data-job-act="team-check" data-fk="job:team-check"${dis}>${icon('plugin')}<span>${esc(t('jobTeamCheck'))}</span></button></div>`;
  if (team !== false) return '';
  if (ui === 'confirm') {
    return `<div class="job-team flow-confirm" role="group"><p class="small">${esc(t('jobTeamConfirm'))}</p><div class="flow-btns"><button type="button" class="act-btn primary" data-job-act="team-yes" data-fk="job:team-yes">${esc(t('jobTeamYes'))}</button><button type="button" class="act-btn" data-job-act="team-no" data-fk="job:team-no">${esc(t('jobTeamNo'))}</button></div></div>`;
  }
  return `<div class="job-team"><p class="small">${esc(t('jobTeamMissing'))}</p><button type="button" class="act-btn" data-job-act="team" data-fk="job:team"${dis}>${icon('plugin')}<span>${esc(t('jobTeamInstall'))}</span></button></div>`;
}

// The tool a job starts with: tools.js preferredTool (the tools panel shows it first too), kept here by name for the
// pages that import it from the job
export { TOOL_KEY, preferredTool, readTool, saveTool };

// What a job sets up before it starts (pure): the team, then the helpers the server chose for this job's words
// (selected, installable, not in the project yet), within the server's limit of one request
export const KEYS_MAX = 25;
export function jobKeys(fit) {
  const fits = (Array.isArray(fit?.candidates) ? fit.candidates : []).filter((c) => c?.selected === true && c.installable === true && !c.installed).map((c) => String(c.key));
  return [...new Set([...TEAM_KEYS, ...fits])].slice(0, KEYS_MAX);
}

// The section (pure): one question, one box, one button (docs/simplify.md). p: the project; data: the /team answer or
// null; opts: { mode, tools (state), text (typed so far) }. The team and the helpers are set up by the Start itself;
// the team's update check and the other tools are in the drawer's details.
// turnOn: actions can be turned on from here (the desktop app), so Start stays pressable while they are off and asks
// once; asking: that question is on screen.
// next: the follow-ups a finished job offers ('change', 'try', 'deploy'); each only fills the box, Start stays the person's
// asNew: the job's result is waiting above (review U07): the box is a plain "New job" after it, without the job's steps
// and with a secondary Start, so it never looks like the way to answer the job
// cost: what a job uses, before it starts (jobCost.js estimateText); '' says nothing
// backup: what the copy the start takes would hold (restore.js scopeHtml, docs/restore.md §12), shown only when the start
// takes one (actions On, or Off with the one-step turn on); '' says nothing. noCopy: no copy can be taken for this project
// (restore.js scopeTakesCopy), so the line under Start promises none
export function jobSectionHtml(p, data, { mode = 'off', tools = toolsState(), text = '', stopped = null, turnOn = false, asking = false, next = [], asNew = false, idle = false, unknown = false, cost = '', backup = '', noCopy = false, offline = false } = {}) {
  if (!p || !p.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  const on = mode === 'dry' || mode === 'live';
  const tool = preferredTool(installedTools(tools));
  // A plan waits for the person: its approval is the one primary action, not a new job's Start (review B1, B7)
  const planWaits = !asNew && !offline && !!planActsHtml(data);
  const oneStep = mode === 'off' && turnOn && !!tool;
  const dis = on || oneStep ? '' : ' aria-disabled="true"';
  const pid = esc(p.id);
  // Several lines: Enter is a new line, Ctrl+Enter (or the button) starts; the count near the limit
  const input = `<label class="sr-only" for="job-${pid}">${esc(t('jobLabel'))}</label><textarea id="job-${pid}" class="job-text" data-job-text="${pid}" data-fk="job:text" rows="3" maxlength="${JOB_MAX}" placeholder="${esc(t('jobPlaceholder'))}" autocomplete="off" aria-describedby="jobKeys-${pid}">${esc(text)}</textarea><p class="small muted job-keys" id="jobKeys-${pid}"><span>${esc(t('jobKeyHint'))}</span> <span class="job-count" data-job-count="${pid}" aria-live="polite">${esc(jobCountText(text))}</span></p>`;
  // While the tools are still being looked for, say so (not "no tool yet"); a look that failed before any answer
  // ('error') says so with the way to the tools panel: "no tool yet" then sent the person installing a tool they have
  // (the error words were never reached before: the type check found it, 2026-10-10)
  const looking = tools.status === 'idle' || tools.status === 'loading' || tools.status === 'error';
  const btn = looking
    ? `<p class="small" role="status">${esc(t(tools.status === 'error' ? 'aiLoadFailed' : 'aiLoading'))}</p>${tools.status === 'error' ? `<button type="button" class="act-btn primary" data-ai-act="tools" data-fk="job:tools">${icon('plugin')}<span>${esc(t('aiStartCardTools'))}</span></button>` : ''}`
    : tool
    ? `<button type="button" class="act-btn${asNew || planWaits ? '' : ' primary'} job-go" data-job-act="start" data-job-tool="${esc(tool.id)}" data-fk="job:start" aria-describedby="jobWhy"${dis}>${icon('spark')}<span>${esc(t('jobGo'))}</span></button>`
    : `<p class="small">${esc(t('jobNoTool'))}</p><button type="button" class="act-btn primary" data-ai-act="tools" data-fk="job:tools">${icon('plugin')}<span>${esc(t('aiInstallOne'))}</span></button>`;
  // "It shows you its plan first" only for a tool that starts a job in its plan mode with the version installed (planNow,
  // server/tools.mjs; an older server says nothing of it): Codex and OpenCode have none here (ui-states-plan U2)
  const noPlan = tool?.planNow === false ? 'NoPlan' : '';
  const why = !tool ? '' : mode === 'live' ? t(`${noCopy ? 'jobGoWithNoCopy' : 'jobGoWith'}${noPlan}`, { tool: tool.name }) : mode === 'dry' ? t('jobWhyDry') : oneStep ? t('jobWhyOffOne') : t('jobWhyOff');
  // "Turn actions on and start?": the switch's own title, what On means for this job, yes / cancel
  const ask = oneStep && asking
    ? `<div class="flow-confirm" role="group" aria-labelledby="jobQ"><p id="jobQ"><b>${esc(t('actionsSwitchConfirmTitle'))}</b> ${esc(t('jobTurnOnAsk', { tool: tool.name }))}</p><div class="flow-btns"><button type="button" class="act-btn primary" data-job-act="start-on" data-fk="job:start-on">${esc(t('jobTurnOnYes'))}</button><button type="button" class="act-btn" data-job-act="start-no" data-fk="job:start-no">${esc(t('jobTeamNo'))}</button></div></div>`
    : '';
  const follow = data?.step === 'done' ? nextHtml(next) : '';
  const steps = asNew ? '' : stopped && data && STEPS.includes(data.step) && mode === 'live' ? stoppedStepsHtml(data, stopped) : `${stepsHtml(data, { idle, unknown, offline })}${offline ? '' : planActsHtml(data)}`;
  return `<section class="dr-sec job" data-sec="job" aria-labelledby="jobH"><h3 id="jobH">${icon('spark')} ${esc(t(asNew ? 'jobAskNew' : 'jobAsk'))}</h3>${steps}${follow}<div class="job-row">${input}${btn}</div>${ask}${why && !ask ? `<p class="small muted flow-why" id="jobWhy">${esc(why)}</p>` : ''}${cost && tool && !ask ? `<p class="small muted job-cost">${esc(cost)}</p>` : ''}${backup && tool && !ask && !offline && (mode === 'live' || oneStep) ? backup : ''}${historyHtml(data?.history)}</section>`;
}

// Earlier jobs of the project (server/team.mjs jobHistory), folded: what was done before, newest first (pure)
export function historyHtml(list) {
  const rows = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.title === 'string' && x.title).slice(0, 10);
  if (!rows.length) return '';
  const li = rows
    .map((x) => {
      const bits = [x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : '', Number(x.tasks) > 0 ? t('jobHistTasks', { count: Number(x.tasks) }) : '', x.accepted ? t('jobHistAccepted') : x.verdict === 'REVISE' ? t('jobHistRevise') : ''].filter(Boolean).join(' · ');
      return `<li><b>${esc(x.title)}</b>${bits ? `<span class="small muted">${esc(bits)}</span>` : ''}</li>`;
    })
    .join('');
  return `<details class="job-history"><summary class="small">${esc(t('jobHistTitle', { count: rows.length }))}</summary><ul>${li}</ul></details>`;
}

// What a finished job can lead to (seen at Lovable and Replit: the next step offered after a result). Known keys only;
// a web project gets "try it like a user" and "put it online" (kit: try-it-in-browser, deploy-web), every project
// "change something". Pure.
export const NEXT_KEYS = Object.freeze(['change', 'try', 'deploy']);
export function nextFor({ web = false } = {}) {
  return web ? ['change', 'try', 'deploy'] : ['change'];
}
function nextHtml(keys) {
  const list = (Array.isArray(keys) ? keys : []).filter((k) => NEXT_KEYS.includes(k));
  if (!list.length) return '';
  return `<div class="job-next" role="group" aria-label="${esc(t('jobNextTitle'))}"><span class="small muted">${esc(t('jobNextTitle'))}</span>${list.map((k) => `<button type="button" class="act-btn" data-job-next="${k}" data-fk="job:next-${k}">${esc(t(`jobNext_${k}`))}</button>`).join('')}</div>`;
}

// The team's own small section in the drawer's details: installed or not, and "update the team" (pure)
export function teamSectionHtml(p, { mode = 'off', team = null, teamUi = '', updates = 0 } = {}) {
  if (!p || !p.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  const dis = mode === 'dry' || mode === 'live' ? '' : ' aria-disabled="true"';
  const body = teamHtml(team, TEAM_UI.has(teamUi) ? teamUi : '', dis, updates);
  return body ? `<section class="dr-sec job-team-sec" data-sec="team" aria-labelledby="teamH"><h3 id="teamH">${icon('users')} ${esc(t('jobTeamSec'))}</h3><p class="small muted">${esc(t('jobIntro'))}</p>${body}</section>` : '';
}

// Where a job's team and helpers go (pure): the folder the job's own tool reads (server/install.mjs TARGETS). Claude
// Code reads .claude/skills; every other tool reads the shared .agents/skills (checked in each tool's adapter or
// package, 2026-10-07: Codex, Gemini CLI, Antigravity, Copilot, Cursor, Qwen Code, OpenCode). A project Claude Code
// worked in keeps .claude as well, so both tools see the team. Before, a new project's Codex job got .claude only.
// Its agents go to .claude always (Claude Code, Copilot CLI and Cursor CLI read it) and, converted, to the agents folder
// of Gemini CLI, Qwen Code, OpenCode or Codex when the job runs with one of them (server/agentFormats.mjs).
const AGENT_TARGET = Object.freeze({ gemini: 'gemini', qwen: 'qwen', opencode: 'opencode', codex: 'codex' });
export function jobTargets(toolId, via = []) {
  if (!toolId || toolId === 'claude') return ['claude'];
  const out = Array.isArray(via) && via.includes('claude-code') ? ['claude', 'agents'] : ['agents'];
  return AGENT_TARGET[toolId] ? [...out, AGENT_TARGET[toolId]] : out;
}

// Give a job (the drawer's Start and the building's box): the team and the helpers that fit this job are set up in
// one request (live mode; the server skips what is there and never touches an item the project changed), then the AI
// tool starts with the job as its first message (the same path as every start: a restore point first). deps: { mode,
// tools, fetchFit(projectId, idea), runAction, runMenuItem, openDrawer, toast }
export async function giveJob(p, text, deps) {
  const { mode, tools, fetchFit, runAction, runMenuItem, openDrawer, toast = () => {} } = deps;
  const job = String(text || '').trim().slice(0, JOB_MAX);
  if (!job) return { ok: false, error: 'empty' };
  const tool = preferredTool(installedTools(tools));
  if (!tool) return { ok: false, error: 'tool-missing' };
  if (mode === 'live') {
    toast({ tone: 'ok', title: t('jobAsk'), body: t('jobPreparing') });
    let fit = null;
    try {
      // The fit reads the first FIT_READ characters only (IDEA_MAX in server/fit.mjs); a long job in the URL could pass
      // the header limit and the fit would be lost
      fit = await fetchFit(p.id, Array.from(job).slice(0, FIT_READ).join(''));
    } catch {
      fit = null;
    }
    const keys = jobKeys(fit);
    const r = await runAction({ action: 'skills-apply', projectId: p.id, keys, targets: jobTargets(tool.id, p.via) });
    const count = (Number(r?.result?.copied) || 0) + (Number(r?.result?.updated) || 0);
    // Nothing to copy: the team and its helpers are there already ("0 helpers set up" read like a failure, 2026-10-08)
    toast({ tone: r?.ok ? 'ok' : 'warn', title: t('jobAsk'), body: r?.ok ? (count ? t('jobPrepared', { count }) : t('jobPreparedAlready')) : t('jobPrepareSkipped') });
  }
  const it = { id: `start-ai:${tool.id}`, label: t('jobStartWith', { tool: tool.name }), action: 'start-ai', payload: { projectId: p.id, tool: tool.id, job }, name: p.name, toolName: tool.name };
  const openSkills = (x) => openDrawer?.({ ...x, section: 'skills' });
  return runMenuItem(it, { target: { type: 'project', id: p.id }, openDrawer, openSkills, toast });
}

// The fit of a project for a job's words (GET /api/projects/<id>/fit, read-only)
export async function fetchFitFor(projectId, idea, { signal = undefined } = {}) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/fit?idea=${encodeURIComponent(idea)}`, { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Answers per project (asked again after ttl ms, so the bar follows the AI's work), the typed text and the team step
export function createJob({ fetchJson = fetchTeam, onData = (_projectId) => {}, now = () => Date.now(), ttl = 8000 } = {}) {
  const cache = new Map();
  const texts = new Map();
  const uis = new Map();
  const updates = new Map(); // the team items a preview found newer, per project
  function get(projectId) {
    const e = cache.get(projectId);
    if (e && (e.pending || now() - e.at < ttl)) return e;
    const next = { at: e?.at || 0, data: e?.data || null, pending: true };
    cache.set(projectId, next);
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => cache.set(projectId, { at: now(), data, pending: false }),
        () => cache.set(projectId, { at: now(), data: next.data, pending: false }),
      )
      .then(() => {
        try {
          onData(projectId);
        } catch (err) {
          console.error(err);
        }
      });
    return next;
  }
  return {
    get,
    text: (projectId) => texts.get(projectId) || '',
    setText: (projectId, v) => texts.set(projectId, String(v || '').slice(0, JOB_MAX)),
    ui: (projectId) => uis.get(projectId) || '',
    setUi: (projectId, v) => uis.set(projectId, TEAM_UI.has(v) ? v : ''),
    updates: (projectId) => updates.get(projectId) || [],
    setUpdates: (projectId, list) => updates.set(projectId, Array.isArray(list) ? list : []),
    html: (p, opts = {}) => (p?.path ? jobSectionHtml(p, get(p.id).data, { ...opts, text: texts.get(p.id) || '' }) : ''),
    teamHtml: (p, opts = {}) => (p?.path ? teamSectionHtml(p, { ...opts, teamUi: uis.get(p.id) || '', updates: (updates.get(p.id) || []).length }) : ''),
  };
}
