// The page's Content Security Policy and its framing ban, pinned. The in-app "On" confirmation of the actions switch
// (docs/actions-toggle.md) lives inside the page: its only guards are that no script but our own files can run there
// (script-src 'self', no 'unsafe-inline', no 'unsafe-eval') and that no other page can frame it (frame-ancestors
// 'none' and X-Frame-Options: DENY). A change that loosens any of these must fail here.
// The real request handler runs in this process on an ephemeral port. Run: node --test test/csp.test.mjs
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, SECURITY_HEADERS } from '../server/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// A policy as { directive: [sources] } (directive names in lower case, sources as written)
function parseCsp(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    assert.equal(Object.hasOwn(out, key), false, `directive ${key} given twice`);
    out[key] = sources;
  }
  return out;
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// What every served file must carry: the policy guarding the in-page confirmation and the framing ban
function assertGuarded(r, label) {
  assert.equal(r.status, 200, label);
  assert.equal(r.headers['x-frame-options'], 'DENY', `${label}: X-Frame-Options`);
  const raw = r.headers['content-security-policy'];
  assert.equal(typeof raw, 'string', `${label}: a Content-Security-Policy header`);
  const csp = parseCsp(raw);
  assert.deepEqual(csp['default-src'], ["'self'"], `${label}: default-src 'self'`);
  assert.deepEqual(csp['script-src'], ["'self'"], `${label}: script-src is our own files only`);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"], `${label}: frame-ancestors 'none'`);
  // Nothing may loosen scripts: no inline or eval source anywhere in the policy, and no script-src-elem/-attr (they
  // would override script-src for elements or attributes)
  assert.doesNotMatch(raw, /'unsafe-eval'|'wasm-unsafe-eval'|'unsafe-hashes'|'strict-dynamic'/i, `${label}: no eval or dynamic source`);
  assert.doesNotMatch(csp['script-src'].join(' '), /unsafe-inline|data:|blob:|\*/i, `${label}: no inline script`);
  assert.equal(csp['script-src-elem'], undefined, `${label}: no script-src-elem`);
  assert.equal(csp['script-src-attr'], undefined, `${label}: no script-src-attr`);
  // Nothing else may be framed or load objects either: the page itself is the only document
  assert.ok(!csp['child-src'] && !csp['frame-src'] && !csp['object-src'], `${label}: frames and objects fall back to default-src 'self'`);
}

describe('page security headers (the in-app actions confirmation relies on them)', () => {
  let server;
  let port;
  before(async () => {
    let handler = null;
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    handler = createHandler({ ingest: {}, catalog: {}, clients: new Set(), port, publicDir: PUBLIC_DIR, actions: null, instance: 'csp-test' });
  });
  after(() => server?.listening && server.close());

  test('/ (index.html): script-src self only, default-src self, frame-ancestors none, X-Frame-Options DENY', async () => {
    const r = await get(port, '/');
    assert.match(r.headers['content-type'], /^text\/html/);
    assertGuarded(r, '/');
    // The policy only holds because the page has no inline script: every <script> loads one of our files
    const scripts = [...r.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, 'the page loads its scripts');
    for (const [, attrs, inner] of scripts) {
      assert.match(attrs, /\ssrc="\/?[\w./-]+\.m?js"/, `a script from a file: <script${attrs}>`);
      assert.equal(inner.trim(), '', 'no inline script body');
    }
    assert.doesNotMatch(r.body, /\son[a-z]+\s*=/i, 'no inline event handler attribute');
  });

  test('inline styles are allowed (the terminal screen needs <style> elements), inline scripts never', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    const dir = (name) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
    assert.deepEqual(dir('script-src'), ["'self'"]);
    assert.deepEqual(dir('style-src-elem'), ["'self'", "'unsafe-inline'"]);
    for (const d of ['img-src', 'default-src', 'connect-src']) assert.ok(!dir(d).some((x) => /^https?:|\*/.test(x)), `${d} stays on this server`);
    assert.doesNotMatch(csp, /font-src/, 'fonts fall back to default-src self');
  });

  test('a static script and a stylesheet carry the same policy and framing ban', async () => {
    const js = await get(port, '/js/main.js');
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assertGuarded(js, '/js/main.js');
    const css = await get(port, '/css/app.css');
    assert.match(css.headers['content-type'], /^text\/css/);
    assertGuarded(css, '/css/app.css');
    // One policy for every response: the same text as the page's
    assert.equal(js.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
    assert.equal(css.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
  });

  test('an API answer carries them too', async () => {
    const r = await get(port, '/api/nothing-here');
    assert.equal(r.status, 404);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.deepEqual(parseCsp(r.headers['content-security-policy'])['frame-ancestors'], ["'none'"]);
  });

  test('the policy in the source is the one served (a sanity check of the parser)', () => {
    const csp = parseCsp(SECURITY_HEADERS['Content-Security-Policy']);
    assert.deepEqual(csp['script-src'], ["'self'"]);
    assert.deepEqual(parseCsp("script-src 'self' 'unsafe-inline'")['script-src'], ["'self'", "'unsafe-inline'"]);
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'index.html')));
  });
});
