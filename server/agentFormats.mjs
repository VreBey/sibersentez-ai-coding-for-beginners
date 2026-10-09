// @ts-check
// An agent (sub-agent) written for Claude Code, in the shape another AI tool loads (2026-10-07). The kit's and the
// library's agents are Markdown with YAML frontmatter (name, description, tools in Claude Code's names, license,
// metadata). Copilot CLI and Cursor CLI read .claude/agents as they are; the others need their own file, each checked
// in the installed tool:
//   gemini   <p>/.gemini/agents/<name>.md    Gemini CLI 0.61: a strict schema (unknown keys such as license or
//            metadata make the agent fail to load); name a slug, description; the body is its prompt
//   qwen     <p>/.qwen/agents/<name>.md      Qwen Code 0.25: name, description; the body is its prompt
//   opencode <p>/.opencode/agents/<name>.md  OpenCode 1.18: description, mode subagent (tools is a map there, not
//            Claude Code's list: left out, the tool's defaults apply)
//   codex    <p>/.codex/agents/<name>.toml   Codex CLI 0.160: name, description, developer_instructions (it says it
//            "must define developer_instructions")
// Tools are left out everywhere: each tool names its own and a wrong name stops the agent from loading. The comment
// lines of the frontmatter (the kit's license notice, which asks to be kept) are kept. Pure.

export const AGENT_FORMATS = Object.freeze(['gemini', 'qwen', 'opencode', 'codex']);
// Raised whenever convertAgent writes another text for the same source: installed copies are then updated
// (install.mjs keeps it with the source's hash)
export const AGENT_FORMAT_VERSION = 2;
export const agentFileName = (name, format) => `${name}${format === 'codex' ? '.toml' : '.md'}`;

// { name, description, comments: [lines], body } of a Markdown agent, or null when it has no frontmatter
export function parseAgent(text) {
  const s = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s);
  if (!m) return null;
  const out = { name: '', description: '', comments: [], body: m[2] };
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#/.test(l)) {
      out.comments.push(l);
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
  if (format === 'codex') return `${note.join('\n')}\nname = ${q(slug)}\ndescription = ${q(description)}\ndeveloper_instructions = ${q(body.trim())}\n`;
  const fields = format === 'opencode' ? [`description: ${q(description)}`, 'mode: subagent'] : [`name: ${q(slug)}`, `description: ${q(description)}`];
  return `---\n${note.join('\n')}\n${fields.join('\n')}\n---\n\n${body}`;
}
