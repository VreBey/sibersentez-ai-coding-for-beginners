// "A new version is out" (roadmap F3a, 2026-10-08): off by default (nothing leaves this computer); on, the page asks
// its own server, which asks GitHub's API for this repository's latest release at most once a day. Nothing is sent or
// downloaded. No network here: GitHub's answer is a fake.
// Run: node --test test/updates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNewer, parseLatest, parseVersion, createUpdateChecker, readLast, LATEST_URL, CHECK_TTL_MS, FAIL_TTL_MS } from '../server/update.mjs';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('versions: newer only for a higher release; a pre-release counts below its release; unknown is never newer', () => {
  assert.equal(isNewer('0.17.0', '0.16.0'), true);
  assert.equal(isNewer('v0.16.1', '0.16.0'), true);
  assert.equal(isNewer('0.16.0', '0.16.0'), false);
  assert.equal(isNewer('0.15.9', '0.16.0'), false);
  assert.equal(isNewer('0.17.0', '0.17.0-beta'), true);
  assert.equal(isNewer('0.17.0-beta', '0.17.0'), false);
  assert.equal(isNewer('nonsense', '0.16.0'), false);
  assert.equal(isNewer('0.17.0', null), false);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3, '']);
});

test('GitHub’s answer: a published release of this repository only; its page link must be this repository’s', () => {
  assert.deepEqual(parseLatest({ tag_name: 'v0.17.0', html_url: 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.17.0' }), { version: '0.17.0', url: 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.17.0' });
  assert.equal(parseLatest({ tag_name: 'v0.17.0', html_url: 'https://evil.example/x' }).url, 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/latest', 'a foreign link is replaced by the releases page');
  for (const bad of [null, {}, { tag_name: 'v0.17.0', draft: true }, { tag_name: 'v0.17.0', prerelease: true }, { tag_name: '0.17.0-rc1' }, { tag_name: 'latest' }]) assert.equal(parseLatest(bad), null, JSON.stringify(bad));
  assert.equal(LATEST_URL, 'https://api.github.com/repos/VreBey/sibersentez-ai-coding-for-beginners/releases/latest');
});

test('the checker: one request a day (a failure retried after an hour), one at a time; only this one address', async () => {
  let clock = 0;
  const asked = [];
  let answer = { ok: true, json: { tag_name: 'v0.17.0', html_url: 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.17.0' } };
  const c = createUpdateChecker({ current: '0.16.0', now: () => clock, get: async (url) => (asked.push(url), answer) });
  const [a, b] = await Promise.all([c.check(), c.check()]);
  assert.equal(a, b);
  assert.deepEqual([a.ok, a.latest, a.newer, a.current], [true, '0.17.0', true, '0.16.0']);
  assert.deepEqual(asked, [LATEST_URL], 'one request for two questions');
  clock = CHECK_TTL_MS - 1;
  await c.check();
  assert.equal(asked.length, 1, 'within the day: no request');
  clock = CHECK_TTL_MS + 1;
  answer = { ok: false, reason: 'rate-limited' };
  assert.deepEqual([(await c.check()).ok, c.last().reason], [false, 'rate-limited']);
  clock += FAIL_TTL_MS - 1;
  await c.check();
  assert.equal(asked.length, 2, 'a failure: not again within the hour');
  clock += 2;
  answer = { ok: true, json: { tag_name: 'v0.16.0' } };
  assert.equal((await c.check()).newer, false);
  assert.equal(asked.length, 3);
});

test('the checker across starts: the last answer is kept in a file, so a new start within the day asks nothing; another version, a damaged file or one from the future ask again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-update-'));
  try {
    const file = path.join(dir, 'update-check.json');
    let clock = 1000;
    const asked = [];
    const get = async (url) => (asked.push(url), { ok: true, json: { tag_name: 'v0.17.0', html_url: 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.17.0' } });
    const first = await createUpdateChecker({ current: '0.16.0', now: () => clock, get, file }).check();
    assert.equal(asked.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), first, 'kept whole');
    assert.deepEqual(fs.readdirSync(dir), ['update-check.json'], 'no temporary file left');
    clock += CHECK_TTL_MS - 10;
    const again = await createUpdateChecker({ current: '0.16.0', now: () => clock, get, file }).check();
    assert.deepEqual([asked.length, again.latest, again.newer], [1, '0.17.0', true], 'a new start within the day: from the file');
    await createUpdateChecker({ current: '0.17.0', now: () => clock, get, file }).check();
    assert.equal(asked.length, 2, 'the app was updated: asked again');
    fs.writeFileSync(file, JSON.stringify({ ...first, checkedAt: clock + 1e9 }));
    await createUpdateChecker({ current: '0.16.0', now: () => clock, get, file }).check();
    assert.equal(asked.length, 3, 'from the future: asked again');
    fs.writeFileSync(file, '{not json');
    await createUpdateChecker({ current: '0.16.0', now: () => clock, get, file }).check();
    assert.equal(asked.length, 4, 'damaged: asked again');
    fs.writeFileSync(file, JSON.stringify({ ...first, checkedAt: clock, url: 'https://evil.example/', latest: '0.18.0' }));
    const c = createUpdateChecker({ current: '0.16.0', now: () => clock, get, file });
    assert.equal(readLast(file, '0.16.0', () => clock).url, 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/latest', 'a foreign link never comes back from the file');
    assert.equal((await c.check()).latest, '0.18.0');
    assert.equal(asked.length, 4);
    const failed = await createUpdateChecker({ current: '0.16.0', now: () => (clock += CHECK_TTL_MS + 1), get: async () => (asked.push('x'), { ok: false, reason: 'rate-limited' }), file }).check();
    assert.equal(failed.reason, 'rate-limited');
    clock += FAIL_TTL_MS - 10;
    await createUpdateChecker({ current: '0.16.0', now: () => clock, get, file }).check();
    assert.equal(asked.length, 5, 'a failure kept for an hour across starts too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page: off by default and then never asks; on, it asks; a newer version is told once; only known words and this repository’s link pass', async () => {
  globalThis.localStorage = memory();
  const m = await import('../public/js/updates.js?' + Date.now());
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), { json: async () => ({ ok: true, current: '0.16.0', latest: '0.17.0', newer: true, url: 'https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.17.0' }) });
  assert.equal(m.updatesOn(), false);
  await m.checkUpdates({ fetchImpl });
  assert.deepEqual(calls, [], 'off: no request at all');
  assert.equal(m.updatesState().status, 'off');
  await m.setUpdatesOn(true, { fetchImpl });
  assert.deepEqual(calls, ['/api/update'], 'its own server only');
  assert.equal(m.noticeDue(), true);
  m.markTold();
  assert.equal(m.noticeDue(), false, 'told once per version');
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const html = m.updateRowHtml();
    assert.ok(html.includes(STRINGS[lang].updNewer.replace('{latest}', '0.17.0').replace('{current}', '0.16.0')) && html.includes('href="https://github.com/VreBey/'));
    assert.ok(m.updateRowHtml({ status: 'off' }).includes(STRINGS[lang].updOffText));
    for (const k of ['updTitle', 'updText', 'updOffText', 'updChecking', 'updFailed', 'updLatest', 'updNewer', 'updOpen', 'updNoticeTitle', 'updNoticeBody']) assert.ok(STRINGS[lang][k]?.trim(), `${lang} ${k}`);
  }
  setLanguage('en');
  assert.equal(m.cleanAnswer({ ok: true, current: '0.16.0', latest: '0.17.0', newer: true, url: 'https://evil.example/' }).url, null);
  assert.deepEqual(m.cleanAnswer({ ok: true, latest: '<b>', newer: true }), { ok: false, reason: 'no-release', current: null });
  await m.setUpdatesOn(false, { fetchImpl });
  await m.checkUpdates({ fetchImpl });
  assert.equal(calls.length, 1, 'off again: no more requests');
  delete globalThis.localStorage;
});

test('wiring: GET only; the start of the page asks only through checkUpdates (never in QA); Settings has the switch; the promise is said', () => {
  const app = read('server/app.mjs');
  assert.ok(app.indexOf("if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'get-only' });") < app.indexOf("if (p === '/api/update') {"), 'GET only, as every API route');
  const main = read('public/js/main.js');
  assert.ok(main.includes('if (!QA) {\n  checkUpdates().then(() => {'));
  assert.equal((main.match(/\/api\/update/g) || []).length, 0, 'the page asks only through updates.js');
  const settings = read('public/js/views/settings.js');
  assert.ok(settings.includes("toggle('data-set-updates', 'set:updates', updatesChecked, t('updTitle'))"));
  assert.match(STRINGS.tr.updText, /hiçbir şey göndermez, hiçbir şey indirmez/);
  const server = read('server/update.mjs');
  assert.doesNotMatch(server, /createWriteStream|child_process|spawn\(/, 'nothing downloaded, nothing run');
  assert.equal((server.match(/writeFileSync\(/g) || []).length, 1, 'one write: the last answer, small JSON, in the hub');
  assert.ok(server.includes("fs.writeFileSync(tmp, JSON.stringify(a), { flag: 'wx' });"));
});
