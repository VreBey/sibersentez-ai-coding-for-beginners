// "This job's result" in the drawer (public/js/jobResult.js; the review's package 3): what was asked, this job's own
// changes, the checks apart (the AI reviewer's report, nothing SiberSentez ran, the person's acceptance), how to open
// it, going back. Run: node --test test/job-result.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobResultHtml, createJobResult, RESULT_STEPS } from '../public/js/jobResult.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';
import { esc } from '../public/js/format.js';

const J = 'J' + '0123456789abcdef'.repeat(2);
const team = (over = {}) => ({ step: 'finish', plan: { title: 'Add a menu page', jobId: J }, review: { verdict: 'APPROVE' }, ...over });
const changes = (over = {}) => ({ basis: 'start', changed: ['index.html'], added: ['menu.html', 'menu.css'], deleted: [], total: 3, notes: 0, scope: 'full', leftOut: 0, ...over });
const has = (html, key, vars) => html.includes(esc(vars ? STRINGS.en[key].replace(/\{(\w+)\}/g, (_, k) => vars[k]) : STRINGS.en[key]));

test('only at the result (finish) and after it (done)', () => {
  setLanguage('en');
  assert.deepEqual(RESULT_STEPS, ['finish', 'done']);
  for (const step of ['plan', 'build', 'check', 'none']) assert.equal(jobResultHtml({ team: team({ step }), changes: changes() }), '', step);
  assert.equal(jobResultHtml({ team: null }), '');
  assert.ok(jobResultHtml({ team: team(), changes: changes() }).includes('data-sec="result"'));
});

test("what was asked, this job's own changes in words and names, the basis said", () => {
  setLanguage('en');
  const html = jobResultHtml({ team: team(), changes: changes() });
  assert.ok(html.includes('Add a menu page'));
  assert.ok(has(html, 'jrChanges', { changed: 1, added: 2, deleted: 0 }));
  assert.ok(html.includes('class="jr-changed"><code translate="no" title="index.html">index.html</code>'));
  assert.ok(html.includes('class="jr-added"><code translate="no" title="menu.html">'));
  assert.ok(has(html, 'jrBasis'), 'changes the person made meanwhile are in it too');
  // A long list: eight names, the rest counted
  const many = Array.from({ length: 12 }, (_, i) => `f${i}.js`);
  const long = jobResultHtml({ team: team(), changes: changes({ changed: many, added: [], total: 12 }) });
  assert.equal((long.match(/<li class="jr-/g) || []).length, 8);
  assert.ok(has(long, 'jrMore', { count: 4 }));
  // Nothing changed; the team's notes apart; a lean copy's blind spot
  assert.ok(has(jobResultHtml({ team: team(), changes: changes({ changed: [], added: [], total: 0 }) }), 'jrNoChanges'));
  assert.ok(has(jobResultHtml({ team: team(), changes: changes({ notes: 2 }) }), 'jrNotes'));
  assert.ok(has(jobResultHtml({ team: team(), changes: changes({ scope: 'lean', leftOut: 7 }) }), 'jrLean', { count: 7 }));
  // No start copy of its own: said, and the recent changes further down named for what they are
  for (const basis of ['no-record', 'no-copy', 'gone', 'unreadable']) assert.ok(has(jobResultHtml({ team: team(), changes: { basis } }), `jrBasis_${basis}`), basis);
  assert.ok(has(jobResultHtml({ team: team(), changes: { basis: 'strange' } }), 'jrBasis_unreadable'));
  assert.ok(has(jobResultHtml({ team: team(), changes: null }), 'jrLoading'));
});

test("the checks apart: the AI reviewer's own report, nothing SiberSentez ran, the person's acceptance", () => {
  setLanguage('en');
  const finish = jobResultHtml({ team: team(), changes: changes() });
  assert.ok(has(finish, 'jrReviewApproved') && has(finish, 'jrNotRun') && has(finish, 'jrNotAccepted'));
  assert.ok(!has(finish, 'jrAccepted'), 'a result is never shown as accepted before the person did');
  const done = jobResultHtml({ team: team({ step: 'done' }), changes: changes() });
  assert.ok(has(done, 'jrAccepted'));
  assert.ok(has(jobResultHtml({ team: team({ review: { verdict: 'REVISE' } }), changes: changes() }), 'jrReviewRevise'));
  assert.ok(has(jobResultHtml({ team: team({ review: null }), changes: changes() }), 'jrReviewNone'));
  // How to open it, and going back as the job box says it (a copy no longer there is never promised)
  assert.ok(has(finish, 'jrOpen'));
  const kept = jobResultHtml({ team: team(), changes: changes(), point: { id: 'R20261007100000aaaa', scope: 'full', leftOut: 0, available: true } });
  assert.ok(has(kept, 'rstStartFull'));
  const gone = jobResultHtml({ team: team(), changes: changes(), point: { id: 'R20261007100000aaaa', available: false } });
  assert.ok(has(gone, 'rstStartGone') && !has(gone, 'rstStartFull'));
});

test('both languages have every sentence', () => {
  for (const lang of ['en', 'tr']) for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('jr'))) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  // The Turkish sentences name the drawer's sections by their own titles
  assert.ok(STRINGS.tr.jrOpen.includes(STRINGS.tr.runTitle));
  assert.ok(STRINGS.tr['jrBasis_no-record'].includes(STRINGS.tr.chgTitle));
});

test('the answers are asked per project and job, again after a while; a job from before job ids has no copy of its own', async () => {
  setLanguage('en');
  let calls = 0;
  let clock = 0;
  const seen = [];
  const r = createJobResult({ fetchJson: async (p, j) => (calls++, seen.push([p, j]), changes()), onData: () => {}, now: () => clock, ttl: 1000 });
  assert.equal(r.get('p', J), null, 'asked: not known yet');
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.get('p', J).basis, 'start');
  assert.equal(calls, 1);
  clock = 2000;
  r.get('p', J);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(calls, 2, 'again after ttl');
  assert.deepEqual(seen[0], ['p', J]);
  assert.equal(r.get('p', 'nope'), null);
  const legacy = r.html({ id: 'p' }, team({ plan: { title: 'Old job' } }), null);
  assert.ok(has(legacy, 'jrBasis_no-record'), 'no job id: no start copy of its own');
  assert.equal(calls, 2, 'nothing asked for it');
  // A failed answer says it could not compare, never stays "comparing"
  const failing = createJobResult({ fetchJson: async () => { throw new Error('down'); }, now: () => 0 });
  failing.get('q', J);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(failing.get('q', J).basis, 'unreadable');
});

test('the drawer shows it under the job, before "How to run it"', () => {
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.indexOf('${jobResultSection(p)}') > 0 && drawer.indexOf('${jobResultSection(p)}') < drawer.indexOf("${built ? runHint.html(p, { quiet: resultFirst }) : ''}"));
  assert.ok(drawer.includes('return jobResult.html(p, d, startPoint, waiting ? { steps: stepsHtml(d, { offline: store.lost }), go, cost, tips, back: backOpts } : { cost, tips, back: backOpts });'));
  // The way to the job's AI session goes where the Building's result card goes (review U08)
  assert.ok(drawer.includes("if (act === 'open-ai') return void window.dispatchEvent(new CustomEvent('hq-action', { detail: { action: 'open-ai-terminal', projectId: p.id, sessionId: btn.dataset.jobSession || null } }));"));
});

test('while the result waits: the way to the job\'s own AI session, never "the lead\'s terminal" (review U08)', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const go = jobResultHtml({ team: team(), changes: changes(), go: { session: 'S1', tab: false } });
    assert.ok(go.includes('data-job-act="open-ai" data-job-session="S1"'), lang);
    assert.ok(go.includes(esc(STRINGS[lang].jrGoAi)), lang);
    assert.doesNotMatch(STRINGS[lang].jrNotAccepted, /lead|lider/i, lang);
    // An AI tab of the project runs in SiberSentez's terminal, no session known: the button brings the tab forward
    const tab = jobResultHtml({ team: team(), changes: changes(), go: { session: null, tab: true } });
    assert.ok(tab.includes('data-job-act="open-ai" data-fk') && !tab.includes('data-job-session'), lang);
    // Neither: said plainly, no button that leads nowhere
    const none = jobResultHtml({ team: team(), changes: changes(), go: { session: null, tab: false } });
    assert.ok(!none.includes('data-job-act="open-ai"') && none.includes(esc(STRINGS[lang].jrNoSession)), lang);
    // Its AI no longer runs: said before the click (the job box said it before, review round 1)
    const stopped = jobResultHtml({ team: team(), changes: changes(), go: { session: 'S1', tab: false, stopped: true } });
    assert.ok(stopped.includes(esc(STRINGS[lang].wsJobStopped)) && stopped.indexOf(esc(STRINGS[lang].wsJobStopped)) < stopped.indexOf('data-job-act="open-ai"'), lang);
    assert.ok(!go.includes(esc(STRINGS[lang].wsJobStopped)), lang);
    // Accepted (done): nothing to answer
    assert.ok(!jobResultHtml({ team: team({ step: 'done' }), changes: changes(), go: { session: 'S1', tab: true } }).includes('open-ai'), lang);
  }
  setLanguage('en');
});

test('the result first: the job\'s steps lead it; the job box after it is a secondary "New job" without them (review U07)', async () => {
  setLanguage('en');
  const { jobSectionHtml, stepsHtml } = await import('../public/js/views/job.js');
  const d = team();
  const res = jobResultHtml({ team: d, changes: changes(), steps: stepsHtml(d), go: { session: 'S1', tab: false } });
  assert.ok(res.indexOf('class="job-steps"') > res.indexOf('id="jrH"') && res.indexOf('class="job-steps"') < res.indexOf('jr-checks'));
  const p = { id: 'p1', path: 'C:\\p1', name: 'p1' };
  const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
  const asNew = jobSectionHtml(p, d, { mode: 'live', tools, asNew: true });
  const usual = jobSectionHtml(p, d, { mode: 'live', tools });
  assert.ok(asNew.includes(esc(STRINGS.en.jobAskNew)) && !asNew.includes('class="job-steps"'));
  assert.ok(usual.includes(esc(STRINGS.en.jobAsk)) && usual.includes('class="job-steps"'));
  assert.match(usual, /class="act-btn primary job-go"/);
  assert.match(asNew, /class="act-btn job-go"/, 'Start is secondary next to the waiting result');
});

test("jobSession: the session that names the job, else a nearby unnamed one; never another tool's job (review U08)", async () => {
  const { jobSession } = await import('../public/js/views/job.js');
  const H = 3600000;
  const named = { id: 'A', projectId: 'p', lastAt: 1 * H, jobId: J };
  const loose = { id: 'B', projectId: 'p', lastAt: 10 * H };
  const other = { id: 'C', projectId: 'q', lastAt: 20 * H };
  const job = { jobId: J, tool: 'claude', updatedAt: 10 * H };
  // The named one wins even when older than the job's last change
  assert.equal(jobSession({ sessions: [named, loose, other], projectId: 'p', job })?.id, 'A');
  assert.equal(jobSession({ sessions: [loose, other], projectId: 'p', job })?.id, 'B');
  // An unnamed session long before the job's last change is not its session
  assert.equal(jobSession({ sessions: [{ ...loose, lastAt: 1 * H }], projectId: 'p', job }), null);
  assert.equal(jobSession({ sessions: [loose], projectId: 'p', job: { ...job, tool: 'codex' } }), null);
  assert.equal(jobSession({ sessions: [loose], projectId: 'p', job: null }), null);
});
