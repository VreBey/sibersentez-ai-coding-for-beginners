// A Claude Code agent in each AI tool's own shape (server/agentFormats.mjs) and installed there (server/install.mjs,
// 2026-10-07). The shapes were checked in the installed tools: Gemini CLI's strict schema, Qwen Code's parser,
// OpenCode's agent struct, Codex's "must define developer_instructions". Run: node --test test/agent-formats.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgent, convertAgent, AGENT_FORMATS } from '../server/agentFormats.mjs';
import { planInstall, executeInstall, planRemove, executeRemove, readInstalls, TARGETS } from '../server/install.mjs';

const KIT_AGENT = [
  '---',
  '# SiberSentez Kit agent.',
  '# SPDX-License-Identifier: MIT (full text: LICENSE.md in the SiberSentez kit folder). Keep this notice.',
  'name: backend-builder',
  'description: "Builds server-side work: API routes, \\"data\\" storage. Use when a task is about an API."',
  'tools: Read, Grep, Glob, Edit, Write, Bash',
  'license: "MIT (see the notice at the top of this file)"',
  'metadata:',
  '  author: "SiberSentez"',
  '  version: "0.2.0"',
  '---',
  '',
  '# Backend builder',
  '',
  "You build one task. Don't touch other files.",
  '',
].join('\n');

// The YAML frontmatter's top-level keys (enough for these files: one key a line)
const keysOf = (md) => /^---\n([\s\S]*?)\n---/.exec(md)[1].split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);

test('the agent read: name, description (a JSON-quoted string), the comment lines, the body', () => {
  const a = parseAgent(KIT_AGENT);
  assert.equal(a.name, 'backend-builder');
  assert.equal(a.description, 'Builds server-side work: API routes, "data" storage. Use when a task is about an API.');
  assert.equal(a.comments.length, 2);
  assert.ok(a.body.includes('# Backend builder'));
  assert.equal(parseAgent('no frontmatter'), null);
});

test("each tool's shape: only the keys it accepts (Gemini's schema is strict), the license notice kept, the body as the prompt", () => {
  const gemini = convertAgent(KIT_AGENT, 'gemini');
  assert.deepEqual(keysOf(gemini), ['name', 'description', 'tools'], 'no license or metadata; the tools in Gemini CLI names');
  assert.ok(gemini.includes('# SPDX-License-Identifier: MIT') && gemini.includes("You build one task. Don't touch other files."));
  assert.deepEqual(keysOf(convertAgent(KIT_AGENT, 'qwen')), ['name', 'description', 'tools'], 'the tools in Qwen Code names');
  const oc = convertAgent(KIT_AGENT, 'opencode');
  assert.deepEqual(keysOf(oc), ['description', 'mode']);
  assert.ok(oc.includes('mode: subagent'));
  const toml = convertAgent(KIT_AGENT, 'codex');
  assert.match(toml, /^name = "backend-builder"$/m);
  assert.match(toml, /^description = "Builds server-side work: API routes, \\"data\\" storage\. Use when a task is about an API\."$/m);
  assert.match(toml, /^developer_instructions = "# Backend builder\\n\\nYou build one task\. Don't touch other files\."$/m);
  assert.ok(toml.startsWith('# SiberSentez Kit agent.'), 'the notice as TOML comments');
  // A value that parses back as JSON is a valid TOML basic string and YAML double-quoted string
  for (const line of toml.split('\n').filter((l) => / = "/.test(l))) assert.doesNotThrow(() => JSON.parse(line.slice(line.indexOf('= ') + 2)), line);
  assert.equal(convertAgent(KIT_AGENT, 'claude'), null, 'not a converted format');
  assert.equal(convertAgent('---\ndescription: x\n---\nbody', 'gemini', 'My Agent!'), convertAgent('---\nname: my-agent\ndescription: x\n---\nbody', 'gemini'), 'a slug from the file name');
});

test('installed for a Codex and a Gemini job: .claude as it is, .codex and .gemini converted; the record keeps the source apart; removed cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sib-agents-'));
  after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'registry'), { recursive: true });
  const src = path.join(root, 'lib', 'backend-builder.md');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, KIT_AGENT);
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const library = [{ kind: 'agent', name: 'backend-builder', path: src, rel: 'agents/backend-builder.md' }];
  const project = { id: 'p1' };
  const items = [{ kind: 'agent', name: 'backend-builder' }];
  for (const t of AGENT_FORMATS) assert.ok(TARGETS.includes(t), t);
  const plan = planInstall({ project, dir, items, targets: ['agents', 'codex', 'gemini'], library, installs: [], kit: null });
  assert.deepEqual(plan.map((e) => `${e.target}:${e.op}`), ['claude:copy', 'codex:copy', 'gemini:copy']);
  const r = executeInstall({ plan, project, hubDir: hub, installs: [] });
  assert.equal(r.copied, 3);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'agents', 'backend-builder.md'), 'utf8'), KIT_AGENT, 'as it is');
  assert.match(fs.readFileSync(path.join(dir, '.codex', 'agents', 'backend-builder.toml'), 'utf8'), /^developer_instructions = /m);
  assert.deepEqual(keysOf(fs.readFileSync(path.join(dir, '.gemini', 'agents', 'backend-builder.md'), 'utf8')), ['name', 'description', 'tools']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.codex')), ['agents'], 'no staging file left');
  const rec = readInstalls(hub).installs;
  const codexRec = rec.find((x) => x.target === 'codex');
  assert.ok(codexRec.srcHash && codexRec.srcHash !== codexRec.hash, 'the source hash apart from the written file');
  // Unchanged source: up to date, not an update every time
  const again = planInstall({ project, dir, items, targets: ['codex', 'gemini'], library, installs: rec, kit: null });
  assert.deepEqual(again.map((e) => `${e.target}:${e.reason}`), ['claude:up-to-date', 'codex:up-to-date', 'gemini:up-to-date']);
  // A skill never goes to an agent-only target
  const skill = planInstall({ project, dir, items: [{ kind: 'skill', name: 'x' }], targets: ['codex', 'agents'], library: [], installs: [], kit: null });
  assert.deepEqual(skill.map((e) => e.target), ['agents']);
  // Removed: the converted files too, only while unchanged
  const rm = planRemove({ project, dir, items, targets: ['codex', 'gemini'], installs: rec });
  assert.deepEqual(rm.map((e) => `${e.target}:${e.op}`), ['claude:remove', 'codex:remove', 'gemini:remove']);
  executeRemove({ plan: rm, hubDir: hub, installs: rec });
  assert.equal(fs.existsSync(path.join(dir, '.codex', 'agents', 'backend-builder.toml')), false);
});

test('Codex: an agent that can neither change files nor run commands runs in a read-only sandbox (learn.chatgpt.com subagents, 2026-10-09)', () => {
  const withTools = (tools) => KIT_AGENT.replace('tools: Read, Grep, Glob, Edit, Write, Bash', tools);
  assert.match(convertAgent(withTools('tools: Read, Grep, Glob'), 'codex'), /^sandbox_mode = "read-only"$/m, 'a scout that only reads');
  // A command may write (a test's temp files) or reach localhost (a QA run starts the program): the parent sandbox
  assert.doesNotMatch(convertAgent(withTools('tools: Read, Grep, Glob, Bash'), 'codex'), /sandbox_mode/, 'a reviewer that runs checks');
  assert.match(convertAgent(withTools('tools: read, grep'), 'codex'), /^sandbox_mode = "read-only"$/m, 'tool names in any case');
  assert.doesNotMatch(convertAgent(withTools('tools: read, edit'), 'codex'), /sandbox_mode/, 'a lower-case edit still writes');
  assert.match(convertAgent(withTools('tools:\n  - Read\n  - Grep'), 'codex'), /^sandbox_mode = "read-only"$/m, 'a YAML list');
  assert.doesNotMatch(convertAgent(KIT_AGENT, 'codex'), /sandbox_mode/, 'a builder that edits keeps the parent sandbox');
  assert.doesNotMatch(convertAgent(withTools('tools: Read, Grep, Write'), 'codex'), /sandbox_mode/, 'a planner that writes its plan file');
  assert.doesNotMatch(convertAgent(withTools(''), 'codex'), /sandbox_mode/, 'no tools line: every tool, the parent sandbox');
  // Only Codex has the sandbox setting
  assert.doesNotMatch(convertAgent(withTools('tools: Read, Grep'), 'gemini'), /sandbox_mode/);
  assert.deepEqual(parseAgent(withTools('tools: Read, Grep, Glob')).tools, ['Read', 'Grep', 'Glob']);
});

test('Gemini CLI: the agent keeps its tool limits in Gemini names when every Claude Code tool has one (checked in Gemini CLI 0.63.0 with its own loader, 2026-10-09)', () => {
  const withTools = (tools) => KIT_AGENT.replace('tools: Read, Grep, Glob, Edit, Write, Bash', tools);
  const toolsOf = (md) => JSON.parse(/^tools: (.*)$/m.exec(md)?.[1] ?? 'null');
  assert.deepEqual(toolsOf(convertAgent(withTools('tools: Read, Grep, Glob'), 'gemini')), ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'], 'a scout reads only');
  assert.deepEqual(toolsOf(convertAgent(KIT_AGENT, 'gemini')), ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'replace', 'write_file', 'run_shell_command'], 'a builder');
  assert.equal(toolsOf(convertAgent(withTools('tools: Read, mcp__db__query'), 'gemini')), null, 'a tool with no Gemini name: no list, the defaults apply rather than a wrong limit');
  assert.equal(toolsOf(convertAgent(withTools(''), 'gemini')), null, 'no tools line: every tool');
  assert.equal(toolsOf(convertAgent(withTools('tools: Read'), 'opencode')), null, 'OpenCode takes a map, not a list');
});

test('Qwen Code: the agent keeps its tool limits in Qwen names (ToolNames of the installed Qwen Code 0.25.0, 2026-10-09)', () => {
  const withTools = (tools) => KIT_AGENT.replace('tools: Read, Grep, Glob, Edit, Write, Bash', tools);
  const toolsOf = (md) => JSON.parse(/^tools: (.*)$/m.exec(md)?.[1] ?? 'null');
  // Qwen matches a subagent's tools by name or display name only: Read, Write and Bash (ReadFile, WriteFile, Shell there)
  // would be names of no tool, and the agent would lose them
  assert.deepEqual(toolsOf(convertAgent(withTools('tools: Read, Grep, Glob'), 'qwen')), ['read_file', 'grep_search', 'glob', 'list_directory'], 'a scout reads only');
  assert.deepEqual(toolsOf(convertAgent(KIT_AGENT, 'qwen')), ['read_file', 'grep_search', 'glob', 'list_directory', 'edit', 'write_file', 'run_shell_command'], 'a builder');
  assert.deepEqual(toolsOf(convertAgent(withTools('tools: Read, Bash(git:*), PowerShell, WebFetch, WebSearch, TodoWrite, Task, Skill, NotebookEdit, MultiEdit, LS'), 'qwen')), ['read_file', 'run_shell_command', 'web_fetch', 'web_search', 'todo_write', 'agent', 'skill', 'notebook_edit', 'edit', 'list_directory']);
  assert.equal(toolsOf(convertAgent(withTools('tools: Read, mcp__db__query'), 'qwen')), null, 'a tool with no Qwen name: no list, the defaults apply rather than a wrong limit');
  assert.equal(toolsOf(convertAgent(withTools(''), 'qwen')), null, 'no tools line: every tool');
});

test('OpenCode: an agent without edit or shell tools gets those permissions denied (checked with the installed OpenCode 1.18.35: opencode agent list shows the rules, 2026-10-09)', () => {
  const withTools = (tools) => KIT_AGENT.replace('tools: Read, Grep, Glob, Edit, Write, Bash', tools);
  const perm = (md) => (/^permission:\n((?: {2}.+\n)+)/m.exec(md)?.[1] || '').trim().split('\n').filter(Boolean).map((l) => l.trim());
  assert.deepEqual(perm(convertAgent(withTools('tools: Read, Grep, Glob'), 'opencode')), ['edit: deny', 'bash: deny'], 'a scout');
  assert.deepEqual(perm(convertAgent(withTools('tools: Read, Grep, Glob, Bash'), 'opencode')), ['edit: deny'], 'a reviewer runs checks, writes nothing');
  assert.deepEqual(perm(convertAgent(withTools('tools: Read, Grep, Glob, Write'), 'opencode')), ['bash: deny'], 'a planner writes its plan, runs nothing');
  assert.deepEqual(perm(convertAgent(KIT_AGENT, 'opencode')), [], 'a builder: no denial');
  assert.deepEqual(perm(convertAgent(withTools(''), 'opencode')), [], 'no tools line: every tool');
  assert.deepEqual(keysOf(convertAgent(withTools('tools: Read'), 'opencode')), ['description', 'mode', 'permission']);
});

test('a tool given as a permission rule (Bash(git:*)) is that tool in every converted shape', () => {
  const withTools = (tools) => KIT_AGENT.replace('tools: Read, Grep, Glob, Edit, Write, Bash', tools);
  const md = withTools('tools: Read, Grep, Bash(git:*)');
  assert.doesNotMatch(convertAgent(md, 'codex'), /sandbox_mode/, 'it runs commands: not read-only');
  assert.doesNotMatch(convertAgent(md, 'opencode'), /bash: deny/);
  assert.match(convertAgent(md, 'gemini'), /"run_shell_command"/);
});
