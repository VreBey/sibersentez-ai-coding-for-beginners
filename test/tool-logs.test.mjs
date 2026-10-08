// Other AI tools' session logs (server/toolLogs.mjs, server/ingest.mjs, 2026-10-07): Codex CLI's and Gemini CLI's
// sessions are read with Claude Code's session model. Fixture logs in a temporary folder; the real home is never read.
// Run: node --test test/tool-logs.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ingest, toolCategory as toolCat } from '../server/ingest.mjs';
import { sessionView } from '../server/views.mjs';
import { classifyForeign, codexPromptText, codexPermission, codexToolCall, geminiToolCall, geminiPromptText } from '../server/toolLogs.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sib-toollogs-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const CODEX = path.join(ROOT, 'codex', 'sessions');
const GEMINI = path.join(ROOT, 'gemini', 'tmp');
const QWEN = path.join(ROOT, 'qwen', 'projects');
const COPILOT = path.join(ROOT, 'copilot', 'session-state');
const CURSOR = path.join(ROOT, 'cursor');
const PROJECT = path.join(ROOT, 'work', 'menu-site');
const JOB = 'J' + '0123456789abcdef'.repeat(2);
const UUID = '01a11627-d3d7-7b73-8a1a-619e30c69d4a';

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
function ingest() {
  const projects = new Map([[PROJECT.toLowerCase(), 'menu']]);
  const ing = new Ingest({ resolve: (cwd) => (cwd ? projects.get(String(cwd).toLowerCase()) || null : null), getProject: () => null, allProjects: () => [], roster: new Map() });
  ing.cutoff = 0;
  ing.initial = true;
  ing.foreignDirs = { codex: CODEX, gemini: GEMINI, qwen: QWEN, copilot: COPILOT, cursor: CURSOR };
  return ing;
}
const T = (m) => Date.UTC(2026, 9, 7, 10, m, 0);
const ts = (m) => `2026-10-07T10:${String(m).padStart(2, '0')}:00.000Z`;

test('which files are logs: Codex rollouts under its sessions folder, Gemini chats under tmp/<project>/chats', () => {
  const dirs = { codex: CODEX, gemini: GEMINI };
  assert.deepEqual(classifyForeign(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T14-37-51-${UUID}.jsonl`), dirs), { kind: 'foreign', tool: 'codex', sessionId: UUID });
  assert.deepEqual(classifyForeign(path.join(GEMINI, 'menu-site', 'chats', 'session-2026-10-07T10-00-ab12.jsonl'), dirs), { kind: 'foreign', tool: 'gemini', slug: 'menu-site', whole: false });
  assert.equal(classifyForeign(path.join(GEMINI, 'menu-site', 'chats', 'session-old.json'), dirs).whole, true);
  assert.equal(classifyForeign(path.join(GEMINI, 'menu-site', 'logs.json'), dirs), null);
  assert.equal(classifyForeign(path.join(CODEX, 'notes.jsonl'), dirs), null);
  assert.equal(classifyForeign(path.join(ROOT, 'elsewhere', `rollout-x-${UUID}.jsonl`), dirs), null);
});

test("the person's words only: Codex's own context in user messages and Gemini's setup text are left out", () => {
  const msg = (...texts) => ({ type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) });
  assert.equal(codexPromptText(msg('# AGENTS.md instructions for C:\\x\n...', '<environment_context>\n</environment_context>')), '');
  assert.equal(codexPromptText(msg('<recommended_plugins>…', 'Menü sayfası ekle')), 'Menü sayfası ekle');
  assert.equal(codexPromptText(msg('<user_instructions>\nx\n</user_instructions>')), '');
  // The person's own HTML is a prompt (review: not every "<" is Codex's context)
  assert.equal(codexPromptText(msg('<div class="menu"> bunu ortala')), '<div class="menu"> bunu ortala');
  assert.equal(codexPromptText({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }), '');
  assert.equal(geminiPromptText([{ text: '<session_context>\nThis is the Gemini CLI.' }]), '');
  assert.equal(geminiPromptText('Add a menu page'), 'Add a menu page');
});

test("Codex's approval and sandbox in the page's permission words; tool calls under their own name with Claude Code's category", () => {
  assert.equal(codexPermission('never', { type: 'danger-full-access' }), 'bypassPermissions');
  assert.equal(codexPermission('never', 'workspace-write'), 'dontAsk');
  assert.equal(codexPermission('on-request', { type: 'workspace-write' }), 'acceptEdits');
  assert.equal(codexPermission('on-request', 'read-only'), 'default');
  assert.equal(codexPermission('untrusted', 'danger-full-access'), 'default');
  assert.equal(codexPermission('on-request', 'danger-full-access'), 'auto');
  assert.equal(codexPermission(null, null), null);
  assert.deepEqual(codexToolCall({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'npm test' }), { id: 'c1', raw: 'exec', mapped: 'Bash', input: { command: 'npm test' } });
  assert.equal(codexToolCall({ type: 'function_call', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' }).mapped, 'Edit');
  assert.equal(codexToolCall({ type: 'local_shell_call', action: { command: ['git', 'status'] } }).input.command, 'git status');
  assert.equal(codexToolCall({ type: 'message' }), null);
  assert.deepEqual(geminiToolCall({ id: 'g1', name: 'run_shell_command', args: { command: 'npm run dev' } }), { id: 'g1', raw: 'run_shell_command', mapped: 'Bash', input: { command: 'npm run dev' } });
  assert.equal(geminiToolCall({ name: 'read_file', args: { absolute_path: 'C:\\p\\a.js' } }).input.file_path, 'C:\\p\\a.js');
});

test('a Codex session: its project, prompts (the job named by the first), model, permission mode, cumulative tokens and tool calls', async () => {
  const ing = ingest();
  const file = write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T10-00-00-${UUID}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id: UUID, timestamp: ts(0), cwd: PROJECT, cli_version: '0.160.1', source: 'cli' } },
    { timestamp: ts(0), type: 'turn_context', payload: { cwd: PROJECT, model: 'gpt-6-astra', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for x' }] } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Please read .sibersentez/job-${JOB}.md and follow it` }] } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'npm test' } },
    { timestamp: ts(3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 120, reasoning_output_tokens: 30 }, last_token_usage: { input_tokens: 9000 } } } },
    'not json',
    { timestamp: ts(4), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 200, reasoning_output_tokens: 50 }, last_token_usage: { input_tokens: 9500 } } } },
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  await ing.processFile(file);
  const s = ing.sessions.get(UUID);
  assert.ok(s, 'the session is read');
  assert.equal(s.tool, 'codex');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.jobId, JOB, 'the first prompt names the job');
  assert.equal(s.promptCount, 1, "Codex's own context is not a prompt");
  assert.equal(s.model, 'gpt-6-astra');
  assert.equal(s.permissionMode, 'acceptEdits');
  assert.equal(s.tokensOut, 200, 'cumulative: the newest total, not a sum; reasoning is part of the output, not added');
  assert.equal(s.contextTokens, 9500);
  assert.equal(s.toolCalls, 1);
  assert.deepEqual(s.toolCounts, { exec: 1 });
  assert.equal(s.lastAction.cat, 'shell');
  assert.equal(s.version, '0.160.1');
  const v = sessionView(ing, s);
  assert.equal(v.tool, 'codex', 'the page gets the tool');
  // Read again (a rescan): nothing counted twice
  await ing.processFile(file);
  assert.equal(s.promptCount, 1);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.tokensOut, 200);
});

test("a Codex sub-agent's thread is left out (its lead stands for the work)", async () => {
  const ing = ingest();
  const id = '01a11627-0000-7b73-8a1a-619e30c69d4a';
  await ing.processFile(write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T10-05-00-${id}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id, cwd: PROJECT, source: { subagent: { thread_spawn: { parent_thread_id: UUID } } } } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sub task' }] } },
  ]));
  assert.equal(ing.sessions.get(id), undefined);
});

test('a Gemini session: its project from .project_root, prompts once per message, tokens once per message, tool calls once per id', async () => {
  const ing = ingest();
  const dir = path.join(GEMINI, 'menu-site');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), PROJECT);
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = write(path.join(dir, 'chats', 'session-2026-10-07T10-00-aaaa.jsonl'), [
    { sessionId: sid, projectHash: 'h', startTime: ts(0), lastUpdated: ts(0), kind: 'main' },
    { id: 'u0', timestamp: ts(0), type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.' }] },
    { id: 'u1', timestamp: ts(1), type: 'user', content: [{ text: `Please read .sibersentez/job-${JOB}.md and follow it` }] },
    { id: 'g1', timestamp: ts(2), type: 'gemini', content: '', model: 'gemini-3-pro', toolCalls: [{ id: 't1', name: 'run_shell_command', args: { command: 'npm test' } }] },
    // The same message written again with its tokens and a second call
    { id: 'g1', timestamp: ts(2), type: 'gemini', content: 'done', model: 'gemini-3-pro', tokens: { input: 5000, output: 80, thoughts: 20 }, toolCalls: [{ id: 't1', name: 'run_shell_command', args: { command: 'npm test' } }, { id: 't2', name: 'read_file', args: { absolute_path: 'a.js' } }] },
    { $set: { lastUpdated: ts(3) } },
    { $rewindTo: 'g1' },
  ]);
  await ing.processFile(file);
  const s = ing.sessions.get(sid);
  assert.ok(s, 'the session is read');
  assert.equal(s.tool, 'gemini');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.jobId, JOB);
  assert.equal(s.promptCount, 1, 'the setup text is not a prompt');
  assert.equal(s.model, 'gemini-3-pro');
  assert.equal(s.tokensOut, 100, 'output and thoughts, once for the message');
  assert.equal(s.contextTokens, 5000);
  assert.equal(s.toolCalls, 2, 'each call once');
  assert.deepEqual(s.toolCounts, { run_shell_command: 1, read_file: 1 });
  await ing.processFile(file);
  assert.equal(s.toolCalls, 2);
});

test("Gemini: another program's agent server (kind a2a) is not a session; an old whole-file session is read and read again without counting twice", async () => {
  const ing = ingest();
  const dir = path.join(GEMINI, 'menu-site');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), PROJECT);
  await ing.processFile(write(path.join(dir, 'chats', 'session-2026-10-07T11-00-a2a-serv.jsonl'), [{ sessionId: 'a2a-1', startTime: ts(0), kind: 'a2a-serv' }, { $set: { messages: [{ id: 'm', type: 'user', content: 'x' }] } }]));
  assert.equal(ing.sessions.get('a2a-1'), undefined);
  const old = path.join(dir, 'chats', 'session-old.json');
  fs.writeFileSync(old, JSON.stringify({ sessionId: 'old-1', startTime: ts(0), lastUpdated: ts(5), messages: [{ id: 'u', timestamp: ts(1), type: 'user', content: 'Fix the menu' }, { id: 'g', timestamp: ts(2), type: 'gemini', tokens: { output: 10 } }] }));
  await ing.processFile(old);
  await ing.processFile(old);
  const s = ing.sessions.get('old-1');
  assert.equal(s.promptCount, 1);
  assert.equal(s.tokensOut, 10);
  assert.equal(s.projectId, 'menu');
});

test("a session continues with its own tool only, never as Claude Code's (the job, the terminal tab, the server)", async () => {
  const { resumeCandidate, jobSession } = await import('../public/js/views/job.js');
  const { tabResumeSession } = await import('../public/js/dockState.js');
  const now = Date.now();
  const codex = { id: UUID, tool: 'codex', projectId: 'p', lastAt: now - 1000, jobId: JOB, live: null };
  assert.equal(resumeCandidate({ sessions: [codex], projectId: 'p', job: { step: 'build', jobId: JOB, tool: 'claude' }, now }), null);
  assert.equal(jobSession({ sessions: [codex], projectId: 'p', job: { jobId: JOB, tool: 'claude' } }), null);
  assert.equal(tabResumeSession([codex], { projectId: 'p', jobId: JOB }, now), null);
  const actions = fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8');
  // Windows Terminal's continue and the copy are Claude Code's own; start-ai continues each session with its own tool
  assert.ok(actions.includes("if ((action === 'resume' || action === 'fork') && (session.tool || 'claude') !== 'claude') return reject(400, 'resume-claude-only');"));
  assert.ok(actions.includes("if (resume && (ingest?.sessions?.get(t.ctx.sessionId)?.tool || 'claude') !== body.tool) return reject(400, 'resume-other-tool');"));
  assert.ok(actions.includes('args: ctx.resume ? resumeArgs(tool, ctx.sessionId)'));
  // The same tool's session does continue: a Codex job goes on with its Codex session, a Codex tab with Codex's
  const job = { step: 'build', jobId: JOB, tool: 'codex' };
  assert.equal(resumeCandidate({ sessions: [codex], projectId: 'p', job, now })?.id, UUID);
  assert.equal(jobSession({ sessions: [codex], projectId: 'p', job })?.id, UUID);
  assert.equal(tabResumeSession([codex], { projectId: 'p', jobId: JOB, tool: 'codex' }, now)?.id, UUID);
  // A tool whose sessions are not read has none
  assert.equal(resumeCandidate({ sessions: [codex], projectId: 'p', job: { ...job, tool: 'opencode' }, now }), null);
});

test('a session that fell out of the window comes back when its log grows (a resumed session), with its project', async () => {
  const ing = ingest();
  const id = '01a11627-1111-7b73-8a1a-619e30c69d4a';
  const file = write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T10-10-00-${id}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id, cwd: PROJECT } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] } },
  ]);
  await ing.processFile(file);
  ing.sessions.delete(id); // what the window's sweep does
  fs.appendFileSync(file, JSON.stringify({ timestamp: ts(9), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] } }) + '\n');
  await ing.processFile(file);
  const s = ing.sessions.get(id);
  assert.ok(s, 'it is seen again');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.lastPrompt, 'again');
});

test("Codex's day folders before the window are not looked into; newer ones are", async () => {
  const ing = ingest();
  const old = write(path.join(CODEX, '2020', '01', '02', 'rollout-2020-01-02T10-00-00-01a11627-2222-7b73-8a1a-619e30c69d4a.jsonl'), [{ type: 'session_meta', payload: {} }]);
  ing.cutoff = Date.UTC(2026, 0, 1);
  const found = (await ing.walkForeign()).map((f) => f.abs);
  assert.ok(!found.includes(old), 'an old day is skipped');
  assert.ok(found.some((f) => f.includes(`${path.sep}2026${path.sep}10${path.sep}07${path.sep}`)), 'a day in the window is walked');
});

test('a Qwen Code session: one record a line, its prompts (the real user only), model, tokens per record, tool calls with Gemini names', async () => {
  const ing = ingest();
  const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
  const rec = (over) => ({ sessionId: sid, timestamp: ts(0), cwd: PROJECT, version: '0.25.0', gitBranch: 'main', ...over });
  const file = write(path.join(QWEN, 'c--work-menu-site', 'chats', `${sid}.jsonl`), [
    rec({ uuid: 'r1', type: 'user', provenance: 'real_user', message: { role: 'user', parts: [{ text: `Please read .sibersentez/job-${JOB}.md and follow it` }] } }),
    // OpenAI's way, as Qwen converts it: the 15 reasoning tokens are inside the 60 of the completion (total 4060)
    rec({ uuid: 'r2', type: 'assistant', timestamp: ts(1), model: 'qwen3-coder', message: { role: 'model', parts: [{ text: 'ok' }, { functionCall: { id: 'f1', name: 'run_shell_command', args: { command: 'npm test' } } }] }, usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 60, thoughtsTokenCount: 15, totalTokenCount: 4060 } }),
    rec({ uuid: 'r3', type: 'tool_result', timestamp: ts(2) }),
    rec({ uuid: 'r4', type: 'assistant', timestamp: ts(3), model: 'qwen3-coder', message: { parts: [{ text: 'done' }] }, usageMetadata: { promptTokenCount: 4200, candidatesTokenCount: 25 } }),
    rec({ uuid: 'r5', type: 'user', provenance: 'system_injected', message: { parts: [{ text: 'not the person' }] } }),
  ]);
  const ledger = path.join(QWEN, 'c--work-menu-site', 'chats', `${sid}.ledger.jsonl`);
  assert.equal(ing.classify(ledger), null, 'the ledger is not a log');
  await ing.processFile(file);
  const s = ing.sessions.get(sid);
  assert.ok(s);
  assert.equal(s.tool, 'qwen');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.jobId, JOB);
  assert.equal(s.promptCount, 1);
  assert.equal(s.model, 'qwen3-coder');
  assert.equal(s.tokensOut, 85, 'per record: total - prompt (60), then the candidates without a total (25); thoughts never added on top');
  assert.equal(s.contextTokens, 4200);
  assert.deepEqual(s.toolCounts, { run_shell_command: 1 });
  assert.equal(s.branch, 'main');
  assert.ok((await ing.walkForeign()).some((f) => f.abs === file), 'walked');
});

test("other tools' requests go into the usage ledger in Claude Code's shape: cached input apart, each request once", async () => {
  const ing = ingest();
  const calls = [];
  ing.ledger = { add: (x) => calls.push(x) };
  const id = '01a11627-3333-7b73-8a1a-619e30c69d4a';
  const tc = (total, last) => ({ timestamp: ts(2), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  const file = write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T10-20-00-${id}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id, cwd: PROJECT } },
    { timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    tc({ total_tokens: 1200, output_tokens: 200 }, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200 }),
    // The same event written again: one request
    tc({ total_tokens: 1200, output_tokens: 200 }, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200 }),
  ]);
  await ing.processFile(file);
  const codex = calls.filter((c) => c.key.startsWith('codex|'));
  assert.equal(new Set(codex.map((c) => c.key)).size, 1, 'one key for the repeated event (the ledger keeps one record a key)');
  assert.deepEqual(codex[0].usage, { input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 200 });
  assert.equal(codex[0].model, 'gpt-6-astra');
  assert.equal(codex[0].projectId, 'menu');
  const dir = path.join(GEMINI, 'menu-site');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), PROJECT);
  await ing.processFile(write(path.join(dir, 'chats', 'session-2026-10-07T10-30-cccc.jsonl'), [
    { sessionId: 'cccc-1', startTime: ts(0), kind: 'main' },
    { id: 'g1', timestamp: ts(1), type: 'gemini', model: 'gemini-3-pro', tokens: { input: 900, cached: 300, output: 50, thoughts: 10 } },
    { id: 'g1', timestamp: ts(1), type: 'gemini', model: 'gemini-3-pro', tokens: { input: 900, cached: 300, output: 50, thoughts: 10 } },
  ]));
  const gem = calls.filter((c) => c.key.startsWith('gemini|'));
  assert.equal(gem.length, 1, 'a message rewritten is counted once');
  assert.deepEqual(gem[0].usage, { input_tokens: 600, cache_read_input_tokens: 300, output_tokens: 60 });
});

test("Qwen's prompt is what the person typed: not the files Qwen added for an @-reference; older records by Qwen's own rule", async () => {
  const { qwenPromptText, qwenOutTokens } = await import('../server/toolLogs.mjs');
  const typed = { type: 'user', provenance: 'real_user', systemPayload: { displayText: 'explain @a.js' }, message: { parts: [{ text: 'explain @a.js' }, { text: '--- Content from referenced files --- ...' }] } };
  assert.equal(qwenPromptText(typed), 'explain @a.js');
  assert.equal(qwenPromptText({ type: 'user', message: { parts: [{ text: 'old record' }] } }), 'old record', 'no provenance, no subtype');
  assert.equal(qwenPromptText({ type: 'user', subtype: 'mid_turn_user_message', message: { parts: [{ text: 'typed mid-turn' }] } }), 'typed mid-turn');
  assert.equal(qwenPromptText({ type: 'user', subtype: 'cron', message: { parts: [{ text: 'not the person' }] } }), '');
  // Gemini's way (thoughts apart): total - prompt holds both
  assert.equal(qwenOutTokens({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 150 }), 50);
  assert.equal(qwenOutTokens({ candidatesTokenCount: 40, thoughtsTokenCount: 10 }), 40);
  assert.equal(qwenOutTokens(null), 0);
});

test('a resumed Codex session that fell out of the window goes on from its own count', async () => {
  const ing = ingest();
  const id = '01a11627-4444-7b73-8a1a-619e30c69d4a';
  const tc = (out) => JSON.stringify({ timestamp: ts(5), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { output_tokens: out }, last_token_usage: { input_tokens: 1 } } } });
  const file = write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T10-40-00-${id}.jsonl`), [{ timestamp: ts(0), type: 'session_meta', payload: { id, cwd: PROJECT } }, tc(1000)]);
  await ing.processFile(file);
  const bumps = [];
  const bump = ing.bump.bind(ing);
  ing.bump = (metric, pid, t, n) => (metric === 'tokens' && bumps.push(n), bump(metric, pid, t, n));
  ing.sessions.delete(id);
  fs.appendFileSync(file, tc(1050) + '\n');
  await ing.processFile(file);
  assert.equal(ing.sessions.get(id).tokensOut, 1050);
  assert.deepEqual(bumps, [50], 'only what is new');
});

test("Codex: a history its desktop app imported (no thread_source) and its guardian reviewer's thread are not sessions; the person's are", async () => {
  const ing = ingest();
  const ids = ['01a11627-7777-7b73-8a1a-619e30c69d4a', '01a11627-8888-7b73-8a1a-619e30c69d4a', '01a11627-9999-7b73-8a1a-619e30c69d4a'];
  const metas = [
    { id: ids[0], cwd: PROJECT, originator: 'Codex Desktop', source: 'vscode' },
    { id: ids[1], cwd: PROJECT, originator: 'codex_work_desktop', source: 'subagent', thread_source: 'guardian_review' },
    { id: ids[2], cwd: PROJECT, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' },
  ];
  for (let i = 0; i < 3; i++) {
    await ing.processFile(write(path.join(CODEX, '2026', '10', '07', `rollout-2026-10-07T11-0${i}-00-${ids[i]}.jsonl`), [
      { timestamp: ts(0), type: 'session_meta', payload: metas[i] },
      { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Set model to `Opus 5.5` and saved as your default' }] } },
    ]));
  }
  assert.equal(ing.sessions.get(ids[0]), undefined, 'imported: Claude Code work is not shown twice');
  assert.equal(ing.sessions.get(ids[1]), undefined, "the guardian reviewer's thread");
  assert.ok(ing.sessions.get(ids[2]), 'a session the person started in the desktop app');
});

test('a Copilot CLI session (the shape of two sessions run here): its folder, the typed prompt, model, tool call, tokens at shutdown', async () => {
  const ing = ingest();
  const calls = [];
  ing.ledger = { add: (x) => calls.push(x) };
  const sid = 'a1a9708c-4abd-41f0-ab11-d319595ee7af';
  const ev = (type, data, m) => ({ type, data, id: `e${m}`, timestamp: ts(m), parentId: null });
  const file = write(path.join(COPILOT, sid, 'events.jsonl'), [
    ev('session.start', { sessionId: sid, copilotVersion: '1.0.92', context: { cwd: PROJECT } }, 0),
    ev('session.model_change', { newModel: 'mai-code-1.1-flash' }, 0),
    ev('user.message', { content: `Please read .sibersentez/job-${JOB}.md and follow it`, transformedContent: '<context>…</context> Please read' }, 1),
    ev('assistant.message', { model: 'mai-code-1.1-flash', toolRequests: [{ toolCallId: 'c1', name: 'view', arguments: { path: 'note.txt' } }] }, 2),
    ev('tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: 'note.txt' } }, 2),
    ev('assistant.turn_end', {}, 3),
    ev('session.shutdown', { currentModel: 'mai-code-1.1-flash', tokenDetails: { input: { tokenCount: 500 }, cache_read: { tokenCount: 31200 }, cache_write: { tokenCount: 0 }, output: { tokenCount: 88 } } }, 4),
  ]);
  assert.equal(ing.classify(path.join(COPILOT, sid, 'workspace.yaml')), null);
  assert.equal(ing.classify(path.join(COPILOT, 'not-a-uuid', 'events.jsonl')), null);
  await ing.processFile(file);
  const s = ing.sessions.get(sid);
  assert.ok(s);
  assert.equal(s.tool, 'copilot');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.jobId, JOB, 'the typed prompt, not the transformed one');
  assert.equal(s.model, 'mai-code-1.1-flash');
  assert.equal(s.version, '1.0.92');
  assert.deepEqual(s.toolCounts, { view: 1 });
  assert.equal(s.lastAction.cat, toolCat('Read'));
  assert.equal(s.tokensOut, 88);
  assert.deepEqual(calls.map((c) => c.usage), [{ input_tokens: 500, cache_read_input_tokens: 31200, output_tokens: 88 }], 'its input is without the cached part already');
  assert.ok((await ing.walkForeign()).some((f) => f.abs === file));
});

test("resume arguments: the id after them, or joined to Copilot's --resume=; the launcher takes an option joined to a UUID only", async () => {
  const { resumeArgs, launcherText } = await import('../server/launch.mjs');
  const { TOOLS } = await import('../server/tools.mjs');
  const tool = (id) => TOOLS.find((x) => x.id === id);
  assert.deepEqual(resumeArgs(tool('codex'), UUID), ['resume', UUID]);
  assert.deepEqual(resumeArgs(tool('copilot'), UUID), [`--resume=${UUID}`]);
  assert.deepEqual(resumeArgs(tool('opencode'), UUID), ['--session', UUID]);
  assert.deepEqual(resumeArgs({ resume: null }, UUID), []);
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' };
  const ok = launcherText({ toolName: 'Copilot CLI', file: 'C:\\t\\copilot.cmd', ext: '.cmd', args: [`--resume=${UUID}`], env });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  for (const bad of ['--resume=x&calc', '--resume="a"', '--x=12345678']) assert.equal(launcherText({ toolName: 'X', file: 'C:\\t\\x.cmd', ext: '.cmd', args: [bad], env }).ok, false, bad);
});

test("a Cursor CLI session (the shape of one run here): the person's words inside <user_query>, its folder and times from meta.json", async () => {
  const ing = ingest();
  const sid = '9ef86e13-84c6-4a72-81c0-72eddeda4300';
  const file = write(path.join(CURSOR, 'projects', 'C-work-menu-site', 'agent-transcripts', sid, `${sid}.jsonl`), [
    { role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Wednesday, Oct 7</timestamp>\n<user_query>\nPlease read .sibersentez/job-${JOB}.md and follow it\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'OK' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { target_file: 'a.js' } }] } },
    { type: 'turn_ended', status: 'success' },
  ]);
  const meta = path.join(CURSOR, 'chats', '0b43df77e30e31933ba7d83eba70b0a2', sid, 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ schemaVersion: 1, createdAtMs: T(0), updatedAtMs: T(5), hasConversation: true, cwd: PROJECT }));
  assert.equal(ing.classify(path.join(CURSOR, 'projects', 'x', 'agent-transcripts', sid, 'other.jsonl')), null);
  await ing.processFile(file);
  const s = ing.sessions.get(sid);
  assert.ok(s);
  assert.equal(s.tool, 'cursor');
  assert.equal(s.projectId, 'menu');
  assert.equal(s.jobId, JOB, 'the words inside <user_query>, not the timestamp');
  assert.ok(s.lastAt >= T(5), 'meta.json updatedAtMs, or the transcript file time when later');
  assert.deepEqual(s.toolCounts, { read_file: 1 });
  assert.equal(s.lastStop, 'end_turn');
  assert.ok((await ing.walkForeign()).some((f) => f.abs === file));
});

test('a continued Copilot session: each shutdown holds its own run, so the session adds them up and the ledger books each', async () => {
  const ing = ingest();
  const calls = [];
  ing.ledger = { add: (x) => calls.push(x) };
  const sid = '9995566b-f0aa-4a69-a130-e60c4b102e1a';
  const sd = (id, out, write, m) => ({ type: 'session.shutdown', id, timestamp: ts(m), data: { tokenDetails: { input: { tokenCount: 7490 }, cache_read: { tokenCount: 8320 }, cache_write: { tokenCount: write }, output: { tokenCount: out } } } });
  await ing.processFile(write(path.join(COPILOT, sid, 'events.jsonl'), [{ type: 'session.start', id: 'e0', timestamp: ts(0), data: { sessionId: sid, context: { cwd: PROJECT } } }, sd('s1', 5, 0, 1), sd('s2', 21, 16885, 9)]));
  assert.equal(ing.sessions.get(sid).tokensOut, 26);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].usage.cache_creation_input_tokens, 16885, 'the cache write is booked too');
});

test('which tools continue from here: a UUID session id and resume arguments (OpenCode ids are not UUIDs)', async () => {
  const { canContinueTool } = await import('../public/js/jobId.js');
  for (const id of ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'cursor', undefined]) assert.equal(canContinueTool(id), true, String(id));
  for (const id of ['opencode', 'antigravity', 'x']) assert.equal(canContinueTool(id), false, id);
  const { launcherText } = await import('../server/launch.mjs');
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' };
  for (const bad of [`--resume=${UUID}&calc`, `--resume=${UUID.toUpperCase()}`, `--resume=${UUID} x`]) assert.equal(launcherText({ toolName: 'X', file: 'C:\\t\\x.cmd', ext: '.cmd', args: [bad], env }).ok, false, bad);
});

test("a Cursor transcript without meta.json: its own file time stands in, and meta.json is looked for once", async () => {
  const ing = ingest();
  const sid = '11111111-2222-4333-8444-555555555555';
  const file = write(path.join(CURSOR, 'projects', 'C-work-x', 'agent-transcripts', sid, `${sid}.jsonl`), [{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>hello</user_query>' }] } }]);
  await ing.processFile(file);
  const s = ing.sessions.get(sid);
  assert.ok(s.lastAt > 0, 'the file time');
  assert.equal(ing.files.get(file).metaMissing, true);
  assert.equal(s.lastPrompt, 'hello');
});
