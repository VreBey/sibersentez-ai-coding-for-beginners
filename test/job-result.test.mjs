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
  assert.ok(drawer.includes('return jobResult.html(p, d, startPoint, waiting ? { steps: stepsHtml(d, { offline: store.lost }), go, cost, tips, back: backOpts, guide } : { cost, tips, back: backOpts, guide });'));
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

// The app's own record (docs/internal/evidence-card-plan.md E2): what it saw apart from what the reviewer wrote
test("the app's record: when it saw the verdict, and whether the files are still those it was about", async () => {
  const { dayTime } = await import('../public/js/format.js');
  const seenAt = Date.UTC(2026, 9, 9, 12, 30);
  const rec = (over = {}) => ({ jobId: J, verdict: { value: 'APPROVE', blockers: 0, nits: 1, reviewAt: seenAt - 5000, seenAt }, tree: null, acceptedSeenAt: null, ...over });
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const S = STRINGS[lang];
    const fill = (k, vars) => esc(S[k].replace(/\{(\w+)\}/g, (_, x) => vars[x]));
    const lead = fill('jrSeen', { time: dayTime(seenAt) });
    const html = (result, over = {}) => jobResultHtml({ team: team(over), changes: changes(), result });
    // Same and same content: the reviewer's words first, then what the app saw
    const same = html({ fresh: 'same', record: rec() });
    assert.ok(same.includes(lead) && same.includes(esc(S.jrFresh_same)), lang);
    assert.ok(same.indexOf(esc(S.jrReviewApproved)) < same.indexOf(lead), `${lang}: declared before observed`);
    assert.ok(html({ fresh: 'same-content', record: rec() }).includes(esc(S['jrFresh_same-content'])), lang);
    // Changed: a warning without a count, and the way to a new review
    const changed = html({ fresh: 'changed', writtenSince: 3, record: rec() });
    assert.ok(changed.includes(esc(S.jrFresh_changed)) && changed.includes('class="jr-seen jr-stale"'), lang);
    assert.ok(changed.includes('data-jr-act="re-review"') && changed.includes(esc(S.jrActReReview)), lang);
    assert.ok(!/\b3\b/.test(changed.slice(changed.indexOf('jr-stale'), changed.indexOf('data-jr-act="re-review"'))), `${lang}: writes are not counted as changes`);
    assert.ok(!same.includes('re-review'), lang);
    // Unknown: the reason in words; the scan's limits share one sentence; an unknown reason a general one
    for (const [reason, key] of [['written-before-seen', 'written-before-seen'], ['no-review-time', 'no-review-time'], ['unreadable', 'unreadable'], ['too-many-files', 'too-big'], ['too-deep', 'too-big'], ['folder-missing', 'folder-missing'], ['folder', 'folder'], ['no-hub', 'folder'], ['strange', 'other']]) {
      const u = html({ fresh: 'unknown', reason, record: rec() });
      assert.ok(u.includes(lead) && u.includes(esc(S[`jrFreshUnknown_${key}`])), `${lang} ${reason}`);
    }
    // No record of the app's: nothing "seen", said why
    const none = html({ fresh: 'unknown', reason: 'no-record', record: null });
    assert.ok(none.includes(esc(S['jrFreshUnknown_no-record'])) && !none.includes(esc(S.jrSeen.split('{')[0])), lang);
    // A record of another verdict (the app has not looked at the new one yet), no verdict at all, still asked: nothing
    for (const [result, over] of [[{ fresh: 'same', record: rec({ verdict: { ...rec().verdict, value: 'REVISE' } }) }, {}], [{ fresh: 'same', record: rec() }, { review: null }], [null, {}]]) {
      assert.ok(!html(result, over).includes('jr-seen'), lang);
    }
    // A REVISE verdict the app saw is told the same way
    assert.ok(html({ fresh: 'changed', record: rec({ verdict: { ...rec().verdict, value: 'REVISE' } }) }, { review: { verdict: 'REVISE' } }).includes('jr-stale'), lang);
    // Accepted: when the app saw it, else as before; never before the person accepted
    const done = jobResultHtml({ team: team({ step: 'done' }), changes: changes(), result: { fresh: 'same', record: rec({ acceptedSeenAt: seenAt + 60000 }) } });
    assert.ok(done.includes(fill('jrAcceptedSeen', { time: dayTime(seenAt + 60000) })), lang);
    assert.ok(jobResultHtml({ team: team({ step: 'done' }), changes: changes(), result: { fresh: 'same', record: rec() } }).includes(esc(S.jrAccepted)), lang);
    assert.ok(!html({ fresh: 'same', record: rec({ acceptedSeenAt: seenAt }) }).includes(esc(S.jrAcceptedSeen.split('(')[0])), lang);
  }
  setLanguage('en');
});

test("the app's record is asked per job while a verdict or the acceptance shows; a failed answer says nothing", async () => {
  setLanguage('en');
  let asked = 0;
  const r = createJobResult({ fetchJson: async () => changes(), fetchRecord: async () => (asked++, { fresh: 'changed', record: { jobId: J, verdict: { value: 'APPROVE', seenAt: 1 } } }), now: () => 0 });
  const p = { id: 'p' };
  r.html(p, team(), null);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(asked, 1);
  assert.ok(r.html(p, team(), null).includes('jr-stale'));
  // No verdict yet and not accepted: not asked; a job without an id: not asked
  r.html({ id: 'q' }, team({ review: null }), null);
  r.html({ id: 'q' }, team({ plan: { title: 'Old job' } }), null);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(asked, 1);
  const failing = createJobResult({ fetchJson: async () => changes(), fetchRecord: async () => { throw new Error('down'); }, now: () => 0 });
  failing.html(p, team(), null);
  await new Promise((res) => setTimeout(res, 0));
  assert.ok(!failing.html(p, team(), null).includes('jr-seen'));
});

test('"Ask for a new review" writes its draft into the AI tab, never with Enter; without it, into the job box', () => {
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes("if (act === 'explain' || act === 're-review') {"));
  assert.ok(drawer.includes("const text = t(act === 'explain' ? 'jrExplainDraft' : 'jrReReviewDraft');"));
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].jrReReviewDraft.includes('REVIEW.md'), lang);
});

// Review of E2 (round 1): "the same" only of the files compared, a failed answer never leaves an old one, no record
// yet asked again soon, another round's counts say nothing, a broken record never says "seen" and "no record" at once
test("the app's record, review round 1: what is promised, what is kept, what is asked again", async () => {
  const seenAt = Date.UTC(2026, 9, 9, 12, 30);
  const v = { value: 'APPROVE', blockers: 0, nits: 1, reviewAt: seenAt - 5000, seenAt };
  const rec = (over = {}) => ({ jobId: J, verdict: v, tree: { scope: 'full' }, acceptedSeenAt: null, ...over });
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const S = STRINGS[lang];
    const html = (result, over = {}) => jobResultHtml({ team: team({ review: { verdict: 'APPROVE', blockers: 0, nits: 1 }, ...over }), changes: changes(), result });
    // The same: said of the files compared, the folders left out named; a lean copy's big files and logs too
    assert.match(S.jrFresh_same, /node_modules/, lang);
    assert.ok(!html({ fresh: 'same', record: rec() }).includes(esc(S.jrFreshLean)), lang);
    assert.ok(html({ fresh: 'same', record: rec({ tree: { scope: 'lean' } }) }).includes(esc(S.jrFreshLean)), lang);
    assert.ok(html({ fresh: 'same-content', record: rec({ tree: { scope: 'lean' } }) }).includes(esc(S.jrFreshLean)), lang);
    // Another round with the same value and other counts: the app has not looked at it yet
    assert.ok(!html({ fresh: 'changed', record: rec() }, { review: { verdict: 'APPROVE', blockers: 0, nits: 3 } }).includes('jr-seen'), lang);
    assert.ok(html({ fresh: 'changed', record: rec() }, { review: { verdict: 'APPROVE' } }).includes('jr-stale'), `${lang}: no counts, value decides`);
    // A record whose files' part could not be read back: "seen", and no "no record" next to it
    const broken = html({ fresh: 'unknown', reason: 'no-record', record: rec({ tree: null }) });
    assert.ok(broken.includes(esc(S.jrFreshUnknown_other)) && !broken.includes(esc(S['jrFreshUnknown_no-record'])), lang);
    for (const [reason, key] of [['too-large', 'too-big'], ['file-too-large', 'too-big'], ['folder-missing', 'folder-missing'], ['legacy-hub', 'folder']]) {
      assert.ok(html({ fresh: 'unknown', reason, record: rec() }).includes(esc(S[`jrFreshUnknown_${key}`])), `${lang} ${reason}`);
    }
    assert.doesNotMatch(S.jrReReviewDraft, /[\r\n]/, lang);
  }
  setLanguage('en');
  const tick = () => new Promise((res) => setTimeout(res, 0));
  let clock = 0;
  let answer = { fresh: 'same', record: rec() };
  let asked = 0;
  const r = createJobResult({ fetchJson: async () => changes(), fetchRecord: async () => { asked++; if (answer instanceof Error) throw answer; return answer; }, now: () => clock });
  const p = { id: 'p' };
  r.html(p, team(), null);
  await tick();
  assert.ok(r.html(p, team(), null).includes(esc(STRINGS.en.jrFresh_same)));
  // Asked again after the server's own while (15 s); a failure then says nothing, never the old "same"
  clock = 14000;
  r.html(p, team(), null);
  assert.equal(asked, 1);
  clock = 16000;
  answer = new Error('down');
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 2);
  assert.ok(!r.html(p, team(), null).includes('jr-seen'), 'a failed answer leaves nothing old');
  // No record yet: asked again after a few seconds, not after 15
  answer = { fresh: 'unknown', reason: 'no-record', record: null };
  clock = 40000;
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 3);
  clock = 43500;
  answer = { fresh: 'same', record: rec() };
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 4);
  assert.ok(r.html(p, team(), null).includes(esc(STRINGS.en.jrFresh_same)));
});

// Review of E2 (round 2): the app writes its record when it first sees the verdict, also after it was closed, so a
// missing record is never put down to that; a record that stays missing is not asked for every few seconds
test("the app's record, review round 2: no record is told without a wrong cause, and asked soon only at first", async () => {
  for (const lang of ['en', 'tr']) assert.doesNotMatch(STRINGS[lang]['jrFreshUnknown_no-record'], /closed|kapalı/i, lang);
  const tick = () => new Promise((res) => setTimeout(res, 0));
  let clock = 0;
  let asked = 0;
  const r = createJobResult({ fetchJson: async () => changes(), fetchRecord: async () => (asked++, { fresh: 'unknown', reason: 'no-record', record: null }), now: () => clock });
  const p = { id: 'p' };
  r.html(p, team(), null);
  await tick();
  clock = 3500;
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 2, 'asked again soon in the first minute');
  clock = 70000;
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 3);
  clock = 74000;
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 3, 'after the first minute, as any other answer');
  clock = 86000;
  r.html(p, team(), null);
  await tick();
  assert.equal(asked, 4);
});
