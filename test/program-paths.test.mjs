// Small hardening (review A7; the first round of hardening is test/hardening.test.mjs): programs by absolute path,
// never looked up in the working folder; a cap on open live streams (one listener per channel: test/terminal.test.mjs).
// Run: node --test test/program-paths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHandler, STREAM_MAX } from '../server/app.mjs';
import { gitProgram } from '../server/git.mjs';
import { gitStatus } from '../server/changes.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('git: an absolute git.exe or none; with none, a status answers null without starting anything', async () => {
  const exe = gitProgram();
  // Windows: git.exe by its full path; Linux and macOS: git by its full path (plan G1)
  const ok = process.platform === 'win32' ? (e) => path.win32.isAbsolute(e) && /git\.exe$/i.test(e) : (e) => e.startsWith('/') && /\/git$/.test(e);
  assert.ok(exe === null || ok(exe), String(exe));
  let started = false;
  const run = () => {
    started = true;
    throw new Error('never');
  };
  assert.equal(await gitStatus('C:\\nowhere', { run, exe: null }), null);
  assert.equal(started, false);
  for (const f of ['server/git.mjs', 'server/changes.mjs']) assert.doesNotMatch(read(f), /(?:spawn|execFile|run)\('git'/, `${f}: no bare 'git'`);
});

test('PowerShell and cmd: under System32 by absolute path', () => {
  assert.doesNotMatch(read('server/live.mjs'), /execFile\('powershell'/);
  assert.match(read('server/live.mjs'), /'System32', 'WindowsPowerShell', 'v1\.0', 'powershell\.exe'\)/);
  assert.doesNotMatch(read('server/index.mjs'), /spawn\('cmd'/);
  assert.match(read('server/index.mjs'), /'System32', 'cmd\.exe'\)/);
});

test('live streams: at most STREAM_MAX open; one more is refused until one closes', async () => {
  const clients = new Set();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ ingest: { sessions: new Map(), scan: { done: true } }, catalog: { projects: new Map(), roster: new Map() }, clients, port, publicDir: 'unused' }));
  const ask = () =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', agent: false, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
        res.destroy();
      });
      req.on('error', reject);
    });
  try {
    for (let i = 0; i < STREAM_MAX; i++) clients.add({ fake: i });
    assert.equal(await ask(), 503, 'one over the cap');
    clients.delete([...clients][0]);
    assert.equal(await ask(), 200, 'room again');
  } finally {
    for (const c of clients) c.destroy?.();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
