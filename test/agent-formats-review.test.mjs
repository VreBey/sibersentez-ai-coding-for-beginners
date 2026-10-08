// The review's cases for converted agents (2026-10-07): removal takes the converted copies the record lists, a source
// that changed updates them, a copy the person changed is left alone, an unconvertible agent says so in the preview,
// characters TOML and YAML refuse are escaped, Turkish names make clean slugs. Run: node --test test/agent-formats-review.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertAgent, slugOf, parseAgent } from '../server/agentFormats.mjs';
import { planInstall, executeInstall, planRemove, executeRemove, readInstalls } from '../server/install.mjs';
import { RESTORE_SKIP_TOP } from '../server/restore.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sib-agents-review-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const agentText = (desc, body = 'Do the task.\n') => `---\nname: helper\ndescription: "${desc}"\n---\n\n${body}`;

function setup(name) {
  const root = path.join(ROOT, name);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'registry'), { recursive: true });
  const src = path.join(root, 'lib', 'helper.md');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, agentText('Helps.'));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const library = [{ kind: 'agent', name: 'helper', path: src, rel: 'agents/helper.md' }];
  return { hub, src, dir, library, project: { id: name }, items: [{ kind: 'agent', name: 'helper' }] };
}
const install = (w, targets, installs = readInstalls(w.hub).installs) => {
  const plan = planInstall({ project: w.project, dir: w.dir, items: w.items, targets, library: w.library, installs, kit: null });
  executeInstall({ plan, project: w.project, hubDir: w.hub, installs });
  return plan;
};

test("removing an agent from the page (target claude) takes the converted copies a job installed too", () => {
  const w = setup('remove');
  install(w, ['agents', 'codex', 'gemini']);
  const rec = readInstalls(w.hub).installs;
  const rm = planRemove({ project: w.project, dir: w.dir, items: w.items, targets: ['claude'], installs: rec });
  assert.deepEqual(rm.map((e) => `${e.target}:${e.op}`).sort(), ['claude:remove', 'codex:remove', 'gemini:remove']);
  executeRemove({ plan: rm, hubDir: w.hub, installs: rec });
  for (const f of ['.claude/agents/helper.md', '.codex/agents/helper.toml', '.gemini/agents/helper.md']) assert.equal(fs.existsSync(path.join(w.dir, f)), false, f);
  assert.equal(readInstalls(w.hub).installs.length, 0);
});

test("a changed source updates the converted copy; a copy the person changed is left alone", () => {
  const w = setup('update');
  install(w, ['codex']);
  fs.writeFileSync(w.src, agentText('Helps more.'));
  const plan = install(w, ['codex']);
  assert.deepEqual(plan.map((e) => `${e.target}:${e.op}:${e.reason}`), ['claude:update:library-changed', 'codex:update:library-changed']);
  assert.match(fs.readFileSync(path.join(w.dir, '.codex', 'agents', 'helper.toml'), 'utf8'), /Helps more\./);
  fs.appendFileSync(path.join(w.dir, '.codex', 'agents', 'helper.toml'), '# mine\n');
  fs.writeFileSync(w.src, agentText('Helps even more.'));
  const after2 = planInstall({ project: w.project, dir: w.dir, items: w.items, targets: ['codex'], library: w.library, installs: readInstalls(w.hub).installs, kit: null });
  assert.equal(after2.find((e) => e.target === 'codex').reason, 'modified');
});

test('an agent that cannot be converted says so in the preview, and no folder is made for it', () => {
  const w = setup('bad');
  fs.writeFileSync(w.src, 'no frontmatter at all');
  const plan = planInstall({ project: w.project, dir: w.dir, items: w.items, targets: ['gemini'], library: w.library, installs: [], kit: null });
  const g = plan.find((e) => e.target === 'gemini');
  assert.equal(g.op, 'skip');
  assert.equal(g.reason, 'not-convertible');
  executeInstall({ plan, project: w.project, hubDir: w.hub, installs: [] });
  assert.equal(fs.existsSync(path.join(w.dir, '.gemini')), false);
});

test('DEL and the C1 controls escaped (TOML and YAML refuse them raw); a plain value loses its comment; Turkish letters make clean slugs; an empty body gets the description', () => {
  const desc = 'Odd \u007f and \u0085 here, """ too';
  const toml = convertAgent(agentText(desc), 'codex');
  assert.equal(/[\u007f-\u009f]/.test(toml), false);
  assert.match(toml, /\\u007f/);
  const line = toml.split('\n').find((l) => l.startsWith('description = '));
  assert.equal(JSON.parse(line.slice('description = '.length)), desc);
  assert.equal(/[\u007f-\u009f]/.test(convertAgent(agentText(desc), 'gemini')), false);
  assert.equal(parseAgent('---\nname: helper # the helper\ndescription: x\n---\nb').name, 'helper');
  assert.equal(slugOf('Kod-Denetçi'), 'kod-denetci');
  assert.equal(slugOf('İş Ağacı Şefi'), 'is-agaci-sefi');
  const empty = convertAgent('---\nname: e\ndescription: "Does e."\n---\n', 'codex');
  assert.match(empty, /^developer_instructions = "Does e\."$/m);
});

test("going back to a restore point leaves the AI tools' folders alone (their agents are SiberSentez's copies)", () => {
  for (const d of ['.claude', '.agents', '.gemini', '.qwen', '.opencode', '.codex']) assert.ok(RESTORE_SKIP_TOP.has(d), d);
});
