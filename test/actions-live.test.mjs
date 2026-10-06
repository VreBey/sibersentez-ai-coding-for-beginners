// A new actions mode without a restart (docs/actions-toggle.md §3.5): the server's setMode (a new token, the old one
// refused), the shell channel's actions-reload (the server reads its own sources; the message names no mode), the
// shell's decision between in place and restart, the page's switch closing once the mode is in force, and the wiring.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createActions } from '../server/actions.mjs';
import { createProjectChannel } from '../server/memory.mjs';
import { resolveActionModeNow } from '../server/config.mjs';
import { applyActionsModeLive } from '../electron/helpers.mjs';
import { initialSwitch, switchStep } from '../public/js/actionsSwitch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-live-mode-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PORT = 45999;
const fakeRes = () => ({ headersSent: false, writeHead(code) { this.code = code; }, end(b) { this.body = b; } });
const make = (mode) => createActions({ catalog: {}, ingest: {}, fit: { invalidate() {} }, mode, port: PORT, log: () => {} });
const get = (actions) => {
  const r = fakeRes();
  actions.handleGet({ headers: { 'sec-fetch-site': 'same-origin' } }, r);
  return { status: r.code, body: r.body ? JSON.parse(r.body) : null };
};
async function post(actions, token) {
  const req = Object.assign(new EventEmitter(), {
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-sibersentez-token': token },
  });
  const r = fakeRes();
  const done = actions.handlePost(req, r);
  process.nextTick(() => {
    req.emit('data', Buffer.from('{"action":"explorer","projectId":"alpha"}'));
    req.emit('end');
  });
  await done;
  return { status: r.code, body: JSON.parse(r.body) };
}

describe('server: setMode', () => {
  test('off -> dry -> live -> off: a new token each time, the old one refused, the list follows the mode', async () => {
    const a = make('off');
    assert.equal(a.mode, 'off');
    assert.equal(get(a).status, 404);
    assert.deepEqual(a.setMode('dry'), { changed: true, mode: 'dry' });
    const g1 = get(a);
    assert.equal(g1.status, 200);
    assert.equal(g1.body.mode, 'dry');
    assert.match(g1.body.token, /^[0-9a-f]{64}$/);
    assert.ok(a.list().length > 0);
    assert.deepEqual(a.setMode('live'), { changed: true, mode: 'live' });
    const g2 = get(a);
    assert.equal(g2.body.mode, 'live');
    assert.notEqual(g2.body.token, g1.body.token, 'a new token with the new mode');
    const stale = await post(a, g1.body.token);
    assert.equal(stale.status, 403, 'a request under the old mode is refused, never run in the new one');
    assert.deepEqual(a.setMode('off'), { changed: true, mode: 'off' });
    assert.equal(a.token, null);
    assert.deepEqual(a.list(), []);
    assert.equal(get(a).status, 404);
    assert.equal((await post(a, g2.body.token)).status, 404, 'off: no action at all');
  });

  test('the same mode changes nothing (the token stays); an unknown one means off', () => {
    const a = make('dry');
    const tok = a.token;
    assert.deepEqual(a.setMode('dry'), { changed: false, mode: 'dry' });
    assert.equal(a.token, tok);
    assert.deepEqual(a.setMode('everything'), { changed: true, mode: 'off' });
    assert.equal(a.token, null);
  });
});

describe('server: the shell channel', () => {
  test('actions-reload answers with the mode the server now runs in; the message cannot name one', () => {
    const asked = [];
    const ch = createProjectChannel({ catalog: {}, reloadActions: () => (asked.push(1), { ok: true, mode: 'dry', reason: 'applied' }) });
    const r = ch.handle({ sibersentez: 'shell-call', id: 7, type: 'actions-reload', mode: 'live' });
    assert.deepEqual(r, { sibersentez: 'shell-reply', id: 7, ok: true, reason: 'applied', mode: 'dry' }, 'the mode in the message is ignored');
    assert.equal(asked.length, 1);
    const old = createProjectChannel({ catalog: {} });
    assert.deepEqual(old.handle({ sibersentez: 'shell-call', id: 8, type: 'actions-reload' }), { sibersentez: 'shell-reply', id: 8, ok: false, reason: 'unknown-request' });
    const broken = createProjectChannel({ catalog: {}, reloadActions: () => { throw new Error('C:\\secret'); } });
    assert.deepEqual(broken.handle({ sibersentez: 'shell-call', id: 9, type: 'actions-reload' }), { sibersentez: 'shell-reply', id: 9, ok: false, reason: 'error' });
  });

  test('the mode is read again from the same sources: the hub settings, below sibersentez.json and the environment', () => {
    const hub = path.join(TMP, 'hub');
    const app = path.join(TMP, 'app');
    fs.mkdirSync(hub, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    const now = (env = {}) => resolveActionModeNow({ env, appDir: app, hub });
    assert.equal(now(), 'off', 'no settings.json');
    fs.writeFileSync(path.join(hub, 'settings.json'), JSON.stringify({ actions: 'live' }));
    assert.equal(now(), 'live');
    fs.writeFileSync(path.join(hub, 'settings.json'), JSON.stringify({ actions: 'dry' }));
    assert.equal(now(), 'dry');
    assert.equal(now({ SIBERSENTEZ_ACTIONS: 'nonsense' }), 'off', 'an unknown value in a higher source means off');
    fs.writeFileSync(path.join(app, 'sibersentez.json'), JSON.stringify({ actions: 'off' }));
    assert.equal(now(), 'off', 'sibersentez.json decides before settings.json');
    assert.equal(resolveActionModeNow({ env: {}, appDir: path.join(TMP, 'none'), hub: null }), 'off', 'no hub: off');
  });
});

describe('shell: in place or restart', () => {
  const run = async (opts) => {
    const seen = { calls: 0, restarts: 0 };
    const how = await applyActionsModeLive({
      requested: 'dry',
      serverReady: true,
      call: async () => (seen.calls++, opts.reply),
      restart: () => seen.restarts++,
      ...opts,
    });
    return { how, ...seen };
  };
  test('an answer naming the saved mode: in place, no restart', async () => {
    assert.deepEqual(await run({ reply: { ok: true, mode: 'dry', reason: 'applied' } }), { how: 'live', calls: 1, restarts: 0 });
    assert.deepEqual(await run({ reply: { ok: true, mode: 'dry', reason: 'same' } }), { how: 'live', calls: 1, restarts: 0 });
  });
  test('anything else restarts: another mode, an old server, a timeout, a throw, no ready server', async () => {
    assert.deepEqual(await run({ reply: { ok: true, mode: 'off' } }), { how: 'restart', calls: 1, restarts: 1 });
    assert.deepEqual(await run({ reply: { ok: false, reason: 'unknown-request' } }), { how: 'restart', calls: 1, restarts: 1 });
    assert.deepEqual(await run({ reply: { ok: false, reason: 'timeout' } }), { how: 'restart', calls: 1, restarts: 1 });
    assert.deepEqual(await run({ call: async () => { throw new Error('x'); } }), { how: 'restart', calls: 0, restarts: 1 });
    assert.deepEqual(await run({ serverReady: false, reply: { ok: true, mode: 'dry' } }), { how: 'restart', calls: 0, restarts: 1 });
  });
});

describe('page: the switch closes once the saved mode is in force', () => {
  const saving = () => {
    let s = switchStep(initialSwitch('off'), { type: 'open' }).state;
    return switchStep(s, { type: 'pick', mode: 'dry' }).state;
  };
  test('answer first, then the event: saved, then closed', () => {
    const saved = switchStep(saving(), { type: 'result', reply: { changed: true, reason: 'saved', mode: 'dry' } }).state;
    assert.equal(saved.step, 'saved');
    const done = switchStep(saved, { type: 'mode', mode: 'dry' });
    assert.equal(done.state.open, false);
    assert.equal(done.state.step, 'choose');
    assert.equal(done.state.current, 'dry');
    assert.ok(done.effects.some((fx) => fx.type === 'closed'));
  });
  test('the event first, then the answer: closed at once', () => {
    const learned = switchStep(saving(), { type: 'mode', mode: 'dry' }).state;
    assert.equal(learned.step, 'saving', 'still waiting for the shell');
    const done = switchStep(learned, { type: 'result', reply: { changed: true, reason: 'saved', mode: 'dry' } });
    assert.equal(done.state.open, false);
    assert.equal(done.state.current, 'dry');
  });
  test('a mode that is not the saved one leaves the saved step alone (the restart path reloads the window)', () => {
    const saved = switchStep(saving(), { type: 'result', reply: { changed: true, reason: 'saved', mode: 'dry' } }).state;
    assert.equal(switchStep(saved, { type: 'mode', mode: 'off' }).state.step, 'saved');
  });
});

test('wiring: the shell asks in place first, the server tells the page, the page asks again', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  const main = read('electron', 'main.mjs');
  const fn = main.slice(main.indexOf('function applyActionsMode('), main.indexOf('\n}\n', main.indexOf('function applyActionsMode(')));
  assert.ok(fn.includes("call: () => serverCalls.call(state.server, 'actions-reload'),"));
  assert.ok(fn.includes("restart: () => applyServerSettingsChange('actions mode'),"));
  assert.ok(fn.includes('serverReady: Boolean(state.server?.alive && !state.launching && state.origin),'));
  const index = read('server', 'index.mjs');
  assert.ok(index.includes("broadcast('actions', { mode: actions.mode });"), 'the event carries the mode only, never the token');
  assert.ok(/reloadActions: \(\) => \{\n\s+const r = actions\.setMode\(resolveActionModeNow\(/.test(index), 'the server reads the mode itself');
  assert.ok(read('public', 'js', 'main.js').includes("es.addEventListener('actions', () => initActions());"));
});

test('page: two quick mode reads, the older answer arriving last, leave the newer mode', async () => {
  const { initActions, actionsState, _resetActionsForTest } = await import('../public/js/actions.js');
  _resetActionsForTest?.();
  const answer = (mode) => ({ ok: true, status: 200, json: async () => ({ mode, token: (mode === 'dry' ? 'a' : 'b').repeat(64) }) });
  let releaseOld;
  const old = initActions({ fetch: () => new Promise((r) => (releaseOld = () => r(answer('dry')))) });
  await initActions({ fetch: async () => answer('live') });
  releaseOld();
  await old;
  assert.equal(actionsState().mode, 'live');
  assert.equal(actionsState().token, 'b'.repeat(64));
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.ok(/if \(greeted\) initActions\(\);\n\s+greeted = true;/.test(main), 'a reconnect asks for the mode again');
});
