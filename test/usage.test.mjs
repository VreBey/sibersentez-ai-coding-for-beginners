// Live usage tracking (docs/usage.md): counting, prices, periods, the ledger file, the log files the reader skips, the
// API route, the patch and the page's pure helpers. Days are local: the tests run in Europe/Istanbul (UTC+3, no DST).
process.env.TZ = 'Europe/Istanbul';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { UsageLedger, usageValues, usageKey, localDay, periodRange, scanOlderLogs, readUsageLines, hourLabel, HOUR, ledgerFile } from '../server/usage.mjs';
import { priceOf, costOf, PRICED_AT } from '../server/prices.mjs';
import { usageRoute, createHandler } from '../server/app.mjs';
import { Ingest } from '../server/ingest.mjs';
import { takePatch, snapshot } from '../server/views.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { setLanguage } from '../public/js/i18n.js';
import { usd, amount, millions, percent, dateText, cardLineHtml, stripHtml, cardsHtml, chartHtml, bySpend, createProjectUsage, sectionHtml, setPeriod, getPeriod, costShown, setCostShown, advancedShown, setAdvancedShown, resetPrefs, onPrefs, stripOpen, setStripOpen, PERIOD_KEY, COST_KEY, ADVANCED_KEY } from '../public/js/usage.js';
import { projectGroups } from '../public/js/views/projects.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-29T10:30:00Z'); // 13:30 in Istanbul
const iso = (t) => new Date(t).toISOString();
const U = (o = {}) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...o });
const msg = (id, req, t, usage, model = 'claude-opus-5-5') => ({ timestamp: typeof t === 'number' ? iso(t) : t, ...(req ? { requestId: req } : {}), message: { id, model, usage } });
const ledgerAt = (now = NOW, opts = {}) => new UsageLedger({ now: () => now, log: () => {}, debounceMs: 0, ...opts });
// Every temporary folder this file makes is removed when it ends (2026-10-09: tens of thousands were left in TEMP)
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const tmpDir = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sibersentez-usage-${name}-`));
  made.push(d);
  return d;
};

test('usage values: cache writes split into 5-minute and 1-hour parts; without the split the whole write is 5-minute', () => {
  assert.deepEqual(usageValues({ input_tokens: 3, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 }, cache_read_input_tokens: 1000, output_tokens: 7 }), [3, 40, 60, 1000, 7]);
  assert.deepEqual(usageValues({ cache_creation_input_tokens: 100 }), [0, 100, 0, 0, 0]);
  assert.deepEqual(usageValues({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 30 } }), [0, 70, 30, 0, 0]);
  assert.deepEqual(usageValues({ input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: NaN }), [0, 0, 0, 0, 0]);
  assert.deepEqual(usageValues(null), [0, 0, 0, 0, 0]);
  assert.equal(usageKey({ requestId: 'r1', message: { id: 'm1' } }, 'f'), 'm1|r1');
  assert.equal(usageKey({ message: { id: 'm1' } }, 'f'), 'f|m1');
  assert.equal(usageKey({ message: {} }, 'f'), null);
});

test('prices: dated ids take the longest matching id; 5-minute writes cost 1.25x input, 1-hour writes 2x; unknown models have no price', () => {
  assert.equal(PRICED_AT, '2026-09-25');
  assert.equal(priceOf('claude-opus-5-5').input, 4);
  assert.equal(priceOf('claude-opus-5-5-20260901').input, 4, 'opus 5.5, never opus 5');
  assert.equal(priceOf('claude-opus-5').input, 5);
  assert.equal(priceOf('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceOf('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(priceOf('claude-fable-5').cacheRead, 1);
  assert.equal(priceOf('claude-opus-50'), null);
  assert.equal(priceOf('gpt-5'), null);
  assert.equal(priceOf(''), null);
  const M = 1e6;
  // opus 5.5: input 4, 5-minute write 5, 1-hour write 8, read 0.2, output 20
  assert.equal(costOf('claude-opus-5-5', { input: M }), 4);
  assert.equal(costOf('claude-opus-5-5', { cacheWrite5m: M }), 5);
  assert.equal(costOf('claude-opus-5-5', { cacheWrite1h: M }), 8);
  assert.equal(costOf('claude-opus-5-5', { cacheRead: M }), 0.2);
  assert.equal(costOf('claude-opus-5-5', { output: M }), 20);
  assert.equal(Math.round(costOf('claude-sonnet-4-6', { input: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M, output: M }) * 100) / 100, 3 + 3.75 + 6 + 0.3 + 15);
  assert.equal(costOf('claude-mystery-9', { output: M }), null);
});

test('a message on several lines and in a sub-agent file is counted once, with the largest value of each field', () => {
  const l = ledgerAt();
  const t = NOW - HOUR;
  assert.equal(l.line(msg('m1', 'r1', t, U({ input_tokens: 2, output_tokens: 5 })), { fileKey: 's1', projectId: 'p1' }), true);
  assert.equal(l.line(msg('m1', 'r1', t + 500, U({ input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 900 })), { fileKey: 's1', projectId: 'p1' }), true);
  // Same line again, then a copy with a smaller output in the sub-agent's file: nothing changes
  assert.equal(l.line(msg('m1', 'r1', t + 500, U({ input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 900 })), { fileKey: 's1', projectId: 'p1' }), false);
  assert.equal(l.line(msg('m1', 'r1', t + 900, U({ output_tokens: 30 })), { fileKey: 's1/a1', projectId: 'p1' }), false);
  const r = l.report('24h');
  assert.equal(r.totals.messages, 1);
  assert.equal(r.totals.output, 50);
  assert.equal(r.totals.input, 2);
  assert.equal(r.totals.cacheRead, 900);
  // Without a request id the key is per log file: the same id in one file once, in another file again
  l.line(msg('m2', null, t, U({ output_tokens: 1 })), { fileKey: 's2', projectId: 'p1' });
  l.line(msg('m2', null, t, U({ output_tokens: 1 })), { fileKey: 's2', projectId: 'p1' });
  assert.equal(l.report('24h').totals.messages, 2);
  l.line(msg('m2', null, t, U({ output_tokens: 1 })), { fileKey: 's3', projectId: 'p1' });
  assert.equal(l.report('24h').totals.messages, 3);
});

test('the synthetic model, lines without an id or usage, and bad times are not counted', () => {
  const l = ledgerAt();
  assert.equal(l.line(msg('m1', 'r1', NOW, U({ output_tokens: 5 }), '<synthetic>'), { fileKey: 's' }), false);
  assert.equal(l.line({ timestamp: iso(NOW), message: { model: 'claude-opus-5', usage: U({ output_tokens: 5 }) } }, { fileKey: 's' }), false);
  assert.equal(l.line({ timestamp: iso(NOW), message: { id: 'x', model: 'claude-opus-5' } }, { fileKey: 's' }), false);
  assert.equal(l.line(msg('m3', 'r3', 'not a time', U({ output_tokens: 5 })), { fileKey: 's' }), false);
  assert.equal(l.report('30d').totals.messages, 0);
});

test('processed tokens are new input + cache writes + output; the cache share is reads over all input', () => {
  const l = ledgerAt();
  l.line(msg('m1', 'r1', NOW - 60000, U({ input_tokens: 10, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, cache_read_input_tokens: 940, output_tokens: 5 })), { fileKey: 's', projectId: 'p1' });
  const tt = l.report('24h').totals;
  assert.equal(tt.cacheWrite5m, 20);
  assert.equal(tt.cacheWrite1h, 30);
  assert.equal(tt.cacheWrite, 50);
  assert.equal(tt.processed, 65);
  assert.equal(tt.cacheShare, 0.94);
  // opus 5.5: (10*4 + 20*5 + 30*8 + 940*0.2 + 5*20) / 1e6
  assert.equal(tt.usd, Math.round(((10 * 4 + 20 * 5 + 30 * 8 + 940 * 0.2 + 5 * 20) / 1e6) * 100) / 100);
  assert.equal(ledgerAt().report('24h').totals.cacheShare, 0, 'no input: share 0');
});

test('a model without a price is counted in tokens, never priced at $0 silently: the total says it is incomplete', () => {
  const l = ledgerAt();
  l.line(msg('m1', 'r1', NOW - 60000, U({ output_tokens: 1e6 })), { fileKey: 's', projectId: 'p1' });
  l.line(msg('m2', 'r2', NOW - 60000, U({ output_tokens: 1e6 }), 'claude-mystery-9'), { fileKey: 's', projectId: 'p1' });
  const r = l.report('24h');
  assert.equal(r.totals.output, 2e6);
  assert.equal(r.totals.usd, 20);
  assert.equal(r.totals.usdPartial, true);
  assert.deepEqual(r.unpriced, ['claude-mystery-9']);
  const m = r.models.find((x) => x.model === 'claude-mystery-9');
  assert.equal(m.priced, false);
  assert.equal(m.usd, 0);
  assert.equal(r.models.find((x) => x.model === 'claude-opus-5-5').priced, true);
  const s = l.summary();
  assert.deepEqual(s.unpriced, ['claude-mystery-9']);
  assert.equal(s.periods['24h'].usdPartial, true);
});

test('days are local: 23:30 and 00:30 Istanbul time fall on two days of the daily series', () => {
  assert.equal(localDay(Date.parse('2026-09-27T20:30:00Z')), '2026-09-27');
  assert.equal(localDay(Date.parse('2026-09-27T21:30:00Z')), '2026-09-28');
  const l = ledgerAt();
  l.line(msg('a', 'r', '2026-09-27T20:30:00Z', U({ output_tokens: 3 })), { fileKey: 's', projectId: 'p1' });
  l.line(msg('b', 'r', '2026-09-27T21:30:00Z', U({ output_tokens: 4 })), { fileKey: 's', projectId: 'p1' });
  const daily = l.report('30d').daily;
  assert.equal(daily.length, 30);
  assert.equal(daily.at(-1).day, '2026-09-29', 'ends today (local)');
  assert.equal(daily.find((d) => d.day === '2026-09-27').output, 3);
  assert.equal(daily.find((d) => d.day === '2026-09-28').output, 4);
});

test('this month starts at local midnight of the 1st; 24h, 7d and 30d slide by whole hours', () => {
  const r = periodRange('month', NOW);
  assert.equal(r.from, new Date(2026, 8, 1).getTime());
  assert.equal(periodRange('24h', NOW).from, Date.parse('2026-09-28T11:00:00Z'));
  assert.equal(periodRange('7d', NOW).from, Date.parse('2026-09-22T11:00:00Z'));
  assert.equal(periodRange('30d', NOW).from, Date.parse('2026-08-30T11:00:00Z'));
  const l = ledgerAt();
  const add = (id, t) => l.line(msg(id, 'r', t, U({ output_tokens: 1 })), { fileKey: 's', projectId: 'p1' });
  add('aug31-2330', '2026-08-31T20:30:00Z'); // 23:30 on 31 August, local
  add('sep01-0030', '2026-08-31T21:30:00Z'); // 00:30 on 1 September, local
  add('h-25', '2026-09-28T10:59:00Z'); // just before the 24 hours
  add('h-24', '2026-09-28T11:00:00Z'); // first minute of the 24 hours
  add('now', NOW);
  const n = (p) => l.report(p).totals.messages;
  assert.equal(n('24h'), 2);
  assert.equal(n('7d'), 3);
  assert.equal(n('month'), 4, 'from 00:30 on the 1st');
  assert.equal(n('30d'), 5);
  const s = l.summary();
  assert.deepEqual(Object.keys(s.periods), ['24h', '7d', 'month', '30d']);
  assert.deepEqual(['24h', '7d', 'month', '30d'].map((p) => s.periods[p].messages), [2, 3, 4, 5]);
});

test('per project and per model; a project report and its 30-day card summary', () => {
  const l = ledgerAt();
  l.line(msg('a', 'r', NOW - HOUR, U({ output_tokens: 1e6 })), { fileKey: 's', projectId: 'p1' });
  l.line(msg('b', 'r', NOW - HOUR, U({ output_tokens: 1e6 }), 'claude-sonnet-5'), { fileKey: 's', projectId: 'p2' });
  l.line(msg('c', 'r', NOW - 3 * DAY, U({ output_tokens: 2e6 }), 'claude-sonnet-5'), { fileKey: 's', projectId: 'p2' });
  const r = l.report('30d', { nameOf: (id) => ({ p1: 'One', p2: 'Two' })[id] });
  assert.deepEqual(r.projects.map((p) => [p.id, p.name, p.usd]), [
    ['p2', 'Two', 30],
    ['p1', 'One', 20],
  ]);
  assert.deepEqual(r.models.map((m) => [m.model, m.messages]), [
    ['claude-sonnet-5', 2],
    ['claude-opus-5-5', 1],
  ]);
  const p2 = l.report('24h', { projectId: 'p2' });
  assert.equal(p2.totals.messages, 1);
  assert.equal(p2.projects, undefined);
  assert.equal(p2.daily.reduce((s, d) => s + d.messages, 0), 2, 'the daily series covers 30 days of that project');
  assert.equal(l.projectUsage('p2').usd, 30);
  assert.equal(l.projectUsage('p3'), null);
});

test('a restart never counts a message twice: the file and the logs are merged per hour and project, not added', () => {
  const hub = tmpDir('restart');
  const lines = [
    [msg('a', 'r', NOW - 2 * HOUR, U({ input_tokens: 5, output_tokens: 100 })), 'p1'],
    [msg('b', 'r', NOW - 2 * HOUR, U({ output_tokens: 200 })), 'p1'],
    [msg('c', 'r', NOW - 26 * HOUR, U({ output_tokens: 300 }), 'claude-sonnet-5'), 'p2'],
  ];
  const feedAll = (l, list) => list.forEach(([o, pid]) => l.line(o, { fileKey: 's', projectId: pid }));
  const a = ledgerAt(NOW, { hubDir: hub });
  a.beginScan();
  feedAll(a, lines);
  a.finishScan();
  assert.ok(fs.existsSync(ledgerFile(hub)));
  const ra = a.report('7d').totals;
  assert.equal(ra.messages, 3);

  // Restart: the numbers are there before any log line, and the rescan of the same lines changes nothing
  const b = ledgerAt(NOW, { hubDir: hub });
  assert.deepEqual(b.report('7d').totals, ra);
  b.beginScan();
  // Halfway through the rescan an hour has fewer messages in the logs read so far than in the file: no dip
  feedAll(b, lines.slice(0, 1));
  assert.deepEqual(b.report('7d').totals, ra);
  assert.equal(b.summary().scanning, true);
  feedAll(b, lines);
  assert.deepEqual(b.report('7d').totals, ra);
  // A new message after the restart is added once
  b.line(msg('d', 'r', NOW - 60000, U({ output_tokens: 7 })), { fileKey: 's', projectId: 'p1' });
  b.finishScan();
  assert.equal(b.report('7d').totals.messages, 4);
  assert.equal(b.report('7d').totals.output, 607);
  const c = ledgerAt(NOW, { hubDir: hub });
  assert.deepEqual(c.report('7d').totals, b.report('7d').totals, 'a third start reads the same');
  c.beginScan();
  feedAll(c, [...lines, [msg('d', 'r', NOW - 60000, U({ output_tokens: 7 })), 'p1']]);
  c.finishScan();
  assert.deepEqual(c.report('7d').totals, b.report('7d').totals);
});

test('logs deleted after they were counted keep their numbers; a half-written hour is replaced by the complete one', () => {
  const hub = tmpDir('deleted');
  const early = [msg('a', 'r', NOW - 30 * HOUR, U({ output_tokens: 10 })), msg('b', 'r', NOW - 30 * HOUR, U({ output_tokens: 20 }))];
  const late = msg('c', 'r', NOW - 2 * HOUR, U({ output_tokens: 40 }));
  const a = ledgerAt(NOW, { hubDir: hub });
  for (const o of [...early, late]) a.line(o, { fileKey: 's', projectId: 'p1' });
  a.flush();
  // The early hour's log is gone: only the late line is read again
  const b = ledgerAt(NOW, { hubDir: hub });
  b.beginScan();
  b.line(late, { fileKey: 's', projectId: 'p1' });
  b.finishScan();
  assert.equal(b.report('7d').totals.messages, 3);
  assert.equal(b.report('7d').totals.output, 70);
  // The file held one message of an hour that went on: the logs have three, the report shows three (not four)
  const hub2 = tmpDir('half');
  const h = NOW - 5 * HOUR;
  const c = ledgerAt(NOW, { hubDir: hub2 });
  c.line(msg('x1', 'r', h, U({ output_tokens: 1 })), { fileKey: 's', projectId: 'p1' });
  c.flush();
  const d = ledgerAt(NOW, { hubDir: hub2 });
  for (const id of ['x1', 'x2', 'x3']) d.line(msg(id, 'r', h + 1000, U({ output_tokens: 1 })), { fileKey: 's', projectId: 'p1' });
  assert.equal(d.report('24h').totals.messages, 3);
});

test('a broken ledger file is kept aside and rebuilt; bad rows of a good file are skipped', () => {
  const hub = tmpDir('broken');
  fs.mkdirSync(path.join(hub, 'usage'), { recursive: true });
  fs.writeFileSync(ledgerFile(hub), 'not json at all', 'utf8');
  const logs = [];
  const l = ledgerAt(NOW, { hubDir: hub, log: (x) => logs.push(x) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /broken/);
  assert.ok(fs.existsSync(ledgerFile(hub) + '.broken'));
  assert.equal(l.report('30d').totals.messages, 0);
  l.beginScan();
  l.line(msg('a', 'r', NOW - HOUR, U({ output_tokens: 9 })), { fileKey: 's', projectId: 'p1' });
  l.finishScan();
  const saved = JSON.parse(fs.readFileSync(ledgerFile(hub), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.pricedAt, PRICED_AT);
  assert.deepEqual(saved.fields, ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'messages']);
  // Bad rows: a wrong length, negative numbers, a bad hour label; the good row stays
  const h = hourLabel(Math.floor((NOW - HOUR) / HOUR));
  saved.hours[h].p1.bad = [1, 2, 3];
  saved.hours[h].p1['claude-opus-5'] = [-1, 'x', 0, 0, 5, 1];
  saved.hours['2026-99-99T99'] = { p1: { m: [1, 1, 1, 1, 1, 1] } };
  fs.writeFileSync(ledgerFile(hub), JSON.stringify(saved));
  const r = ledgerAt(NOW, { hubDir: hub }).report('30d');
  assert.equal(r.totals.messages, 2);
  assert.equal(r.totals.output, 14);
  // A file of another version is not read as this one
  fs.writeFileSync(ledgerFile(hub), JSON.stringify({ ...saved, version: 99 }));
  ledgerAt(NOW, { hubDir: hub, log: () => {} });
  assert.ok(fs.existsSync(ledgerFile(hub) + '.broken'));
});

test('without a hub the ledger works in memory and writes nothing', () => {
  const l = ledgerAt(NOW);
  assert.equal(l.file, null);
  l.line(msg('a', 'r', NOW, U({ output_tokens: 1 })), { fileKey: 's', projectId: 'p1' });
  assert.equal(l.flush(), false);
  assert.equal(l.report('24h').totals.messages, 1);
});

test('hours older than 40 days fold into their local day in the file, each hour once', () => {
  const hub = tmpDir('fold');
  const old1 = Math.floor((NOW - 45 * DAY) / HOUR);
  const data = {
    version: 1,
    hours: {
      [hourLabel(old1)]: { p1: { 'claude-opus-5': [0, 0, 0, 0, 10, 1] } },
      [hourLabel(old1 + 1)]: { p1: { 'claude-opus-5': [0, 0, 0, 0, 20, 2] } },
    },
    days: {},
  };
  fs.mkdirSync(path.join(hub, 'usage'), { recursive: true });
  fs.writeFileSync(ledgerFile(hub), JSON.stringify(data));
  const l = ledgerAt(NOW, { hubDir: hub });
  l.dirty = true;
  l.flush();
  l.dirty = true;
  l.flush();
  const saved = JSON.parse(fs.readFileSync(ledgerFile(hub), 'utf8'));
  assert.deepEqual(Object.keys(saved.hours), []);
  const day = localDay(old1 * HOUR);
  assert.deepEqual(saved.days[day].p1['claude-opus-5'], [0, 0, 0, 0, 30, 3]);
  // After a restart the fold is not repeated
  const again = ledgerAt(NOW, { hubDir: hub });
  again.dirty = true;
  again.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile(hub), 'utf8')).days[day].p1['claude-opus-5'], [0, 0, 0, 0, 30, 3]);
});

test('sweep: keys and hours that leave the horizon are forgotten, kept on the file side; an old line is not counted again', () => {
  let now = NOW;
  const hub = tmpDir('sweep');
  const l = new UsageLedger({ hubDir: hub, now: () => now, log: () => {}, debounceMs: 0 });
  const o = msg('a', 'r', NOW - HOUR, U({ output_tokens: 11 }));
  l.line(o, { fileKey: 's', projectId: 'p1' });
  now = NOW + 33 * DAY;
  l.sweep();
  assert.equal(l.keys.size, 0);
  assert.equal(l.fresh.size, 0);
  assert.equal(l.line(o, { fileKey: 's', projectId: 'p1' }), false, 'older than the horizon: ignored');
  l.dirty = true;
  l.flush();
  const saved = JSON.parse(fs.readFileSync(ledgerFile(hub), 'utf8'));
  assert.deepEqual(saved.hours[hourLabel(Math.floor((NOW - HOUR) / HOUR))].p1['claude-opus-5-5'], [0, 0, 0, 0, 11, 1]);
});

// ---------- the log reader hands its lines over; the patch carries the numbers ----------

function fakeCatalog() {
  const project = { id: 'p1', name: 'P1', kind: 'adhoc', path: 'C:\\p1', stats24: {} };
  return { resolve: () => 'p1', getProject: (id) => (id === 'p1' ? project : null), allProjects: () => [project], roster: new Map() };
}
function feed(ing, ctx, st, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  ing.line(ctx, st, buf, 0, buf.length);
}
const asst = (id, req, usage, t = new Date().toISOString()) => ({ parentUuid: 'x', isSidechain: false, cwd: 'C:\\p1', sessionId: 's1', message: { model: 'claude-opus-5-5', id, role: 'assistant', type: 'message', content: [], usage }, requestId: req, type: 'assistant', timestamp: t });

test('incremental: assistant lines from the log reader update the ledger, and the next patch carries the numbers and the project card', () => {
  const catalog = fakeCatalog();
  const ing = new Ingest(catalog);
  ing.cutoff = 0;
  ing.initial = false;
  const ledger = new UsageLedger({ log: () => {} });
  ing.ledger = ledger;
  const s = ing.getSession('s1', null);
  const st = { kind: 'main', sessionId: 's1' };
  feed(ing, s, st, asst('m1', 'r1', U({ input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 500 })));
  let p = takePatch(ing, catalog);
  assert.equal(p.kpi.usage.periods['24h'].messages, 1);
  assert.equal(p.kpi.usage.periods['24h'].output, 10);
  assert.equal(p.projects.find((x) => x.id === 'p1').usage30.output, 10);
  assert.equal(takePatch(ing, catalog), null, 'nothing new: no patch');
  // The same response grows on its next line: only the difference is added
  feed(ing, s, st, asst('m1', 'r1', U({ input_tokens: 3, output_tokens: 42, cache_read_input_tokens: 500 })));
  p = takePatch(ing, catalog);
  assert.equal(p.kpi.usage.periods['24h'].output, 42);
  assert.equal(p.kpi.usage.periods['24h'].messages, 1);
  // A sub-agent file repeating the line (same ids) adds nothing; a new response adds one message
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a1.jsonl'));
  feed(ing, ag, { kind: 'agent', sessionId: 's1', agentId: 'a1' }, asst('m1', 'r1', U({ output_tokens: 42 })));
  feed(ing, ag, { kind: 'agent', sessionId: 's1', agentId: 'a1' }, asst('m2', 'r2', U({ output_tokens: 1 })));
  p = takePatch(ing, catalog);
  assert.equal(p.kpi.usage.periods['24h'].messages, 2);
  assert.equal(ledger.report('24h').projects[0].id, 'p1', 'the sub-agent is booked on its session\'s project');
  // The snapshot carries the same summary; without a ledger it carries none
  assert.equal(snapshot(ing, catalog).kpi.usage.periods['30d'].messages, 2);
  const bare = new Ingest(catalog);
  assert.equal(snapshot(bare, catalog).kpi.usage, null);
  assert.equal(snapshot(bare, catalog).projects[0].usage30, null);
});

test('the log files the reader skips: only "usage" lines, the project from the first working directory, sub-agents with their session', async () => {
  const root = tmpDir('older');
  const slug = 'C--proj-a';
  fs.mkdirSync(path.join(root, slug, 's1', 'subagents'), { recursive: true });
  const t = (h) => iso(NOW - h * HOUR);
  const L = (o) => JSON.stringify(o) + '\n';
  const main = path.join(root, slug, 's1.jsonl');
  fs.writeFileSync(
    main,
    L({ type: 'user', cwd: 'C:\\proj\\a', message: { role: 'user', content: 'hi' }, timestamp: t(20 * 24) }) +
      L({ cwd: 'C:\\proj\\a\\sub', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5', usage: U({ output_tokens: 10 }), content: [{ type: 'text', text: 'line\u2028sep\u2029x' }] }, timestamp: t(20 * 24) }) +
      L({ cwd: 'C:\\proj\\a', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5', usage: U({ output_tokens: 12 }) }, timestamp: t(20 * 24) }) +
      L({ cwd: 'C:\\proj\\a', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-5', usage: U({ output_tokens: 5 }) }, timestamp: t(20 * 24 - 1) }) +
      L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'the word "usage" in a result is escaped: never parsed' }] }, timestamp: t(20 * 24 - 1) }) +
      L({ type: 'user', toolUseResult: { usage: { output_tokens: 3 } }, message: { role: 'user', content: 'a usage key outside message: parsed, not counted' }, timestamp: t(20 * 24 - 1) }) +
      '{"cwd":"C:\\\\proj\\\\a","requestId":"r9","message":{"id":"m9","model":"claude-opus-5","usage":{"output_tokens":1000}}', // no newline: a half-written last line
  );
  const agent = path.join(root, slug, 's1', 'subagents', 'agent-x.jsonl');
  fs.writeFileSync(agent, L({ cwd: 'C:\\elsewhere', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-5', usage: U({ output_tokens: 5 }) }, timestamp: t(20 * 24 - 1) }) + L({ cwd: 'C:\\elsewhere', requestId: 'r3', message: { id: 'm3', model: 'claude-opus-5', usage: U({ output_tokens: 7 }) }, timestamp: t(20 * 24 - 1) }));
  const recent = path.join(root, slug, 's2.jsonl'); // the reader's own file: skipped here
  fs.writeFileSync(recent, L({ cwd: 'C:\\proj\\a', requestId: 'r4', message: { id: 'm4', model: 'claude-opus-5', usage: U({ output_tokens: 99 }) }, timestamp: t(1) }));
  const ancient = path.join(root, slug, 's0.jsonl'); // older than the horizon: skipped
  fs.writeFileSync(ancient, L({ cwd: 'C:\\proj\\a', requestId: 'r5', message: { id: 'm5', model: 'claude-opus-5', usage: U({ output_tokens: 77 }) }, timestamp: t(40 * 24) }));
  const mtimes = { [main]: NOW - 20 * DAY, [agent]: NOW - 20 * DAY, [recent]: NOW - HOUR, [ancient]: NOW - 40 * DAY };
  const kinds = { [main]: { kind: 'main', slug, sessionId: 's1' }, [agent]: { kind: 'agent', slug, sessionId: 's1', agentId: 'x' }, [recent]: { kind: 'main', slug, sessionId: 's2' }, [ancient]: { kind: 'main', slug, sessionId: 's0' } };
  const ingest = { walk: async () => Object.keys(mtimes).map((abs) => ({ abs, mtime: mtimes[abs], size: fs.statSync(abs).size })), classify: (abs) => kinds[abs] || null, sessions: new Map() };
  const resolved = [];
  const catalog = { resolve: (cwd, s) => (resolved.push([cwd, s]), cwd ? `proj:${cwd}` : null) };
  const l = ledgerAt(NOW);
  const n = await scanOlderLogs(l, { ingest, catalog, projectsDir: root, before: NOW - 14 * DAY });
  assert.equal(n, 2, 'the main file and its sub-agent');
  assert.deepEqual(l.scanInfo, { done: 2, total: 2 });
  const r = l.report('30d');
  assert.equal(r.totals.messages, 3, 'm1 (two lines), m2 (twice: main and sub-agent), m3');
  assert.equal(r.totals.output, 12 + 5 + 7);
  assert.deepEqual(r.projects.map((p) => p.id), ['proj:C:\\proj\\a'], 'the sub-agent keeps its session\'s project');
  assert.deepEqual(resolved, [['C:\\proj\\a', slug]], 'resolved once, from the first working directory');
  // The reader parses only lines that hold "usage"
  const seen = [];
  const first = await readUsageLines(main, (o) => seen.push(o.message?.id || o.type));
  assert.equal(first, 'C:\\proj\\a');
  assert.deepEqual(seen, ['m1', 'm1', 'm2', 'user']);
});

// ---------- the API ----------

test('GET /api/usage: periods, a project filter and the access rules', async () => {
  const l = ledgerAt(Date.now());
  l.line(msg('a', 'r', Date.now() - 60000, U({ output_tokens: 1e6 })), { fileKey: 's', projectId: 'p1' });
  const catalog = fakeCatalog();
  const q = (s) => new URLSearchParams(s);
  assert.equal(usageRoute(null, catalog, q('')).status, 404);
  assert.equal(usageRoute(l, catalog, q('period=year')).status, 400);
  assert.equal(usageRoute(l, catalog, q('period=7d&project=..%2Fx')).status, 400);
  assert.equal(usageRoute(l, catalog, q('project=nope')).status, 404);
  const all = usageRoute(l, catalog, q(''));
  assert.equal(all.status, 200);
  assert.equal(all.body.period, '24h');
  assert.equal(all.body.pricedAt, PRICED_AT);
  assert.equal(all.body.totals.usd, 20);
  assert.deepEqual(all.body.projects.map((p) => [p.id, p.name]), [['p1', 'P1']]);
  const one = usageRoute(l, catalog, q('period=month&project=p1'));
  assert.equal(one.status, 200);
  assert.equal(one.body.name, 'P1');
  assert.equal(one.body.totals.output, 1e6);

  const ing = new Ingest(catalog);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ ingest: ing, catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, usage: l }));
  const get = (p, method = 'GET', headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    const r = await get('/api/usage?period=30d', 'GET', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    assert.equal(JSON.parse(r.body).totals.messages, 1);
    assert.equal((await get('/api/usage?period=30d', 'POST')).status, 405);
    assert.equal((await get('/api/usage', 'GET', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 403);
    assert.equal((await get('/api/usage?period=x')).status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------- the page ----------

test('page formats: every dollar starts with "~$"; token amounts in thousands, millions and billions per language', () => {
  setLanguage('tr');
  assert.equal(usd(2733.4), '~$2.733');
  assert.equal(usd(4.2), '~$4,20');
  assert.equal(usd(0), '~$0');
  assert.equal(usd(null), '~$—');
  assert.equal(amount(5690), '5,7 bin');
  assert.equal(amount(14.9e6), '14,9 milyon');
  assert.equal(amount(15.98e9), '15,98 milyar');
  assert.equal(amount(999), '999');
  assert.equal(millions(20.2e6), '20,2 M');
  assert.equal(percent(0.9817), '98');
  assert.equal(percent(0.001), '<1');
  assert.equal(dateText('2026-09-25'), '25.09.2026');
  setLanguage('en');
  assert.equal(usd(2733.4), '~$2,733');
  assert.equal(amount(14.9e6), '14.9M');
  assert.equal(amount(15.98e9), '15.98B');
  assert.equal(millions(20.2e6), '20.2M');
  setLanguage('tr');
});

const summary = {
  ready: true,
  scanning: false,
  pricedAt: '2026-09-25',
  unpriced: [],
  periods: {
    '24h': { input: 5690, cacheWrite: 14.3e6, cacheRead: 858.8e6, output: 614526, processed: 14.9e6, messages: 2822, cacheShare: 0.98, usd: 262, usdPartial: false },
    '7d': { input: 1, cacheWrite: 1, cacheRead: 1, output: 1, processed: 3, messages: 1, cacheShare: 0.33, usd: 2733, usdPartial: false },
    month: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1, processed: 3, messages: 1, cacheShare: 0.33, usd: 1, usdPartial: false },
    '30d': { input: 1, cacheWrite: 1, cacheRead: 1, output: 1, processed: 3, messages: 40193, cacheShare: 0.33, usd: 8975, usdPartial: true },
  },
};

test('the strip: period buttons, four cards with dollars, three without; the dollar card says estimate and not billed', () => {
  setLanguage('tr');
  const html = stripHtml(summary, { period: '24h', showCost: true, open: true });
  assert.equal((html.match(/data-usage-period=/g) || []).length, 4);
  assert.match(html, /data-usage-open[^>]*aria-expanded="true" aria-controls="usageCards">Daralt/);
  assert.match(html, /data-usage-period="24h"[^>]*class="on" aria-pressed="true"/);
  assert.equal((html.match(/class="us-card /g) || []).length, 4);
  assert.match(html, /İşlenen token/);
  assert.match(html, /14,9 milyon/);
  assert.match(html, /Önbellekten okunan/);
  assert.match(html, /girdinin %98 kadarı önbellekten/);
  assert.match(html, /~\$262/);
  assert.match(html, /API karşılığı \(tahmini\)/);
  assert.match(html, /aboneliğinde faturalanmaz/);
  assert.match(html, /Fiyatlar: Anthropic API, 25\.09\.2026/);
  assert.match(html, /2\.822 mesaj/);
  const noCost = stripHtml(summary, { period: '24h', showCost: false, open: true });
  assert.equal((noCost.match(/class="us-card /g) || []).length, 3);
  assert.doesNotMatch(noCost, /~\$/);
  assert.match(noCost, /\$ göster/);
  // An incomplete total says so
  const partial = stripHtml({ ...summary, unpriced: ['claude-mystery-9'] }, { period: '30d', showCost: true, open: true });
  assert.match(partial, /eksik: bazı modellerin fiyatı bilinmiyor/);
  assert.match(partial, /claude-mystery-9/);
  assert.equal(stripHtml(null), '');
  assert.match(stripHtml({ ...summary, scanning: true }, { period: '7d' }), /eski loglar hâlâ sayılıyor/);
});

test('"not your bill" stands next to the dollars; with ANTHROPIC_API_KEY set the strip warns that the amount may be a real bill and opens the setup check', () => {
  setLanguage('tr');
  const closed = stripHtml(summary, { period: '24h', showCost: true, open: false });
  assert.match(closed, /~\$262<\/b><small class="us-sum-bill">API karşılığı · faturan değil<\/small>/);
  assert.doesNotMatch(closed, /us-warn/);
  const keyed = { ...summary, apiKeyEnv: true };
  const k = stripHtml(keyed, { period: '24h', showCost: true, open: false });
  assert.match(k, /API anahtarı öderse gerçek harcama/);
  assert.match(k, /class="us-warn"[^]*ANTHROPIC_API_KEY tanımlı[^]*data-usage-setup[^>]*>Kurulum kontrolü/);
  const kOpen = stripHtml(keyed, { period: '24h', showCost: true, open: true });
  assert.match(kOpen, /us-warn/);
  assert.match(kOpen, /API anahtarı öderse gerçek harcama/, 'the dollar card says it too');
  assert.doesNotMatch(stripHtml(keyed, { period: '24h', showCost: false }), /us-warn|~\$/, 'dollars hidden: no warning about them');
  setLanguage('en');
  assert.match(stripHtml(summary, { period: '24h', showCost: true, open: false }), /API equivalent · not your bill/);
  // The ledger carries the flag it was given, as a boolean only
  assert.equal(ledgerAt(NOW, { apiKeyEnv: true }).summary().apiKeyEnv, true);
  assert.equal(ledgerAt(NOW, { apiKeyEnv: 'sk-ant-x' }).summary().apiKeyEnv, false);
  assert.equal(ledgerAt().summary().apiKeyEnv, false);
});

test('the strip starts closed: one line with the processed tokens and the dollars, the cards behind "Details"', () => {
  setLanguage('tr');
  resetPrefs();
  const closed = stripHtml(summary, { period: '24h', showCost: true });
  assert.doesNotMatch(closed, /class="us-card /);
  assert.doesNotMatch(closed, /usageCards/);
  assert.match(closed, /data-usage-open[^>]*aria-expanded="false">Ayrıntı/);
  assert.match(closed, /14,9 milyon işlenen token/);
  assert.match(closed, /class="us-sum-cost" title="[^"]*aboneliğinde ayrıca faturalanmaz[^"]*">~\$262/);
  assert.match(closed, /2\.822 mesaj/);
  // Without dollars only the tokens; an incomplete total is marked
  assert.doesNotMatch(stripHtml(summary, { period: '24h', showCost: false }), /~\$/);
  assert.match(stripHtml({ ...summary, unpriced: ['claude-mystery-9'] }, { period: '30d', showCost: true }), /us-sum-cost partial" title="[^"]*claude-mystery-9/);
  // The choice is kept and does not wake the listeners of the period and dollar settings
  let calls = 0;
  const off = onPrefs(() => calls++);
  assert.equal(stripOpen(), false);
  assert.equal(setStripOpen(true), true);
  assert.equal(setStripOpen(true), false);
  assert.equal(stripOpen(), true);
  assert.match(stripHtml(summary, { period: '24h', showCost: true }), /class="us-card /);
  off();
  assert.equal(calls, 0);
  resetPrefs();
});

test('project card line, sort by spend and the drawer section', async () => {
  setLanguage('tr');
  const u = { usd: 2231.4, output: 20.2e6, processed: 1, cacheRead: 1, messages: 5 };
  assert.match(cardLineHtml(u, true), /30 gün ~\$2\.231 · 20,2 M çıktı/);
  assert.match(cardLineHtml(u, false), /30 gün · 20,2 M çıktı/);
  assert.doesNotMatch(cardLineHtml(u, false), /\$/);
  assert.equal(cardLineHtml(null, true), '');
  assert.equal(cardLineHtml({ ...u, messages: 0 }, true), '');
  const ps = [
    { id: 'a', name: 'A', usage30: { usd: 10, processed: 900, messages: 1 } },
    { id: 'b', name: 'B', usage30: null },
    { id: 'c', name: 'C', usage30: { usd: 50, processed: 100, messages: 1 } },
  ];
  assert.deepEqual(bySpend(ps, true).map((g) => g.map((p) => p.id)), [['c', 'a'], ['b']]);
  assert.deepEqual(bySpend(ps, false)[0].map((p) => p.id), ['a', 'c'], 'without dollars: by processed tokens');
  const groups = projectGroups(ps, { sort: 'spend', cost: true });
  assert.deepEqual(groups.map((g) => [g.title, g.items.map((p) => p.id)]), [
    ['Son 30 günde en çok kullanan', ['c', 'a']],
    ['Son 30 günde kullanım yok', ['b']],
  ]);
  assert.equal(projectGroups(ps, { sort: 'activity', now: 0 }).length, 1);

  // The drawer section: loading, then the answer (asked once within the ttl), bars of 30 days, the models
  const data = {
    period: '7d',
    pricedAt: '2026-09-25',
    totals: { input: 1, cacheWrite: 2, cacheRead: 97, output: 3, processed: 6, messages: 4, cacheShare: 0.97, usd: 12.5, usdPartial: true },
    models: [
      { model: 'claude-opus-5-5', priced: true, usd: 12.5, processed: 6, output: 3, messages: 3 },
      { model: 'claude-mystery-9', priced: false, usd: 0, processed: 1, output: 1, messages: 1 },
    ],
    daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, processed: i, cacheRead: 0, output: i, messages: i ? 1 : 0, usd: i })),
    unpriced: ['claude-mystery-9'],
    scanning: false,
  };
  let calls = 0;
  let arrived = null;
  let clock = 1000;
  const pu = createProjectUsage({ fetchJson: async () => (calls++, data), onData: (id) => (arrived = id), now: () => clock, ttl: 5000 });
  assert.match(pu.html('p1', { period: '7d', showCost: true }), /Kullanım yükleniyor/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(arrived, 'p1');
  const html = pu.html('p1', { period: '7d', showCost: true });
  assert.equal(calls, 1, 'cached');
  assert.equal((html.match(/class="us-bar[ "]/g) || []).length, 30);
  assert.match(html, /Opus 5\.5/);
  assert.match(html, /fiyat bilinmiyor/);
  assert.match(html, /<span class="us-mnums">6 işlenen · 3 çıktı<\/span><b>~\$13<\/b>/);
  assert.match(html, /Fiyatlar: Anthropic API, 25\.09\.2026 · API karşılığı, tahmini/);
  assert.match(html, /data-sec="usage"/);
  clock += 6000;
  assert.match(pu.html('p1', { period: '7d', showCost: true }), /~\$13/, 'the older answer stays on screen while a new one is asked for');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2, 'asked again after the ttl');
  const tokensOnly = sectionHtml({ data }, { period: '7d', showCost: false });
  assert.doesNotMatch(tokensOnly, /~\$/);
  assert.match(tokensOnly, /Günlük işlenen token/);
  assert.match(sectionHtml({ error: true }, { period: '24h' }), /Kullanım alınamadı/);
  // A period without messages: no row of zeros, the 30 days stay
  const quiet = sectionHtml({ data: { ...data, totals: { ...data.totals, messages: 0 } } }, { period: '24h', showCost: true });
  assert.match(quiet, /Bu dönemde kullanım yok/);
  assert.doesNotMatch(quiet, /class="us-card /);
  assert.equal((quiet.match(/class="us-bar[ "]/g) || []).length, 30);
  assert.match(chartHtml(data.daily, true), /aria-label="Günlük API karşılığı: ~\$435"/);
  assert.match(cardsHtml(data.totals, { showCost: true, unpriced: data.unpriced, pricedAt: data.pricedAt }), /eksik/);
});

test('page preferences: period, dollars and the advanced views are kept in the browser; default 24 hours, dollars and advanced views hidden (docs/direction.md §3.3)', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    resetPrefs();
    assert.equal(getPeriod(), '24h');
    assert.equal(costShown(), false, 'a newcomer meets no price by default');
    assert.equal(advancedShown(), false);
    assert.equal(setCostShown(true), true);
    assert.equal(store.get(COST_KEY), '1');
    assert.equal(setAdvancedShown(true), true);
    assert.equal(store.get(ADVANCED_KEY), '1');
    resetPrefs();
    assert.equal(costShown(), true);
    assert.equal(advancedShown(), true);
    assert.equal(setAdvancedShown(false), true);
    let changes = 0;
    const off = onPrefs(() => changes++);
    assert.equal(setPeriod('month'), true);
    assert.equal(setPeriod('month'), false, 'no change');
    assert.equal(setPeriod('year'), false, 'unknown period');
    assert.equal(setCostShown(false), true);
    assert.equal(store.get(PERIOD_KEY), 'month');
    assert.equal(store.get(COST_KEY), '0');
    assert.equal(changes, 2);
    off();
    resetPrefs();
    assert.equal(getPeriod(), 'month', 'read back after a reload');
    assert.equal(costShown(), false);
    store.set(PERIOD_KEY, 'garbage');
    resetPrefs();
    assert.equal(getPeriod(), '24h');
    // A blocked storage keeps the choice for the page
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    resetPrefs();
    assert.equal(getPeriod(), '24h');
    assert.equal(setPeriod('7d'), true);
    assert.equal(getPeriod(), '7d');
  } finally {
    delete globalThis.localStorage;
    resetPrefs();
  }
});

// ---------------- the project drawer: activity tiles next to the usage section ----------------

test('project drawer tiles: tool calls, prompts and running agents; output tokens only in the usage section', async () => {
  const { projectTilesHtml } = await import('../public/js/views/drawer.js');
  const html = projectTilesHtml({ stats24: { tools: 1234, tokens: 987654, prompts: 7 }, runningAgents: 2 });
  assert.equal((html.match(/<div><b>/g) || []).length, 3, 'three tiles');
  assert.match(html, /<b>1\.234<\/b><span>araç · 24 sa<\/span>/);
  assert.match(html, /<b>7<\/b><span>komut · 24 sa<\/span>/);
  assert.match(html, /<b>2<\/b><span>çalışan ajan<\/span>/);
  assert.doesNotMatch(html, /çıktı token/, 'the old output tile is gone');
  assert.doesNotMatch(html, /987/, 'the 24-hour output count is not shown twice');
  assert.match(html, /repeat\(3, minmax\(0, 1fr\)\)/, 'one row of three');
  // A project without numbers yet
  assert.equal((projectTilesHtml({}).match(/<b>0<\/b>/g) || []).length, 3);
});
