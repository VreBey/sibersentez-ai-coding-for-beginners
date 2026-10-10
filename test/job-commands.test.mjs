// The commands a job's AI ran and how they ended, as Claude Code's log shows them (docs/internal/evidence-card-plan.md
// E3): server/jobCommands.mjs reads them, server/ingest.mjs keeps them per job session, public/js/jobResult.js says
// them on the result card. The line shapes below are those of real Claude Code 2.1.283-2.1.296 logs (2026-10-10).
// Run: node --test test/job-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { commandLabel, hasMore, lineJoins, commandKey, shellOutcome, backgroundEnd, jobCommandsSummary, COMMANDS_MAX, BG_WAIT_MAX_MS } from '../server/jobCommands.mjs';
import { Ingest } from '../server/ingest.mjs';
import { commandsHtml } from '../public/js/jobResult.js';
import { setLanguage } from '../public/js/i18n.js';

const J = 'J764b5cd98f2fd06dfaf205c587fb8833';

test('a command is named by its program and a known sub-command, never its arguments', () => {
  const label = (c) => commandLabel(c).label;
  assert.deepEqual(commandLabel('npm test'), { label: 'npm test', more: false, joins: 'none' });
  // A leading cd names nothing, but its own exit code may be the line's: more is on the line
  assert.deepEqual(commandLabel('cd /c/Users/x/app && npm run build'), { label: 'npm run build', more: true, joins: 'and' });
  assert.equal(label('cd "C:\\My App"; npx vitest run'), 'npx vitest', 'npx: the package only');
  assert.equal(label('npx wrangler secret put'), 'npx wrangler');
  assert.equal(label('git push --force origin main'), 'git push');
  assert.equal(label('node --test test/a.test.mjs'), 'node');
  assert.equal(label('py hunterpass'), 'py', 'python and the like: the first argument is a file or a value');
  assert.equal(label('python -m pytest'), 'python');
  // A word that could be a value is not taken: digits, capitals, a flag
  assert.equal(label('npm Abc123secret'), 'npm');
  assert.equal(label('npm --token=xyz test'), 'npm');
  assert.equal(label('npm run Deploy2Prod'), 'npm run');
  // Environment values stay out (ingest.mjs programName / programRest), their words too; one that may run on names nothing
  assert.equal(label('API_KEY=abc npm test'), 'npm test');
  assert.equal(label('X="a git word y" git push'), 'git push');
  assert.equal(label('A=$(cat key) npm test'), '');
  assert.deepEqual(commandLabel('& "C:\\Program Files\\nodejs\\npm.cmd" test'), { label: 'npm.cmd test', more: false, joins: 'none' });
  assert.equal(label('Push-Location app; npm test'), 'npm test');
  // The line's hash tells the very same line only
  assert.equal(commandKey('npm test '), commandKey('npm test'));
  assert.notEqual(commandKey('cd a && npm test'), commandKey('cd b && npm test'));
  // The shell's folder lasts between calls, and a worktree agent runs elsewhere: the folder is part of the line
  assert.notEqual(commandKey('npm test', 'C:\\a'), commandKey('npm test', 'C:\\b'));
});

test('what joins a line\'s commands: only && (every part ended well when the line did), or another join', () => {
  assert.equal(lineJoins('npm test 2>&1 | tail -20'), 'other');
  assert.equal(lineJoins('npm run build && npm test'), 'and');
  assert.equal(lineJoins('npm run build && npm test || echo x'), 'other');
  assert.equal(lineJoins('npm test; echo done'), 'other');
  assert.equal(lineJoins('npm test\necho x'), 'other');
  assert.equal(lineJoins('npm start &'), 'other');
  assert.equal(lineJoins('npm test > out.txt 2>&1'), 'none', 'a redirection is no join');
  assert.equal(lineJoins('grep "a|b;c" file'), 'none', 'quoted joins are none');
  assert.equal(lineJoins("echo 'x && y'"), 'none');
  assert.equal(lineJoins('& "C:\\x\\npm.cmd" test'), 'none', 'PowerShell\'s call operator');
  assert.equal(hasMore('cd app && npm test'), true);
  assert.equal(hasMore('npm test'), false);
});

const result = (block, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...block }] }, ...extra });

test('how a shell call ended, from the shapes Claude Code writes', () => {
  const ok = result({ content: 'fine' }, { toolUseResult: { stdout: 'fine', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });
  assert.deepEqual(shellOutcome(ok, ok.message.content[0]), { end: 'ok' });
  const noMatch = result({ content: '' }, { toolUseResult: { stdout: '', interrupted: false, returnCodeInterpretation: 'No matches found' } });
  assert.deepEqual(shellOutcome(noMatch, noMatch.message.content[0]), { end: 'ok' }, 'Claude Code reads exit 1 of grep as no error');
  const failed = result({ content: 'Exit code 2\nnpm ERR! test failed', is_error: true }, { toolUseResult: 'Error: Exit code 2\nnpm ERR! test failed' });
  assert.deepEqual(shellOutcome(failed, failed.message.content[0]), { end: 'failed', code: 2 });
  const denied = result({ content: 'This command requires approval', is_error: true }, { toolDenialKind: 'user-rejected' });
  assert.deepEqual(shellOutcome(denied, denied.message.content[0]), { end: 'not-run' });
  const blocked = result({ content: '<tool_use_error>Blocked: sleep 5 followed by: cat x</tool_use_error>', is_error: true });
  assert.deepEqual(shellOutcome(blocked, blocked.message.content[0]), { end: 'not-run' });
  // Could not start, or a worktree agent refusing it (71 such lines in real logs, with no toolDenialKind): did not run
  const spawn = result({ content: 'EPERM: operation not permitted, uv_spawn', is_error: true });
  assert.deepEqual(shellOutcome(spawn, spawn.message.content[0]), { end: 'not-run' });
  const worktree = result({ content: 'This agent is isolated in the worktree C:\\x, but this command is too complex to verify. Refusing to run it.', is_error: true });
  assert.deepEqual(shellOutcome(worktree, worktree.message.content[0]), { end: 'not-run' });
  const interrupted = result({ content: '[Request interrupted by user for tool use]', is_error: true });
  assert.deepEqual(shellOutcome(interrupted, interrupted.message.content[0]), { end: 'no-code' });
  // An error text not seen before is not known: never "it did not run" (review E3 round 2)
  const other = result({ content: 'Command timed out after 2m', is_error: true });
  assert.deepEqual(shellOutcome(other, other.message.content[0]), { end: 'no-code' });
  const spawn2 = result({ content: 'ENAMETOOLONG: name too long, uv_spawn', is_error: true });
  assert.deepEqual(shellOutcome(spawn2, spawn2.message.content[0]), { end: 'not-run' });
  const stopped = result({ content: '' }, { toolUseResult: { interrupted: true } });
  assert.deepEqual(shellOutcome(stopped, stopped.message.content[0]), { end: 'no-code' });
  const bg = result({ content: 'Command running in background with ID: b6cq.' }, { toolUseResult: { backgroundTaskId: 'b6cq', interrupted: false } });
  assert.deepEqual(shellOutcome(bg, bg.message.content[0]), { end: 'background' });
  // An agent's log may carry no toolUseResult: the call's own run_in_background says it
  const bare = result({ content: 'Command running in background with ID: x.' });
  assert.deepEqual(shellOutcome(bare, bare.message.content[0], true), { end: 'background' });
  // Text parts instead of a string
  const parts = result({ content: [{ type: 'text', text: 'Exit code 127\nnot found' }], is_error: true });
  assert.deepEqual(shellOutcome(parts, parts.message.content[0]), { end: 'failed', code: 127 });
});

const note = (id, status, summary) => `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>C:\\x\\b1.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

test('a background command\'s end comes from its notification; only the end of the summary is read', () => {
  assert.deepEqual(backgroundEnd(note('toolu_A', 'completed', 'Background command "Run tests" completed (exit code 0)')), { id: 'toolu_A', end: 'ok', code: 0 });
  assert.deepEqual(backgroundEnd(note('toolu_A', 'completed', 'Background command "grep" completed (exit code 1: No matches found)')), { id: 'toolu_A', end: 'ok', code: 1 });
  assert.deepEqual(backgroundEnd(note('toolu_A', 'failed', 'Background command "Build" failed with exit code 127')), { id: 'toolu_A', end: 'failed', code: 127 });
  assert.deepEqual(backgroundEnd(note('toolu_A', 'killed', 'Background command "Serve" was stopped')), { id: 'toolu_A', end: 'no-code' });
  // A description that itself speaks of an exit code does not decide
  assert.deepEqual(backgroundEnd(note('toolu_A', 'failed', 'Background command "check that it failed with exit code 0" failed with exit code 3')), { id: 'toolu_A', end: 'failed', code: 3 });
  assert.equal(backgroundEnd('<status>completed</status>'), null, 'no tool-use id');
  assert.equal(backgroundEnd(note('toolu_A', 'running', 'Background command "x" is running')), null);
});

// ---------------- ingest ----------------
function fakeCatalog() {
  return { resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() };
}
const T0 = Date.parse('2026-10-10T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const feed = (ing, ctx, o) => {
  const buf = Buffer.from(JSON.stringify(o));
  ing.line(ctx, {}, buf, 0, buf.length);
};
const first = (s = 0) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: at(s), cwd: 'C:\\nowhere-sibersentez', message: { role: 'user', content: `Read .sibersentez/job-${J}.md and do the job.` } });
const call = (id, command, s, extra = {}) => ({ parentUuid: 'x', isSidechain: false, type: 'assistant', timestamp: at(s), message: { model: 'claude-opus-5-5', id: 'm' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...extra } }], usage: { output_tokens: 1 } } });
// Real lines start with parentUuid (a line starting with "type" is a tool's own record). The first of Claude Code's two result shapes: type first, the id after the (possibly long) content
const res = (id, s, block = {}, extra = {}) => ({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', ...block, tool_use_id: id }] }, timestamp: at(s), toolUseResult: { stdout: 'ok', interrupted: false }, ...extra });
const fail = (id, s, code) => res(id, s, { content: `Exit code ${code}\nfailed`, is_error: true }, { toolUseResult: `Error: Exit code ${code}` });

test('ingest keeps a job session\'s commands and how they ended; a session with no job keeps none', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  feed(ing, s, call('toolu_1', 'cd app && npm test', 1));
  feed(ing, s, fail('toolu_1', 2, 1));
  // The same label in another folder is another line: it says nothing of the first
  feed(ing, s, call('toolu_2', 'cd other && npm test', 3));
  feed(ing, s, { parentUuid: 'x', type: 'user', timestamp: at(4), message: { role: 'user', content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'pass' }] }, toolUseResult: { stdout: 'pass', interrupted: false } });
  feed(ing, s, call('toolu_3', 'npm run lint | tail -3', 5));
  feed(ing, s, fail('toolu_3', 6, 2));
  feed(ing, s, call('toolu_4', 'rm -rf dist', 7));
  feed(ing, s, res('toolu_4', 8, { content: 'Permission denied', is_error: true }, { toolDenialKind: 'permission-rule' }));
  feed(ing, s, call('toolu_5', 'npm start', 9, { run_in_background: true }));
  feed(ing, s, res('toolu_5', 10, { content: 'Command running in background with ID: b1.' }, { toolUseResult: { backgroundTaskId: 'b1', interrupted: false } }));
  let sum = ing.jobCommands(J);
  assert.deepEqual({ ran: sum.ran, ok: sum.ok, failed: sum.failed, notRun: sum.notRun, noEnd: sum.noEnd }, { ran: 4, ok: 1, failed: 2, notRun: 1, noEnd: 1 });
  assert.deepEqual(sum.failures.map((f) => [f.label, f.more, f.code, f.laterOk]), [['npm run lint', true, 2, null], ['npm test', true, 1, false]]);
  assert.equal(sum.failures[1].at, Date.parse(at(2)), 'when it ended');
  assert.equal(JSON.stringify(sum).includes('rm'), false, 'a refused command is counted, not named');
  assert.equal(JSON.stringify(sum).includes('app'), false, 'no argument and no hash leaves');
  // The very same line again, ending well: now it is said
  feed(ing, s, call('toolu_6', 'cd app && npm test', 11));
  feed(ing, s, res('toolu_6', 12));
  assert.equal(ing.jobCommands(J).failures.find((f) => f.label === 'npm test').laterOk, true);
  // The background end arrives as a queue-operation line, then again as an attachment: counted once
  const n = note('toolu_5', 'failed', 'Background command "Start" failed with exit code 1');
  feed(ing, s, { type: 'queue-operation', operation: 'enqueue', timestamp: at(20), content: n });
  feed(ing, s, { parentUuid: 'x', isSidechain: false, attachment: { type: 'queued_command', prompt: n }, type: 'attachment', timestamp: at(21) });
  sum = ing.jobCommands(J);
  assert.deepEqual([sum.ran, sum.failed, sum.noEnd], [5, 3, 0]);
  assert.equal(sum.failures[0].label, 'npm start');
  // No job, no record
  const other = ing.getSession('s2', null);
  feed(ing, other, { ...first(), message: { role: 'user', content: 'fix the bug' } });
  feed(ing, other, call('toolu_9', 'npm test', 1));
  assert.equal(other.commands, undefined);
  assert.equal(ing.jobCommands('J' + '0'.repeat(32)), null, 'no session of that job');
});

test('ingest: a resumed or forked session that copies the job\'s calls counts them once', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  for (const id of ['s1', 's1-fork']) {
    const s = ing.getSession(id, null);
    feed(ing, s, first());
    feed(ing, s, call('toolu_1', 'npm test', 1));
    feed(ing, s, fail('toolu_1', 2, 1));
    feed(ing, s, call('toolu_2', 'npm run build', 3));
  }
  // Only the fork saw the second call end
  feed(ing, ing.sessions.get('s1-fork'), res('toolu_2', 4));
  const sum = ing.jobCommands(J);
  assert.deepEqual([sum.ran, sum.ok, sum.failed, sum.noEnd, sum.failedLines], [2, 1, 1, 0, 1]);
});

test('ingest: a background end in a user line counts; one that never comes is not waited for forever', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  feed(ing, s, call('toolu_B', 'npm run e2e', 1, { run_in_background: true }));
  feed(ing, s, res('toolu_B', 2, { content: 'Command running in background with ID: b2.' }));
  feed(ing, s, call('toolu_C', 'npm start', 3, { run_in_background: true }));
  feed(ing, s, res('toolu_C', 4, { content: 'Command running in background with ID: b3.' }));
  feed(ing, s, { parentUuid: 'x', isSidechain: false, type: 'user', timestamp: at(30), message: { role: 'user', content: note('toolu_B', 'completed', 'Background command "e2e" completed (exit code 0)') } });
  assert.deepEqual([ing.jobCommands(J).ok, ing.jobCommands(J).noEnd], [1, 1]);
  assert.equal(s.bgWaits, 1);
  // Hours later its session goes on: the one that never ended stops being waited for
  const later = (BG_WAIT_MAX_MS + 60000) / 1000;
  feed(ing, s, { parentUuid: 'x', isSidechain: false, type: 'user', timestamp: at(later), message: { role: 'user', content: 'and now?' } });
  feed(ing, s, { parentUuid: 'x', isSidechain: false, type: 'user', timestamp: at(later + 1), message: { role: 'user', content: 'still there?' } });
  assert.deepEqual([s.bgWaits, s.shellWait.size, ing.jobCommands(J).noEnd], [0, 0, 1]);
});

test('ingest: an agent of a job session counts for the job; a result that only quotes a waiting id is no result', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, path.join(os.tmpdir(), 'none', 'agent-a1.jsonl'));
  feed(ing, ag, call('toolu_A', 'npm test', 1));
  // Another tool's output quoting the waiting id, even as the key itself (escaped in JSON)
  feed(ing, ag, { parentUuid: 'x', type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', content: 'log: {"tool_use_id":"toolu_A"} toolu_A', tool_use_id: 'toolu_other' }] } });
  assert.equal(ing.jobCommands(J).noEnd, 1);
  feed(ing, ag, fail('toolu_A', 3, 1));
  assert.deepEqual([ing.jobCommands(J).ran, ing.jobCommands(J).failed], [1, 1]);
  // The same call read twice (a line seen again) is one command
  feed(ing, ag, call('toolu_A', 'npm test', 1));
  assert.equal(ing.jobCommands(J).ran, 1);
});

test('ingest keeps at most COMMANDS_MAX commands per session; the counts keep every one, ended or not', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  for (let i = 0; i < COMMANDS_MAX + 10; i++) {
    feed(ing, s, call(`toolu_${i}`, 'npm test', i + 1));
    feed(ing, s, res(`toolu_${i}`, i + 1));
  }
  feed(ing, s, call('toolu_hung', 'npm test', COMMANDS_MAX + 20));
  for (let i = 0; i < COMMANDS_MAX; i++) feed(ing, s, call(`toolu_x${i}`, 'node', COMMANDS_MAX + 30 + i));
  assert.equal(s.commands.size, COMMANDS_MAX);
  assert.ok(s.shellWait.size <= COMMANDS_MAX && !s.shellWait.has('toolu_hung'), 'a call dropped from the list waits no more');
  const sum = ing.jobCommands(J);
  assert.deepEqual([sum.ok, sum.noEnd, sum.ran], [COMMANDS_MAX + 10, COMMANDS_MAX + 1, 2 * COMMANDS_MAX + 11]);
});

test('ingest: the same line passing later in another folder says nothing of the failed one', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  feed(ing, s, { ...call('toolu_1', 'npm test', 1), cwd: 'C:\\app\\a' });
  feed(ing, s, fail('toolu_1', 2, 1));
  feed(ing, s, { ...call('toolu_2', 'npm test', 3), cwd: 'C:\\app\\b' });
  feed(ing, s, res('toolu_2', 4));
  assert.equal(ing.jobCommands(J).failures[0].laterOk, false);
  feed(ing, s, { ...call('toolu_3', 'npm test', 5), cwd: 'C:\\app\\a' });
  feed(ing, s, res('toolu_3', 6));
  assert.equal(ing.jobCommands(J).failures[0].laterOk, true);
});

test('a job with sessions of tools whose logs are not read says so', () => {
  const sum = jobCommandsSummary([{ id: 'c1', tool: 'codex' }]);
  assert.deepEqual([sum.ran, sum.unknownTools], [0, ['codex']]);
  assert.equal(jobCommandsSummary([]), null);
});

// ---------------- the result card ----------------
test('the card says what the log shows, apart from the reviewer\'s words; never "no commands" for a tool it cannot read', () => {
  setLanguage('en');
  assert.equal(commandsHtml(undefined), '');
  assert.match(commandsHtml(null), /has not seen this job’s AI session/);
  const html = commandsHtml({ ran: 4, ok: 1, failed: 2, notRun: 1, noEnd: 1, unknownTools: [], failures: [{ label: 'npm run lint', more: true, code: 2, at: T0, laterOk: null }, { label: 'npm test', more: false, code: 1, at: T0, laterOk: true }] });
  assert.match(html, /ran 4 commands for this job; 2 of them ended with an error\./);
  assert.match(commandsHtml({ ran: 1, failed: 1, failures: [] }), /ran 1 command for this job; it ended with an error\./);
  assert.match(commandsHtml({ ran: 1, ok: 1, failures: [] }), /ran 1 command for this job; it ended without an error\./);
  assert.match(commandsHtml({ ran: 9, failed: 6, failedLines: 5, failures: [1, 2, 3, 4, 5].map((i) => ({ label: `npm run t${i}`, code: 1, at: T0, laterOk: false })) }), /and 2 more command lines that ended with an error/);
  assert.match(html, /<code translate="no">npm run lint …<\/code> ended with code 2 \([^)]+\)\./);
  assert.match(html, /npm test<\/code> ended with code 1 \([^)]+\); a later run of the very same command line ended without an error\./);
  assert.match(html, /How 1 of them ended is not in the log/);
  assert.match(html, /could not start, so they did not run: 1\./);
  assert.match(html, /not what it checked/);
  assert.match(commandsHtml({ ran: 3, ok: 3, failed: 0, notRun: 0, noEnd: 0, unknownTools: [], failures: [] }), /none ended with an error/);
  const codex = commandsHtml({ ran: 0, ok: 0, failed: 0, notRun: 0, noEnd: 0, unknownTools: ['codex'], failures: [] });
  assert.match(codex, /Commands run with Codex are not known/);
  assert.doesNotMatch(codex, /no commands/);
  assert.match(commandsHtml({ ran: 0, ok: 0, failed: 0, notRun: 0, noEnd: 0, unknownTools: [], failures: [] }), /ran no commands/);
  // Labels are escaped
  assert.doesNotMatch(commandsHtml({ ran: 1, failed: 1, failures: [{ label: '<b>', code: 1, at: T0, laterOk: false }] }), /<b>/);
  setLanguage('tr');
  assert.match(commandsHtml({ ran: 2, ok: 1, failed: 1, notRun: 0, noEnd: 0, unknownTools: [], failures: [{ label: 'npm test', more: false, code: 1, at: T0, laterOk: false }] }), /2 komut çalıştırdı; 1 tanesi hatayla bitti\..*1 koduyla bitti .*aynı satırın sonradan hatasız biten bir çalıştırması yok./s);
  setLanguage('en');
});
