// Action layer tests (contract §5, §7). Run: node --test test/actions.test.mjs
// No real process is started: spawn is a fake (injected). Temp folders live under the system temp folder.
// Each test proves a rejection rule or an argv format of the contract on a real HTTP server (random port).
// Error texts asserted below are the server's user-facing messages (Turkish until the i18n pass).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createActions, readActionMode, buildArgv, buildShellFallbackArgv, realWorkDir, hasAsarSegment, ACTION_NAMES } from '../server/actions.mjs';
import { ACTION_FIELDS as CLIENT_ACTION_FIELDS, ACTION_NAMES as CLIENT_ACTION_NAMES, actionBody } from '../public/js/actions.js';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';

// ---------------- fake world ----------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-actions-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const mkdir = (...parts) => {
  const d = path.join(ROOT, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// Hub: only library/<category> folders (packages are validated against them)
const HUB = mkdir('hub');
for (const k of ['web-ui', 'design']) mkdir('hub', 'library', k);
fs.writeFileSync(path.join(HUB, 'library', 'file-package'), 'not a folder');
// Working directory of started processes (stands in for the app folder)
const WORK = mkdir('app');
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_EXE = path.join(mkdir('vscode'), 'Code.exe');
fs.writeFileSync(CODE_EXE, '');
// The terminal fallback's programs (stand in for %SystemRoot%\System32\cmd.exe and Windows PowerShell)
const CMD_EXE = path.join(mkdir('system32'), 'cmd.exe');
const PS_EXE = path.join(mkdir('system32', 'WindowsPowerShell', 'v1.0'), 'powershell.exe');
fs.writeFileSync(CMD_EXE, '');
fs.writeFileSync(PS_EXE, '');

const DIR_A = mkdir('alpha');
const DIR_B = mkdir('beta');
const DIR_SEMI = mkdir('semi;colon'); // Windows allows ';' in a folder name: it must still be rejected
const DIR_ADHOC = mkdir('unregistered');
const DIR_HOME = mkdir('home');
const DIR_TITLE = mkdir('title');
const DIR_MISSING = path.join(ROOT, 'missing');
const DIR_FLEETING = mkdir('fleeting'); // removed by a test while a request runs

const S_IDLE = '11111111-1111-4111-8111-111111111111';
const S_LIVE = '22222222-2222-4222-8222-222222222222';
const S_SEMI = '33333333-3333-4333-8333-333333333333';
const S_NOCWD = '44444444-4444-4444-8444-444444444444';
const S_UNKNOWN = '55555555-5555-4555-8555-555555555555';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plugin = (p) => path.join(HUB, 'library', p);

function fakeCatalog() {
  const projects = [
    { id: 'alpha', name: 'Alpha', kind: 'registered', path: DIR_A },
    { id: 'beta', name: 'Beta', kind: 'registered', path: DIR_B },
    { id: 'semicolon', name: 'Semicolon', kind: 'registered', path: DIR_SEMI },
    { id: 'quoted', name: 'Quoted', kind: 'registered', path: String.raw`C:\x\a"b` },
    { id: 'bad-title', name: 'Name; bad', kind: 'registered', path: DIR_TITLE },
    { id: 'dash-title', name: '-rm', kind: 'registered', path: DIR_TITLE },
    { id: 'fleeting', name: 'Fleeting', kind: 'registered', path: DIR_FLEETING },
    { id: 'lost', name: 'Lost', kind: 'registered', path: DIR_MISSING },
    { id: 'pathless', name: 'Pathless', kind: 'registered', path: null },
    { id: 'x-unregistered', name: 'unregistered', kind: 'adhoc', path: DIR_ADHOC },
    { id: 'x-home', name: 'Home folder', kind: 'adhoc', path: DIR_HOME, broad: true },
  ];
  // The roster plays no part in package validation: a category in the catalog without a hub folder is still rejected
  const roster = new Map();
  const add = (kind, name, source, category) => roster.set(`${kind}:${name}`, { kind, name, source, sources: [source], category, installedIn: [] });
  add('skill', 'ui-kit', 'library', 'web-ui');
  add('skill', 'security-review', 'library', 'security');
  add('plugin', 'some-plugin', 'plugin', 'claude-code-skills');
  return { roster, getProject: (id) => projects.find((p) => p.id === id) || null };
}

function fakeIngest() {
  return {
    sessions: new Map([
      [S_IDLE, { id: S_IDLE, cwd: DIR_A, projectId: 'alpha', live: null }],
      [S_LIVE, { id: S_LIVE, cwd: DIR_A, projectId: 'alpha', live: { pid: 1, status: 'idle' } }],
      [S_SEMI, { id: S_SEMI, cwd: DIR_SEMI, projectId: 'semicolon', live: null }],
      [S_NOCWD, { id: S_NOCWD, cwd: DIR_MISSING, projectId: 'alpha', live: null }],
    ]),
  };
}

// Fake spawn: records the call and emits 'spawn' (or the given error code) on the next tick
function fakeSpawn(calls, failCode = null) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefed = true;
    };
    process.nextTick(() => (failCode ? child.emit('error', Object.assign(new Error('fake error'), { code: failCode })) : child.emit('spawn')));
    return child;
  };
}

// Fake spawn that decides per call: fail(cmd, args, opts) returns an error code or null
function scriptedSpawn(calls, fail) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    const code = fail(cmd, args, opts);
    process.nextTick(() => (code ? child.emit('error', Object.assign(new Error('fake error'), { code })) : child.emit('spawn')));
    return child;
  };
}
// start-ai (docs/ai-start.md): a fake tool detector (Claude Code found), so no test ever runs a real detection
const FAKE_CLAUDE = path.join(mkdir('bin'), 'claude.exe');
fs.writeFileSync(FAKE_CLAUDE, '');
const fakeTools = () => ({ detect: async () => ({ at: 0, tools: [{ id: 'claude', name: 'Claude Code', installed: true, chosen: { file: FAKE_CLAUDE, ext: '.exe', extra: false }, installs: [], via: 'native', version: '1.0.0', ready: 'yes' }] }) });

// As on Windows: CreateProcess cannot enter a folder inside an archive or a missing folder, and libuv reports ENOENT
const windowsLike = (opts) => (hasAsarSegment(opts.cwd) || !fs.existsSync(opts.cwd) ? 'ENOENT' : null);

function request(port, { method = 'GET', path: p = '/', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const h = { Host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    for (const [k, v] of Object.entries(headers)) if (v === undefined) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        settled = true;
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    // On 413 the server may close the connection without reading the rest of the body: errors after the answer are ignored
    req.on('error', (e) => {
      if (!settled) reject(e);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`no answer: ${method} ${p}`)));
    if (chunks) {
      for (const c of chunks) req.write(c);
      req.end();
    } else req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const goodHeaders = (port, token) => ({
  Origin: `http://127.0.0.1:${port}`,
  'Sec-Fetch-Site': 'same-origin',
  'Content-Type': 'application/json',
  'X-SiberSentez-Token': token || '',
});

async function startServer({ mode = 'dry', withActions = true, ...over } = {}) {
  const spawnCalls = [];
  const logs = [];
  let clock = Date.UTC(2026, 8, 27, 12, 0, 0);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const actions = withActions
    ? createActions({
        catalog: fakeCatalog(),
        ingest: fakeIngest(),
        mode,
        port,
        hubDir: HUB,
        workDir: WORK,
        codeExe: CODE_EXE,
        cmdExe: CMD_EXE,
        powershellExe: PS_EXE,
        spawn: fakeSpawn(spawnCalls),
        now: () => clock,
        log: (l) => logs.push(l),
        ai: { tools: fakeTools() },
        ...over,
      })
    : null;
  const catalog = { resolve: () => null, getProject: () => null, allProjects: () => [], roster: new Map() };
  server.on('request', createHandler({ ingest: fakeIngest(), catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions }));
  return {
    port,
    actions,
    spawnCalls,
    logs,
    tick: (ms) => (clock += ms),
    get: (p, headers = {}) => request(port, { path: p, headers }),
    post: (body, headers = {}) => request(port, { method: 'POST', path: '/api/action', body, headers: { ...goodHeaders(port, actions?.token), ...headers } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// A valid JSON body of exactly `total` bytes (filled with an extra field)
function paddedBody(total) {
  const base = { action: 'explorer', projectId: 'alpha', padding: '' };
  const pad = total - Buffer.byteLength(JSON.stringify(base));
  return JSON.stringify({ ...base, padding: 'a'.repeat(pad) });
}

// ---------------- pure functions ----------------
test('readActionMode: only dry and 1 turn it on; missing, 0 and unknown values are off', () => {
  assert.equal(readActionMode({}), 'off');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: '0' }), 'off');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: '' }), 'off');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: 'true' }), 'off');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: 'yes' }), 'off');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: 'dry' }), 'dry');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: ' DRY ' }), 'dry');
  assert.equal(readActionMode({ SIBERSENTEZ_ACTIONS: '1' }), 'live');
});

test('buildArgv: the argv formats of the contract (pure)', () => {
  const ctx = { dir: String.raw`C:\p\a b`, title: 'Alpha', sessionId: S_IDLE, newSessionId: S_UNKNOWN, projectId: 'alpha', packageDirs: [plugin('web-ui'), plugin('design')], codeExe: CODE_EXE };
  const wt = ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ctx.dir, '--title', 'Alpha', '--suppressApplicationTitle', 'claude'];
  const plugins = ['--plugin-dir', plugin('web-ui'), '--plugin-dir', plugin('design')];
  assert.deepEqual(buildArgv('resume', ctx), [...wt, '--resume', S_IDLE, ...plugins]);
  assert.deepEqual(buildArgv('fork', ctx), [...wt, '--resume', S_IDLE, ...plugins, '--fork-session']);
  assert.deepEqual(buildArgv('new', ctx), [...wt, '-n', 'alpha', '--session-id', S_UNKNOWN, ...plugins]);
  assert.deepEqual(buildArgv('resume', { ...ctx, packageDirs: [] }), [...wt, '--resume', S_IDLE]);
  // A plain terminal: a new tab with the default profile in the folder, no command (so no AI tool starts)
  assert.deepEqual(buildArgv('terminal', ctx), ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ctx.dir, '--title', 'Alpha']);
  assert.deepEqual(buildShellFallbackArgv({ cmdExe: CMD_EXE, powershellExe: PS_EXE }), [CMD_EXE, '/d', '/c', 'start', '', PS_EXE, '-NoExit']);
  assert.deepEqual(buildArgv('explorer', ctx), ['explorer.exe', `"${ctx.dir}"`]);
  assert.deepEqual(buildArgv('vscode', ctx), [CODE_EXE, ctx.dir]);
  assert.throws(() => buildArgv('rm', ctx));
  assert.throws(() => buildArgv('skills-install', ctx), 'no skill installing in this phase');
});

// ---------------- off mode ----------------
test('off mode: action endpoints 404, no token, no process and no log; other endpoints unchanged', async () => {
  const env = await startServer({ mode: 'off' });
  try {
    assert.equal(env.actions.mode, 'off');
    assert.equal(env.actions.token, null);
    assert.deepEqual(env.actions.list(), []);
    const g = await env.get('/api/actions', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(g.status, 404);
    assert.deepEqual(g.json, { error: 'actions-off' });
    const p = await env.post({ action: 'explorer', projectId: 'alpha' });
    assert.equal(p.status, 404);
    assert.equal(p.json.error, 'actions-off');
    assert.equal((await env.get('/')).status, 200);
    assert.equal((await request(env.port, { method: 'POST', path: '/api/snapshot' })).status, 405);
    assert.equal((await env.get('/api/snapshot', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 403);
    assert.equal(env.spawnCalls.length, 0);
    assert.equal(env.logs.length, 0);
    // The module stays off on its own too (a direct call, without relying on app.mjs routing)
    const fakeRes = () => ({ headersSent: false, writeHead(code) { this.code = code; }, end(b) { this.body = b; } });
    const good = goodHeaders(env.port, 'x');
    const req = Object.assign(new EventEmitter(), { headers: { ...good, host: `127.0.0.1:${env.port}`, origin: good.Origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } });
    const r1 = fakeRes();
    const posting = env.actions.handlePost(req, r1);
    // If the check breaks, the body would be read: the request must not hang, the test must turn red
    process.nextTick(() => {
      req.emit('data', Buffer.from('{"action":"explorer","projectId":"alpha"}'));
      req.emit('end');
    });
    await posting;
    assert.equal(r1.code, 404);
    assert.deepEqual(JSON.parse(r1.body), { error: 'actions-off' });
    const r2 = fakeRes();
    env.actions.handleGet({ headers: { 'sec-fetch-site': 'same-origin' } }, r2);
    assert.equal(r2.code, 404);
  } finally {
    await env.close();
  }
  // Without actions at all (the old call form) POST stays 405 everywhere
  const bare = await startServer({ withActions: false });
  try {
    assert.equal((await request(bare.port, { method: 'POST', path: '/api/action', headers: goodHeaders(bare.port, 'x'), body: '{}' })).status, 405);
    assert.equal((await bare.get('/api/actions', { 'Sec-Fetch-Site': 'same-origin' })).status, 404);
  } finally {
    await bare.close();
  }
});

// ---------------- GET /api/actions ----------------
test('GET /api/actions: Sec-Fetch-Site required and same-origin; reply has mode, 64 hex token and the action list', async () => {
  const env = await startServer({ mode: 'dry' });
  try {
    assert.equal((await env.get('/api/actions')).status, 403, 'no Sec-Fetch-Site');
    for (const s of ['cross-site', 'same-site', 'none']) assert.equal((await env.get('/api/actions', { 'Sec-Fetch-Site': s })).status, 403, s);
    assert.equal((await env.get('/api/actions', { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://evil.example' })).status, 403, 'wrong Origin');
    const r = await env.get('/api/actions', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'dry');
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.json.actions, [...ACTION_NAMES]);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY', 'security headers on action endpoints too');
    assert.ok(r.headers['content-security-policy']);
    // Methods: /api/actions GET only, /api/action POST only; the Host rule comes first
    assert.equal((await request(env.port, { method: 'PUT', path: '/api/actions', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 405);
    assert.equal((await env.get('/api/action', { 'Sec-Fetch-Site': 'same-origin' })).status, 405);
    assert.equal((await env.get('/api/actions', { Host: `evil.example:${env.port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 421);
    // The token is generated again on every start
    const other = createActions({ catalog: fakeCatalog(), ingest: fakeIngest(), mode: 'dry', port: 1, hubDir: HUB, log: () => {} });
    assert.notEqual(other.token, env.actions.token);
  } finally {
    await env.close();
  }
});

// ---------------- POST /api/action: header rules ----------------
test('POST: missing or wrong Origin -> 403 (must name the same host as Host)', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  try {
    assert.equal((await env.post(body, { Origin: undefined })).status, 403, 'no Origin');
    for (const o of ['http://evil.example', 'null', `https://127.0.0.1:${env.port}`, `http://127.0.0.1:${env.port + 1}`, `http://localhost:${env.port}`]) {
      assert.equal((await env.post(body, { Origin: o })).status, 403, o);
    }
    const r = await env.post(body, { Host: `localhost:${env.port}`, Origin: `http://localhost:${env.port}` });
    assert.equal(r.status, 200, 'a consistent request under the localhost name passes');
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('POST: missing Sec-Fetch-Site or not same-origin -> 403', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  try {
    assert.equal((await env.post(body, { 'Sec-Fetch-Site': undefined })).status, 403, 'missing');
    for (const s of ['cross-site', 'same-site', 'none']) assert.equal((await env.post(body, { 'Sec-Fetch-Site': s })).status, 403, s);
  } finally {
    await env.close();
  }
});

test('POST: Content-Type other than application/json -> 415 (text/plain, form, missing)', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  try {
    assert.equal((await env.post(body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await env.post(body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await env.post(body, { 'Content-Type': 'multipart/form-data; boundary=x' })).status, 415);
    assert.equal((await env.post(body, { 'Content-Type': 'application/json; charset=latin1' })).status, 415);
    assert.equal((await env.post(body, { 'Content-Type': undefined })).status, 415);
    assert.equal((await env.post(body, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
  } finally {
    await env.close();
  }
});

test('POST: body at most 16384 bytes (a job of 2000 characters fits); 16385 bytes -> 413 (with Content-Length and when chunked)', async () => {
  const env = await startServer();
  try {
    const exact = paddedBody(16384);
    assert.equal(Buffer.byteLength(exact), 16384);
    const r = await env.post(exact);
    assert.equal(r.status, 400, '16384 bytes pass the size rule (400 because of the extra field)');
    const big = paddedBody(16385);
    assert.equal(Buffer.byteLength(big), 16385);
    assert.equal((await env.post(big)).status, 413);
    const chunked = await request(env.port, { method: 'POST', path: '/api/action', headers: goodHeaders(env.port, env.actions.token), chunks: ['{"action":"explorer","x":"' + 'a'.repeat(12000), 'b'.repeat(5000) + '"}'] });
    assert.equal(chunked.status, 413);
  } finally {
    await env.close();
  }
});

test('POST: not JSON or not an object -> 400', async () => {
  const env = await startServer();
  try {
    for (const raw of ['not json', '[1,2]', 'null', '"text"', '42', '']) assert.equal((await env.post(raw)).status, 400, raw);
  } finally {
    await env.close();
  }
});

test('POST: wrong, missing or short token -> 403; the token is checked before validation', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  try {
    const wrong = env.actions.token.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': wrong })).status, 403);
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': undefined })).status, 403);
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': env.actions.token.slice(0, 10) })).status, 403);
    assert.equal((await env.post({ action: 'rm -rf' }, { 'X-SiberSentez-Token': wrong })).status, 403, 'a request without the token cannot even get the action name validated');
    assert.equal((await env.post(body)).status, 200);
  } finally {
    await env.close();
  }
});

// ---------------- validation ----------------
test('validation: unknown action and unexpected field -> 400 (no path or command comes from the browser)', async () => {
  const env = await startServer();
  try {
    const bad = [
      { action: 'rm' },
      { action: 'constructor', projectId: 'alpha' },
      { action: '__proto__', projectId: 'alpha' },
      { projectId: 'alpha' },
      { action: 'explorer', projectId: 'alpha', path: 'C:\\Windows' },
      { action: 'new', projectId: 'alpha', command: 'calc.exe' },
      { action: 'resume', sessionId: S_IDLE, item: 'ui-kit' },
      { action: 'explorer' },
      { action: 'explorer', projectId: 42 },
      { action: 'resume', sessionId: S_IDLE, packages: 'web-ui' },
      { action: 'resume', sessionId: S_IDLE, packages: Array.from({ length: 11 }, () => 'web-ui') },
      { action: 'resume', sessionId: 'abc' },
      { action: 'resume', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase() },
      { action: 'explorer', projectId: '-alpha' },
      { action: 'explorer', projectId: 'alpha beta' },
      { action: 'skills-preview', projectId: 'alpha' },
      { action: 'skills-preview', projectId: 'alpha', packages: ['web-ui'], item: 'ui-kit' },
      { action: 'resume', sessionId: S_IDLE, packages: ['Web_UI'] },
      { action: 'skills-install', projectId: 'alpha', item: 'UI Kit' },
    ];
    for (const b of bad) {
      const r = await env.post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.ok, false);
    }
    assert.equal((await env.post('{"action":"explorer","projectId":"alpha","__proto__":{"x":1}}')).status, 400, '__proto__ key');
    assert.equal((await env.post({ action: 'rm' })).json.error, 'unknown-action');
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('validation: unknown project, session, package or missing folder -> 404', async () => {
  const env = await startServer();
  try {
    const cases = [
      [{ action: 'explorer', projectId: 'missing-project' }, 'project-not-found'],
      [{ action: 'resume', sessionId: S_UNKNOWN }, 'session-not-found'],
      [{ action: 'explorer', projectId: 'lost' }, 'folder-missing'],
      [{ action: 'new', projectId: 'pathless' }, 'folder-missing'],
      [{ action: 'resume', sessionId: S_NOCWD }, 'folder-missing'],
      [{ action: 'resume', sessionId: S_IDLE, packages: ['missing-package'] }, 'package-folder-missing'],
      [{ action: 'resume', sessionId: S_IDLE, packages: ['claude-code-skills'] }, 'package-folder-missing'],
      [{ action: 'resume', sessionId: S_IDLE, packages: ['security'] }, 'package-folder-missing'],
      [{ action: 'new', projectId: 'alpha', packages: ['file-package'] }, 'package-folder-missing'],
    ];
    for (const [b, msg] of cases) {
      const r = await env.post(b);
      assert.equal(r.status, 404, JSON.stringify(b));
      assert.equal(r.json.error, msg);
      assert.notEqual(r.json.error, 'actions-off', 'the client would read this text as "off"');
    }
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('validation: no action on a broad-folder project -> 409; an unregistered but not broad folder is allowed', async () => {
  const env = await startServer();
  try {
    for (const action of ['explorer', 'vscode', 'new', 'terminal']) {
      const r = await env.post({ action, projectId: 'x-home' });
      assert.equal(r.status, 409, action);
      assert.match(r.json.error, /broad-folder/);
    }
    assert.equal((await env.post({ action: 'explorer', projectId: 'x-unregistered' })).status, 200, 'an unregistered but not broad folder can be opened');
    assert.equal((await env.post({ action: 'resume', sessionId: S_IDLE, projectId: 'beta' })).status, 400, 'the session belongs to another project');
  } finally {
    await env.close();
  }
});

test('validation: a path or title with `;` or `"` -> 409 (even if the folder exists), no process starts', async () => {
  const env = await startServer({ mode: 'live' });
  try {
    assert.ok(fs.statSync(DIR_SEMI).isDirectory(), 'the folder with a semicolon really exists');
    const cases = [
      { action: 'explorer', projectId: 'semicolon' },
      { action: 'new', projectId: 'semicolon' },
      { action: 'resume', sessionId: S_SEMI },
      { action: 'explorer', projectId: 'quoted' },
      { action: 'vscode', projectId: 'quoted' },
      { action: 'new', projectId: 'bad-title' },
    ];
    for (const b of cases) assert.equal((await env.post(b)).status, 409, JSON.stringify(b));
    assert.match((await env.post({ action: 'new', projectId: 'bad-title', packages: [] })).json.error, /project-name-unsafe/);
    assert.equal((await env.post({ action: 'explorer', projectId: 'bad-title' })).status, 200, 'the title is only used by terminal actions');
    assert.equal(env.spawnCalls.length, 1, 'only the last valid request started a process');
  } finally {
    await env.close();
  }
});

test('resume on a live session -> 409 with hint fork; fork is allowed', async () => {
  const env = await startServer();
  try {
    const r = await env.post({ action: 'resume', sessionId: S_LIVE });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { ok: false, error: 'session-live', hint: 'fork' });
    const f = await env.post({ action: 'fork', sessionId: S_LIVE });
    assert.equal(f.status, 200);
    assert.equal(f.json.argv.at(-1), '--fork-session');
  } finally {
    await env.close();
  }
});

// ---------------- skill actions and packages (contract §5) ----------------
test('skill actions refuse the bodies of the earlier package phase (packages, item): 400 unexpected-field, no process, nothing written', async () => {
  const env = await startServer({ mode: 'live' });
  const hubBefore = listTree(HUB);
  try {
    for (const b of [
      { action: 'skills-preview', projectId: 'alpha', packages: ['web-ui'] },
      { action: 'skills-install', projectId: 'alpha', item: 'ui-kit' },
      { action: 'skills-install', projectId: 'alpha', packages: ['design'] },
      // Even next to a well-formed skill body the old fields are refused
      { action: 'skills-install', projectId: 'alpha', items: [{ kind: 'skill', name: 'ui-kit' }], packages: ['design'] },
      { action: 'skills-remove', projectId: 'alpha', items: [{ kind: 'skill', name: 'ui-kit' }], item: 'ui-kit' },
      { action: 'skills-trial', projectId: 'alpha', items: [{ kind: 'skill', name: 'ui-kit' }], packages: ['web-ui'] },
    ]) {
      const r = await env.post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error, 'unexpected-field', JSON.stringify(b));
    }
    assert.ok(ACTION_NAMES.includes('skills-preview') && ACTION_NAMES.includes('skills-install'), 'the skill actions exist; only the old body shape is refused');
    assert.equal(env.spawnCalls.length, 0, 'no process was started');
    assert.deepEqual(listTree(HUB), hubBefore, 'nothing was written into the hub');
    assert.deepEqual(fs.readdirSync(DIR_A), [], 'nothing was written into the project');
  } finally {
    await env.close();
  }
});

test('the page and the server agree on every action and on the fields each one may carry (public/js/actions.js ACTION_FIELDS)', async () => {
  assert.deepEqual([...CLIENT_ACTION_NAMES], [...ACTION_NAMES], 'same actions, same order');
  const env = await startServer({ mode: 'dry' });
  const hubBefore = listTree(HUB);
  // One well-formed value per field; items take the import shape for library-import
  const value = (action, k) =>
    ({
      sessionId: S_IDLE,
      projectId: 'alpha',
      packages: ['web-ui'],
      source: DIR_B,
      items: action === 'library-import' || action === 'github-import' ? [{ path: 'x', category: 'web' }] : [{ kind: 'skill', name: 'ui-kit' }],
      targets: ['claude'],
      plan: true,
      keys: ['skill:ui-kit'],
      tool: 'claude',
      withIdea: true,
      resume: true,
      job: 'Add a sign-in page',
      inDock: true,
      url: 'https://github.com/owner/repo',
      fetchId: 'owner-repo@abcdef0',
      pointId: 'R20260930120000abcd',
      planId: '0123456789abcdef',
      open: 'index.html',
    })[k];
  const universe = [...new Set(Object.values(CLIENT_ACTION_FIELDS).flat())];
  const refused = (r) => r.status === 400 && /^(unexpected-field|beklenmeyen alan)/.test(String(r.json?.error));
  try {
    for (const action of CLIENT_ACTION_NAMES) {
      // Everything the page may send for this action passes the server's field check...
      const full = actionBody(Object.fromEntries([['action', action], ...CLIENT_ACTION_FIELDS[action].map((k) => [k, value(action, k)])]));
      assert.deepEqual(Object.keys(full).sort(), ['action', ...CLIENT_ACTION_FIELDS[action]].sort(), action);
      const r = await env.post(full);
      assert.ok(!refused(r), `${action}: the server refused a field the page sends (${r.status} ${r.json?.error})`);
      // ...and every other field the page knows is one the server refuses for this action (the lists are equal)
      for (const k of universe.filter((f) => !CLIENT_ACTION_FIELDS[action].includes(f))) {
        const x = await env.post({ ...full, [k]: value(action, k) });
        assert.ok(refused(x), `${action}: the server accepts ${k}, the page never sends it`);
      }
    }
    assert.equal(env.spawnCalls.length, 0, 'dry mode: nothing started');
    assert.deepEqual(listTree(HUB), hubBefore, 'dry mode: nothing written');
  } finally {
    await env.close();
  }
});

// Every file and folder below a folder (relative paths, sorted)
function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

test('packages only when the hub has the category folder: present -> --plugin-dir; missing -> 404; no hub -> 404 but actions without packages still run', async () => {
  const env = await startServer({ mode: 'dry' });
  try {
    const ok = await env.post({ action: 'new', projectId: 'alpha', packages: ['design'] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.argv.slice(-2), ['--plugin-dir', plugin('design')]);
    // In the roster but without a hub folder: rejected
    const missing = await env.post({ action: 'new', projectId: 'beta', packages: ['security'] });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'package-folder-missing');
  } finally {
    await env.close();
  }
  for (const hubDir of [null, undefined, path.join(ROOT, 'missing-hub')]) {
    const noHub = await startServer({ mode: 'dry', hubDir });
    try {
      const r = await noHub.post({ action: 'resume', sessionId: S_IDLE, packages: ['web-ui'] });
      assert.equal(r.status, 404, String(hubDir));
      assert.equal(r.json.error, 'hub-missing');
      const plain = await noHub.post({ action: 'resume', sessionId: S_IDLE });
      assert.equal(plain.status, 200, 'without a hub an action without packages works');
      assert.ok(!plain.json.argv.includes('--plugin-dir'));
      assert.equal((await noHub.post({ action: 'explorer', projectId: 'alpha' })).status, 200);
    } finally {
      await noHub.close();
    }
  }
  // Legacy hub: kutuphane/<category> is accepted when library/<category> does not exist
  const legacyHub = mkdir('legacy-hub');
  mkdir('legacy-hub', 'kutuphane', 'old-package');
  mkdir('legacy-hub', 'kutuphane', 'both');
  mkdir('legacy-hub', 'library', 'both');
  const legacy = await startServer({ mode: 'dry', hubDir: legacyHub });
  try {
    const r = await legacy.post({ action: 'new', projectId: 'alpha', packages: ['old-package', 'both'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.argv.slice(-4), ['--plugin-dir', path.join(legacyHub, 'kutuphane', 'old-package'), '--plugin-dir', path.join(legacyHub, 'library', 'both')], 'the English folder wins when both exist');
  } finally {
    await legacy.close();
  }
});

// ---------------- rate limit ----------------
test('the same action on the same target twice within 3 s -> 429; another target or action is allowed', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  try {
    assert.equal((await env.post(body)).status, 200);
    assert.equal((await env.post(body)).status, 429);
    env.tick(2999);
    assert.equal((await env.post(body)).status, 429, '2.999 s');
    assert.equal((await env.post({ action: 'explorer', projectId: 'beta' })).status, 200, 'another target');
    assert.equal((await env.post({ action: 'vscode', projectId: 'alpha' })).status, 200, 'another action');
    env.tick(1);
    assert.equal((await env.post(body)).status, 200, '3 s passed');
    // A rejected request sets no timer: a request with an invalid token never leads to 429
    assert.equal((await env.post({ action: 'explorer', projectId: 'beta' }, { 'X-SiberSentez-Token': 'x' })).status, 403);
  } finally {
    await env.close();
  }
});

// ---------------- dry mode ----------------
test('dry: no process starts; the reply carries the contract argv; packages -> --plugin-dir <hub>\\library\\<category>', async () => {
  const env = await startServer({ mode: 'dry' });
  const next = () => env.tick(3000);
  try {
    const wt = (dir, title) => ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', dir, '--title', title, '--suppressApplicationTitle', 'claude'];
    let r = await env.post({ action: 'resume', sessionId: S_IDLE, packages: ['web-ui', 'design', 'web-ui'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'dry');
    assert.equal(r.json.action, 'resume');
    assert.deepEqual(r.json.argv, [...wt(DIR_A, 'Alpha'), '--resume', S_IDLE, '--plugin-dir', plugin('web-ui'), '--plugin-dir', plugin('design')]);
    next();
    r = await env.post({ action: 'fork', sessionId: S_IDLE, projectId: 'alpha' });
    assert.deepEqual(r.json.argv, [...wt(DIR_A, 'Alpha'), '--resume', S_IDLE, '--fork-session']);
    r = await env.post({ action: 'new', projectId: 'alpha', packages: ['design'] });
    assert.match(r.json.sessionId, UUID_RE);
    assert.deepEqual(r.json.argv, [...wt(DIR_A, 'Alpha'), '-n', 'alpha', '--session-id', r.json.sessionId, '--plugin-dir', plugin('design')]);
    r = await env.post({ action: 'explorer', sessionId: S_IDLE });
    assert.deepEqual(r.json.argv, ['explorer.exe', `"${DIR_A}"`]);
    r = await env.post({ action: 'vscode', projectId: 'beta' });
    assert.deepEqual(r.json.argv, [CODE_EXE, DIR_B]);
    // Terminal: the Windows Terminal command, and the PowerShell one used when wt.exe cannot be started
    r = await env.post({ action: 'terminal', projectId: 'beta' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.argv, ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', DIR_B, '--title', 'Beta']);
    assert.deepEqual(r.json.fallbackArgv, [CMD_EXE, '/d', '/c', 'start', '', PS_EXE, '-NoExit']);
    assert.equal(r.json.terminal, undefined, 'nothing was opened');
    r = await env.post({ action: 'terminal', sessionId: S_IDLE });
    assert.deepEqual(r.json.argv, ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', DIR_A, '--title', 'Alpha']);
    assert.equal(env.spawnCalls.length, 0, 'spawn is never called in dry mode');
  } finally {
    await env.close();
  }
});

// ---------------- live mode (fake processes) ----------------
test('live: spawn with shell:false, an argv array, detached and no stdio; explorer gets a verbatim argument; Code.exe gets no ELECTRON_RUN_AS_NODE', async () => {
  const env = await startServer({ mode: 'live' });
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const r = await env.post({ action: 'resume', sessionId: S_IDLE, packages: ['web-ui'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'live');
    const c = env.spawnCalls[0];
    assert.equal(c.cmd, 'wt.exe');
    assert.ok(Array.isArray(c.args));
    assert.deepEqual([c.cmd, ...c.args], r.json.argv);
    assert.equal(c.opts.shell, false);
    assert.equal(c.opts.detached, true);
    assert.equal(c.opts.stdio, 'ignore');
    assert.equal(c.opts.cwd, WORK, 'a bare program name must not be looked up in the project folder: cwd is the app folder');
    assert.ok(!c.opts.windowsVerbatimArguments);

    await env.post({ action: 'explorer', projectId: 'alpha' });
    const e = env.spawnCalls[1];
    assert.equal(e.cmd, 'explorer.exe');
    assert.deepEqual(e.args, [`"${DIR_A}"`]);
    assert.equal(e.opts.windowsVerbatimArguments, true);
    assert.equal(e.opts.shell, false);

    await env.post({ action: 'vscode', projectId: 'alpha' });
    const v = env.spawnCalls[2];
    assert.equal(v.cmd, CODE_EXE);
    assert.deepEqual(v.args, [DIR_A]);
    assert.equal(v.opts.shell, false);
    assert.equal(v.opts.env.ELECTRON_RUN_AS_NODE, undefined);

    const term = await env.post({ action: 'terminal', projectId: 'alpha' });
    assert.equal(term.status, 200);
    assert.equal(term.json.terminal, 'wt');
    const w = env.spawnCalls[3];
    assert.deepEqual([w.cmd, ...w.args], ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', DIR_A, '--title', 'Alpha']);
    assert.deepEqual(term.json.argv, [w.cmd, ...w.args]);
    assert.equal(w.opts.cwd, WORK, 'wt.exe is looked up from the app folder, never from the project folder');
    assert.equal(w.opts.detached, true);
    assert.equal(w.opts.stdio, 'ignore');
    assert.ok(!w.opts.windowsVerbatimArguments);
    assert.equal(env.spawnCalls.length, 4, 'Windows Terminal opened: no fallback');
    for (const call of env.spawnCalls) assert.equal(call.opts.shell, false);
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
    await env.close();
  }
});

test('live: 501 when a program is missing (wt ENOENT, no Code.exe)', async () => {
  const calls = [];
  const env = await startServer({ mode: 'live', spawn: fakeSpawn(calls, 'ENOENT'), codeExe: path.join(ROOT, 'none', 'Code.exe') });
  try {
    const r = await env.post({ action: 'new', projectId: 'alpha' });
    assert.equal(r.status, 501);
    assert.match(r.json.error, /wt-missing/);
    const v = await env.post({ action: 'vscode', projectId: 'alpha' });
    assert.equal(v.status, 501);
    assert.equal(v.json.error, 'vscode-missing');
    assert.equal(calls.length, 1, 'no spawn is tried without Code.exe');
  } finally {
    await env.close();
  }
});

// ---------------- log ----------------
test('log: one line per request in a fixed format; no token, body or unregistered folder name', async () => {
  const env = await startServer({ mode: 'live' });
  try {
    const requests = [
      [{ action: 'explorer', projectId: 'alpha', secret: 'SECRET-VALUE' }, {}],
      [{ action: 'explorer', projectId: 'alpha' }, { 'X-SiberSentez-Token': 'wrong-SECRET' }],
      [{ action: 'explorer', projectId: 'alpha' }, { Origin: 'http://evil.example' }],
      [{ action: 'new', projectId: 'alpha', packages: ['web-ui'] }, {}],
      [{ action: 'explorer', projectId: 'x-unregistered' }, {}],
      [{ action: 'resume', sessionId: S_LIVE }, {}],
      ['{broken SECRET', {}],
    ];
    for (const [b, h] of requests) await env.post(b, h);
    await env.get('/api/actions', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(env.logs.length, requests.length + 1, 'one line per request');
    const LINE = /^\[action\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+ \S+ \d{3} \S+$/;
    for (const l of env.logs) {
      assert.match(l, LINE);
      assert.ok(!l.includes(env.actions.token), 'token in the log');
      assert.ok(!/SECRET|unregistered|semicolon|web-ui/.test(l), l);
    }
    assert.match(env.logs[0], / explorer alpha 400 /);
    assert.match(env.logs[1], / 403 token$/);
    assert.match(env.logs[4], / explorer x-#[0-9a-f]{8} 200 live$/);
    assert.match(env.logs[5], / resume 22222222 409 /);
  } finally {
    await env.close();
  }
});

// ---------------- review round 2 (independent review findings) ----------------
const LOG_LINE = /^\[action\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+ \S+ \d{3} \S+$/;
const noteOf = (line) => line.split(' ').at(-1);

test('rejection order is fixed: Content-Type, size and JSON before the token; Origin before Sec-Fetch-Site', async () => {
  const env = await startServer();
  const body = { action: 'explorer', projectId: 'alpha' };
  const wrongToken = { 'X-SiberSentez-Token': 'a'.repeat(64) };
  try {
    let r = await env.post(body, { ...wrongToken, 'Content-Type': 'text/plain' });
    assert.equal(r.status, 415, 'wrong token + text/plain -> 415');
    r = await env.post(paddedBody(16385), wrongToken);
    assert.equal(r.status, 413, 'wrong token + 16385 bytes -> 413');
    r = await env.post('{broken', wrongToken);
    assert.equal(r.status, 400, 'wrong token + broken JSON -> 400');
    assert.equal(r.json.error, 'bad-json');
    r = await env.post(body, { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'origin-rejected', 'wrong Origin + cross-site -> the Origin message');
    r = await env.post(body, { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' });
    assert.equal(r.status, 403, 'Sec-Fetch-Site before Content-Type');
    assert.equal(r.json.error, 'cross-site');
    assert.deepEqual(env.logs.map(noteOf), ['content-type', 'size', 'json', 'origin', 'fetch-site']);
  } finally {
    await env.close();
  }
});

test('last guard: with `;` in the hub path the --plugin-dir argument never reaches wt -> 409; a request without packages is allowed', async () => {
  const semiHub = mkdir('hub;semi');
  mkdir('hub;semi', 'library', 'web-ui');
  const env = await startServer({ mode: 'live', hubDir: semiHub });
  try {
    for (const b of [
      { action: 'resume', sessionId: S_IDLE, packages: ['web-ui'] },
      { action: 'new', projectId: 'alpha', packages: ['web-ui'] },
    ]) {
      const r = await env.post(b);
      assert.equal(r.status, 409, JSON.stringify(b));
      assert.equal(r.json.error, 'command-unsafe');
    }
    assert.equal(env.spawnCalls.length, 0, 'no process started');
    // Without packages the hub path never enters argv: allowed
    const ok = await env.post({ action: 'resume', sessionId: S_IDLE });
    assert.equal(ok.status, 200);
    assert.ok(!env.spawnCalls[0].args.some((a) => a.includes(';')));
    assert.equal(env.spawnCalls[0].opts.cwd, WORK);
  } finally {
    await env.close();
  }
});

test('missing working directory: no process is tried, 500 "app folder not found" (not a misleading 501 "wt.exe not found")', async () => {
  // As in real life: spawn fails with ENOENT when the working directory is missing
  const calls = [];
  const spawnLikeNode = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeSpawn([], fs.existsSync(opts.cwd) ? null : 'ENOENT')(cmd, args, opts);
  };
  const env = await startServer({ mode: 'live', workDir: path.join(ROOT, 'missing-app'), spawn: spawnLikeNode });
  try {
    for (const b of [
      { action: 'explorer', projectId: 'alpha' },
      { action: 'vscode', projectId: 'alpha' },
      { action: 'new', projectId: 'alpha' },
      { action: 'resume', sessionId: S_IDLE },
    ]) {
      const r = await env.post(b);
      assert.equal(r.status, 500, JSON.stringify(b));
      assert.equal(r.json.error, 'app-folder-missing');
    }
    assert.equal(calls.length, 0, 'no process was tried');
  } finally {
    await env.close();
  }
  // A missing hub does not cause this error: the hub is not the working directory of processes
  const noHub = await startServer({ mode: 'live', hubDir: path.join(ROOT, 'missing-hub') });
  try {
    const r = await noHub.post({ action: 'explorer', projectId: 'alpha' });
    assert.equal(r.status, 200);
    assert.equal(noHub.spawnCalls[0].opts.cwd, WORK);
  } finally {
    await noHub.close();
  }
  // Without workDir the app folder (parent of server/, i.e. the repository root) is used
  const dflt = await startServer({ mode: 'live', workDir: undefined, hubDir: null });
  try {
    assert.equal((await dflt.post({ action: 'explorer', projectId: 'alpha' })).status, 200);
    assert.equal(dflt.spawnCalls[0].opts.cwd, APP_ROOT);
  } finally {
    await dflt.close();
  }
});

test('Origin host name is case-insensitive: Host localhost + Origin http://LOCALHOST accepted, a name mismatch is still 403', async () => {
  const env = await startServer();
  try {
    const up = await env.post({ action: 'explorer', projectId: 'alpha' }, { Host: `localhost:${env.port}`, Origin: `http://LOCALHOST:${env.port}` });
    assert.equal(up.status, 200);
    const host = await env.post({ action: 'explorer', projectId: 'beta' }, { Host: `LOCALHOST:${env.port}`, Origin: `http://localhost:${env.port}` });
    assert.equal(host.status, 200);
    const mixed = await env.post({ action: 'vscode', projectId: 'alpha' }, { Origin: `http://LOCALHOST:${env.port}` });
    assert.equal(mixed.status, 403, 'Host 127.0.0.1, Origin localhost: different names');
  } finally {
    await env.close();
  }
});

test('405 on action routes writes one log line (with an Allow header); in off mode the routes do not exist: 404, no log', async () => {
  const env = await startServer();
  try {
    const put = await request(env.port, { method: 'PUT', path: '/api/actions', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, 'GET, HEAD');
    const del = await request(env.port, { method: 'DELETE', path: '/api/action', headers: goodHeaders(env.port, env.actions.token) });
    assert.equal(del.status, 405);
    assert.equal(del.headers.allow, 'POST');
    assert.equal((await env.get('/api/action', { 'Sec-Fetch-Site': 'same-origin' })).status, 405);
    assert.equal((await request(env.port, { method: 'POST', path: '/api/snapshot' })).status, 405, 'not an action route');
    assert.equal(env.logs.length, 3, 'only the 405s on action routes');
    for (const l of env.logs) {
      assert.match(l, LOG_LINE);
      assert.match(l, / 405 method$/);
    }
    assert.match(env.logs[0], / list - 405 /);
  } finally {
    await env.close();
  }
  const off = await startServer({ mode: 'off' });
  try {
    assert.equal((await request(off.port, { method: 'PUT', path: '/api/actions' })).status, 404);
    assert.equal((await off.get('/api/action')).status, 404);
    assert.equal(off.logs.length, 0);
  } finally {
    await off.close();
  }
});

// ---------------- installed app: working directory (app.asar) ----------------
test('realWorkDir: a path inside an Electron archive becomes the folder that holds it; any other path is unchanged (pure)', () => {
  const R = String.raw`C:\Users\example\AppData\Local\Programs\SiberSentez\resources`;
  assert.equal(realWorkDir(`${R}\\app.asar`), R);
  assert.equal(realWorkDir(`${R}\\app.asar\\server`), R, 'a folder deeper in the archive');
  assert.equal(realWorkDir(`${R}\\APP.ASAR`), R, 'case does not matter');
  assert.equal(realWorkDir(`${R}/app.asar`), R);
  assert.equal(realWorkDir(`${R}\\app.asar.unpacked`), `${R}\\app.asar.unpacked`, 'the unpacked folder is a real folder');
  assert.equal(realWorkDir(String.raw`C:\a.asarx\b`), String.raw`C:\a.asarx\b`);
  assert.equal(realWorkDir(String.raw`D:\x.asar`), 'D:\\', 'an archive at a drive root: the root');
  assert.equal(realWorkDir(String.raw`C:\repo\sibersentez`), String.raw`C:\repo\sibersentez`, 'running from source: unchanged');
  assert.equal(realWorkDir(undefined), undefined);
  assert.equal(realWorkDir(''), '');
  assert.ok(hasAsarSegment(`${R}\\app.asar`) && hasAsarSegment(`${R}\\app.asar\\x`) && hasAsarSegment('app.asar'));
  for (const p of [R, `${R}\\app.asar.unpacked`, String.raw`C:\a.asarx`, '', null, undefined, 42]) assert.equal(hasAsarSegment(p), false, String(p));
  assert.equal(hasAsarSegment(realWorkDir(`${R}\\app.asar\\server`)), false);
});

test('installed app (regression): the app folder inside app.asar is replaced by the resources folder; no spawn gets an .asar working directory, every launch runs (before: 501 terminal-missing for all)', async () => {
  const resources = mkdir('Programs', 'SiberSentez', 'resources');
  // Electron's patched fs shows the archive as a folder: a real folder of that name stands in for it
  const asar = mkdir('Programs', 'SiberSentez', 'resources', 'app.asar');
  const calls = [];
  const env = await startServer({ mode: 'live', workDir: asar, spawn: scriptedSpawn(calls, (cmd, args, opts) => windowsLike(opts)) });
  try {
    const bodies = [
      { action: 'terminal', projectId: 'alpha' },
      { action: 'terminal', sessionId: S_IDLE },
      { action: 'resume', sessionId: S_IDLE },
      { action: 'fork', sessionId: S_LIVE },
      { action: 'new', projectId: 'alpha' },
      { action: 'explorer', projectId: 'alpha' },
      { action: 'vscode', projectId: 'alpha' },
    ];
    for (const b of bodies) {
      const r = await env.post(b);
      assert.equal(r.status, 200, `${JSON.stringify(b)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.equal(calls.length, bodies.length, 'one process per request (Windows Terminal opened, no fallback)');
    for (const c of calls) {
      assert.equal(c.opts.cwd, resources, c.cmd);
      assert.equal(hasAsarSegment(c.opts.cwd), false);
    }
  } finally {
    await env.close();
  }
});

test('launch errors: ENOENT names the program only when the working directory is a real folder; a vanished app folder is "app folder not found", never "wt.exe not found"', async () => {
  // The app folder disappears between validation and spawn (as a moved or removed app would)
  const work = path.join(ROOT, 'vanishing-app');
  const calls = [];
  const spawn = scriptedSpawn(calls, (cmd, args, opts) => {
    fs.rmSync(work, { recursive: true, force: true });
    return windowsLike(opts);
  });
  fs.mkdirSync(work, { recursive: true });
  const env = await startServer({ mode: 'live', workDir: work, spawn });
  try {
    for (const b of [
      { action: 'new', projectId: 'alpha' },
      { action: 'resume', sessionId: S_IDLE },
      { action: 'explorer', projectId: 'alpha' },
    ]) {
      fs.mkdirSync(work, { recursive: true });
      const r = await env.post(b);
      assert.equal(r.status, 500, JSON.stringify(b));
      assert.equal(r.json.error, 'app-folder-missing');
      assert.match(env.logs.at(-1), / 500 workdir$/);
    }
    fs.mkdirSync(work, { recursive: true });
    const before = calls.length;
    const t = await env.post({ action: 'terminal', projectId: 'alpha' });
    assert.equal(t.status, 500);
    assert.equal(t.json.error, 'app-folder-missing');
    assert.equal(calls.length, before + 1, 'no PowerShell fallback under a wrong "Windows Terminal not found"');
  } finally {
    await env.close();
  }
  // The folder is there: the same ENOENT is a missing program (501)
  const env2 = await startServer({ mode: 'live', spawn: scriptedSpawn([], () => 'ENOENT') });
  try {
    const r = await env2.post({ action: 'new', projectId: 'alpha' });
    assert.equal(r.status, 501);
    assert.equal(r.json.error, 'wt-missing');
  } finally {
    await env2.close();
  }
});

// ---------------- terminal action (docs/terminal.md) ----------------
test('terminal: Windows Terminal missing -> Windows PowerShell in its own console window, by absolute path, in the folder; nothing from the request on its command line', async () => {
  const calls = [];
  const env = await startServer({ mode: 'live', spawn: scriptedSpawn(calls, (cmd) => (cmd === 'wt.exe' ? 'ENOENT' : null)) });
  try {
    const r = await env.post({ action: 'terminal', projectId: 'alpha' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.terminal, 'powershell');
    assert.equal(r.json.fallbackReason, 'terminal-missing');
    assert.deepEqual(r.json.argv, [CMD_EXE, '/d', '/c', 'start', '', PS_EXE, '-NoExit']);
    assert.equal(calls.length, 2, 'Windows Terminal tried first, then PowerShell');
    assert.equal(calls[0].cmd, 'wt.exe');
    assert.equal(calls[0].opts.cwd, WORK);
    const ps = calls[1];
    assert.equal(ps.cmd, CMD_EXE);
    assert.ok(path.isAbsolute(ps.cmd) && path.isAbsolute(ps.args[4]), 'both programs by absolute path: nothing is looked up in the project folder');
    assert.deepEqual(ps.args, ['/d', '/c', 'start', '', PS_EXE, '-NoExit']);
    assert.equal(ps.opts.cwd, DIR_A, 'the shell opens in the folder: it is the working directory');
    assert.equal(ps.opts.shell, false);
    assert.equal(ps.opts.detached, true);
    assert.equal(ps.opts.stdio, 'ignore');
    assert.ok(!ps.opts.windowsVerbatimArguments);
    assert.ok(!ps.args.some((a) => a.includes(DIR_A) || a.includes('Alpha') || a.includes('alpha')), 'no folder, name or id on the command line');
    assert.match(env.logs.at(-1), / terminal alpha 200 fallback$/);
  } finally {
    await env.close();
  }
  // Windows Terminal is there but fails to start: PowerShell too, and the reply says why
  const calls2 = [];
  const env2 = await startServer({ mode: 'live', spawn: scriptedSpawn(calls2, (cmd) => (cmd === 'wt.exe' ? 'EACCES' : null)) });
  try {
    const f = await env2.post({ action: 'terminal', sessionId: S_IDLE });
    assert.equal(f.status, 200);
    assert.equal(f.json.terminal, 'powershell');
    assert.equal(f.json.fallbackReason, 'terminal-failed');
    assert.equal(calls2[1].opts.cwd, DIR_A);
  } finally {
    await env2.close();
  }
});

test('terminal: neither Windows Terminal nor PowerShell -> 501 no-terminal; the folder vanished -> 404 folder-missing; a PowerShell failure -> 500 launch-failed', async () => {
  const calls = [];
  const env = await startServer({ mode: 'live', spawn: scriptedSpawn(calls, (cmd) => (cmd === 'wt.exe' ? 'ENOENT' : null)), powershellExe: path.join(ROOT, 'none', 'powershell.exe') });
  try {
    const r = await env.post({ action: 'terminal', projectId: 'alpha' });
    assert.equal(r.status, 501);
    assert.deepEqual(r.json, { ok: false, mode: 'live', error: 'no-terminal', action: 'terminal' });
    assert.equal(calls.length, 1, 'a missing PowerShell is not started');
  } finally {
    await env.close();
  }
  const calls2 = [];
  const env2 = await startServer({
    mode: 'live',
    spawn: scriptedSpawn(calls2, (cmd, args, opts) => {
      if (cmd !== 'wt.exe') return windowsLike(opts);
      fs.rmSync(DIR_FLEETING, { recursive: true, force: true }); // the folder goes while Windows Terminal is tried
      return 'ENOENT';
    }),
  });
  try {
    const r = await env2.post({ action: 'terminal', projectId: 'fleeting' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'folder-missing');
    assert.equal(calls2.length, 2);
  } finally {
    await env2.close();
    fs.mkdirSync(DIR_FLEETING, { recursive: true });
  }
  const env3 = await startServer({ mode: 'live', spawn: scriptedSpawn([], (cmd) => (cmd === 'wt.exe' ? 'ENOENT' : 'EPERM')) });
  try {
    const r = await env3.post({ action: 'terminal', projectId: 'alpha' });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'launch-failed');
  } finally {
    await env3.close();
  }
});

test('terminal: the argument checks of every Windows Terminal action (unsafe folder or title, a title read as an option, broad folder); only ids in the body; nothing starts', async () => {
  const env = await startServer({ mode: 'live' });
  try {
    const conflicts = [
      [{ action: 'terminal', projectId: 'semicolon' }, /unsafe/],
      [{ action: 'terminal', projectId: 'quoted' }, /unsafe/],
      [{ action: 'terminal', sessionId: S_SEMI }, /unsafe/],
      [{ action: 'terminal', projectId: 'bad-title' }, /project-name-unsafe/],
      [{ action: 'terminal', projectId: 'dash-title' }, /project-name-unsafe/],
      [{ action: 'terminal', projectId: 'x-home' }, /broad-folder/],
    ];
    for (const [b, msg] of conflicts) {
      const r = await env.post(b);
      assert.equal(r.status, 409, JSON.stringify(b));
      assert.match(r.json.error, msg, JSON.stringify(b));
    }
    for (const b of [
      { action: 'terminal' },
      { action: 'terminal', projectId: 'alpha', command: 'claude' },
      { action: 'terminal', projectId: 'alpha', packages: ['web-ui'] },
      { action: 'terminal', projectId: 'alpha', path: 'C:\\Windows' },
      { action: 'terminal', projectId: 'alpha', shell: 'cmd.exe' },
      { action: 'terminal', projectId: '-alpha' },
      { action: 'terminal', sessionId: 'abc' },
    ]) {
      assert.equal((await env.post(b)).status, 400, JSON.stringify(b));
    }
    assert.equal((await env.post({ action: 'terminal', projectId: 'lost' })).status, 404);
    assert.equal((await env.post({ action: 'terminal', sessionId: S_NOCWD })).status, 404);
    assert.equal(env.spawnCalls.length, 0, 'no process was started');
    // The title only matters to Windows Terminal actions; an unregistered but not broad folder is allowed
    assert.equal((await env.post({ action: 'explorer', projectId: 'dash-title' })).status, 200);
    assert.equal((await env.post({ action: 'terminal', projectId: 'x-unregistered' })).status, 200);
    // Rate limit: the same terminal twice within 3 s -> 429
    assert.equal((await env.post({ action: 'terminal', projectId: 'x-unregistered' })).status, 429);
  } finally {
    await env.close();
  }
});

// "Open in the browser" (docs/run-hint.md): the explorer action opens the project's own index.html, and nothing else
test('explorer open: only the literal index.html, a plain file at the project root, never with a session', async () => {
  assert.deepEqual(buildArgv('explorer', { dir: 'C:\\p', file: 'C:\\p\\index.html' }), ['explorer.exe', '"C:\\p\\index.html"']);
  const env = await startServer({ mode: 'dry' });
  const page = path.join(DIR_A, 'index.html');
  try {
    const missing = await env.post({ action: 'explorer', projectId: 'alpha', open: 'index.html' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'file-missing');
    fs.writeFileSync(page, '<h1>hi</h1>');
    const ok = await env.post({ action: 'explorer', projectId: 'alpha', open: 'index.html' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.argv, ['explorer.exe', `"${page}"`]);
    for (const bad of [{ open: 'other.html' }, { open: '..\\index.html' }, { open: true }, { open: 'index.html', sessionId: S_IDLE }]) {
      const r = await env.post({ action: 'explorer', projectId: 'alpha', ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const term = await env.post({ action: 'terminal', projectId: 'alpha', open: 'index.html' });
    assert.equal(term.status, 400, 'only the explorer action takes it');
    fs.rmSync(page);
    fs.mkdirSync(page);
    const folder = await env.post({ action: 'explorer', projectId: 'alpha', open: 'index.html' });
    assert.equal(folder.json.error, 'file-missing', 'a folder named index.html is not a page');
    assert.equal(env.spawnCalls.length, 0, 'dry mode: nothing started');
  } finally {
    fs.rmSync(page, { recursive: true, force: true });
    await env.close();
  }
});
