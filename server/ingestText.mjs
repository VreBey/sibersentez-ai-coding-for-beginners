// @ts-check
// What a log line says, in words: a tool's category, the short text of an action, a program's name, the text of a
// message, a parsed line. Moved out of server/ingest.mjs (docs/internal/module-split-plan.md I1); used by the Claude
// Code reader there, the other tools' readers (ingestForeign.mjs) and jobCommands.mjs. ingest.mjs re-exports them.
import { truncate } from './util.mjs';

// A plan shown for approval is kept up to this many characters
export const PLAN_MAX = 6000;

export function toolCategory(name) {
  if (/^(Read|Glob|Grep|LS|NotebookRead|ToolSearch)$/.test(name)) return 'read';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'write';
  if (/^(Bash|PowerShell|Monitor|BashOutput|KillShell|TaskStop)$/.test(name)) return 'shell';
  if (/^(WebFetch|WebSearch)$/.test(name) || /chrome|browser|playwright/i.test(name)) return 'web';
  if (name === 'Agent' || name === 'Task' || name === 'SendMessage') return 'agent';
  if (name === 'Skill') return 'skill';
  if (name === 'Workflow') return 'workflow';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function base(p) {
  return p ? String(p).split(/[\\/]/).pop() : '';
}

export function workflowNameOf(input) {
  if (!input) return '';
  if (input.name) return String(input.name);
  const m = /name\s*:\s*['"]([^'"]+)['"]/.exec(input.script || '');
  if (m) return m[1];
  if (input.scriptPath) return base(input.scriptPath).replace(/\.m?js$/, '');
  return '';
}

// Program name of a command with no description. Leading environment variable assignments (X=... , $env:X=...; , set X=...)
// are dropped because their values may be secrets; of the first remaining word only the file name part is taken, with a narrow
// character set. If it does not fit, nothing is shown.
const ENV_ASSIGN = [
  /^\$env:[\w.]+\s*=\s*('[^']*'|"[^"]*"|[^;\s]*)\s*;?\s*/i,
  // cmd: the value may contain spaces, and runs up to & / && or the end of the line
  /^set\s+"?[\w.]+=([^&\r\n]*)(?:&&?|$)\s*/i,
  /^(?:export\s+)?[A-Za-z_]\w*=('[^']*'|"[^"]*"|\S*)\s*/,
];
// Where an assignment ends whose value is command output, a variable expansion or an escaped space
// cannot be known safely: what follows may be part of the value, so the program name is never shown.
const RISKY_VALUE = /\$[('"{]|`|<\(|\\/;
// The command after its leading environment assignments (and PowerShell's call operator), or null when where an
// assignment ends cannot be known safely
export function programRest(command) {
  let s = String(command || '').trim();
  for (let i = 0; i < 8; i++) {
    let hit = false;
    for (const re of ENV_ASSIGN) {
      const m = re.exec(s);
      if (!m) continue;
      if (RISKY_VALUE.test(m[1] || '')) return null;
      s = s.slice(m[0].length);
      hit = true;
      break;
    }
    if (!hit) break;
  }
  return s.replace(/^&\s*/, ''); // PowerShell call operator: & "C:\...\x.exe"
}

export function programName(command) {
  const s = programRest(command);
  if (s === null) return '';
  // A quoted first part (a path with spaces) is taken whole; otherwise up to the first space
  const q = /^(["'])(.*?)\1/.exec(s);
  const first = q ? q[2] : s.split(/\s+/)[0] || '';
  const name = first.replace(/^["'(]+|["')]+$/g, '').split(/[\\/]/).pop();
  return /^[\w.+-]{1,32}$/.test(name) ? name : '';
}

// A safe short summary for the "what is it doing now" line: not the raw command or a full path;
// the file name, the short description Claude wrote, the domain, the pattern, the agent/skill name.
export function actionText(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      // With no description, only the name of the program being run (not its arguments)
      return input.description || programName(input.command);
    case 'Grep':
    case 'Glob':
      return truncate(input.pattern || '', 60);
    case 'WebFetch':
      try {
        return new URL(input.url).hostname;
      } catch {
        return '';
      }
    case 'WebSearch':
      return truncate(input.query || '', 60);
    case 'Agent':
    case 'Task':
      return [input.subagent_type, input.description].filter(Boolean).join(': ');
    case 'Skill':
      return input.skill || '';
    case 'Workflow':
      return workflowNameOf(input);
    default:
      if (name.startsWith('mcp__')) return name.replace(/^mcp__/, '').replace(/__/g, ' · ');
      return '';
  }
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b?.type === 'text' && b.text) parts.push(b.text);
    else if (b?.type === 'image') parts.push('[image]');
  }
  return parts.join(' ');
}

export function parseLine(buf, a, b) {
  try {
    return JSON.parse(buf.toString('utf8', a, b));
  } catch {
    return null;
  }
}
