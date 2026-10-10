// @ts-check
// The commands an AI ran for a job and how each ended, as its own log shows them (docs/internal/evidence-card-plan.md
// E3). Observed, never proof: an exit code says how a command line ended, not what it checked. Only Claude Code's log
// is read so far (checked in real 2.1.283-2.1.296 logs, 2026-10-10):
//   a Bash / PowerShell tool_result with is_error and a text starting "Exit code N"   ran, ended with code N
//   is_error saying it was interrupted                                                 stopped: no exit code
//   is_error with toolDenialKind, "<tool_use_error>", a worktree agent's               did not run (refused, blocked,
//   "Refusing to run it", a spawn error (EPERM, ENAMETOOLONG)                          or could not start)
//   any other is_error                                                                 no exit code (not known)
//   toolUseResult.interrupted                                                          stopped: no exit code
//   no is_error                                                                         ended without error (code 0, or
//                                                                                       one Claude Code reads as no
//                                                                                       error: "No matches found")
//   no is_error, run in the background (run_in_background, or toolUseResult.backgroundTaskId after a time-out): its
//   end comes later in a <task-notification> naming the same tool-use id ("completed (exit code N)", "failed with
//   exit code N", or killed / stopped), in a queue-operation line, a queued_command attachment or a user line; about
//   one in six never gets one
// Neither the command line nor any output leaves memory: a label made of the program's name (ingest.mjs programName)
// and, for a few well-known programs, a plain lower-case sub-command ("npm test"), whether more is on its line ("…"),
// and a hash of the whole line, kept in memory only, so "a later run ended without an error" is said of the very same
// line only (review E3: the same label is often another command: node with another script, npm test in another folder).
import crypto from 'node:crypto';
import { programName, programRest } from './ingestText.mjs';
import { redact } from './util.mjs';
import { OBSERVED_TOOLS } from './tools.mjs';

// Per session or agent; a resumed or forked session copies its calls into a new log, so the job's calls are counted
// once by their tool-use id across all its sessions
export const COMMANDS_MAX = 1000;
const FAILURES_SHOWN = 5;
// A background command whose end never came (no notification) stops being waited for after this long of its session
export const BG_WAIT_MAX_MS = 6 * 3600000;

// A leading "cd <folder> &&" (or ;) says where, not what: the label is the program after it
const LEADING_CD = /^(?:cd|pushd|set-location|push-location|sl)(?:\s+\/d)?\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/i;
// Programs whose sub-command says what ran (npm test, git status); the word must be plain lower case (no digit, no
// capital: not a token), the script after "run" a plain name too. npx: the package only (what follows is its own
// arguments). Not python and the like: their first argument is a file or a value
const WITH_SUB = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'deno', 'cargo', 'go', 'dotnet', 'git', 'uv', 'poetry', 'make', 'docker', 'flutter', 'gradle', 'mvn']);
const SUB_WORD = /^[a-z][a-z-]{0,19}$/;
const SCRIPT_WORD = /^[a-z][a-z:._-]{0,29}$/;

// What joins the commands of a line at the top level (outside quotes): 'none' (one command), 'and' (only &&: the line
// ends without error only when every part did) or 'other' (; || | & or a new line: the exit code is that of a part).
// A redirection's & (2>&1, &>) is no join, nor a leading & (PowerShell's call operator).
export function lineJoins(command) {
  const s = String(command || '');
  let q = '';
  let joins = 'none';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '\\' || c === '`') i++;
    else if (c === ';' || c === '|' || c === '\n' || c === '\r') return 'other';
    else if (c === '&' && s[i - 1] !== '>' && s[i + 1] !== '>' && s.slice(0, i).trim()) {
      if (s[i + 1] !== '&') return 'other';
      joins = 'and';
      i++;
    }
  }
  return joins;
}

export const hasMore = (command) => lineJoins(command) !== 'none';

// A command line -> { label, more, joins } with no argument kept but a known program's sub-command; label '' when the
// program cannot be named safely (programName's rules: an environment value that may run on is never shown). more: the
// line holds more than the labelled program (a leading cd too: its own exit code may be the line's)
export function commandLabel(command) {
  const whole = String(command || '').trim();
  const joins = lineJoins(whole);
  let s = whole;
  for (let i = 0; i < 4; i++) {
    const m = LEADING_CD.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const more = joins !== 'none';
  const program = programName(s);
  const rest = programRest(s);
  if (!program || rest === null) return { label: '', more, joins };
  const words = [program];
  const key = program.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (WITH_SUB.has(key)) {
    // The words after the program itself (a quoted path may hold spaces), never those of an environment value
    const q = /^(["'])(.*?)\1/.exec(rest);
    const tokens = (q ? rest.slice(q[0].length) : rest.replace(/^\S+/, '')).trim().split(/\s+/);
    const sub = tokens[0];
    if (sub && SUB_WORD.test(sub)) {
      words.push(sub);
      const next = tokens[1];
      if ((sub === 'run' || sub === 'run-script') && key !== 'npx' && next && SCRIPT_WORD.test(next)) words.push(next);
    }
  }
  return { label: redact(words.join(' ')), more, joins };
}

// The whole line's hash with the folder it ran in (the shell's folder lasts from call to call, and a worktree agent
// runs the same line elsewhere): kept in memory to tell the very same line run again, never shown or sent
export const commandKey = (command, cwd = '') => crypto.createHash('sha256').update(`${String(cwd || '')}\0${String(command || '').trim()}`).digest('hex').slice(0, 24);

// Error texts of a call that never ran (Claude Code 2.1.283-2.1.296): a tool error, a worktree agent's refusal, a
// spawn error (EPERM / ENAMETOOLONG ... uv_spawn)
const NOT_RUN_TEXT = /^<tool_use_error>|\bRefusing to run it\b|^E[A-Z]{2,20}: [^\n]{0,200}spawn\b/;

// The text of a tool_result block (a string, or text parts)
function resultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

// How a shell call ended, from its tool_result line (o) and block. bg: the call asked to run in the background.
// -> { end: 'ok' | 'failed' | 'not-run' | 'no-code' | 'background', code? }
export function shellOutcome(o, block, bg = false) {
  if (block?.is_error === true) {
    const text = resultText(block);
    const m = /^Exit code (-?\d{1,6})\b/.exec(text);
    if (m) return { end: 'failed', code: Number(m[1]) };
    // Refused, blocked or could not start, as the real logs say it: no command ran. Any other error text is not known
    // (review E3 round 2: a new text, such as a time-out after the command ran, must not become "it did not run")
    if ((typeof o?.toolDenialKind === 'string' && o.toolDenialKind) || NOT_RUN_TEXT.test(text)) return { end: 'not-run' };
    return { end: 'no-code' };
  }
  const r = o?.toolUseResult;
  if (r && typeof r === 'object' && r.interrupted === true) return { end: 'no-code' };
  if (bg || (r && typeof r === 'object' && r.backgroundTaskId)) return { end: 'background' };
  return { end: 'ok' };
}

// A background command's end from a <task-notification> text: { id, end, code? } or null
export function backgroundEnd(text) {
  const s = String(text || '');
  const id = /<tool-use-id>(toolu_[A-Za-z0-9]{1,64})<\/tool-use-id>/.exec(s)?.[1];
  if (!id) return null;
  const status = /<status>([a-z_]{1,20})<\/status>/.exec(s)?.[1] || '';
  // The summary ends with the outcome; the command's own description comes before it, so only its end is read
  const sum = /<summary>([\s\S]{0,4000}?)<\/summary>/.exec(s)?.[1] || '';
  const done = /completed \(exit code (-?\d{1,6})(?::[^)]{0,80})?\)\s*$/.exec(sum);
  if (done && status === 'completed') return { id, end: 'ok', code: Number(done[1]) };
  const failed = /failed with exit code (-?\d{1,6})\s*$/.exec(sum);
  if (failed && status === 'failed') return { id, end: 'failed', code: Number(failed[1]) };
  if (status === 'killed' || status === 'stopped' || status === 'failed') return { id, end: 'no-code' };
  return null;
}

// The tools whose logs the app reads for commands; any other says "not known for <tool>"
export const COMMAND_TOOLS = OBSERVED_TOOLS;

// One job's commands across its sessions and their agents (ctx.commands: Map tool-use id -> entry, ctx.commandsDropped:
// the counts of entries dropped over COMMANDS_MAX). sessions: ingest sessions with the job's id; agentsOf(id): a
// session's agents. -> null when no session of the job is known, else
//   { ran, ok, failed, notRun, noEnd, unknownTools: [tool], failures: [{ label, more, code, at, laterOk }], failedLines }
// A call copied into a resumed or forked session's log counts once (its tool-use id). failures: per command line the
// newest failed run (newest first, at most 5; failedLines: how many lines failed in all); at: when it ended (or
// started, when that is not known); laterOk: a later run of the very same line ended without error; null when that
// says nothing (the line's exit code is that of one of its parts: ; || | &)
export function jobCommandsSummary(sessions, agentsOf = (_id) => []) {
  if (!sessions.length) return null;
  const out = { ran: 0, ok: 0, failed: 0, notRun: 0, noEnd: 0, unknownTools: /** @type {string[]} */ ([]), failures: /** @type {any[]} */ ([]), failedLines: 0 };
  const byId = new Map();
  const count = (end, n = 1) => {
    if (end === 'ok') out.ok += n;
    else if (end === 'failed') out.failed += n;
    else if (end === 'not-run') out.notRun += n;
    else out.noEnd += n;
  };
  for (const s of sessions) {
    if (!COMMAND_TOOLS.has(s.tool || 'claude')) {
      if (!out.unknownTools.includes(s.tool)) out.unknownTools.push(s.tool);
      continue;
    }
    for (const ctx of [s, ...agentsOf(s.id)]) {
      for (const [end, n] of Object.entries(ctx.commandsDropped || {})) count(end, n);
      for (const [id, e] of ctx.commands || []) {
        const had = byId.get(id);
        // A copy whose end is known wins over one still waiting
        if (!had || (had.end === 'running' && e.end !== 'running')) byId.set(id, e);
      }
    }
  }
  const all = [...byId.values()].sort((x, y) => x.at - y.at);
  for (const e of all) count(e.end);
  out.ran = out.ok + out.failed + out.noEnd;
  const byLine = new Map();
  for (const e of all) {
    const g = byLine.get(e.key) || { failure: null, laterOk: false };
    if (e.end === 'failed') {
      g.failure = e;
      g.laterOk = false;
    } else if (e.end === 'ok' && g.failure) g.laterOk = true;
    byLine.set(e.key, g);
  }
  const failing = [...byLine.values()].filter((g) => g.failure && g.failure.label);
  out.failedLines = failing.length;
  out.failures = failing
    .sort((x, y) => (y.failure.endAt || y.failure.at) - (x.failure.endAt || x.failure.at))
    .slice(0, FAILURES_SHOWN)
    .map((g) => ({ label: g.failure.label, more: g.failure.more, code: g.failure.code, at: g.failure.endAt || g.failure.at, laterOk: g.failure.joins === 'other' ? null : g.laterOk }));
  return out;
}
