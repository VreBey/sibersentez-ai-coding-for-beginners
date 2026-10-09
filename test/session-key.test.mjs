// The session key (review A1): the desktop shell makes a fresh secret every launch, the server asks for it on every
// /api route, and only the shell's own window sends it. Another program on this computer cannot copy it from a header.
// Run: node --test test/session-key.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionKeyAllowed } from '../server/app.mjs';
import { resolveConfig } from '../server/config.mjs';
import { buildServerEnv, withSessionKey } from '../electron/helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'a1'.repeat(32);
const req = (url, key) => ({ url, headers: key === undefined ? {} : { 'x-sibersentez-key': key } });

test('server: without a key nothing changes; with one every /api route needs it, the page itself stays open', () => {
  assert.equal(sessionKeyAllowed(req('/api/snapshot'), null), true, 'no key: the server started on its own');
  for (const url of ['/', '/?lang=tr', '/js/main.js', '/css/app.css', '/apix', '/API/snapshot']) assert.equal(sessionKeyAllowed(req(url), KEY), true, url);
  for (const url of ['/api', '/api/', '/api/snapshot', '/api/stream', '/api/actions', '/api/action', '/api/projects/x/fit?idea=a', '/./api/snapshot', '/x/../api/snapshot', '/api/../api/actions']) {
    assert.equal(sessionKeyAllowed(req(url), KEY), false, `${url} without the key`);
    assert.equal(sessionKeyAllowed(req(url, KEY), KEY), true, `${url} with the key`);
  }
  assert.equal(sessionKeyAllowed(req('/api/snapshot', 'b2'.repeat(32)), KEY), false, 'a wrong key of the same length');
  assert.equal(sessionKeyAllowed(req('/api/snapshot', KEY.slice(1)), KEY), false, 'a shorter key');
  assert.equal(sessionKeyAllowed(req('/api/snapshot', `${KEY} `), KEY), false, 'a longer key');
  assert.equal(sessionKeyAllowed({ url: '/api/snapshot', headers: { 'x-sibersentez-key': [KEY, KEY] } }, KEY), false, 'a repeated header');
});

test('config: a valid key is taken; an invalid one closes /api instead of opening it; it is never logged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-key-'));
  try {
    const logs = [];
    const read = (v) => resolveConfig({ env: v === undefined ? {} : { SIBERSENTEZ_SESSION_KEY: v }, appDir: dir, homeDir: dir, log: (l) => logs.push(l) }).sessionKey;
    assert.equal(read(undefined), null);
    assert.equal(read(` ${KEY} `), KEY);
    for (const bad of ['short', KEY.toUpperCase(), `${KEY}0`, 'z'.repeat(64)]) {
      const k = read(bad);
      assert.match(k, /^[0-9a-f]{64}$/, bad);
      assert.notEqual(k, bad);
      assert.equal(sessionKeyAllowed(req('/api/snapshot', bad), k), false, `${bad} does not open /api`);
    }
    assert.ok(logs.length === 4 && logs.every((l) => /SIBERSENTEZ_SESSION_KEY is invalid/.test(l)));
    assert.ok(!logs.join('\n').includes(KEY.toUpperCase()), 'the value is not logged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('config: the key leaves the environment once read, so programs the server starts never inherit it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-key-env-'));
  try {
    // A fixed program; the module and the key come as arguments, never written into the code (code scanning #14)
    const code = 'const [url, key] = process.argv.slice(1); import(url).then((m) => console.log(JSON.stringify({ taken: m.SESSION_KEY === key, left: process.env.SIBERSENTEZ_SESSION_KEY ?? null })))';
    const url = new URL('server/config.mjs', `file:///${ROOT.replace(/\\/g, '/')}/`).href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code, url, KEY], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: dir, HOME: dir, SIBERSENTEZ_HUB: path.join(dir, 'no-hub'), SIBERSENTEZ_SESSION_KEY: KEY },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { taken: true, left: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('shell: the key goes only to our own server, and a header the page set itself is replaced', () => {
  const origin = 'http://127.0.0.1:47710';
  assert.deepEqual(withSessionKey(`${origin}/api/snapshot`, origin, { Accept: '*/*' }, KEY), { Accept: '*/*', 'X-SiberSentez-Key': KEY });
  assert.deepEqual(withSessionKey(`${origin}/api/snapshot`, origin, { 'x-sibersentez-key': 'forged' }, KEY), { 'X-SiberSentez-Key': KEY });
  for (const url of ['http://127.0.0.1:47711/api/snapshot', 'http://localhost:47710/api/snapshot', 'https://example.com/', 'http://user:pw@127.0.0.1:47710/api/snapshot', 'not a url']) {
    assert.deepEqual(withSessionKey(url, origin, { 'X-SiberSentez-Key': 'x', A: '1' }, KEY), { A: '1' }, url);
  }
  assert.deepEqual(withSessionKey(`${origin}/api/snapshot`, null, {}, KEY), {}, 'no server yet');
  assert.deepEqual(withSessionKey(`${origin}/api/snapshot`, origin, {}, ''), {}, 'no key');
});

test('shell: the server environment carries the new key; one the user set is never passed on', () => {
  const env = buildServerEnv({ PATH: 'C:\\Windows', SIBERSENTEZ_SESSION_KEY: 'mine', orkestra_session_key: 'old' }, { port: 47712, hubPath: 'C:\\hub', instance: 'x', sessionKey: KEY });
  assert.deepEqual(Object.entries(env).filter(([k]) => /session_key/i.test(k)), [['SIBERSENTEZ_SESSION_KEY', KEY]]);
  const none = buildServerEnv({ SIBERSENTEZ_SESSION_KEY: 'mine' }, { port: 47712, hubPath: null, instance: 'x' });
  assert.equal(none.SIBERSENTEZ_SESSION_KEY, undefined);
});

test('wiring: the shell makes the key, hands it to the server and adds it to its own requests; the server checks it before anything else', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
  assert.ok(main.includes("sessionKey: randomBytes(32).toString('hex'),"));
  assert.ok(main.includes('sessionKey: state.sessionKey });'));
  assert.ok(main.includes('withSessionKey(details.url, state.origin, details.requestHeaders, state.sessionKey)'));
  const app = fs.readFileSync(path.join(ROOT, 'server', 'app.mjs'), 'utf8');
  const h = app.indexOf('  function handle(req, res) {');
  assert.ok(h > 0 && app.indexOf('sessionKeyAllowed(req, sessionKey)', h) < app.indexOf('actionRoute(req.url)', h), 'before the action routes');
  assert.ok(fs.readFileSync(path.join(ROOT, 'server', 'index.mjs'), 'utf8').includes('sessionKey: SESSION_KEY'));
});
