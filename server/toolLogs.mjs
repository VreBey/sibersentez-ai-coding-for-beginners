// Other AI tools' own session logs (2026-10-07): Codex CLI and Gemini CLI write a log per session on this computer,
// as Claude Code does in ~/.claude/projects. server/ingest.mjs reads them with the same session model, so their
// sessions, prompts, model, tokens, tool calls and permission mode show up like Claude Code's. This module holds the
// pure parts (tested in node): which files are logs, and what one record means. Formats, checked on this computer's
// own logs and the installed packages (Codex CLI 0.153-0.160, Gemini CLI 0.61):
//   Codex  <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl, appended. Each line
//          { timestamp, type, payload }: session_meta (id, cwd, cli_version, source), turn_context (model,
//          approval_policy, sandbox_policy), response_item (message with a role; function_call, custom_tool_call,
//          local_shell_call, web_search_call), event_msg (token_count with cumulative total_token_usage,
//          task_started, task_complete).
//   Gemini ~/.gemini/tmp/<project>/chats/session-*.jsonl, appended (0.61: a metadata line { sessionId, startTime,
//          kind }, then message records { id, timestamp, type: user | gemini | info | error, content, model,
//          tokens, toolCalls } where the same id may be written again with more in it, { $set } metadata updates
//          that may hold the whole messages list, { $rewindTo }); older versions wrote one session-*.json file.
//          The project folder: <project>/.project_root, else ~/.gemini/projects.json (path -> project name).
// Only what the app shows is kept (the same as for Claude Code): the person's prompts cut short and redacted by the
// ingest, never the AI's answers or the files it read.
import path from 'node:path';

export const FOREIGN_TOOLS = Object.freeze(['codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cursor']);

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Which tool's log a file is, or null. dirs: { codex, gemini } (the sessions folder of each)
export function classifyForeign(abs, dirs = {}) {
  const name = path.basename(abs);
  if (dirs.codex) {
    const rel = path.relative(dirs.codex, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && /^rollout-.+\.jsonl$/.test(name)) {
      return { kind: 'foreign', tool: 'codex', sessionId: UUID_RE.exec(name)?.[1]?.toLowerCase() || null };
    }
  }
  if (dirs.copilot) {
    const rel = path.relative(dirs.copilot, abs);
    const parts = rel.split(path.sep);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 2 && name === 'events.jsonl' && /^[0-9a-f-]{36}$/i.test(parts[0])) {
      return { kind: 'foreign', tool: 'copilot', sessionId: parts[0].toLowerCase() };
    }
  }
  if (dirs.cursor) {
    const rel = path.relative(dirs.cursor, abs);
    const parts = rel.split(path.sep);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 5 && parts[0] === 'projects' && parts[2] === 'agent-transcripts' && /^[0-9a-f-]{36}$/i.test(parts[3]) && name === `${parts[3]}.jsonl`) {
      return { kind: 'foreign', tool: 'cursor', sessionId: parts[3].toLowerCase() };
    }
  }
  if (dirs.qwen) {
    const rel = path.relative(dirs.qwen, abs);
    const parts = rel.split(path.sep);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 3 && parts[1] === 'chats' && /^[0-9a-f-]{32,36}\.jsonl$/i.test(name)) {
      return { kind: 'foreign', tool: 'qwen' };
    }
  }
  if (dirs.gemini) {
    const rel = path.relative(dirs.gemini, abs);
    const parts = rel.split(path.sep);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 3 && parts[1] === 'chats' && /^session-.+\.jsonl?$/.test(name)) {
      return { kind: 'foreign', tool: 'gemini', slug: parts[0], whole: name.endsWith('.json') };
    }
  }
  return null;
}

// The text a person typed, from a Codex user message's parts. Codex puts its own context into user messages too:
// "# AGENTS.md instructions ...", <environment_context>, <recommended_plugins>, <user_instructions> and the like are
// left out. Its tags are snake_case words; a part the person starts with HTML (<div>, <html>) stays (review).
const CODEX_CONTEXT_RE = /^<\/?[a-z]+(?:_[a-z]+)+\b[^>]*>/;
export function codexPromptText(payload) {
  if (!payload || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return '';
  return payload.content
    .filter((p) => p && typeof p.text === 'string' && (p.type === 'input_text' || p.type === 'text'))
    .map((p) => p.text)
    .filter((x) => {
      const s = x.trimStart();
      return s && !CODEX_CONTEXT_RE.test(s) && !/^#\s*AGENTS\.md instructions/i.test(s);
    })
    .join('\n')
    .trim();
}

// Codex's approval and sandbox policies in the words the page already has for Claude Code's permission modes
// (public/js/permMode.js): never asks and no sandbox: bypassPermissions; never asks: dontAsk (what is not allowed
// fails); read-only or untrusted: default (it asks); its own folder writable: acceptEdits; everything writable:
// auto. null: not known.
export function codexPermission(approval, sandbox) {
  const a = typeof approval === 'string' ? approval : null;
  const s = typeof sandbox === 'string' ? sandbox : typeof sandbox?.type === 'string' ? sandbox.type : typeof sandbox?.mode === 'string' ? sandbox.mode : null;
  if (!a && !s) return null;
  if (a === 'never') return s === 'danger-full-access' ? 'bypassPermissions' : 'dontAsk';
  if (a === 'untrusted' || s === 'read-only') return 'default';
  if (s === 'workspace-write') return 'acceptEdits';
  if (s === 'danger-full-access') return 'auto';
  return 'default';
}

// Each tool's names for what Claude Code calls Bash, Edit, Read...: the category (ingest toolCategory) and the
// one-line description (actionText) come from Claude Code's name; the session keeps the tool's own name
const CODEX_NAMES = Object.freeze({ exec: 'Bash', shell: 'Bash', exec_command: 'Bash', local_shell: 'Bash', apply_patch: 'Edit', update_plan: 'TodoWrite', web_search: 'WebSearch', view_image: 'Read' });
const GEMINI_NAMES = Object.freeze({ run_shell_command: 'Bash', replace: 'Edit', edit: 'Edit', write_file: 'Write', read_file: 'Read', read_many_files: 'Read', list_directory: 'Glob', glob: 'Glob', search_file_content: 'Grep', grep: 'Grep', web_fetch: 'WebFetch', google_web_search: 'WebSearch', write_todos: 'TodoWrite', save_memory: 'Write', exit_plan_mode: 'ExitPlanMode' });

function inputOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : { command: raw };
  } catch {
    return { command: raw };
  }
}

// A command as Claude Code's Bash input has it ({ command }), from what each tool passes
function asBash(input) {
  const c = input.command ?? input.cmd ?? input.script;
  return { command: Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '' };
}

// A Codex tool call: { id, raw, mapped, input } or null (not a call)
export function codexToolCall(payload) {
  if (!payload || typeof payload.type !== 'string') return null;
  const id = payload.call_id || payload.id || null;
  if (payload.type === 'local_shell_call') return { id, raw: 'shell', mapped: 'Bash', input: asBash(payload.action || {}) };
  if (payload.type === 'web_search_call') return { id, raw: 'web_search', mapped: 'WebSearch', input: { query: payload.action?.query || '' } };
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null;
  const raw = typeof payload.name === 'string' && payload.name ? payload.name.slice(0, 60) : 'tool';
  const mapped = CODEX_NAMES[raw] || raw;
  const input = inputOf(payload.type === 'custom_tool_call' ? payload.input : payload.arguments);
  return { id, raw, mapped, input: mapped === 'Bash' ? asBash(input) : input };
}

// A Gemini tool call of a message: { id, raw, mapped, input } or null
export function geminiToolCall(tc) {
  if (!tc || typeof tc.name !== 'string' || !tc.name) return null;
  const raw = tc.name.slice(0, 60);
  const mapped = GEMINI_NAMES[raw] || raw;
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const input = mapped === 'Bash' ? asBash(args) : { ...args, file_path: args.file_path ?? args.absolute_path ?? args.path };
  return { id: typeof tc.id === 'string' ? tc.id : null, raw, mapped, input };
}

// The text of a Gemini user message (a string or parts); its own setup text (<session_context>) is left out
export function geminiPromptText(content) {
  const text = Array.isArray(content) ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : typeof content === 'string' ? content : '';
  const s = text.trim();
  return s && !s.startsWith('<session_context>') ? s : '';
}

// GitHub Copilot CLI (1.0.92, checked on two sessions run here 2026-10-07): <COPILOT_HOME or ~/.copilot>/session-state/
// <uuid>/events.jsonl, appended, one event a line { type, data, id, timestamp }: session.start (data.sessionId,
// copilotVersion, context.cwd), session.model_change (newModel), user.message (content: what the person typed),
// assistant.message (model, toolRequests), tool.execution_start (toolCallId, toolName, arguments), session.shutdown
// (tokenDetails { input, cache_read, cache_write, output } { tokenCount }: input without the cached part, as Claude's).
// A VS Code Copilot chat keeps a folder there too, without events.jsonl.
const COPILOT_NAMES = Object.freeze({ view: 'Read', read: 'Read', edit: 'Edit', str_replace: 'Edit', create: 'Write', write: 'Write', powershell: 'Bash', bash: 'Bash', shell: 'Bash', grep: 'Grep', glob: 'Glob', web_fetch: 'WebFetch', fetch: 'WebFetch', task: 'Agent' });
export function copilotToolCall(data) {
  if (!data || typeof data.toolName !== 'string' || !data.toolName) return null;
  const raw = data.toolName.slice(0, 60);
  const mapped = COPILOT_NAMES[raw] || raw;
  const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
  const input = mapped === 'Bash' ? asBash(args) : { ...args, file_path: args.file_path ?? args.path };
  return { id: typeof data.toolCallId === 'string' ? data.toolCallId : null, raw, mapped, input };
}
export function copilotTokens(details) {
  const n = (k) => Number(details?.[k]?.tokenCount) || 0;
  return details && typeof details === 'object' ? { input: n('input'), cacheRead: n('cache_read'), cacheWrite: n('cache_write'), output: n('output') } : null;
}

// Cursor CLI (2026.10.01, checked on a session run here 2026-10-07): ~/.cursor/projects/<folder>/agent-transcripts/
// <uuid>/<uuid>.jsonl, appended, one line a message { role, message: { content: [{ type: 'text', text }] } } and
// { type: 'turn_ended' }; no time, model or folder on the lines. Those are in ~/.cursor/chats/<hash>/<uuid>/meta.json
// { cwd, createdAtMs, updatedAtMs }. The person's words are inside <user_query> after Cursor's <timestamp>.
export function cursorPromptText(o) {
  if (o?.role !== 'user' || !Array.isArray(o.message?.content)) return '';
  const text = o.message.content.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  return (q ? q[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')).trim();
}
const CURSOR_NAMES = Object.freeze({ shell: 'Bash', run_terminal_cmd: 'Bash', read_file: 'Read', read: 'Read', edit_file: 'Edit', edit: 'Edit', write: 'Write', grep: 'Grep', glob: 'Glob', list_dir: 'Glob', web_search: 'WebSearch' });
// A tool call in an assistant message (the shape Claude Code's messages have; not yet seen in a local Cursor session)
export function cursorToolCalls(o) {
  if (o?.role !== 'assistant' || !Array.isArray(o.message?.content)) return [];
  return o.message.content
    .filter((p) => p && (p.type === 'tool_use' || p.type === 'tool-call') && typeof (p.name || p.toolName) === 'string')
    .map((p) => {
      const raw = String(p.name || p.toolName).slice(0, 60);
      const mapped = CURSOR_NAMES[raw] || raw;
      const args = p.input && typeof p.input === 'object' ? p.input : p.args && typeof p.args === 'object' ? p.args : {};
      return { id: typeof p.id === 'string' ? p.id : null, raw, mapped, input: mapped === 'Bash' ? asBash(args) : { ...args, file_path: args.file_path ?? args.path ?? args.target_file } };
    });
}

// OpenCode (1.18.35, checked on a session run here 2026-10-07): one SQLite database, <XDG_DATA_HOME or ~/.local/share>/
// opencode/opencode.db, read read-only (node:sqlite). Tables: session (id ses_..., directory, title, version, model,
// tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, time_created, time_updated, parent_id), message
// (session_id, time_created, time_updated, data: { role, modelID, providerID, tokens { input, output, reasoning,
// cache { read, write } } }), part (message_id, session_id, data: { type: text | tool | ..., text, synthetic }). A tool
// part's fields (tool, callID, state.input) are OpenCode's documented shape, not yet seen in a local session.
export function opencodeText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join('\n')
    .trim();
}
const OPENCODE_NAMES = Object.freeze({ bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit', grep: 'Grep', glob: 'Glob', list: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Agent', todowrite: 'TodoWrite' });
export function opencodeToolCall(part) {
  if (!part || part.type !== 'tool' || typeof part.tool !== 'string' || !part.tool) return null;
  const raw = part.tool.slice(0, 60);
  const mapped = OPENCODE_NAMES[raw] || raw;
  const args = part.state?.input && typeof part.state.input === 'object' ? part.state.input : {};
  const input = mapped === 'Bash' ? asBash(args) : { ...args, file_path: args.file_path ?? args.filePath ?? args.path };
  return { id: typeof part.callID === 'string' ? part.callID : null, raw, mapped, input };
}
// A message's tokens as the ledger counts them: OpenCode keeps the cached input apart already, and reasoning apart
// from the output
export function opencodeTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const n = (v) => Number(v) || 0;
  return { input: n(t.input), cacheRead: n(t.cache?.read), output: n(t.output) + n(t.reasoning) };
}

// Qwen Code (0.25, its package's ChatRecordingService): ~/.qwen/projects/<project>/chats/<session>.jsonl, appended,
// one record a line { uuid, sessionId, timestamp, type: user | assistant | tool_result | system, provenance, cwd,
// version, gitBranch, model, message: { parts: [{ text } | { functionCall: { id, name, args } }] }, usageMetadata
// (Gemini's: promptTokenCount, candidatesTokenCount, thoughtsTokenCount) }. Its tools have Gemini CLI's names.
// The person's words: what they typed (systemPayload.displayText) before Qwen added the files they @-referenced and its
// hooks' context to the parts; a record without provenance (older Qwen) counts as the person's only as Qwen's own
// legacy rule has it (no subtype, or a message typed mid-turn) (review 2026-10-07)
export function qwenPromptText(o) {
  if (o?.type !== 'user') return '';
  if (o.provenance ? o.provenance !== 'real_user' : o.subtype !== undefined && o.subtype !== 'mid_turn_user_message') return '';
  if (typeof o.systemPayload?.displayText === 'string') return o.systemPayload.displayText.trim();
  const parts = Array.isArray(o.message?.parts) ? o.message.parts : [];
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}
export function qwenToolCalls(o) {
  if (o?.type !== 'assistant' || !Array.isArray(o.message?.parts)) return [];
  return o.message.parts.map((p) => (p?.functionCall ? geminiToolCall({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args }) : null)).filter(Boolean);
}
// Qwen's output tokens of a record: total minus prompt, right whether its provider counts thinking inside the
// completion (OpenAI's way, which Qwen converts: candidates = completion, thoughts = reasoning within it) or apart
// (Gemini's); without a total, the candidates alone. Never candidates + thoughts (review 2026-10-07: counted twice)
export function qwenOutTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  const total = Number(u.totalTokenCount) || 0;
  const prompt = Number(u.promptTokenCount) || 0;
  return total > prompt ? total - prompt : Number(u.candidatesTokenCount) || 0;
}

// The output tokens a Gemini message counts (candidates and thoughts), 0 when it has none
export const geminiOutTokens = (tokens) => (tokens && typeof tokens === 'object' ? (Number(tokens.output) || 0) + (Number(tokens.thoughts) || 0) : 0);
// Codex's cumulative output tokens of a session from a token_count event, or null. reasoning_output_tokens is a part
// of output_tokens, not added to it (checked on this computer's 3744 records: never more than the output; review
// 2026-10-07)
export function codexTotalOut(payload) {
  const u = payload?.info?.total_token_usage;
  return u ? Number(u.output_tokens) || 0 : null;
}
// Codex's context size at its last request (input tokens), or null
export function codexContext(payload) {
  const u = payload?.info?.last_token_usage;
  return u ? Number(u.input_tokens) || 0 : null;
}
