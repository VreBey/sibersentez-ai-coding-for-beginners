// The result first, with its four ways in one row (review B3, UX plan §6.4): open it, ask for a change, accept it, go
// back to before the job. Run: node --test test/result-acts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobResultHtml, resultActsHtml } from '../public/js/jobResult.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const team = (step) => ({ step, plan: { title: 'Kafe sayfası', jobId: 'J' + 'a'.repeat(32) } });

test('while the result waits: the four ways first, Open leads; the AI button stays as a plain one; done: none', () => {
  setLanguage('tr');
  try {
    const h = jobResultHtml({ team: team('finish'), changes: { basis: 'no-record' }, point: { id: 'R20261009090001aaaa', available: true }, go: { session: 'S', tab: false } });
    assert.ok(h.indexOf('data-jr-act="open"') < h.indexOf('jr-checks'), 'before the checks');
    assert.match(h, /class="act-btn primary" data-jr-act="open"/);
    for (const a of ['change', 'accept']) assert.match(h, new RegExp(`class="act-btn" data-jr-act="${a}"`));
    assert.match(h, /data-rst-act="preview" data-rst-id="R20261009090001aaaa"/);
    assert.ok(h.includes(STRINGS.tr.jrActsNote));
    assert.match(h, /class="act-btn" data-job-act="open-ai"/, 'one primary only');
    assert.equal((h.match(/act-btn primary/g) || []).length, 1);
    assert.ok(!jobResultHtml({ team: team('done'), changes: { basis: 'no-record' } }).includes('data-jr-act'), 'accepted: nothing left to do');
    assert.ok(!resultActsHtml({ id: 'R20261009090001aaaa', available: false }).includes('data-rst-act'), 'a copy no longer kept: no way back offered');
    assert.ok(!resultActsHtml(null).includes('data-rst-act'));
  } finally {
    setLanguage('en');
  }
});

test('wiring: the drawer sends a change and an acceptance as drafts into the AI tab (never Enter), else the job box or a note', () => {
  const d = read('public/js/views/drawer.js');
  assert.ok(d.includes("const jr = e.target.closest('[data-jr-act]');"));
  assert.ok(d.includes("const r = askAiDraft(projectId, t(act === 'change' ? 'jrChangeDraft' : 'jrAcceptDraft'));"));
  assert.ok(d.includes("if (act === 'change') return fillJob(projectId, t('jobNextText_change'));"));
  assert.ok(d.includes("const open = body.querySelector('[data-run-open]');"));
  const rh = read('public/js/runHint.js');
  assert.ok(rh.includes('return asker ? asker.ask(projectId, text) : null;'), 'the same path as "Ask the AI": terminalDock askAi, no Enter');
  for (const k of ['jrChangeDraft', 'jrAcceptDraft']) assert.doesNotMatch(STRINGS.tr[k] + STRINGS.en[k], /[\r\n]/, `${k}: no Enter inside`);
});

test('the plan (review B7): approve or ask for a change from the job box while it waits; nothing once approved or offline', async () => {
  const { planActsHtml, jobSectionHtml } = await import('../public/js/views/job.js');
  setLanguage('tr');
  try {
    const waiting = { step: 'plan', plan: { title: 'Kafe', approved: false } };
    const h = planActsHtml(waiting);
    assert.match(h, /class="act-btn primary" data-jr-act="plan-ok"/);
    assert.match(h, /class="act-btn" data-jr-act="plan-change"/);
    assert.ok(h.includes(STRINGS.tr.jobPlanNote));
    assert.equal(planActsHtml({ step: 'plan', plan: { approved: true } }), '', 'approved: being cut into tasks');
    assert.equal(planActsHtml({ step: 'plan' }), '', 'no plan yet: still being written');
    assert.equal(planActsHtml({ step: 'build', plan: { approved: false } }), '');
    const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
    const p = { id: 'p', path: 'C:/p' };
    assert.ok(jobSectionHtml(p, waiting, { mode: 'live', tools }).includes('data-jr-act="plan-ok"'));
    assert.ok(!jobSectionHtml(p, waiting, { mode: 'live', tools, offline: true }).includes('data-jr-act="plan-ok"'), 'offline: the plan may be answered already');
    for (const k of ['jobPlanOkDraft', 'jobPlanChangeDraft']) assert.doesNotMatch(STRINGS.tr[k] + STRINGS.en[k], /[\r\n]/, `${k}: no Enter inside`);
  } finally {
    setLanguage('en');
  }
  assert.ok(read('public/js/views/drawer.js').includes("const r = askAiDraft(projectId, t(act === 'plan-ok' ? 'jobPlanOkDraft' : 'jobPlanChangeDraft'));"));
});

test('one primary while the plan waits: Approve, not a new job\'s Start', async () => {
  const { jobSectionHtml } = await import('../public/js/views/job.js');
  const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
  const h = jobSectionHtml({ id: 'p', path: 'C:/p' }, { step: 'plan', plan: { approved: false } }, { mode: 'live', tools });
  assert.equal((h.match(/act-btn primary/g) || []).length, 1);
  assert.match(h, /class="act-btn job-go"/);
  assert.match(jobSectionHtml({ id: 'p', path: 'C:/p' }, null, { mode: 'live', tools }), /class="act-btn primary job-go"/, 'no plan waiting: Start leads');
});

test('"What did it do?" (C3) and a tip for the next job from the person\'s own words (C4)', async () => {
  const { jobTips } = await import('../public/js/jobResult.js');
  assert.deepEqual(jobTips('sayfa yap'), ['short']);
  assert.deepEqual(jobTips('Menü sayfası ekle, iletişim formu koy ve renkleri değiştir lütfen hepsini'), ['many']);
  assert.deepEqual(jobTips('Kafe için menü ve iletişim bilgileri olan tek sayfalık bir site yap'), [], 'one clear job: no tip');
  assert.deepEqual(jobTips(''), []);
  assert.deepEqual(jobTips(null), []);
  setLanguage('tr');
  try {
    const h = jobResultHtml({ team: team('finish'), changes: { basis: 'no-record' }, tips: ['short', 'bogus'] });
    assert.match(h, /class="act-btn" data-jr-act="explain"/);
    assert.ok(h.includes(STRINGS.tr.jrTipsTitle) && h.includes(STRINGS.tr.jrTip_short) && !h.includes('bogus'));
    assert.ok(!jobResultHtml({ team: team('finish'), changes: { basis: 'no-record' } }).includes('jr-tips'), 'no tip: nothing');
  } finally {
    setLanguage('en');
  }
  const d = read('public/js/views/drawer.js');
  // The explain draft (and the new-review one, evidence card E2) goes to the AI tab, else into the job box
  assert.ok(d.includes("const text = t(act === 'explain' ? 'jrExplainDraft' : 'jrReReviewDraft');") && d.includes('const r = askAiDraft(projectId, text);') && d.includes('return fillJob(projectId, text);'));
  assert.ok(d.includes('const tips = jobTips(label);'));
  assert.doesNotMatch(STRINGS.tr.jrExplainDraft + STRINGS.en.jrExplainDraft, /[\r\n]/);
});

test('tips read Turkish words whole: "güve", "düve" are no "ve"; a list of adjectives is one job (review B/C)', async () => {
  const { jobTips } = await import('../public/js/jobResult.js');
  assert.deepEqual(jobTips('Güve resmi koy, düve resmi koy sayfanın en altına'), []);
  assert.deepEqual(jobTips('Ana sayfaya mavi, büyük, yuvarlak bir düğme ekle lütfen'), []);
  assert.deepEqual(jobTips('Menü ekle ve form koy ve renkleri değiştir'), ['many']);
});

test('commas count only beside a joining word: a ten-word list of adjectives is one job (review B/C round 2)', async () => {
  const { jobTips } = await import('../public/js/jobResult.js');
  assert.deepEqual(jobTips('Ana sayfanın en üstüne mavi, büyük, yuvarlak bir düğme ekle'), []);
  assert.deepEqual(jobTips('Menü sayfası ekle, iletişim formu koy ve renkleri değiştir lütfen hepsini'), ['many']);
});
