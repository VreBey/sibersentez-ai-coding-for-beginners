// SiberSentez core tests. Run (in the repository folder): node --test test/core.test.mjs
// Each test catches the return of a real bug found in a review ("turn it red").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLinesFrom, redact, normPath, slugify } from '../server/util.mjs';
import { parseActive, plainText } from '../server/plan.mjs';
import { Catalog } from '../server/catalog.mjs';
import { Ingest, actionText, programName } from '../server/ingest.mjs';
import { liveVerdict, sameStart, refreshGapMs } from '../server/live.mjs';
import http from 'node:http';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { eventRow } from '../public/js/views/feed.js';
import { trSlug, actionPlain } from '../public/js/format.js';
import { store } from '../public/js/store.js';
import { setLanguage } from '../public/js/i18n.js';
import { WIN_ONLY } from './lib/winonly.mjs';

// ---------------- util ----------------
test('readLinesFrom: a partial line is not processed, the next read continues where it stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-'));
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, 'one\ntwo\nhalf');
  const seen = [];
  const on = (buf, a, b) => seen.push(buf.toString('utf8', a, b));
  let off = await readLinesFrom(f, 0, on);
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(off, Buffer.byteLength('one\ntwo\n'));
  fs.appendFileSync(f, '-done\n');
  off = await readLinesFrom(f, off, on);
  assert.deepEqual(seen, ['one', 'two', 'half-done']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readLinesFrom: a shortened file is not reread from the start (no double counting), it jumps to the end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-'));
  const f = path.join(dir, 'b.jsonl');
  fs.writeFileSync(f, 'x\n'.repeat(50));
  const seen = [];
  const off = await readLinesFrom(f, 0, () => seen.push(1));
  assert.equal(seen.length, 50);
  fs.writeFileSync(f, 'y\n'); // rewritten, shorter
  const off2 = await readLinesFrom(f, off, () => seen.push(2));
  assert.equal(seen.length, 50);
  assert.equal(off2, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redact: common key formats are masked, plain text is untouched', () => {
  assert.equal(redact('key sk-ant-abcdefghijklmnop123 done'), 'key ••• done');
  assert.equal(redact('ghp_' + 'a'.repeat(30)), '•••');
  assert.equal(redact('a normal sentence'), 'a normal sentence');
});

// ---------------- plan ----------------
test('plan: phase, current task, next and open items from the status block', () => {
  const md = '# x\n<!-- STATUS -->\n**Aşama:** Systems Design · 7/7\n**Aktif görev:** `/design-system` player\n**Sıradaki:** player-controller.md\n**Açık:** no commit\n<!-- /STATUS -->\n';
  const p = parseActive(md);
  assert.equal(p.phase, 'Systems Design · 7/7');
  assert.equal(p.current, '/design-system player');
  assert.equal(p.next, 'player-controller.md');
  assert.equal(p.open, 'no commit');
});

test('plan: without a status block the first update paragraph is used; dashes in a date are not separators', () => {
  const md = '# Active\n\n*Son güncelleme: 2026-09-27 — **AUTO MODE** (continuing). **Sıradaki:** S12 UI.*\n\n*Önceki: …*\n';
  const p = parseActive(md);
  assert.ok(p.current.startsWith('AUTO MODE'), p.current);
  assert.ok(!p.current.includes('2026'), 'the date is dropped from the summary');
  assert.equal(p.next, 'S12 UI.');
});

test('plainText: strips markdown decoration', () => {
  assert.equal(plainText('**bold** `code` [link](http://x) *italic*'), 'bold code link italic');
});

// ---------------- catalog.resolve ----------------
function mk(id, p) {
  return { id, name: id, kind: 'registered', path: p, _paths: [p], _norm: [normPath(p)], _slugs: [slugify(p).toLowerCase()] };
}
function catalogWith(...projects) {
  const c = new Catalog({ hubDir: null, env: {} });
  c.projects = projects;
  return c;
}
const TMP = 'C:\\Users\\U\\AppData\\Local\\Temp\\claude\\';

test('resolve: a subfolder goes to the longest matching registered project', () => {
  const c = catalogWith(mk('main', 'C:\\Users\\U\\Project'), mk('sub', 'C:\\Users\\U\\Project\\sub'));
  assert.equal(c.resolve('C:\\Users\\U\\Project\\sub\\src', null), 'sub');
  assert.equal(c.resolve('C:\\Users\\U\\Project\\docs', null), 'main');
});

test('resolve: a "Game2" scratchpad is not assigned to the "Game" project (bounded match)', () => {
  const c = catalogWith(mk('game', 'C:\\Users\\U\\Game'));
  const id = c.resolve(TMP + 'C--Users-U-Game2\\1111\\scratchpad', null);
  assert.notEqual(id, 'game');
  assert.equal(c.resolve(TMP + 'C--Users-U-Game\\1111\\scratchpad', null), 'game');
});

test('resolve: no empty project is opened for an unknown project known only by folder name (null)', () => {
  const c = catalogWith(mk('game', 'C:\\Users\\U\\Game'));
  assert.equal(c.resolve(null, 'C--Users-U-Unknown'), null);
  assert.equal(c.adhoc.size, 0);
});

test('resolve: a project first seen through a scratchpad is upgraded to the same id when the real folder appears', { skip: WIN_ONLY }, () => {
  const c = catalogWith();
  const a = c.resolve(TMP + 'C--Users-U-Desktop-SampleApp\\2222\\scratchpad', null);
  const b = c.resolve('C:\\Users\\U\\Desktop\\SampleApp', null);
  assert.equal(a, b);
  const p = c.getProject(a);
  assert.equal(p.name, 'SampleApp');
  assert.equal(p.tmpOnly, false);
  assert.equal([...c.adhoc.values()].length, 1);
});

test('adhoc id: short names keep their id; long names are cut at a word boundary with a short hash, stable across sources', () => {
  const c = catalogWith();
  assert.equal(c.adhocId('c--users-u-desktop-sampleapp'), 'x-c-users-u-desktop-sampleapp', 'short ids are unchanged');
  const long = 'c--users-someone-appdata-local-programs-very-long-folder-name-for-a-project';
  const id = c.adhocId(long);
  assert.match(id, /^x-[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}$/);
  const words = id.slice(2, -7).split('-');
  const all = long.replace(/-+/g, '-').split('-');
  assert.deepEqual(words, all.slice(all.length - words.length), 'the kept part is made of whole words from the end');
  assert.ok(id.length <= 2 + 48 + 7);
  assert.equal(c.adhocId(long), id, 'deterministic');
  const other = long.replace('someone', 'another');
  assert.notEqual(c.adhocId(other), id, 'two long paths with the same tail differ');
  // The real path and the name embedded in a temp folder give the same id for a long folder name
  const real = 'C:\\Users\\U\\Desktop\\a very long project folder name that goes past the limit';
  const fromReal = c.resolve(real, null);
  const embedded = slugify(normPath(real)).toLowerCase();
  const c2 = catalogWith();
  const fromTmp = c2.resolve(TMP + embedded + '\\3333\\scratchpad', null);
  assert.equal(fromTmp, fromReal);
  assert.match(fromReal, /-limit-[0-9a-f]{6}$/);
});

// ---------------- ingest ----------------
function fakeCatalog() {
  return { resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() };
}
function feed(ing, ctx, st, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  ing.line(ctx, st, buf, 0, buf.length);
}
const asst = (id, out, content = [], stop = null, t = '2026-09-27T10:00:00Z') => ({
  parentUuid: 'x',
  isSidechain: false,
  message: { model: 'claude-opus-5-5', id, role: 'assistant', content, stop_reason: stop, usage: { output_tokens: out, input_tokens: 1 } },
  type: 'assistant',
  timestamp: t,
  cwd: 'C:\\p1',
});
const user = (content, extra = {}) => ({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content }, timestamp: '2026-09-27T10:00:01Z', cwd: 'C:\\p1', ...extra });

test('ingest: several lines of one message count its tokens once', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  const st = {};
  feed(ing, s, st, asst('m1', 10));
  feed(ing, s, st, asst('m1', 25));
  feed(ing, s, st, asst('m2', 5));
  assert.equal(s.tokensOut, 30);
});

test('ingest: a /compact summary and an interrupt line are not counted as the user\'s prompt', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, {}, user('This session is being continued from a previous conversation…', { isCompactSummary: true }));
  feed(ing, s, {}, user('[Request interrupted by user]'));
  feed(ing, s, {}, user('run the tests'));
  feed(ing, s, {}, user('<command-name>/loop</command-name><command-args>5m</command-args>'));
  const kinds = ing.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'command']);
  assert.equal(s.promptCount, 2);
});

test('ingest: an agent that runs again and finishes again yields a single "done" event', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  ing.initial = false;
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a1.jsonl'));
  const st = {};
  feed(ing, ag, st, asst('m1', 5, [{ type: 'text', text: 'done' }], 'end_turn', new Date().toISOString()));
  ing.refreshAgentStatus(ag);
  feed(ing, ag, st, user('one more thing'));
  ing.refreshAgentStatus(ag);
  feed(ing, ag, st, asst('m2', 5, [{ type: 'text', text: 'done again' }], 'end_turn', new Date().toISOString()));
  ing.refreshAgentStatus(ag);
  assert.equal(ing.events.filter((e) => e.kind === 'agent_done').length, 1);
});

test('ingest: an agent that hands its work back (Claude Code 2.1.29x, no end_turn) is done at once', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  ing.initial = false;
  const ag = ing.getAgent({ agentId: 'a-hb', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a-hb.jsonl'));
  const st = {};
  const now = new Date().toISOString();
  feed(ing, ag, st, asst('m1', 5, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], null, now));
  feed(ing, ag, st, user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }], { timestamp: now }));
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'running', 'an ordinary tool result: still working');
  feed(ing, ag, st, asst('m2', 5, [{ type: 'tool_use', id: 'tu2', name: 'SubagentHandback', input: {} }], null, now));
  feed(ing, ag, st, user([{ type: 'tool_result', tool_use_id: 'tu2', content: 'handed back' }], { timestamp: now, toolEndsTurn: true }));
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'done');
  assert.equal(ing.events.filter((e) => e.kind === 'agent_done').length, 1);
});

test('ingest: the handback mark is looked for in its own line only, as the top-level key, and only in an agent', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  ing.initial = false;
  const now = new Date().toISOString();
  const ag = ing.getAgent({ agentId: 'a-hb2', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a-hb2.jsonl'));
  // One buffer of several lines, as a read chunk holds them: the plain result before the handback does not end it
  const lines = [
    asst('m1', 5, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat notes.json' } }], null, now),
    // The mark inside a tool's output text (escaped in JSON) is no handback
    user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'the file says "toolEndsTurn":true' }], { timestamp: now }),
    user([{ type: 'tool_result', tool_use_id: 'tu2', content: 'later' }], { timestamp: now, toolEndsTurn: true }),
  ].map((o) => JSON.stringify(o));
  const buf = Buffer.from(lines.join('\n'));
  const st = {};
  let a = 0;
  const lineAt = (i) => {
    const b = a + Buffer.byteLength(lines[i]);
    ing.line(ag, st, buf, a, b);
    a = b + 1;
  };
  lineAt(0);
  lineAt(1);
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'running', 'the next line of the chunk carries the mark: not this one');
  lineAt(2);
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'done');
  // The main session: the same mark changes nothing there
  const main = ing.getSession('s-main', 'x');
  const before = main.lastStop;
  feed(ing, main, {}, user([{ type: 'tool_result', tool_use_id: 'tu3', content: 'x' }], { timestamp: now, toolEndsTurn: true }));
  assert.equal(main.lastStop, before);
});

test('ingest: the last action summary carries the description or program name, not the raw command', () => {
  assert.equal(actionText('Bash', { command: 'git push --force origin main', description: 'Push the changes' }), 'Push the changes');
  assert.equal(actionText('Bash', { command: 'npm test -- --token=secret' }), 'npm');
  assert.equal(actionText('Edit', { file_path: 'C:\\a\\b\\stage.js' }), 'stage.js');
  assert.equal(actionText('WebFetch', { url: 'https://example.com/slides/?q=1' }), 'example.com');
  assert.equal(actionText('WebFetch', { url: 'broken' }), '');
  setLanguage('tr');
  assert.equal(actionPlain({ tool: 'Edit', text: 'app.css' }), 'düzenliyor · app.css');
  setLanguage('en');
  assert.equal(actionPlain({ tool: 'Edit', text: 'app.css' }), 'editing · app.css');
});

test('sweep: an empty session is pruned once and its file offset is kept (no rescan loop)', () => {
  const ing = new Ingest(fakeCatalog());
  const s = ing.getSession('s0', null);
  s.lastAt = 0;
  ing.files.set('C:\\x\\s0.jsonl', { kind: 'main', sessionId: 's0', offset: 97 });
  ing.sweep();
  assert.equal(ing.sessions.has('s0'), false);
  assert.deepEqual(ing.removed.sessions, ['s0']);
  assert.equal(ing.files.has('C:\\x\\s0.jsonl'), true);
});

test('sweep: an agent or workflow with no timed line in the window is never "running" and is pruned', () => {
  // A subagent file whose lines all fall before the window leaves a record with no time at all. Counted as running,
  // it showed as hundreds of "running agents" and "running workflows" that never stopped and were never pruned.
  const ing = new Ingest(fakeCatalog());
  ing.initial = false;
  const old = ing.getAgent({ agentId: 'a-old', sessionId: 's-old', slug: 'x', workflowRunId: 'wf-old' }, path.join(os.tmpdir(), 'none', 'agent-a-old.jsonl'));
  ing.refreshAgentStatus(old);
  assert.notEqual(old.status, 'running');
  assert.equal(ing.workflows.get('wf-old').status, 'running', 'before the sweep');
  ing.sweep();
  assert.equal(ing.agents.has('a-old'), false);
  assert.equal(ing.workflows.has('wf-old'), false);
  // A fresh line still makes an agent run
  const cur = ing.getAgent({ agentId: 'a-new', sessionId: 's-new', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a-new.jsonl'));
  feed(ing, cur, {}, asst('m1', 5, [{ type: 'text', text: 'working' }], null, new Date().toISOString()));
  ing.refreshAgentStatus(cur);
  assert.equal(cur.status, 'running');
  ing.sweep();
  assert.equal(ing.agents.has('a-new'), true);
});

test('a session that closes ends its running agents at once; a line after a resume makes one run again', () => {
  // Seen 2026-10-01: the person closed the terminal of a running job; a background agent stayed "running" for ten
  // minutes, so the Building and the top bar said the job went on
  const ing = new Ingest(fakeCatalog());
  ing.initial = false;
  const t0 = Date.now() - 60000;
  ing.setLive(new Map([['s-job', { status: 'busy', pid: 1, cwd: os.tmpdir(), statusUpdatedAt: t0 }]]));
  const ag = ing.getAgent({ agentId: 'a-bg', sessionId: 's-job', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a-bg.jsonl'));
  feed(ing, ag, {}, asst('m1', 5, [{ type: 'text', text: 'working' }], null, new Date(t0 + 30000).toISOString()));
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'running');
  ing.setLive(new Map());
  assert.equal(ag.status, 'stopped', 'its session closed');
  ing.sweep();
  assert.equal(ag.status, 'stopped', 'the sweep keeps it stopped');
  feed(ing, ag, {}, asst('m2', 5, [{ type: 'text', text: 'again' }], null, new Date(Date.now() + 1000).toISOString()));
  ing.refreshAgentStatus(ag);
  assert.equal(ag.status, 'running', 'a later line: the session was resumed');
});

// ---------------- client store ----------------
const snap = (bootId, ids, seqs) => ({
  bootId,
  generatedAt: 1,
  windowDays: 14,
  scan: {},
  kpi: null,
  projects: [],
  sessions: [],
  agents: [],
  workflows: [],
  roster: [],
  events: ids.map((id) => ({ id, t: id, kind: 'prompt', text: '' })),
  ticks: seqs.map((q) => [q, 's:x', 'read', 'p', q]),
});
const patch = (bootId, ids, seqs) => ({ bootId, t: 2, sessions: [], agents: [], workflows: [], projects: [], events: ids.map((id) => ({ id, t: 100 + id, kind: 'prompt', text: '' })), ticks: seqs.map((q) => [100 + q, 's:x', 'read', 'p', q]), removed: null, kpi: null });

test('store: events already in the snapshot are not taken again from a patch', () => {
  store.load(snap('a', [1, 2, 3], [1, 2]));
  const fresh = store.applyPatch(patch('a', [3, 4], [2, 3]));
  assert.deepEqual(fresh.events.map((e) => e.id), [4]);
  assert.deepEqual(fresh.ticks.map((t) => t[4]), [3]);
  assert.equal(store.events.length, 4);
});

test('store: after a server restart (new snapshot) the sequence limit resets and new events are not swallowed', () => {
  store.load(snap('a', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3]));
  store.load(snap('b', [1, 2], [1]));
  const fresh = store.applyPatch(patch('b', [3], [2]));
  assert.equal(fresh.events.length, 1);
  assert.equal(fresh.ticks.length, 1);
});

test('trSlug: turns a Turkish name into a registry id', () => {
  assert.equal(trSlug('Örnek Çalışma (Sample)'), 'ornek-calisma-sample');
  assert.equal(trSlug('GÖZETİM Şube'), 'gozetim-sube');
});

// ---------------- regression tests added in review rounds ----------------
test('catalog: git info survives the 60 s reload', () => {
  const c = new Catalog({ hubDir: null, env: {} });
  const reg = { projeler: [{ id: 'sample', ad: 'Sample', yol: path.join(os.tmpdir(), 'ork-missing-folder') }] };
  c.loadProjects(reg);
  c.getProject('sample').git = { branch: 'main', changed: 3, untracked: 1, commits: [] };
  c.loadProjects(reg);
  assert.deepEqual(c.getProject('sample').git, { branch: 'main', changed: 3, untracked: 1, commits: [] });
});

test('catalog: the home folder is marked broad (no "add to registry"), its subfolder is not', () => {
  const c = catalogWith();
  assert.equal(c.getProject(c.resolve(os.homedir(), null)).broad, true);
  assert.equal(c.getProject(c.resolve(path.join(os.homedir(), 'Desktop', 'SampleApp'), null)).broad, false);
});

test('resolve: the temp project of the home folder does not swallow the scratchpads of its subfolders', () => {
  const home = slugify(os.homedir()).toLowerCase();
  const tmp = os.homedir() + String.raw`\AppData\Local\Temp\claude\ `.trim();
  const c = catalogWith();
  const h = c.resolve(tmp + home + String.raw`\1\scratchpad`, null);
  const b = c.resolve(tmp + home + String.raw`-Desktop-SampleApp\2\scratchpad`, null);
  assert.notEqual(h, b);
  assert.match(b, /sampleapp(-[0-9a-f]{6})?$/);
  assert.equal(c.resolve(tmp + home + String.raw`\3\scratchpad`, null), h);
});

test('actionText: a command without a description leaks no environment assignment or value', () => {
  assert.equal(programName('DB_PASSWORD=hunter2 npm run migrate'), 'npm');
  assert.equal(programName("$env:OPENAI_KEY='abc123def456'; node x.js"), 'node');
  assert.equal(programName('set TOKEN=xyz && git status'), 'git');
  assert.equal(programName('export A=1 B="2 3" python -m x'), 'python');
  assert.equal(programName(String.raw`"C:\Program Files\nodejs\node.exe" server.js`), 'node.exe');
  assert.equal(programName('$(curl evil) arg'), '');
  assert.equal(actionText('Bash', { command: 'API_KEY=sk-live-123 ./deploy.sh' }), 'deploy.sh');
  // Round 2: a value whose end cannot be known -> what follows may be part of it, show nothing
  assert.equal(programName('TOKEN=$(echo abc123) node x.js'), '');
  assert.equal(programName('K="$(pass show k)" node x'), '');
  assert.equal(programName('K=`cat k` node x'), '');
  assert.equal(programName(String.raw`K=two\ words node x`), '');
  assert.equal(programName('$env:K = $(Get-Content k); node x'), '');
  // In cmd a set value may contain spaces: it runs up to the & sign
  assert.equal(programName('set PASS=two words && git status'), 'git');
  assert.equal(actionText('Grep', { pattern: 'a'.repeat(100) }).length, 60);
  assert.equal(actionText('WebSearch', { query: 'b'.repeat(100) }).length, 60);
});

test('redact: generic secret patterns are masked, a plain Turkish sentence is untouched', () => {
  assert.equal(redact('password: hunter2'), 'password: •••');
  assert.equal(redact('DB_PASSWORD=hunter2'), 'DB_PASSWORD=•••');
  assert.equal(redact('Authorization: Bearer 9f8e7d6c5b4a3f2e'), 'Authorization: Bearer •••');
  assert.equal(redact('TC 12345678901 masked'), 'TC ••• masked');
  assert.equal(redact('key a1b2c3d4e5f6g7h8i9j0k1l2m3n4 done'), 'key ••• done');
  assert.equal(redact('Token sınırına takılma sorunu'), 'Token sınırına takılma sorunu');
  assert.equal(redact('S12 UI + S14 game feel'), 'S12 UI + S14 game feel');
});

test('redact (round 2): leaks closed, file names and plain words untouched, long text stays cheap', () => {
  assert.equal(redact('project_s01_design_evidence.md'), 'project_s01_design_evidence.md');
  // Built from parts: a fake key, but written whole it trips secret scanners (GitHub push protection)
  assert.equal(redact('sk_' + 'live_51Habcdefghijklmnopqrstuv'), '•••');
  assert.equal(redact('{"password": "hunter2"}'), '{"password": •••}');
  assert.equal(redact('password = "two words"'), 'password = •••');
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic •••');
  assert.equal(redact('git clone https://ali:s3cr3t@github.com/x/y'), 'git clone https://ali:•••@github.com/x/y');
  assert.equal(redact('compass=north bypass: yes'), 'compass=north bypass: yes');
  const t0 = Date.now();
  const long = redact('tokentoken'.repeat(20000));
  assert.ok(Date.now() - t0 < 1000, 'long text must not lock up the regular expressions');
  assert.ok(long.length <= 4000);
});

test('live session: a PID taken over by another process or a dead process is no ghost; a stale table is checked again', () => {
  const ms = Date.UTC(2026, 8, 27, 10, 0, 0);
  const ft = (t) => String((BigInt(t) + 11644473600000n) * 10000n);
  const start = ft(ms);
  const table = new Map([[100, start], [200, ft(ms + 5000)]]);
  // Same process; WMI rounds to microseconds, a small difference is tolerated
  assert.equal(liveVerdict(String(BigInt(start) + 9n), 100, table, ms + 60000), 'live');
  // PID 200 now belongs to another process, the table was taken after the recorded process started -> dead
  assert.equal(liveVerdict(start, 200, table, ms + 60000), 'dead');
  // PID not in the table, the table was taken after the process -> dead
  assert.equal(liveVerdict(start, 300, table, ms + 60000), 'dead');
  // The table was taken before the process: it may not have seen it -> check again
  assert.equal(liveVerdict(start, 300, table, ms - 1), 'check');
  // The same millisecond is checked again too (round 2 bug: with <= a ghost stayed live for 5 minutes)
  assert.equal(liveVerdict(start, 300, table, ms), 'check');
  assert.equal(liveVerdict(start, 300, null, 0), 'check');
  assert.equal(sameStart(start, String(BigInt(start) + 20000n)), false);
});

test('live: the gap between PowerShell reads backs off 10 -> 60 -> 300 s on failures and returns to 10 s on success', () => {
  assert.equal(refreshGapMs(0), 10000);
  assert.equal(refreshGapMs(1), 60000);
  assert.equal(refreshGapMs(2), 300000);
  assert.equal(refreshGapMs(50), 300000, 'never longer than 300 s');
  for (const bad of [-1, NaN, undefined, null, Infinity]) assert.ok([10000, 300000].includes(refreshGapMs(bad)), 'nonsense counts do not throw');
  assert.equal(refreshGapMs(-3), 10000);
  assert.equal(refreshGapMs(NaN), 10000);
});

test('ingest: one broken line does not stop the rest of the file, the offset moves to the end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-'));
  const f = path.join(dir, 's9.jsonl');
  const bad = asst('m1', 1, [{ type: 'tool_use', id: 't1', name: 123, input: {} }]);
  fs.writeFileSync(f, JSON.stringify(bad) + '\n' + JSON.stringify(user('next prompt')) + '\n');
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  ing.lineErrors = 1; // keep the first error log line out of the test output
  ing.classify = () => ({ kind: 'main', slug: 'x', sessionId: 's9' });
  await ing.processFile(f);
  assert.equal(ing.lineErrors, 2);
  assert.deepEqual(ing.events.map((e) => e.text), ['next prompt']);
  assert.equal(ing.files.get(f).offset, fs.statSync(f).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ui: log text is printed as escaped text, not as HTML (XSS)', () => {
  const html = eventRow({ id: 1, t: Date.now(), kind: 'prompt', text: '<img src=x onerror=alert(1)>', projectId: null });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// Access rules and crash resistance on a real HTTP server (random port)
function rawGet(port, pathName, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    // A crashed handler never answers: turn the test red instead of hanging
    req.setTimeout(3000, () => req.destroy(new Error(`no answer: ${method} ${pathName}`)));
    req.end();
  });
}

function rawHeaders(port, pathName, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error(`no answer: ${method} ${pathName}`)));
    req.end();
  });
}

async function startHandler(options = {}) {
  const ing = new Ingest(fakeCatalog());
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ ingest: ing, catalog: fakeCatalog(), clients: new Set(), port, publicDir: PUBLIC_DIR, ...options }));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

test('http: broken addresses return 400 and the server stays up; access rules', async () => {
  const { port, close } = await startHandler();
  try {
    assert.equal(await rawGet(port, '//'), 400);
    assert.equal(await rawGet(port, '/%'), 400);
    assert.equal(await rawGet(port, '/css/%E0%A4%A.css'), 400);
    assert.equal(await rawGet(port, '/'), 200, 'still answers after broken requests');
    assert.equal(await rawGet(port, '/', { Host: `evil.example:${port}` }), 421);
    assert.equal(await rawGet(port, '/api/snapshot', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }), 403);
    assert.equal(await rawGet(port, '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 200);
    assert.equal(await rawGet(port, '/api/snapshot', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 403);
    assert.equal(await rawGet(port, '/api/snapshot', {}, 'POST'), 405);
    assert.notEqual(await rawGet(port, '/..%2f..%2fserver%2fconfig.mjs'), 200);
    assert.equal(await rawGet(port, '/api/snapshot', { 'Sec-Fetch-Site': 'same-origin' }), 200);
  } finally {
    await close();
  }
});

test('http: with an instance tag every response carries X-SiberSentez-Instance; without one no response does', async () => {
  const cases = [
    ['/', {}, 'GET', 200],
    ['/api/snapshot', { 'Sec-Fetch-Site': 'same-origin' }, 'GET', 200],
    ['/api/nothing', {}, 'GET', 404],
    ['/missing.css', {}, 'GET', 404],
    ['/%', {}, 'GET', 400],
    ['/', { Host: 'evil.example:1' }, 'GET', 421],
    ['/api/snapshot', {}, 'POST', 405],
    ['/api/snapshot', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, 'GET', 403],
    ['/api/actions', { 'Sec-Fetch-Site': 'same-origin' }, 'GET', 404],
  ];
  const tagged = await startHandler({ instance: 'run-4f2a9c', actions: { mode: 'off' } });
  try {
    for (const [p, h, m, status] of cases) {
      const r = await rawHeaders(tagged.port, p, h, m);
      assert.equal(r.status, status, `${m} ${p}`);
      assert.equal(r.headers['x-sibersentez-instance'], 'run-4f2a9c', `${m} ${p}`);
    }
  } finally {
    await tagged.close();
  }
  const plain = await startHandler();
  try {
    for (const [p, h, m] of cases) {
      const r = await rawHeaders(plain.port, p, h, m);
      assert.equal(r.headers['x-sibersentez-instance'], undefined, `${m} ${p}`);
    }
  } finally {
    await plain.close();
  }
});

test('ingest: the plan a lead shows for approval (plan mode) is kept, the newest one, cut at the limit; an agent\'s is not', async () => {
  const { PLAN_MAX } = await import('../server/ingest.mjs');
  const { sessionView } = await import('../server/views.mjs');
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  const st = {};
  const plan = (id, text, t) => asst(id, 5, [{ type: 'tool_use', id: `tu-${id}`, name: 'ExitPlanMode', input: { plan: text } }], 'tool_use', t);
  feed(ing, s, st, plan('m1', '1. Read the code\n2. Fix the label', '2026-09-27T10:00:00Z'));
  feed(ing, s, st, plan('m2', 'x'.repeat(PLAN_MAX + 50), '2026-09-27T10:05:00Z'));
  assert.ok(s.plan.text.length <= PLAN_MAX + 1, 'cut at the limit');
  assert.equal(s.lastAction.tool, 'ExitPlanMode', 'the last action says the plan waits');
  feed(ing, s, st, plan('m3', 'an older plan', '2026-09-27T09:00:00Z'));
  assert.ok(s.plan.text.startsWith('xxx'), 'an older line does not replace the newest plan');
  assert.equal(sessionView(ing, s).plan.text, s.plan.text, 'the page gets it');
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a1.jsonl'));
  feed(ing, ag, {}, plan('m4', 'agent plan', '2026-09-27T10:06:00Z'));
  assert.equal(ag.plan, undefined, 'only a lead\'s plan');
});
