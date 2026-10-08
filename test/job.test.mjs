// "Do a job" in the drawer (public/js/views/job.js, docs/kit-in-app.md): the section, the progress words, the team keys
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLanguage, STRINGS } from '../public/js/i18n.js';
import { nextFor, NEXT_KEYS, jobSectionHtml, teamSectionHtml, jobNowText, stepsHtml, aiIdleIn, teamInstalled, teamUpdates, createJob, preferredTool, jobKeys, giveJob, TEAM_KEYS, TEAM_ITEMS, JOB_MAX, KEYS_MAX } from '../public/js/views/job.js';
import { jobOf } from '../public/js/hq-live.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
after(() => setLanguage('en'));
setLanguage('en');
const S = STRINGS.en;
const P = { id: 'demo', name: 'Demo', path: 'C:\\p\\demo', exists: true };
const TOOLS = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true, ready: 'yes' }, { id: 'codex', name: 'Codex CLI', installed: true, ready: 'yes' }] };
const NONE = { status: 'ready', tools: [] };

test('section: one question, one box, one Start with the chosen tool; disabled when actions are off; the text is kept and escaped', () => {
  const live = jobSectionHtml(P, null, { mode: 'live', tools: TOOLS, text: '<b>giriş</b> "sayfası"' });
  assert.equal((live.match(/data-job-act="start"/g) || []).length, 1, 'one Start (docs/simplify.md)');
  assert.ok(live.includes('data-job-tool="claude"'), 'Claude Code when nothing was chosen');
  assert.ok(live.includes(S.jobAsk) && live.includes(S.jobGoWith.replace('{tool}', 'Claude Code')));
  assert.ok(!live.includes('aria-disabled'), 'live: enabled');
  // A textarea now (several lines, review U06): the text inside it, escaped
  assert.ok(live.includes('>&lt;b&gt;giriş&lt;/b&gt; &quot;sayfası&quot;</textarea>'), 'the text is escaped');
  assert.ok(live.includes('<textarea') && live.includes('rows="3"'));
  assert.ok(live.includes(`maxlength="${JOB_MAX}"`));
  assert.ok(!live.includes('data-job-act="team'), 'no team step in the section: Start sets it up');
  const off = jobSectionHtml(P, null, { mode: 'off', tools: TOOLS });
  assert.equal((off.match(/aria-disabled="true"/g) || []).length, 1, 'off: the Start disabled');
  assert.ok(off.includes(S.jobWhyOff));
  // Off in the desktop app (it can turn actions on): Start stays pressable and asks once, with yes and cancel
  const one = jobSectionHtml(P, null, { mode: 'off', tools: TOOLS, turnOn: true });
  assert.ok(!one.includes('aria-disabled') && one.includes(S.jobWhyOffOne) && !one.includes('data-job-act="start-on"'), 'off + turnOn: enabled, not asking yet');
  const asking = jobSectionHtml(P, null, { mode: 'off', tools: TOOLS, turnOn: true, asking: true });
  assert.ok(asking.includes('data-job-act="start-on"') && asking.includes('data-job-act="start-no"') && asking.includes(S.actionsSwitchConfirmTitle), 'the question');
  assert.ok(asking.includes(S.jobTurnOnAsk.replace('{tool}', 'Claude Code')), 'it names the tool that starts');
  assert.ok(!jobSectionHtml(P, null, { mode: 'live', tools: TOOLS, turnOn: true, asking: true }).includes('start-on'), 'never asked once On');
  assert.ok(!jobSectionHtml(P, null, { mode: 'off', tools: NONE, turnOn: true, asking: true }).includes('start-on'), 'no tool: the tools panel, not the question');
  const none = jobSectionHtml(P, null, { mode: 'live', tools: NONE });
  assert.ok(none.includes(S.jobNoTool) && none.includes('data-ai-act="tools"'), 'no tool: the tools panel');
  const looking = jobSectionHtml(P, null, { mode: 'live', tools: { status: 'loading', tools: [] } });
  assert.ok(looking.includes(S.aiLoading) && !looking.includes(S.jobNoTool), 'still looking: not "no tool"');
  for (const q of [{ ...P, broad: true }, { ...P, tmpOnly: true }, { ...P, exists: false }, { ...P, path: '' }, { ...P, kind: 'hub' }]) assert.equal(jobSectionHtml(q, null, { mode: 'live', tools: TOOLS }), '');
});

test('the tool a job starts with: the chosen one when installed, else Claude Code, else the first found', () => {
  const found = TOOLS.tools;
  assert.equal(preferredTool(found, 'codex').id, 'codex');
  assert.equal(preferredTool(found, 'gemini').id, 'claude', 'chosen but not installed: Claude Code');
  assert.equal(preferredTool([{ id: 'gemini', name: 'Gemini CLI' }], '').id, 'gemini');
  assert.equal(preferredTool([], 'claude'), null);
  assert.ok(jobSectionHtml(P, null, { mode: 'live', tools: TOOLS }).includes('data-job-tool="claude"'));
});

test('what a job sets up: the team, then the helpers the server chose for its words, within one request', () => {
  const fit = {
    candidates: [
      { key: 'skill:web-app-starter', selected: true, installable: true, installed: false },
      { key: 'skill:debug-helper', selected: false, installable: true, installed: false },
      { key: 'skill:ui-polish', selected: true, installable: true, installed: true },
      { key: 'skill:from-elsewhere', selected: true, installable: false, installed: false },
      { key: 'skill:orchestrate', selected: true, installable: true, installed: false },
    ],
  };
  const keys = jobKeys(fit);
  assert.deepEqual(keys.slice(0, TEAM_KEYS.length), [...TEAM_KEYS], 'the team first');
  assert.ok(keys.includes('skill:web-app-starter'), 'a chosen helper');
  assert.ok(!keys.includes('skill:debug-helper') && !keys.includes('skill:ui-polish') && !keys.includes('skill:from-elsewhere'), 'not chosen, installed or not installable: left out');
  assert.equal(new Set(keys).size, keys.length, 'no repeats');
  assert.deepEqual(jobKeys(null), [...TEAM_KEYS]);
  const many = { candidates: Array.from({ length: 30 }, (_, i) => ({ key: `skill:x${i}`, selected: true, installable: true })) };
  assert.equal(jobKeys(many).length, KEYS_MAX, 'the server takes at most 25 keys');
});

test('giving a job: helpers set up first (live only), then the AI starts with the job; empty and no tool stop', async () => {
  const calls = [];
  const deps = (mode) => ({
    mode,
    tools: TOOLS,
    fetchFit: async (id, idea) => (calls.push(['fit', id, idea]), { candidates: [{ key: 'skill:web-app-starter', selected: true, installable: true }] }),
    runAction: async (body) => (calls.push(['action', body.action, body.keys.length]), { ok: true, mode, result: { copied: 3, updated: 1 } }),
    runMenuItem: async (it) => (calls.push(['start', it.action, it.payload]), { ok: true, mode }),
    toast: (o) => calls.push(['toast', o.body]),
  });
  const r = await giveJob(P, '  giriş sayfası ekle  ', deps('live'));
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => c[0] !== 'toast').map((c) => c[0]), ['fit', 'action', 'start'], 'fit, set up, then start');
  assert.deepEqual(calls.find((c) => c[0] === 'start')[2], { projectId: 'demo', tool: 'claude', job: 'giriş sayfası ekle' });
  assert.equal(calls.find((c) => c[0] === 'fit')[2], 'giriş sayfası ekle');
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === S.jobPrepared.replace('{count}', '4')));
  calls.length = 0;
  // Nothing to copy (the team is there from the last job): said as ready, not "0 helpers set up"
  await giveJob(P, 'renkleri değiştir', { ...deps('live'), runAction: async () => ({ ok: true, mode: 'live', result: { copied: 0, updated: 0 } }) });
  assert.ok(calls.some((c) => c[0] === 'toast' && c[1] === S.jobPreparedAlready));
  calls.length = 0;
  await giveJob(P, 'x', deps('dry'));
  assert.deepEqual(calls.map((c) => c[0]), ['start'], 'Preview: nothing is set up, the start shows what it would do');
  assert.deepEqual(await giveJob(P, '   ', deps('live')), { ok: false, error: 'empty' });
  assert.deepEqual(await giveJob(P, 'x', { ...deps('live'), tools: NONE }), { ok: false, error: 'tool-missing' });
});

test('the team in the details: installed or not, and its update; "not known yet" shows nothing', () => {
  assert.ok(teamSectionHtml(P, { mode: 'live', team: false }).includes('data-job-act="team"'));
  assert.equal(teamSectionHtml(P, { mode: 'live', team: null }), '', 'not known yet: nothing');
  const c = teamSectionHtml(P, { mode: 'live', team: false, teamUi: 'confirm' });
  assert.ok(c.includes('data-job-act="team-yes"') && c.includes('data-job-act="team-no"') && c.includes(S.jobTeamConfirm));
  assert.ok(teamSectionHtml(P, { mode: 'live', team: false, teamUi: 'busy' }).includes(S.jobTeamBusy));
  assert.ok(teamSectionHtml(P, { mode: 'live', team: true, teamUi: 'done' }).includes(S.jobTeamDone));
  assert.equal(teamInstalled({ candidates: [{ key: 'skill:orchestrate', installed: true }] }), true);
  assert.equal(teamInstalled({ candidates: [], excluded: [{ key: 'skill:orchestrate', installed: false }] }), false);
  assert.equal(teamInstalled(null), null);
  // The real answer carries excluded as a number (the soak test caught it)
  assert.equal(teamInstalled({ candidates: [{ key: 'skill:orchestrate', installed: false }], excluded: 12 }), false);
  const installed = teamSectionHtml(P, { mode: 'live', team: true });
  assert.ok(installed.includes('data-job-act="team-check"') && installed.includes(S.jobTeamCheck));
  assert.ok(teamSectionHtml(P, { mode: 'off', team: true }).includes('data-job-act="team-check" data-fk="job:team-check" aria-disabled="true"'));
  const ask = teamSectionHtml(P, { mode: 'live', team: true, teamUi: 'update', updates: 3 });
  assert.ok(ask.includes('data-job-act="team-update-yes"') && ask.includes(STRINGS.en.jobTeamUpdateConfirm.replace('{count}', '3')));
  for (const [ui, key] of [['current', 'jobTeamCurrent'], ['updating', 'jobTeamUpdating'], ['updated', 'jobTeamUpdated'], ['update-failed', 'jobTeamUpdateFailed']]) assert.ok(teamSectionHtml(P, { mode: 'live', team: true, teamUi: ui }).includes(S[key]), ui);
  assert.equal(TEAM_ITEMS.length, TEAM_KEYS.length);
  assert.deepEqual(TEAM_ITEMS[0], { kind: 'skill', name: 'orchestrate' });
  const plan = [
    { op: 'update', kind: 'skill', name: 'orchestrate', reason: 'kit-changed', target: 'claude' },
    { op: 'update', kind: 'skill', name: 'orchestrate', reason: 'kit-changed', target: 'agents' },
    { op: 'skip', kind: 'skill', name: 'orchestrate-build', reason: 'up-to-date' },
    { op: 'update', kind: 'skill', name: 'not-the-team', reason: 'kit-changed' },
    { op: 'update', kind: 'agent', name: 'planner', reason: 'kit-changed' },
  ];
  assert.deepEqual(teamUpdates(plan), [{ kind: 'skill', name: 'orchestrate' }, { kind: 'agent', name: 'planner' }]);
  const j = createJob({ fetchJson: async () => null });
  j.setUpdates('p', [{ kind: 'skill', name: 'orchestrate' }]);
  assert.equal(j.updates('p').length, 1);
});

test('progress: the four steps with the current one marked, and one plain sentence', () => {
  const d = { step: 'build', tasks: { total: 3, todo: 1, doing: 1, done: 1, blocked: 0 }, current: { id: 'T2', title: 'Implement', owner: 'builder', status: 'doing' }, review: null };
  const h = jobSectionHtml(P, d, { mode: 'live', tools: TOOLS });
  assert.ok(h.includes('<li class="done">Plan</li><li class="now" aria-current="step">Build</li>'), h);
  assert.equal(jobNowText(d), 'Working on T2 Implement. 1 of 3 tasks done.');
  assert.equal(jobNowText({ ...d, current: { ...d.current, status: 'blocked' } }), 'T2 Implement is stuck: the AI will say why in the terminal.');
  assert.equal(jobNowText({ step: 'check', tasks: d.tasks, review: { verdict: 'REVISE', blockers: 2 } }), 'The check found 2 problems; they are being fixed.');
  assert.equal(jobNowText({ step: 'finish', tasks: d.tasks, review: { verdict: 'APPROVE', blockers: 0 } }), S.jobNowFinish);
  assert.equal(jobNowText({ step: 'none' }), '');
  // The plan step says what is really there (seen when using the app: "waiting for your approval" before any plan)
  assert.equal(jobNowText({ step: 'plan', plan: null }), S.jobNowPlanWriting, 'no plan yet: being written');
  assert.equal(jobNowText({ step: 'plan', plan: { approved: false } }), S.jobNowPlan, 'a plan: waits for the person');
  assert.equal(jobNowText({ step: 'plan', plan: { approved: true } }), S.jobNowPlanSlicing, 'approved, no tasks yet');
  assert.equal(jobNowText(jobOf({ step: 'plan', plan: { approved: false, title: 'x' } })), S.jobNowPlan, 'the building says the same');
  assert.equal(jobNowText(jobOf({ step: 'plan', plan: null })), S.jobNowPlanWriting);
  // The tool closed before writing a plan (its trust question cancelled) and nothing runs: said so, with what to do
  assert.equal(jobNowText({ step: 'plan', plan: null }, { idle: true }), S.jobNowPlanIdle);
  assert.equal(jobNowText({ step: 'plan', plan: { approved: false } }, { idle: true }), S.jobNowPlan, 'a written plan still waits for the person');
  assert.ok(stepsHtml({ step: 'plan', plan: null }, { idle: true }).includes(S.jobNowPlanIdle));
  assert.ok(jobSectionHtml(P, { step: 'plan', plan: null }, { mode: 'live', tools: TOOLS, idle: true }).includes(S.jobNowPlanIdle), 'the drawer passes it on');
  assert.equal(aiIdleIn({ sessions: [], projectId: 'p', dock: [] }), true);
  assert.equal(aiIdleIn({ sessions: [{ projectId: 'p', live: true }], projectId: 'p', dock: [] }), false, 'a live session works there');
  assert.equal(aiIdleIn({ sessions: [{ projectId: 'q', live: true }, { projectId: 'p', live: false }], projectId: 'p', dock: [{ projectId: 'q' }] }), true, 'others work elsewhere');
  assert.equal(aiIdleIn({ sessions: [], projectId: 'p', dock: [{ projectId: 'p', tool: 'claude' }] }), false, 'an AI tab runs in the terminal');
  assert.equal(aiIdleIn({ sessions: [], projectId: null }), false);
  // The person accepted the result: every step ticked, none current
  const doneData = { step: 'done', plan: { title: 'x', approved: true, accepted: true }, tasks: d.tasks, current: null, review: { verdict: 'APPROVE', blockers: 0, nits: 0 } };
  assert.equal(jobNowText(doneData), S.jobNowDone);
  const doneHtml = jobSectionHtml({ id: 'p', path: 'C:\\p' }, doneData, { mode: 'live' });
  assert.equal((doneHtml.match(/<li class="done"/g) || []).length, 4);
  assert.ok(!doneHtml.includes('aria-current'));
  assert.ok(!jobSectionHtml(P, { step: 'none' }, { mode: 'live', tools: TOOLS }).includes('job-steps'), 'no job yet: no bar');
});

test('cache: asked once per ttl, the answer redraws; the typed text is cut at the limit', async () => {
  let asked = 0;
  let drawn = 0;
  let clock = 0;
  const j = createJob({ fetchJson: async () => (asked++, { step: 'plan' }), onData: () => drawn++, now: () => clock, ttl: 1000 });
  j.get('a');
  j.get('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([asked, drawn, j.get('a').data.step], [1, 1, 'plan']);
  clock = 2000;
  j.get('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 2);
  j.setText('a', 'x'.repeat(JOB_MAX + 50));
  assert.equal(j.text('a').length, JOB_MAX);
  j.setUi('a', 'nonsense');
  assert.equal(j.ui('a'), '');
});

test('every team key names an item of the SiberSentez kit; the drawer leads with the job, folds the rest, and Start goes through giveJob', () => {
  const kit = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'catalog.json'), 'utf8'));
  const names = new Set(kit.items.map((i) => `${i.kind}:${i.name}`));
  for (const k of TEAM_KEYS) assert.ok(names.has(k), `${k} is in the kit`);
  const drawer = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'drawer.js'), 'utf8');
  const job = drawer.indexOf("${resultFirst ? '' : jobBox}");
  const rest = drawer.indexOf('${restore.html(p,');
  const late = drawer.indexOf("${resultFirst ? jobBox : ''}");
  const more = drawer.indexOf('<details class="dr-more"');
  const fit = drawer.indexOf('${fitSection(p)}');
  assert.ok(job > 0 && rest > job && late > rest && more > late && fit > more, 'the job (after the result while it waits), the restore points, then Details with the skills inside');
  assert.ok(drawer.includes("const resultFirst = job.get(p.id).data?.step === 'finish';") && drawer.includes('asNew: resultFirst, idle: aiIdleIn('), 'the result first only while it waits (review U07)');
  assert.ok(drawer.includes('giveJob(p, text, { mode, tools: toolsState(), fetchFit: fetchFitFor, runAction, runMenuItem, openDrawer: open, toast })'), 'Start: the shared path');
  const jobSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'job.js'), 'utf8');
  assert.ok(jobSrc.includes("payload: { projectId: p.id, tool: tool.id, job }"), 'the job rides in the request');
  assert.ok(jobSrc.includes("runAction({ action: 'skills-apply', projectId: p.id, keys, targets: jobTargets(tool.id, p.via) })"), 'the team and helpers through the fit install, where the job’s own tool reads them');
  // The team's update stays: a preview of the team (writes nothing), then an install of exactly what it found newer
  assert.ok(drawer.includes("runAction({ action: 'skills-preview', projectId: p.id, items: [...TEAM_ITEMS] })"));
  assert.ok(drawer.includes("runAction({ action: 'skills-install', projectId: p.id, items })"));
  // The building's box uses the same Start
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.ok(main.includes('return giveJob(p, text, { mode: actionsState().mode, tools: toolsState(), fetchFit: fetchFitFor, runAction, runMenuItem, openDrawer: open, toast: actionToastHere });'));
  for (const lang of ['en', 'tr']) for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('job') || x.startsWith('setTool') || x.startsWith('drMore'))) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});

test('a check in the middle of the build that asked for fixes is said beside the task (seen in a real job, 2026-10-01)', () => {
  const d = { step: 'build', tasks: { done: 4, total: 5 }, current: { id: 'T5', title: 'Story bible', status: 'todo' }, review: { verdict: 'REVISE', blockers: 3, tasks: ['T2', 'T3'] } };
  const text = jobNowText(d);
  assert.match(text, /T5 Story bible/);
  assert.match(text, /3/);
  assert.notEqual(text, jobNowText({ ...d, review: null }), 'without the check, the sentence is the task only');
  assert.equal(jobNowText({ ...d, review: { verdict: 'APPROVE', blockers: 0 } }), jobNowText({ ...d, review: null }));
});

test('a job whose AI no longer runs: the drawer says where it stopped and offers to go on (live), the Building uses the same rule', async () => {
  const { stoppedSession, stoppedStepsHtml, jobSectionHtml } = await import('../public/js/views/job.js');
  const now = Date.now();
  const closed = (id, lastAt) => ({ id, projectId: 'p', lastAt, live: null });
  assert.equal(stoppedSession([closed('a', now - 5000), closed('b', now - 1000), { id: 'x', projectId: 'q', live: null }], 'p', now).id, 'b', 'the last one of the project');
  assert.equal(stoppedSession([closed('a', now), { id: 'c', projectId: 'p', live: { status: 'busy' } }], 'p', now), null, 'one still runs');
  assert.equal(stoppedSession([], 'p', now), null);
  const d = { step: 'build', tasks: { done: 4, total: 5 }, current: { id: 'T5', title: 'Story bible', status: 'todo' }, review: null };
  const html = stoppedStepsHtml(d, { id: 'sess-1' });
  assert.equal((html.match(/job-now/g) || []).length, 1, 'one sentence: where it stopped, not what is worked on');
  assert.ok(!html.includes('T5 Story bible'), 'no "working on" any more');
  assert.match(html, /data-job-act="resume" data-job-session="sess-1"/);
  const p = { id: 'p', name: 'P', path: 'C:\p', kind: 'adhoc' };
  const tools = { status: 'ready', tools: [] };
  assert.match(jobSectionHtml(p, d, { mode: 'live', tools, stopped: { id: 'sess-1' } }), /data-job-act="resume"/);
  assert.doesNotMatch(jobSectionHtml(p, d, { mode: 'off', tools, stopped: { id: 'sess-1' } }), /data-job-act="resume"/, 'not while actions are off');
  assert.doesNotMatch(jobSectionHtml(p, d, { mode: 'live', tools, stopped: null }), /data-job-act="resume"/);
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('stopped: drawerResume(p.id)') && drawer.includes('return resumeCandidate({ sessions: store.sessions.values(), projectId, job: shown, dock: store.dockRunning?.() || [] });'), "the Building's own rule");
  assert.ok(drawer.includes("action: 'resume-session', sessionId: btn.dataset.jobSession"));
});

// 2026-10-02: a finished job offers what comes next (competitors offer the next step after a result); each one only
// fills the box with a sentence that reaches the right kit skill (test/kit.test.mjs IDEAS)
test('a finished job offers its follow-ups: only when done; a web project gets try and deploy, every project change', () => {
  assert.deepEqual(nextFor({ web: true }), ['change', 'try', 'deploy']);
  assert.deepEqual(nextFor({ web: false }), ['change']);
  const done = jobSectionHtml(P, { step: 'done' }, { mode: 'live', tools: TOOLS, next: nextFor({ web: true }) });
  for (const k of NEXT_KEYS) assert.ok(done.includes(`data-job-next="${k}"`) && done.includes(S[`jobNext_${k}`]), k);
  assert.ok(!jobSectionHtml(P, { step: 'build' }, { mode: 'live', tools: TOOLS, next: nextFor({ web: true }) }).includes('data-job-next'), 'not while it is built');
  assert.ok(!jobSectionHtml(P, { step: 'done' }, { mode: 'live', tools: TOOLS, next: ['rm -rf'] }).includes('data-job-next'), 'known keys only');
  for (const lang of ['en', 'tr']) for (const k of NEXT_KEYS) assert.ok(STRINGS[lang][`jobNextText_${k}`], `${lang} ${k}`);
  const drawer = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'drawer.js'), 'utf8');
  assert.ok(drawer.includes('next: nextFor({ web: isWebRun(runHint.get(p.id).data) })') && drawer.includes("return fillJob(current.id, t(`jobNextText_${jn.dataset.jobNext}`));"), 'the drawer fills the box');
  const fill = drawer.slice(drawer.indexOf('const fillJob = '), drawer.indexOf('bindRunHint(body,'));
  assert.ok(fill.includes('job.setText(projectId, text);') && !/startJob|data-job-act|dispatch/.test(fill), 'never starts');
});

test('jobNowText: no empty task name in the sentence (the Building\'s example said "Working on . 0 of 4 tasks done.")', () => {
  setLanguage('en');
  assert.equal(jobNowText({ step: 'build', current: null, tasks: { done: 0, total: 4 } }), '0 of 4 tasks done.');
  assert.equal(jobNowText({ step: 'build', current: { id: '', title: '', status: 'blocked' }, tasks: { done: 1, total: 4 } }), 'A task is stuck: the AI will say why in the terminal.');
  assert.equal(jobNowText({ step: 'build', current: { id: 'T2', title: 'Menu page' }, tasks: { done: 1, total: 4 } }), 'Working on T2 Menu page. 1 of 4 tasks done.');
  setLanguage('tr');
  assert.equal(jobNowText({ step: 'build', current: null, tasks: { done: 0, total: 4 } }), '4 görevden 0 tanesi bitti.');
  setLanguage('en');
});

test("a job's team goes where its own tool reads it: Claude Code .claude, every other tool .agents, both where Claude Code worked too", async () => {
  const { jobTargets } = await import('../public/js/views/job.js');
  assert.deepEqual(jobTargets('claude', ['codex']), ['claude']);
  assert.deepEqual(jobTargets('codex', []), ['agents', 'codex'], 'a new project: Codex sees its team and its agents (before: .claude only)');
  assert.deepEqual(jobTargets('gemini', ['claude-code']), ['claude', 'agents', 'gemini']);
  for (const id of ['qwen', 'opencode']) assert.deepEqual(jobTargets(id, undefined), ['agents', id], id);
  // Copilot CLI and Cursor CLI read .claude/agents, where an agent always goes
  for (const id of ['copilot', 'cursor']) assert.deepEqual(jobTargets(id, undefined), ['agents'], id);
  assert.deepEqual(jobTargets(null), ['claude']);
});

test('a job of several lines (review U06): the server keeps its lines and cuts at JOB_MAX; the count shows near the limit only; Ctrl+Enter starts', async () => {
  const { normalizeJob, JOB_MAX: SERVER_MAX } = await import('../server/fit.mjs');
  const { JOB_MAX: PAGE_MAX, jobCountText } = await import('../public/js/views/job.js');
  assert.equal(SERVER_MAX, PAGE_MAX, 'the page and the server agree');
  assert.equal(normalizeJob('  Menü sayfası ekle  \r\n\r\n\r\n\r\n- fiyatlar   olsun\n\t- fotoğraflar '), 'Menü sayfası ekle\n\n- fiyatlar olsun\n- fotoğraflar');
  assert.equal(Array.from(normalizeJob('ş'.repeat(SERVER_MAX + 50))).length, SERVER_MAX);
  assert.equal(normalizeJob(String.fromCharCode(0, 7, 27) + 'x'), 'x');
  assert.equal(normalizeJob(42), '');
  assert.equal(jobCountText('kısa'), '');
  assert.ok(jobCountText('a'.repeat(PAGE_MAX - 10)).includes(String(PAGE_MAX)));
  const { jobMessageText } = await import('../server/launch.mjs');
  const msg = jobMessageText('Menü sayfası\n- fiyatlar', 'J' + '0123456789abcdef'.repeat(2));
  assert.ok(msg.includes('> Menü sayfası\n> - fiyatlar'), 'each line quoted in the job file');
  const actions = fs.readFileSync(path.join(ROOT, 'server', 'actions.mjs'), 'utf8');
  assert.ok(actions.includes('job = normalizeJob(body.job);'));
  const drawer = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'drawer.js'), 'utf8');
  assert.ok(drawer.includes("if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;"));
  const ws = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'workshop.js'), 'utf8');
  assert.ok(ws.includes('<textarea id="wsGiveText"') && ws.includes("$('give').requestSubmit();"));
});
