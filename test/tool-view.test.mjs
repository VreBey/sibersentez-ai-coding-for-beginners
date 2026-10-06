// Tool view (docs/tool-view.md): which AI tools see a project or a roster item, the tool filter, the tools panel's
// counts, and the server keeping the page's `tools` fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { multiTool, toolOptions, matchesTool, toolTagsHtml, toolSelectHtml, toolIdsOf, ADAPTER_OF_TOOL } from '../public/js/toolTags.js';
import { matchesFilter } from '../public/js/rosterModel.js';
import { toolsPanelHtml, TOOL_ORDER } from '../public/js/views/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = [
  { id: 'claude-code', name: 'Claude Code', detected: true, projects: 3, skills: 12, agents: 4, plugins: 1 },
  { id: 'codex', name: 'Codex', detected: true, projects: 1, skills: 2, agents: 0, plugins: 0 },
  { id: 'gemini-cli', name: 'Gemini CLI', detected: false, projects: 0, skills: 0, agents: 0, plugins: 0 },
];
const P = (id, via) => ({ id, name: id, via });

test('one tool on this computer: no tags, no filter; two: both', () => {
  const one = [{ ...TOOLS[0] }, { ...TOOLS[1], projects: 0, skills: 0 }];
  assert.equal(multiTool(one, [P('a', ['claude-code']), P('b', ['claude-code'])]), false);
  assert.equal(multiTool(TOOLS, []), true, 'the counts alone say two tools left traces');
  assert.equal(multiTool([], [P('a', ['claude-code']), P('b', ['codex'])]), true, 'or the items do');
});

test('filter choices: tools that tag at least one item, the most first; all keeps everything', () => {
  const projects = [P('a', ['claude-code']), P('b', ['claude-code', 'codex']), P('c', ['claude-code']), P('d', [])];
  assert.deepEqual(toolOptions(projects, TOOLS), [
    { id: 'claude-code', name: 'Claude Code', count: 3 },
    { id: 'codex', name: 'Codex', count: 1 },
  ]);
  assert.deepEqual(projects.filter((p) => matchesTool(p, 'codex')).map((p) => p.id), ['b']);
  assert.equal(projects.filter((p) => matchesTool(p, 'all')).length, 4);
  assert.deepEqual(toolIdsOf({ tools: ['codex'] }), ['codex'], 'roster items carry tools');
  assert.deepEqual(toolIdsOf({}), []);
  const html = toolSelectHtml(toolOptions(projects, TOOLS), 'gone-tool', 'All AI tools');
  assert.match(html, /^<option value="all" selected>All AI tools<\/option>/, 'a choice that is gone falls back to all');
  assert.match(html, /<option value="codex">Codex \(1\)<\/option>/);
});

test('the roster filter keeps the items a tool reads', () => {
  const skill = { kind: 'skill', name: 's', tools: ['codex'] };
  assert.equal(matchesFilter(skill, { tool: 'codex' }), true);
  assert.equal(matchesFilter(skill, { tool: 'claude-code' }), false);
  assert.equal(matchesFilter(skill, { tool: 'all' }), true);
  assert.equal(matchesFilter({ kind: 'skill', name: 'x' }, { tool: 'codex' }), false, 'an item without tools');
});

test('tags: short names, at most three and a "+N", every name in the title, names escaped', () => {
  const html = toolTagsHtml(['claude-code', 'codex', 'gemini-cli', 'copilot'], TOOLS);
  assert.equal((html.match(/class="tool-tag"/g) || []).length, 3);
  assert.match(html, />Claude</);
  assert.match(html, /\+1</);
  assert.match(html, /title="Claude Code, Codex, Gemini CLI, Copilot"/);
  assert.equal(toolTagsHtml([], TOOLS), '');
  assert.doesNotMatch(toolTagsHtml(['<x>'], [{ id: '<x>', name: '<b>' }]), /<b>|<x>/);
});

test('the tools panel says what each installed tool sees here', () => {
  const st = { status: 'ready', at: Date.now(), tools: [{ id: 'claude', installed: true, version: '2.1', via: 'native', installs: 1, others: [], ready: 'yes', onPath: true }, { id: 'gemini', installed: true, via: 'npm', installs: 1, others: [], ready: 'unknown', onPath: true }], node: null };
  const html = toolsPanelHtml(st, Date.now(), TOOLS);
  const card = (id) => html.slice(html.indexOf(`data-ai-tool="${id}"`), html.indexOf('</li>', html.indexOf(`data-ai-tool="${id}"`)));
  assert.match(card('claude'), /ai-seen">[^<]*3[^<]*12[^<]*4/);
  assert.match(card('gemini'), /ai-seen muted/, 'installed, nothing found yet');
  assert.doesNotMatch(card('copilot'), /ai-seen/, 'not installed and no traces: no line');
  assert.match(card('codex'), /ai-seen">[^<]*1[^<]*2/, 'not installed but it left traces');
  for (const id of TOOL_ORDER) if (ADAPTER_OF_TOOL[id]) assert.ok(typeof ADAPTER_OF_TOOL[id] === 'string');
});

test('wiring: the minute broadcast carries tools; the store keeps them; both tabs have the filter', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  assert.match(read('server', 'index.mjs'), /JSON\.stringify\(\{ hub: hubView\(catalog\), tools: toolsView\(catalog\), roster:/);
  const storeSrc = read('public', 'js', 'store.js');
  assert.ok(storeSrc.includes('this.tools = Array.isArray(s.tools) ? s.tools : [];'));
  assert.ok(storeSrc.includes('if (Array.isArray(r.tools)) this.tools = r.tools;'));
  for (const view of ['projects.js', 'roster.js']) assert.ok(read('public', 'js', 'views', view).includes('data-k="tool"'), view);
  assert.ok(read('public', 'index.html').includes('<link rel="stylesheet" href="/css/tool-view.css">'));
});
