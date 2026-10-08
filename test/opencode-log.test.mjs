// OpenCode's sessions (server/toolLogs.mjs, server/ingest.mjs scanOpenCode, 2026-10-07): its SQLite database read
// read-only, only what changed since the last read. A temporary database with the columns of OpenCode 1.18.35's
// schema; the real one is never opened. Run: node --test test/opencode-log.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ingest } from '../server/ingest.mjs';
import { opencodeText, opencodeToolCall, opencodeTokens } from '../server/toolLogs.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sib-opencode-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const DB = path.join(ROOT, 'opencode.db');
const PROJECT = path.join(ROOT, 'work', 'menu-site');
const JOB = 'J' + '0123456789abcdef'.repeat(2);
const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);

function makeDb() {
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  return db;
}
function ingest() {
  const ing = new Ingest({ resolve: (cwd) => (cwd && String(cwd).toLowerCase() === PROJECT.toLowerCase() ? 'menu' : null), getProject: () => null, allProjects: () => [], roster: new Map() });
  ing.cutoff = 0;
  ing.initial = true;
  ing.foreignDirs = { codex: null, gemini: null, qwen: null, copilot: null, opencode: DB };
  return ing;
}

test('the pure parts: the typed text without synthetic parts, a tool part, tokens with reasoning in the output', () => {
  assert.equal(opencodeText([{ type: 'text', text: 'Add a menu' }, { type: 'text', text: 'injected', synthetic: true }, { type: 'file' }]), 'Add a menu');
  assert.deepEqual(opencodeToolCall({ type: 'tool', tool: 'bash', callID: 'c1', state: { input: { command: 'npm test' } } }), { id: 'c1', raw: 'bash', mapped: 'Bash', input: { command: 'npm test' } });
  assert.equal(opencodeToolCall({ type: 'text', text: 'x' }), null);
  assert.deepEqual(opencodeTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } }), { input: 100, cacheRead: 300, output: 25 });
});

test('an OpenCode session: its project, title, prompts, model, tool calls and tokens; read again only when changed; a sub-agent session left out', async () => {
  const db = makeDb();
  const sid = 'ses_ee95ce579ffe2695HiWqbAm6PZ';
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(sid, 'global', null, 'eager-star', PROJECT, 'Menu page', '1.18.35', 4000, 60, 15, 300, T0, T0 + 5000);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_child', 'global', sid, 'child', PROJECT, 'New session - x', '1.18.35', 0, 0, 0, 0, T0, T0 + 5000);
  const msg = (id, t, data) => db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, sid, t, t, JSON.stringify(data));
  const part = (id, mid, t, data) => db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, mid, sid, t, t, JSON.stringify(data));
  msg('m1', T0 + 1000, { role: 'user', time: { created: T0 + 1000 } });
  part('p1', 'm1', T0 + 1000, { type: 'text', text: `Please read .sibersentez/job-${JOB}.md and follow it` });
  msg('m2', T0 + 2000, { role: 'assistant', modelID: 'z-ai/glm-5.3-flash', providerID: 'nvidia', tokens: { input: 4000, output: 60, reasoning: 15, cache: { read: 300, write: 0 } }, time: { created: T0 + 2000, completed: T0 + 4000 } });
  part('p2', 'm2', T0 + 3000, { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'npm test' } } });
  db.close();
  const ing = ingest();
  const calls = [];
  ing.ledger = { add: (x) => calls.push(x) };
  await ing.scanOpenCode();
  const s = ing.sessions.get(sid);
  assert.ok(s, 'the session is read');
  assert.equal(s.tool, 'opencode');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.title, 'Menu page');
  assert.equal(s.jobId, JOB);
  assert.equal(s.promptCount, 1);
  assert.equal(s.model, 'z-ai/glm-5.3-flash');
  assert.deepEqual(s.toolCounts, { bash: 1 });
  assert.equal(s.tokensOut, 75, 'output and reasoning');
  assert.deepEqual(calls.map((c) => c.usage), [{ input_tokens: 4000, cache_read_input_tokens: 300, output_tokens: 75 }]);
  assert.equal(ing.sessions.get('ses_child'), undefined, "a sub-agent's session");
  // Nothing changed: not read again; a scan after a change counts nothing twice
  await ing.scanOpenCode();
  assert.equal(s.promptCount, 1);
  ing.oc.mtime = 0;
  await ing.scanOpenCode();
  assert.equal(s.promptCount, 1);
  assert.equal(s.toolCalls, 1);
});

test('no OpenCode database: nothing read, nothing broken', async () => {
  const ing = ingest();
  ing.foreignDirs.opencode = path.join(ROOT, 'none', 'opencode.db');
  await ing.scanOpenCode();
  assert.equal([...ing.sessions.values()].filter((s) => s.tool === 'opencode').length, 0);
});

test('read on: a message added later is found; a tool still running counts once it ended; a broken database breaks nothing', async () => {
  fs.rmSync(DB, { force: true });
  const db = makeDb();
  const sid = 'ses_later';
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(sid, 'global', null, 'later', PROJECT, 'Later', '1.18.35', 0, 0, 0, 0, T0, T0 + 1000);
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('pt', 'mx', sid, T0 + 1000, T0 + 1000, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c9', state: { status: 'running', input: {} } }));
  db.close();
  const ing = ingest();
  await ing.scanOpenCode();
  const s = ing.sessions.get(sid);
  assert.equal(s.toolCalls, 0, 'still running: not yet');
  const db2 = new DatabaseSync(DB);
  // The tool ends and a new prompt comes, later than the session row's own time
  db2.prepare('UPDATE part SET time_updated = ?, data = ? WHERE id = ?').run(T0 + 60000, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c9', state: { status: 'completed', input: { command: 'npm test' } } }), 'pt');
  db2.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('mu', sid, T0 + 61000, T0 + 61000, JSON.stringify({ role: 'user' }));
  db2.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('pu', 'mu', sid, T0 + 61000, T0 + 61000, JSON.stringify({ type: 'text', text: 'and again' }));
  db2.close();
  ing.oc.mtime = 0;
  await ing.scanOpenCode();
  assert.equal(s.toolCalls, 1);
  assert.equal(s.lastAction.text, 'npm', 'with its input (the program only, as for every shell command)');
  assert.equal(s.lastPrompt, 'and again');
  const broken = path.join(ROOT, 'broken.db');
  fs.writeFileSync(broken, 'not a database');
  const ing2 = ingest();
  ing2.foreignDirs.opencode = broken;
  await ing2.scanOpenCode();
  assert.equal(ing2.oc.mtime, 0, 'tried again on the next rescan');
});
