// Earlier jobs (server/team.mjs jobHistory, public/js/views/job.js historyHtml): the team moves a finished job to
// .sibersentez/archive/<date>-<short name>/; the drawer lists them, newest first, read only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobHistory, teamFacts, HISTORY_MAX } from '../server/team.mjs';
import { historyHtml, jobSectionHtml } from '../public/js/views/job.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-history-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
setLanguage('en');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('archive: newest first, at most HISTORY_MAX, real folders only, a Turkish name read, each like the current job', () => {
  const dir = path.join(ROOT, 'p1');
  const arc = path.join(dir, '.sibersentez', 'archive');
  write(path.join(arc, '2026-09-30-giris-sayfasi', 'PLAN.md'), '# Plan: Giriş sayfası\n\nApproved: yes\nResult: accepted\n');
  write(path.join(arc, '2026-09-30-giris-sayfasi', 'TASKS.md'), '## T1: Form\n- status: done\n\n## T2: Şifre\n- status: done\n');
  write(path.join(arc, '2026-10-01-menü-sayfası', 'REVIEW.md'), 'VERDICT: {"verdict":"REVISE","blockers":["Fix the menu"],"nits":[]}\n');
  write(path.join(arc, 'notes.txt'), 'not a job');
  fs.mkdirSync(path.join(ROOT, 'elsewhere'));
  fs.symlinkSync(path.join(ROOT, 'elsewhere'), path.join(arc, '2026-10-02-link'), 'junction');
  const h = jobHistory(path.join(dir, '.sibersentez'));
  assert.deepEqual(h, [
    { title: 'menü sayfası', date: '2026-10-01', accepted: false, verdict: 'REVISE', tasks: 0 },
    { title: 'Giriş sayfası', date: '2026-09-30', accepted: true, verdict: null, tasks: 2 },
  ]);
  assert.deepEqual(teamFacts(dir).history, h, 'the team answer carries it');
  for (let i = 0; i < HISTORY_MAX + 3; i++) fs.mkdirSync(path.join(arc, `2025-01-${String(i + 1).padStart(2, '0')}-x`));
  assert.equal(jobHistory(path.join(dir, '.sibersentez')).length, HISTORY_MAX);
  assert.deepEqual(jobHistory(path.join(ROOT, 'none')), []);
});

test('the drawer: folded, each job with its date, tasks and result; nothing without history; escaped', () => {
  const list = [{ title: 'Giriş <b>', date: '2026-09-30', accepted: true, verdict: null, tasks: 2 }, { title: 'Menü', date: 'bad', accepted: false, verdict: 'REVISE', tasks: 0 }];
  const h = historyHtml(list);
  assert.ok(h.startsWith('<details class="job-history">') && h.includes(STRINGS.en.jobHistTitle.replace('{count}', '2')));
  assert.ok(h.includes('Giriş &lt;b&gt;') && h.includes('2026-09-30 · 2 tasks · result accepted') && h.includes(STRINGS.en.jobHistRevise) && !h.includes('bad'));
  assert.equal(historyHtml([]), '');
  assert.equal(historyHtml(null), '');
  const P = { id: 'p', name: 'P', path: 'C:\\p', exists: true };
  const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
  assert.ok(jobSectionHtml(P, { step: 'none', history: list }, { mode: 'live', tools }).includes('job-history'), 'in the job section');
  for (const lang of ['en', 'tr']) for (const k of ['jobHistTitle', 'jobHistTasks', 'jobHistAccepted', 'jobHistRevise']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});
