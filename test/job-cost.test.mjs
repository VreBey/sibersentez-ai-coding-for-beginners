// What a job cost and what the next may (plan B5): a job's span from its start record to the project's next start (at
// most three hours, never past now), its usage from the ledger's hours, and the range of the recent priced jobs.
// Run: node --test test/job-cost.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, HOUR } from '../server/usage.mjs';
import { jobSpans, estimateOf, jobCostsRoute, JOB_SPAN_MAX_MS, ESTIMATE_MIN } from '../server/jobCost.mjs';
import { PRICED_AT } from '../server/prices.mjs';

const T0 = Date.UTC(2026, 9, 9, 8, 0, 0);
let n = 0;
const ledger = () => new UsageLedger({ now: () => T0 + 10 * HOUR, log: () => {}, debounceMs: 0 });
const use = (l, projectId, t, model, output) => l.add({ key: `k${++n}`, t, projectId, model, usage: { input_tokens: 1000, output_tokens: output } });

test('spans: to the project\'s next start, at most three hours, never past now; other projects do not cut it', () => {
  const s = jobSpans([
    { projectId: 'a', jobId: 'J1', at: T0 },
    { projectId: 'a', jobId: 'J2', at: T0 + HOUR },
    { projectId: 'b', jobId: 'J3', at: T0 + 30 * 60000 },
    { projectId: 'a', jobId: 'J4', at: T0 + 2 * HOUR },
    { projectId: 'a', jobId: 'future', at: T0 + 99 * HOUR },
    { projectId: 'a', at: T0 },
    null,
  ], T0 + 2.5 * HOUR);
  assert.deepEqual(s.map((x) => [x.jobId, x.until - x.at]), [['J4', 0.5 * HOUR], ['J2', HOUR], ['J3', 2 * HOUR], ['J1', HOUR]]);
  assert.equal(jobSpans([{ projectId: 'a', jobId: 'J', at: T0 }], T0 + 99 * HOUR)[0].until - T0, JOB_SPAN_MAX_MS);
});

test('the estimate: the range of recent jobs that did something and have a price; none below ESTIMATE_MIN', () => {
  const j = (usd, messages = 3) => ({ usd, messages });
  assert.equal(estimateOf([j(1.2)]), null, `fewer than ${ESTIMATE_MIN}`);
  assert.deepEqual(estimateOf([j(2.8), j(null), j(0, 0), j(2), j(1.4)]), { jobs: 3, low: 1.4, high: 2.8, median: 2 });
  assert.deepEqual(estimateOf([j(1), j(3)]), { jobs: 2, low: 1, high: 3, median: 2 });
});

test('the route: a job\'s own usage from the ledger; a tool without a price shows tokens, never dollars', () => {
  const l = ledger();
  use(l, 'site', T0 + 5 * 60000, 'claude-opus-5-5', 20000); // job 1, hour 08
  use(l, 'site', T0 + HOUR + 60000, 'claude-opus-5-5', 30000); // job 2, hour 09
  use(l, 'other', T0 + 5 * 60000, 'claude-opus-5-5', 99999); // another project, never counted for site
  use(l, 'cdx', T0 + 2 * HOUR, 'gpt-6-astra', 5000); // a model without a price
  const records = { site: [{ jobId: 'J1', at: T0 }, { jobId: 'J2', at: T0 + HOUR }], cdx: [{ jobId: 'J9', at: T0 + 2 * HOUR }], other: [] };
  const catalog = { hubDir: 'C:\\hub', allProjects: () => ['site', 'cdx', 'other'].map((id) => ({ id })), getProject: (id) => (records[id] ? { id } : null) };
  const readRecords = ({ projectId }) => records[projectId] || [];
  const r = jobCostsRoute({ ledger: l, catalog, now: T0 + 4 * HOUR, readRecords });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.jobs.map((x) => [x.jobId, x]));
  assert.equal(by.J1.output, 20000, 'only its own hour and project');
  assert.equal(by.J2.output, 30000);
  assert.ok(by.J1.usd > 0 && by.J2.usd > by.J1.usd);
  assert.equal(by.J9.usd, null, 'no price: no dollars');
  assert.equal(by.J9.output, 5000, 'its tokens still');
  assert.deepEqual(Object.keys(r.body.estimate), ['jobs', 'low', 'high', 'median']);
  assert.equal(r.body.estimate.jobs, 2, 'the two priced jobs');
  const one = jobCostsRoute({ ledger: l, catalog, projectId: 'site', now: T0 + 4 * HOUR, readRecords });
  assert.deepEqual(one.body.jobs.map((x) => x.jobId), ['J2', 'J1']);
  assert.equal(jobCostsRoute({ ledger: l, catalog, projectId: 'nope', readRecords }).status, 404);
  assert.equal(jobCostsRoute({ ledger: null, catalog }).status, 404);
  assert.deepEqual(jobCostsRoute({ ledger: l, catalog: { allProjects: () => [] }, now: T0 }).body, { jobs: [], estimate: null, pricedOnly: 'anthropic', pricedAt: PRICED_AT }, 'no hub: nothing');
});

test('the page: the range under Start, this job in its result; dollars only when shown and priced, never a made-up one', async () => {
  const { estimateText, jobCostText } = await import('../public/js/jobCost.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  setLanguage('tr');
  try {
    const range = estimateText({ jobs: 3, low: 1.4, high: 2.8, median: 2 }, { showCost: true });
    assert.match(range, /son işler \(3\): her biri ~\$1[.,]40 ile ~\$2[.,]80 arası/, 'no "about ~$" (usd says ~ already)');
    assert.match(estimateText({ jobs: 3, low: 1.4, high: 2.8, median: 2 }, { showCost: true, tool: 'codex' }), /iş bitince sonucunda görünür/, 'measured on Claude only: no range for another tool');
    assert.match(range, /Abonelikte bu tutar ödenmez/);
    assert.match(estimateText(null, { showCost: true }), /iş bitince sonucunda görünür/, 'nothing known: no number');
    assert.match(estimateText({ jobs: 1, low: 1, high: 1 }, { showCost: true }), /iş bitince/, 'one job is no range');
    assert.equal(estimateText({ jobs: 3, low: 1, high: 2 }, { showCost: false }), '', '"Hide $": nothing');
    // Review §7.7: the figure says it is an estimate, how it was counted and the prices' date
    const job = { messages: 4, processed: 52000, usd: 2.1, split: false, others: 0, capped: false };
    assert.match(jobCostText(job, { showCost: true, pricedAt: '2026-09-25' }), /^Bu iş: ~\$2[.,]10 API karşılığı \(tahmini\), işlenen yaklaşık 52 bin token\. Bu projenin, işin sürdüğü tam saatlerdeki kullanımından hesaplandı\. Fiyatlar: Anthropic API, 25\.09\.2026\.$/);
    const all = jobCostText({ ...job, split: true, others: 2, capped: true }, { showCost: true, pricedAt: '2026-09-25' });
    assert.match(all, /hesaplandı; başka bir işle paylaşılan saat eşit bölündü; o saatlerde bu projede açık olan 2 başka yapay zekâ oturumu vardı, o saatlerdeki kullanımları da sayıldı; yalnızca yaklaşık ilk üç saati sayıldı\./);
    assert.match(jobCostText({ ...job, others: 1 }, { showCost: true }), /açık olan 1 başka yapay zekâ oturumu vardı, o saatlerdeki kullanımı da sayıldı\.$/, 'no price date given: none said');
    assert.match(jobCostText({ ...job, others: null }, { showCost: true }), /başka oturum varsa onun kullanımı da sayıldı/, 'not known: said so, never "none"');
    assert.match(jobCostText({ ...job, usd: null }, { showCost: true, pricedAt: '2026-09-25' }), /^Bu iş: yaklaşık 52 bin token işlendi\. Bu projenin/, 'no price: tokens');
    assert.doesNotMatch(jobCostText({ ...job, usd: null }, { showCost: true, pricedAt: '2026-09-25' }), /Fiyatlar/, 'no dollars: no prices date');
    assert.match(jobCostText(job, { showCost: false }), /token işlendi/, '"Hide $": tokens');
    assert.match(jobCostText({ messages: 0, processed: 0, usd: 0, others: 0 }, { showCost: true }), /token kullanımı kaydedilmedi; yapay zekâ aracı bunu kaydetmiyor olabilir/, 'nothing recorded: said, never $0');
    assert.match(jobCostText({ messages: 0, processed: 0, usd: 0, others: null }, { showCost: true }), /^Bu işin saatleri için bilinen bir token kullanımı yok\.$/, 'hours out of the logs\' reach: not known, not "not logged"');
    assert.equal(jobCostText(null), '');
  } finally {
    setLanguage('en');
  }
});

test('wiring: the drawer asks /api/usage/jobs and passes the lines to the job box and the result; the server route is read-only', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const drawer = read('public/js/views/drawer.js');
  assert.ok(drawer.includes("import { createJobCosts, estimateText, jobCostText } from '../jobCost.js';"));
  assert.ok(drawer.includes('cost: estimateText(jobCosts.estimate(p.id), { tool: preferredTool(installedTools())?.id })'));
  assert.ok(drawer.includes('const cost = jobId ? jobCostText(jobCosts.job(p.id, jobId), { pricedAt: jobCosts.pricedAt(p.id) }) : \'\';'));
  const { jobSectionHtml } = await import('../public/js/views/job.js');
  const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
  const box = jobSectionHtml({ id: 'p', path: 'C:/p' }, null, { mode: 'live', tools, cost: 'COST LINE' });
  assert.ok(box.includes('<p class="small muted job-cost">COST LINE</p>'));
  assert.ok(!jobSectionHtml({ id: 'p', path: 'C:/p' }, null, { mode: 'live', tools: { status: 'ready', tools: [] }, cost: 'COST LINE' }).includes('COST LINE'), 'no tool: no line');
  const { jobResultHtml } = await import('../public/js/jobResult.js');
  assert.ok(jobResultHtml({ team: { step: 'finish', plan: { title: 'x' } }, changes: { basis: 'no-record' }, cost: 'THIS JOB' }).includes('<p class="small muted jr-cost">THIS JOB</p>'));
  const app = read('server/app.mjs');
  const at = app.indexOf("if (p === '/api/usage/jobs') {");
  assert.ok(at > 0 && at > app.indexOf("if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405"), 'GET only, after the usual checks');
});

test('two jobs in one hour split it (review B/C: each took the whole hour, so a job read up to twice its cost)', () => {
  const l = ledger();
  use(l, 'p', T0 + 10 * 60000, 'claude-opus-5-5', 20000);
  use(l, 'p', T0 + 40 * 60000, 'claude-opus-5-5', 20000);
  const records = { p: [{ jobId: 'A', at: T0 + 5 * 60000 }, { jobId: 'B', at: T0 + 20 * 60000 }] };
  const catalog = { hubDir: 'C:\hub', allProjects: () => [{ id: 'p' }], getProject: (id) => (id === 'p' ? { id } : null) };
  const r = jobCostsRoute({ ledger: l, catalog, now: T0 + 2 * HOUR, readRecords: ({ projectId }) => records[projectId] || [] });
  const by = Object.fromEntries(r.body.jobs.map((x) => [x.jobId, x]));
  assert.equal(by.A.output + by.B.output, 40000, 'together: the hour once');
  assert.equal(by.A.output, 20000);
  assert.equal(by.B.output, 20000);
});

test('each job says how its numbers were made: an hour split with another job, its span cut, other sessions at work (review §7.7)', async () => {
  const l = ledger();
  use(l, 'p', T0 + 10 * 60000, 'claude-opus-5-5', 20000);
  use(l, 'p', T0 + 5 * HOUR, 'claude-opus-5-5', 20000);
  const records = { p: [{ jobId: 'A', at: T0 + 5 * 60000 }, { jobId: 'B', at: T0 + 20 * 60000 }, { jobId: 'C', at: T0 + 4 * HOUR }] };
  const catalog = { hubDir: 'C:\hub', allProjects: () => [{ id: 'p' }], getProject: (id) => (id === 'p' ? { id } : null) };
  const asked = [];
  const othersIn = (projectId, from, to, jobId) => (asked.push([projectId, from, to, jobId]), jobId === 'C' ? null : 1);
  const r = jobCostsRoute({ ledger: l, catalog, now: T0 + 9 * HOUR, othersIn, readRecords: ({ projectId }) => records[projectId] || [] });
  const by = Object.fromEntries(r.body.jobs.map((x) => [x.jobId, x]));
  assert.deepEqual([by.A.split, by.B.split, by.C.split], [true, true, false]);
  assert.deepEqual([by.A.capped, by.B.capped, by.C.capped], [false, true, true], 'B ran on to C\'s start past three hours; C to now');
  assert.deepEqual([by.A.others, by.C.others], [1, null]);
  // Asked for the whole hours the ledger counts, with the job's id (its own sessions are not "other")
  assert.deepEqual(asked.find((a) => a[3] === 'A'), ['p', T0, T0 + HOUR, 'A']);
  assert.equal(jobCostsRoute({ ledger: l, catalog, projectId: 'p', now: T0 + 9 * HOUR, othersIn: () => 0, readRecords: ({ projectId }) => records[projectId] || [] }).body.jobs.length, 3);
  assert.equal(r.body.pricedAt, PRICED_AT);
  assert.equal(jobCostsRoute({ ledger: l, catalog, now: T0 + 9 * HOUR, othersIn: () => { throw new Error('boom'); }, readRecords: ({ projectId }) => records[projectId] || [] }).body.jobs[0].others, null);

  // The log reader's count: sessions of the project at work in the hours, not the job's own, not known before its window
  const { Ingest } = await import('../server/ingest.mjs');
  const ing = new Ingest({ resolve: () => 'p', getProject: () => null, allProjects: () => [], roster: new Map() });
  ing.cutoff = T0 - HOUR;
  const s = (id, jobId, startedAt, lastAt) => {
    const x = Object.assign(ing.getSession(id, null), { jobId, startedAt, lastAt });
    ing.assignSessionProject(x, 'p');
  };
  s('own', 'A', T0 + 6 * 60000, T0 + 50 * 60000);
  s('chat', null, T0 - 2 * HOUR, T0 + 30 * 60000);
  s('before', null, T0 - 3 * HOUR, T0 - 2 * HOUR);
  s('after', null, T0 + HOUR, T0 + 2 * HOUR);
  assert.equal(ing.otherSessionsIn('p', T0, T0 + HOUR, 'A'), 1, 'the chat at work in that hour');
  assert.equal(ing.otherSessionsIn('elsewhere', T0, T0 + HOUR, 'A'), 0);
  assert.equal(ing.otherSessionsIn('p', T0 - 2 * HOUR, T0, 'A'), null, 'before the window: not known');
  ing.scan.state = 'loading';
  assert.equal(ing.otherSessionsIn('p', T0, T0 + HOUR, 'A'), null, 'still reading the logs: not known');
});
