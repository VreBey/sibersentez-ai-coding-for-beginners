// @ts-check
// An agent (sub-agent) written for Claude Code, in the shape another AI tool loads (2026-10-07). The kit's and the
// library's agents are Markdown with YAML frontmatter (name, description, tools in Claude Code's names, license,
// metadata). Copilot CLI and Cursor CLI read .claude/agents as they are; the others need their own file, each checked
// in the installed tool:
//   gemini   <p>/.gemini/agents/<name>.md    Gemini CLI 0.61: a strict schema (unknown keys such as license or
//            metadata make the agent fail to load); name a slug, description; the body is its prompt
//   qwen     <p>/.qwen/agents/<name>.md      Qwen Code 0.25: name, description, tools in its own names; the body is
//            its prompt
//   opencode <p>/.opencode/agents/<name>.md  OpenCode 1.18: description, mode subagent (tools is a map there, not
//            Claude Code's list: left out, the tool's defaults apply)
//   codex    <p>/.codex/agents/<name>.toml   Codex CLI 0.160: name, description, developer_instructions (it says it
//            "must define developer_instructions"); sandbox_mode "read-only" when the agent can neither change files nor run commands
// Tools are left out elsewhere (each tool names its own and a wrong name stops the agent from loading); Gemini CLI and
// Qwen Code get the list in their own names (GEMINI_TOOLS, QWEN_TOOLS), OpenCode a denied edit, bash or web permission for
// what the tools leave out, Codex a read-only sandbox for an agent that only reads; conversionReport says before an
// install what carries over, what is left out and what a role may do there beyond its list. The comment
// lines of the frontmatter (the kit's license notice, which asks to be kept) are kept. Pure.

export const AGENT_FORMATS = Object.freeze(['gemini', 'qwen', 'opencode', 'codex']);
// Raised whenever convertAgent writes another text for the same source: installed copies are then updated
// (install.mjs keeps it with the source's hash)
export const AGENT_FORMAT_VERSION = 7;
// A Claude Code tool by its bare name in lower case: a permission rule such as Bash(git:*) is the Bash tool
const toolKey = (t) => String(t).replace(/\(.*$/, '').trim().toLowerCase();
// Claude Code tools by their Gemini CLI names (the *_TOOL_NAME constants of Gemini CLI 0.63.0, whose agent schema takes
// a tools list of valid names; read in the installed package, 2026-10-09)
const GEMINI_TOOLS = Object.freeze({
  read: ['read_file', 'read_many_files'],
  grep: ['grep_search'],
  glob: ['glob', 'list_directory'],
  ls: ['list_directory'],
  edit: ['replace'],
  multiedit: ['replace'],
  write: ['write_file'],
  bash: ['run_shell_command'],
  powershell: ['run_shell_command'],
  webfetch: ['web_fetch'],
  websearch: ['google_web_search'],
});
// Claude Code tools by their Qwen Code names (ToolNames of Qwen Code 0.25.0, read in the installed package,
// 2026-10-09). Its loader matches a subagent's tools by a tool's name or display name only (resolveToolNames): Read,
// Write and Bash match neither (ReadFile, WriteFile, Shell) and would be names of no tool, so the agent would lose them
const QWEN_TOOLS = Object.freeze({
  read: ['read_file'],
  grep: ['grep_search'],
  glob: ['glob', 'list_directory'],
  ls: ['list_directory'],
  edit: ['edit'],
  multiedit: ['edit'],
  write: ['write_file'],
  notebookedit: ['notebook_edit'],
  bash: ['run_shell_command'],
  powershell: ['run_shell_command'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
  todowrite: ['todo_write'],
  task: ['agent'],
  skill: ['skill'],
});
// The agent's tool limit in that tool's names (GEMINI_TOOLS or QWEN_TOOLS), or null (no tools line, or no tool it has a
// name for: then no list and the tool's defaults apply; conversionReport says so). A tool it has no name for (an MCP
// tool, TodoWrite in Gemini) is left out: the role does without it, never with more than its list (independent review
// of 0.19.0 §7.4; before, one such tool dropped the whole list and the role got every default tool)
function toolNamesIn(map, tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) for (const n of map[toolKey(t)] || []) if (!out.includes(n)) out.push(n);
  return out.length ? out : null;
}
// Claude Code tools that change files or run commands (lower case): an agent with none of them is read-only
const ACTING_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'bash', 'powershell']);
// What a role may do, by kind (lower-case Claude Code names): change files, run commands, reach the web
const CAPS = Object.freeze({ edit: ['edit', 'write', 'multiedit', 'notebookedit'], shell: ['bash', 'powershell'], web: ['webfetch', 'websearch'] });
const capsOf = (tools) => Object.keys(CAPS).filter((c) => tools.some((t) => CAPS[c].includes(toolKey(t))));

// What carries over when an agent is written for that tool, before it is installed (independent review of 0.19.0 §7.4:
// a conversion is a lossy transfer of what a role may do; a file that loads is no proof it may do the same). Pure.
//   limits   'none'          the agent has no tools line: every tool there as here, nothing to carry
//            'kept'          its limits hold there (in that tool's names or permissions)
//            'defaults'      no tool of its list has a name there: the tool's defaults apply
//            'instructions'  the tool takes no tool list for a role (Codex outside its read-only sandbox): the limits
//                            are in the role's instructions only, the session's sandbox applies
//   wider    what the role may do there that its list does not give it: 'edit', 'shell', 'web'
//   left     tools of its list with no name there: the role does without them (never with more)
//   whole    permission rules such as Bash(git:*): the whole tool there, the narrower rule does not carry
//   readOnly Codex's read-only sandbox (it can run commands that read, never change files: wider holds 'shell')
export function conversionReport(text, format) {
  const a = parseAgent(text);
  if (!a || !AGENT_FORMATS.includes(format)) return null;
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const whole = tools.filter((t) => /\(/.test(String(t)));
  const out = { format, limits: 'kept', wider: /** @type {string[]} */ ([]), left: /** @type {string[]} */ ([]), whole, readOnly: false };
  if (!tools.length) return { ...out, limits: 'none' };
  const has = capsOf(tools);
  const lacking = Object.keys(CAPS).filter((c) => !has.includes(c));
  if (format === 'gemini' || format === 'qwen') {
    const map = format === 'gemini' ? GEMINI_TOOLS : QWEN_TOOLS;
    out.left = tools.filter((t) => !map[toolKey(t)]);
    if (!toolNamesIn(map, tools)) return { ...out, limits: 'defaults', wider: lacking };
    return out;
  }
  if (format === 'codex') {
    out.readOnly = !tools.some((t) => ACTING_TOOLS.has(toolKey(t)));
    // Outside the read-only sandbox a Codex role may change files and run commands whatever its list says; inside it a
    // role with no shell tool may still run commands that read (never change files)
    return out.readOnly ? { ...out, wider: ['shell'] } : { ...out, limits: 'instructions', wider: lacking.filter((c) => c !== 'web') };
  }
  // OpenCode: what the list leaves out of changing files, commands and the web is denied (convertAgent)
  return out;
}
export const agentFileName = (name, format) => `${name}${format === 'codex' ? '.toml' : '.md'}`;

// { name, description, comments: [lines], body } of a Markdown agent, or null when it has no frontmatter
export function parseAgent(text) {
  const s = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s);
  if (!m) return null;
  const out = { name: '', description: '', comments: [], body: m[2], tools: /** @type {string[] | null} */ (null) };
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#/.test(l)) {
      out.comments.push(l);
      continue;
    }
    // tools: a comma list on the line, or a YAML list below it; null when the line is missing (every tool)
    const tl = /^tools:\s*(.*)$/.exec(l);
    if (tl) {
      const inline = tl[1].replace(/\s+#.*$/, '').replace(/^\[|\]$/g, '').trim();
      const items = inline ? inline.split(',') : [];
      for (let j = i + 1; !inline && j < lines.length && /^\s+-\s*\S/.test(lines[j]); j++) items.push(lines[j].replace(/^\s+-\s*/, ''));
      out.tools = items.map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    const kv = /^(name|description):\s*(.*)$/.exec(l);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '' || /^[|>][-+]?$/.test(v)) {
      const parts = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
      v = parts.join(' ');
    } else if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.replace(/^"|"$/g, '');
      }
    } else if (v.startsWith("'")) v = v.replace(/^'|'$/g, '').replace(/''/g, "'");
    // A plain value ends where a comment begins (" # ...")
    else v = v.replace(/\s+#.*$/, '');
    out[kv[1]] = String(v).replace(/\s+/g, ' ').trim();
  }
  return out;
}

// A name as a slug every tool takes (Gemini: /^[a-z0-9-_]+$/), Turkish letters as their plain ones (kod-denetçi ->
// kod-denetci, never kod-denet-i)
// (İ lowercases to i with a combining dot, which NFKD then drops)
const TR = Object.freeze({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' });
export function slugOf(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[çğıöşü]/g, (c) => TR[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The agent's file text for that tool, or null (no frontmatter, no name, an unknown format). name: the item's name
// (the file's name), used when the frontmatter has none
export function convertAgent(text, format, name = '') {
  const a = parseAgent(text);
  if (!a || !AGENT_FORMATS.includes(format)) return null;
  const slug = slugOf(a.name || name);
  if (!slug) return null;
  const description = a.description || slug;
  // An agent without a body would have no prompt: its description stands in
  const body = a.body.replace(/^\n+/, '').trim() ? a.body.replace(/^\n+/, '') : `${description}\n`;
  const note = [...a.comments, `# Converted by SiberSentez for ${format} from the Claude Code agent "${slug}".`];
  // A JSON string is a valid YAML double-quoted string and a valid TOML basic string, once DEL and the C1 controls
  // (which JSON leaves raw and both refuse) are escaped too
  const q = (v) => JSON.stringify(v).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (format === 'codex') {
    // An agent that can neither change files nor run commands (a scout) gets Codex's read-only sandbox; any other keeps
    // the parent's: a command may need to write (a test's temp files) or reach localhost (a QA run starts the program)
    // (learn.chatgpt.com/docs/agent-configuration/subagents, 2026-10-09)
    const readOnly = Array.isArray(a.tools) && a.tools.length > 0 && !a.tools.some((t) => ACTING_TOOLS.has(toolKey(t)));
    return `${note.join('\n')}\nname = ${q(slug)}\ndescription = ${q(description)}\n${readOnly ? 'sandbox_mode = "read-only"\n' : ''}developer_instructions = ${q(body.trim())}\n`;
  }
  const fields = format === 'opencode' ? [`description: ${q(description)}`, 'mode: subagent'] : [`name: ${q(slug)}`, `description: ${q(description)}`];
  const named = format === 'gemini' ? toolNamesIn(GEMINI_TOOLS, a.tools) : format === 'qwen' ? toolNamesIn(QWEN_TOOLS, a.tools) : null;
  if (named) fields.push(`tools: [${named.map(q).join(', ')}]`);
  // OpenCode: what the Claude Code tools leave out is denied (OpenCode 1.18.35 reads permission.edit, .bash, .webfetch and
  // .websearch from the agent file: opencode agent list shows the rules, 2026-10-09 and 2026-10-16)
  if (format === 'opencode' && Array.isArray(a.tools) && a.tools.length) {
    const has = capsOf(a.tools);
    const deny = [...(has.includes('edit') ? [] : ['  edit: deny']), ...(has.includes('shell') ? [] : ['  bash: deny']), ...(has.includes('web') ? [] : ['  webfetch: deny', '  websearch: deny'])];
    if (deny.length) fields.push('permission:', ...deny);
  }
  return `---\n${note.join('\n')}\n${fields.join('\n')}\n---\n\n${body}`;
}
