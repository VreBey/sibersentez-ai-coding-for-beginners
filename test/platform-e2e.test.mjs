// Plan G2: on Linux and macOS an AI tool starts in SiberSentez's own terminal, end to end. A project folder with a
// quote and Turkish letters; a stand-in "claude" that prints where it runs and what it got. The page's request goes
// over HTTP, the server writes the sh launcher, the shell's one-time id is redeemed, and the launcher runs in a real
// pseudo terminal (node-pty): the tool sees the project folder and the whole prompt, the first message is written,
// and the "tool ended" mark appears. Windows has its own (test/ai-start.test.mjs, the packaged QA).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';

const POSIX_ONLY = process.platform === 'win32' && 'Linux and macOS (Windows: Windows Terminal and cmd.exe)';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-e2e-'));
after(() => fs.rmSync(T, { recursive: true, force: true }));

function request(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/action', method: 'POST', agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('start-ai in the app\'s own terminal: the sh launcher runs the tool in the project folder with the whole prompt', { skip: POSIX_ONLY }, async () => {
  const proj = path.join(T, "Oyun çalışması it's");
  const hub = path.join(T, 'hub');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  const tool = path.join(T, 'bin', 'claude');
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, '#!/bin/sh\necho "TOOL-CWD=$(pwd)"\nfor a in "$@"; do echo "TOOL-ARG=$a"; done\n', { mode: 0o755 });
  const catalog = { roster: new Map(), hubDir: hub, getProject: (id) => (id === 'p' ? { id: 'p', name: 'Oyun', kind: 'registered', path: proj, idea: 'Bir kafe sitesi' } : null), allProjects: () => [] };
  const detector = { detect: async () => ({ at: 1, tools: [{ id: 'claude', name: 'Claude Code', installed: true, chosen: { file: tool, ext: '' }, installs: [], via: 'native', version: '2.1.284', ready: 'yes' }], node: null }) };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const actions = createActions({ catalog, ingest: { sessions: new Map() }, mode: 'live', port, hubDir: hub, ai: { tools: detector, env: { HOME: T, SHELL: '/bin/sh', PATH: process.env.PATH } }, log: () => {}, fit: { invalidate() {} } });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, tools: detector }));
  try {
    const r = await request(port, { action: 'start-ai', projectId: 'p', tool: 'claude', withIdea: true, inDock: true }, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.terminal, 'dock');
    const target = actions.terminalTarget({ launchId: r.json.launchId });
    assert.equal(target.ok, true);
    assert.equal(target.dir, proj);
    assert.equal(target.program.file, '/bin/sh');
    const launcher = target.program.args[0];
    assert.match(path.basename(launcher), /^[0-9a-f]{12}\.sh$/);
    // The launcher in a real pseudo terminal, as the desktop shell runs it
    const pty = createRequire(import.meta.url)('node-pty');
    const p = pty.spawn(target.program.file, target.program.args, { cwd: target.dir, cols: 200, rows: 30, env: { PATH: process.env.PATH, HOME: T, SHELL: '/bin/sh' } });
    let out = '';
    p.onData((d) => (out += d));
    const ended = launcher + '.ended';
    for (let i = 0; i < 100 && !fs.existsSync(ended); i++) await new Promise((ok) => setTimeout(ok, 50));
    // The pty's output can arrive after the mark under load (a coverage run on Linux lost it once): wait for it too
    for (let i = 0; i < 60 && !/user's language\.\r?\n/.test(out); i++) await new Promise((ok) => setTimeout(ok, 50));
    p.kill();
    const lines = out.replace(/\r/g, '').split('\n').filter((l) => l.startsWith('TOOL-'));
    assert.equal(lines[0], `TOOL-CWD=${proj}`, out);
    assert.match(lines[1], /^TOOL-ARG=Please read \.sibersentez\/ilk-mesaj\.md and follow it\..*user's language\.$/, 'the prompt as one argument, its quote kept');
    assert.equal(fs.existsSync(ended), true, 'the tool ended, the mark is there');
    assert.deepEqual(fs.readdirSync(path.join(proj, '.sibersentez')).sort(), ['.gitignore', 'ilk-mesaj.md']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
