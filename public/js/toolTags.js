// Which AI tools see a project or a roster item (docs/tool-view.md). The server tags every project with the adapters
// that found it (`via`) and every roster item with the adapters that read it (`tools`); the snapshot's `tools` names
// the adapters and says which are present. Pure helpers here; the views draw the tags and the filter with them.
import { esc } from './format.js';

// Short labels for the tags; a new adapter falls back to its own name
const SHORT = Object.freeze({ 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini', copilot: 'Copilot', cursor: 'Cursor', antigravity: 'Antigravity' });
// One fixed hue per adapter (no logos): the tags and the filter keep the same color everywhere
const HUE = Object.freeze({ 'claude-code': '#e08a5e', codex: '#5fbf9a', 'gemini-cli': '#6f9cf0', copilot: '#b38cf0', cursor: '#c8ccd6', antigravity: '#e6c35c' });
// The start-with-AI tools (views/tools.js TOOL_INFO) and the adapter that reads the same tool's traces
export const ADAPTER_OF_TOOL = Object.freeze({ claude: 'claude-code', codex: 'codex', gemini: 'gemini-cli', copilot: 'copilot', cursor: 'cursor' });

export const toolIdsOf = (x) => (Array.isArray(x?.via) ? x.via : Array.isArray(x?.tools) ? x.tools : []);
export const toolShort = (id, tools = []) => SHORT[id] || tools.find((x) => x.id === id)?.name || id;
export const toolHue = (id) => HUE[id] || '#9aa4b8';

// Tags and the filter mean something only when more than one tool left traces on this computer: with one tool every
// card would carry the same tag
export function multiTool(tools = [], items = []) {
  const seen = new Set();
  for (const x of tools) if (x.projects || x.skills || x.agents || x.plugins) seen.add(x.id);
  for (const it of items) for (const id of toolIdsOf(it)) seen.add(id);
  return seen.size > 1;
}

// The filter's choices: every tool that tags at least one of the items, the most items first
export function toolOptions(items = [], tools = []) {
  const counts = new Map();
  for (const it of items) for (const id of new Set(toolIdsOf(it))) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts]
    .map(([id, count]) => ({ id, name: tools.find((x) => x.id === id)?.name || toolShort(id), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// 'all' (or nothing) keeps every item; a tool id keeps the items it tags
export const matchesTool = (item, tool) => !tool || tool === 'all' || toolIdsOf(item).includes(tool);

export function toolTagsHtml(ids = [], tools = [], { max = 3 } = {}) {
  const list = [...new Set(ids)];
  if (!list.length) return '';
  const names = list.map((id) => tools.find((x) => x.id === id)?.name || toolShort(id));
  const tags = list
    .slice(0, max)
    .map((id) => `<span class="tool-tag" style="--c:${toolHue(id)}" translate="no">${esc(toolShort(id, tools))}</span>`)
    .join('');
  const more = list.length > max ? `<span class="tool-tag more">+${list.length - max}</span>` : '';
  return `<span class="tool-tags" title="${esc(names.join(', '))}">${tags}${more}</span>`;
}

// The <option>s of a tool filter <select>: "All tools", then one per tool with its count
export function toolSelectHtml(options, value, allLabel) {
  const v = options.some((o) => o.id === value) ? value : 'all';
  return `<option value="all"${v === 'all' ? ' selected' : ''}>${esc(allLabel)}</option>${options
    .map((o) => `<option value="${esc(o.id)}"${o.id === v ? ' selected' : ''}>${esc(`${o.name} (${o.count})`)}</option>`)
    .join('')}`;
}
