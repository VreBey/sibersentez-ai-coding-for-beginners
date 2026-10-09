// node-pty's macOS spawn-helper gets its execute bit after npm install (tools/node-pty-mode.mjs, the macOS CI's
// "posix_spawnp failed", 2026-10-09). Windows keeps no execute bits, so the bit itself is checked on Linux and macOS.
// Run: node --test test/pty-mode.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixPtyMode } from '../tools/node-pty-mode.mjs';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-pty-mode-'));
after(() => fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function helperAt(name, mode) {
  const f = path.join(T, 'node_modules', 'node-pty', 'prebuilds', name, 'spawn-helper');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
  fs.chmodSync(f, mode);
  return f;
}

test('only on macOS, and only the darwin helpers; nothing to fix, nothing done', () => {
  const arm = helperAt('darwin-arm64', 0o644);
  helperAt('win32-x64', 0o644);
  assert.deepEqual(fixPtyMode(T, 'win32'), []);
  assert.deepEqual(fixPtyMode(T, 'linux'), []);
  assert.deepEqual(fixPtyMode(path.join(T, 'nowhere'), 'darwin'), [], 'no node-pty: no error');
  if (process.platform === 'win32') return;
  assert.deepEqual(fixPtyMode(T, 'darwin'), [arm]);
  assert.equal(fs.statSync(arm).mode & 0o777, 0o755);
  assert.deepEqual(fixPtyMode(T, 'darwin'), [], 'already executable: left alone');
});

test('it runs after every npm install', () => {
  assert.equal(pkg.scripts.postinstall, 'node tools/node-pty-mode.mjs');
  assert.ok(!pkg.build.files.some((f) => f.includes('tools')), 'the script itself is not packaged');
});
