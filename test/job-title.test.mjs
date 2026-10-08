// A session the app started for a job is named by the job as the person wrote it (found by using the app, 2026-10-08:
// the waiting notice said "Job J764b5cd98f2fd06dfaf205c587fb8833 görevi", the tool's own title for its first message).
// server/job-id.mjs readJobText reads the job's message, server/ingest.mjs keeps it with the session, public/js/store.js
// shows it instead of a title that carries the raw id. Files live under a fresh temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJobText, jobMessageName } from '../server/job-id.mjs';
import { jobMessageText, launchPrompt } from '../server/launch.mjs';
import { Ingest } from '../server/ingest.mjs';
import { sessionView } from '../server/views.mjs';
import { localSession } from '../public/js/store.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-job-title-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const J = 'J764b5cd98f2fd06dfaf205c587fb8833';
const project = (name, text) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, '.sibersentez'), { recursive: true });
  if (text !== undefined) fs.writeFileSync(path.join(dir, '.sibersentez', jobMessageName(J)), text);
  return dir;
};

test('the job\'s words come from its own message: the first line under "The job", short, plain; anything else is no name', () => {
  const dir = project('kafe', jobMessageText('Kafem için menüsü ve iletişim bilgileri olan bir site yap\nRenkler sıcak olsun', J));
  assert.equal(readJobText(dir, J), 'Kafem için menüsü ve iletişim bilgileri olan bir site yap');
  assert.equal(readJobText(project('long', jobMessageText('ş'.repeat(300), J)), J), 'ş'.repeat(120), 'at most 120 characters');
  assert.equal(readJobText(project('none'), J), null, 'no message file');
  assert.equal(readJobText(project('odd', '# not the app\'s file\n> x\n'), J), null, 'no "The job" part');
  assert.equal(readJobText(dir, 'J•••'), null, 'not a job id');
  assert.equal(readJobText('', J), null);
  const big = project('big', jobMessageText('x', J) + ' '.repeat(70 * 1024));
  assert.equal(readJobText(big, J), null, 'a large file is not read');
});

test('ingest keeps the words with the session once its job and folder are known; the page gets them', () => {
  const dir = project('ingest', jobMessageText('Kafe sayfası yap', J));
  const ing = new Ingest({ resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() });
  ing.cutoff = 0;
  ing.initial = true;
  const s = ing.getSession('s1', null);
  const line = (o) => {
    const buf = Buffer.from(JSON.stringify(o));
    ing.line(s, {}, buf, 0, buf.length);
  };
  line({ parentUuid: null, isSidechain: false, type: 'user', timestamp: '2026-10-08T09:00:00Z', cwd: dir, sessionId: 's1', message: { role: 'user', content: launchPrompt(jobMessageName(J)) } });
  assert.equal(s.jobId, J);
  assert.equal(s.jobText, 'Kafe sayfası yap');
  assert.equal(sessionView(ing, s).jobText, 'Kafe sayfası yap');
  // Review 2026-10-08: a key pasted into the job is redacted as a prompt is; a network folder from a log is not opened
  const key = 'sk-ant-api03-' + 'A'.repeat(40);
  const dir2 = project('secret', jobMessageText(`Siteyi yap, anahtar ${key}`, J));
  const s2 = ing.getSession('s2', null);
  const buf = (o) => Buffer.from(JSON.stringify(o));
  const user = (cwd) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: '2026-10-08T09:00:00Z', cwd, sessionId: 'x', message: { role: 'user', content: launchPrompt(jobMessageName(J)) } });
  let b = buf(user(dir2));
  ing.line(s2, {}, b, 0, b.length);
  assert.ok(s2.jobText.startsWith('Siteyi yap') && !s2.jobText.includes(key), s2.jobText);
  const s3 = ing.getSession('s3', null);
  b = buf(user('\\\\server\\share\\kafe'));
  ing.line(s3, {}, b, 0, b.length);
  assert.equal(s3.jobId, J);
  assert.equal(s3.jobText, null, 'a network path is not read');
});

test('the page names a job\'s session by the job when the tool\'s title carries the raw id or there is none; a real title stays', () => {
  assert.equal(localSession({ id: 's', title: `Job ${J} görevi`, jobText: 'Kafe sayfası yap' }).title, 'Kafe sayfası yap');
  assert.equal(localSession({ id: 's', title: '', jobText: 'Kafe sayfası yap' }).title, 'Kafe sayfası yap');
  assert.equal(localSession({ id: 's', title: 'Kafe menü sitesi', jobText: 'Kafe sayfası yap' }).title, 'Kafe menü sitesi', "the tool's own good title");
  const plain = { id: 's', title: `Job ${J} görevi` };
  assert.equal(localSession(plain), plain, 'no words known: as it came');
  assert.equal(localSession(null), null);
});
