// A restore point's label (server/restore.mjs pointLabel; review of 2026-10-02): a secret typed into a job never
// reaches the disk, and the cut is on whole characters.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, listPoints, LABEL_MAX } from '../server/restore.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-label-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let clock = Date.UTC(2026, 9, 2, 12, 0, 0);
const tick = () => (clock += 1000);

test('a point label never keeps a secret typed into the job; it is cut on whole characters', () => {
  const hub = path.join(TMP, 'hub');
  const dir = path.join(TMP, 'proj');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const write = (v) => fs.writeFileSync(path.join(dir, 'index.html'), v);
  write('v1');
  createPoint({ hubDir: hub, projectId: 'p', dir, reason: 'ai-start', now: tick, label: `Bağlan: API_KEY=${'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789'} ile` }); // a fake key in parts (secret scanners)
  write('v2');
  createPoint({ hubDir: hub, projectId: 'p', dir, reason: 'ai-start', now: tick, label: '\u{1F600}'.repeat(100) });
  const [emoji, secret] = listPoints({ hubDir: hub, projectId: 'p' });
  assert.ok(!secret.label.includes('abcdefghijklmnop') && secret.label.includes('•••'), secret.label);
  assert.equal(Array.from(emoji.label).length, LABEL_MAX);
  assert.equal(emoji.label, '\u{1F600}'.repeat(LABEL_MAX), 'whole characters, never half of a pair');
});
