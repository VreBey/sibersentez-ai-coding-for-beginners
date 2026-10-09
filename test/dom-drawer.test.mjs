// The project drawer in a browser (plan D1, happy-dom): the result's ways, the plan's approval, going back to before a
// job (preview, then the one yes in live mode) and a restore cut off halfway, driven by clicks against a fake server.
// Run: node --test test/dom-drawer.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settle, win, click, requests, setRoutes, addRoutes, closeWindow } from './dom/env.mjs';

after(() => closeWindow());
const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
const { store } = await import('../public/js/store.js');
const { initActions } = await import('../public/js/actions.js');
const { createDrawer } = await import('../public/js/views/drawer.js');
const { setRunAsker } = await import('../public/js/runHint.js');
setLanguage('tr');
const S = STRINGS.tr;

const JOB = 'J' + 'b'.repeat(32);
const POINT = 'R20261009090001aaaa';
const BEFORE = 'R20261009090002bbbb';
const TOKEN = 'a'.repeat(64);
let team = { project: 'kafe', step: 'finish', plan: { title: 'Kafe menü sayfası', approved: true, accepted: false, jobId: JOB }, tasks: { total: 1, done: 1 }, review: { verdict: 'APPROVE' }, history: [] };
let restore = { project: 'kafe', points: [{ id: BEFORE, at: 2, reason: 'before-restore', files: 3 }, { id: POINT, at: 1, reason: 'ai-start', files: 3, label: 'sayfa yap' }], keep: 5, jobs: [{ jobId: JOB, at: 1, id: POINT, available: true }], interrupted: null };
const actionPosts = () => requests.filter((r) => r.key === 'POST /api/action').map((r) => r.body);
setRoutes({
  'GET /api/actions': { mode: 'live', token: TOKEN, actions: ['restore-preview', 'restore-apply', 'start-ai'] },
  'GET /api/projects/kafe/team': () => team,
  'GET /api/projects/kafe/restore': () => restore,
  'GET /api/projects/kafe/run': { project: 'kafe', plans: [{ kind: 'web', steps: [{ id: 'open', file: 'index.html' }] }] },
  'GET /api/projects/kafe/job-changes': { basis: 'start', added: ['index.html'], changed: [], deleted: [], notes: 2 },
  'GET /api/projects/kafe/changes': { project: 'kafe', via: 'time', files: [] },
  'GET /api/projects/kafe/fit': { project: 'kafe', items: [], tags: [] },
  'GET /api/projects/kafe/suggestions': { items: [] },
  'GET /api/usage': { totals: { messages: 0 }, models: [], days: [] },
  'GET /api/usage/jobs': { jobs: [{ projectId: 'kafe', jobId: JOB, at: 1, until: 2, messages: 4, processed: 52000, output: 9000, usd: 2.1 }], estimate: { jobs: 3, low: 1.4, high: 2.8, median: 2 } },
  'GET /api/tools': { at: 1, tools: [{ id: 'claude', name: 'Claude Code', installed: true, chosen: { ext: '.exe' }, version: '2.1.284', ready: 'yes' }], node: { installed: true }, git: { installed: true, onPath: true } },
  'POST /api/action': (u, init) => {
    const b = JSON.parse(init.body);
    if (b.action === 'restore-preview') return { ok: true, mode: 'live', action: b.action, point: { id: b.pointId }, planId: 'p1', changed: [], missing: [], added: ['index.html'], counts: { changed: 0, missing: 0, added: 1 }, notes: { changed: 0, missing: 0, added: 0 }, result: { executed: false } };
    if (b.action === 'restore-apply') return { ok: true, mode: 'live', action: b.action, before: BEFORE, planId: 'p1', counts: { changed: 0, missing: 0, added: 1 }, result: { executed: true, restored: 0, removed: 1, failed: [] } };
    return { ok: true };
  },
});

store.load(JSON.parse(fs.readFileSync(new URL('./dom/fixtures/snapshot.json', import.meta.url), 'utf8')));
await initActions();
const drafts = [];
let aiRuns = true;
setRunAsker((projectId, text) => (aiRuns ? (drafts.push([projectId, text]), { ok: true }) : { ok: false, reason: 'no-ai' }), () => aiRuns);
const drawerEl = win.document.createElement('aside');
drawerEl.innerHTML = '<button class="drawer-close"></button><div class="drawer-body" data-k="body"></div>';
const scrim = win.document.createElement('div');
win.document.body.append(drawerEl, scrim);
const toasts = [];
const drawer = createDrawer(drawerEl, scrim, { toast: (t) => toasts.push(t) });
const body = drawerEl.querySelector('[data-k=body]');
const $ = (sel) => body.querySelector(sel);
// The drawer keeps its answers a few seconds; the clock moves on so a reopening asks the server again
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => (skew += 60000);
// The drawer asks the server, then draws again: a few rounds until the answers are in
const openKafe = async () => {
  drawer.open({ type: 'project', id: 'kafe' });
  for (let i = 0; i < 6; i++) {
    await settle(4);
    drawer.rerender?.();
  }
};

test('the result waits: its ways first, Open leads; this job\'s cost; Accept and Change are drafts for the AI, never Enter', async () => {
  await openKafe();
  const acts = $('.jr-acts');
  assert.ok(acts, 'the result\'s row');
  assert.match(acts.querySelector('[data-jr-act="open"]').className, /primary/);
  // In sight: what a closed Details section holds is not on the screen
  const shown = [...body.querySelectorAll('.act-btn.primary')].filter((b) => !b.closest('details:not([open])'));
  assert.deepEqual(shown.map((b) => b.dataset.fk), ['jr:open'], 'one primary in sight: the result’s Open (review B/C)');
  assert.ok($('.jr-cost')?.textContent.includes('52 bin token'), 'this job\'s usage (dollars are hidden by default: its tokens)');
  click($('[data-jr-act="accept"]'));
  assert.deepEqual(drafts.at(-1), ['kafe', S.jrAcceptDraft]);
  click($('[data-jr-act="change"]'));
  assert.deepEqual(drafts.at(-1), ['kafe', S.jrChangeDraft]);
  click($('[data-jr-act="explain"]'));
  assert.deepEqual(drafts.at(-1), ['kafe', S.jrExplainDraft]);
  assert.ok(drafts.every(([, d]) => !/[\r\n]/.test(d)));
  assert.equal(actionPosts().filter((b) => b.action === 'start-ai').length, 0, 'nothing started');
});

test('no AI in the terminal: a change goes into the job box (Start stays the person\'s); acceptance says what to do', async () => {
  aiRuns = false;
  click($('[data-jr-act="change"]'));
  await settle();
  assert.equal($('[data-fk="job:text"]').value, S.jobNextText_change);
  click($('[data-jr-act="accept"]'));
  assert.equal(toasts.at(-1)?.body, S.jrAcceptNoAi);
  aiRuns = true;
});

test('going back to before the job: the preview first, then the one yes; the present is kept (before) and said', async () => {
  click($(`[data-rst-act="preview"][data-rst-id="${POINT}"]`));
  await settle(8);
  assert.deepEqual(actionPosts().at(-1), { action: 'restore-preview', projectId: 'kafe', pointId: POINT });
  drawer.rerender?.();
  const yes = $('[data-rst-act="yes"]');
  assert.ok(yes, 'live mode asks once');
  click(yes);
  await settle(8);
  const apply = actionPosts().at(-1);
  assert.equal(apply.action, 'restore-apply');
  assert.equal(apply.pointId, POINT);
  assert.equal(apply.planId, 'p1', 'the plan the person saw');
  assert.ok(toasts.some((t) => t.title === S.rstTitle), 'the result is said');
});

test('a restore cut off halfway: said first, with its two ways out', async () => {
  restore = { ...restore, interrupted: { at: Date.UTC(2026, 9, 9, 9), to: POINT, before: BEFORE, toAvailable: true, beforeAvailable: true } };
  drawer.close?.();
  later();
  await settle();
  await openKafe();
  const cut = $('.rst-cut');
  assert.ok(cut && cut.textContent.includes('yarıda kesildi'));
  assert.ok(cut.querySelector(`[data-rst-id="${POINT}"]`) && cut.querySelector(`[data-rst-id="${BEFORE}"]`));
});

test('the plan waits: Approve leads (Start is not primary), a click is a draft for the AI', async () => {
  team = { ...team, step: 'plan', plan: { title: 'Kafe', approved: false, jobId: JOB }, review: null };
  drawer.close?.();
  later();
  await settle();
  await openKafe();
  const ok = $('[data-jr-act="plan-ok"]');
  assert.ok(ok && /primary/.test(ok.className));
  assert.ok(!/primary/.test($('[data-job-act="start"]')?.className || ''), 'one primary');
  click(ok);
  assert.deepEqual(drafts.at(-1), ['kafe', S.jobPlanOkDraft]);
});

test('a finished web job: "Put it online" first looks through the project (plan E1), then writes the steps into the job box; nothing starts', async () => {
  team = { ...team, step: 'done', plan: { title: 'Kafe', approved: true, accepted: true, jobId: JOB }, review: { verdict: 'APPROVE' } };
  addRoutes({ 'GET /api/projects/kafe/run': { project: 'kafe', plans: [{ kind: 'static', steps: [{ id: 'open', file: 'index.html' }] }] }, 'GET /api/projects/kafe/publish-check': { project: 'kafe', files: 3, truncated: false, findings: [{ kind: 'env-file', level: 'danger', file: '.env', line: 0, sample: '' }], more: 0 } });
  drawer.close?.();
  later();
  await settle();
  await openKafe();
  const deploy = $('[data-job-next="deploy"]');
  assert.ok(deploy, 'a web project offers Put it online');
  const before = actionPosts().length;
  click(deploy);
  for (let i = 0; i < 4; i++) {
    await settle(4);
    drawer.rerender?.();
  }
  const sec = $('[data-sec="publish"]');
  assert.ok(sec, 'the check is shown');
  assert.match(sec.textContent, /\.env/);
  assert.ok(requests.some((r) => r.key === 'GET /api/projects/kafe/publish-check'));
  click(sec.querySelector('[data-pub-act="write"]'));
  await settle();
  const box = $('[data-fk="job:text"]').value;
  assert.ok(box.startsWith(S.pcJobText) && box.includes('.env'), 'the steps and the file to keep out');
  assert.equal($('[data-sec="publish"]'), null, 'the check closes');
  assert.equal(actionPosts().length, before, 'nothing was sent to start');
});
