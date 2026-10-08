// Incrementally reads Claude Code session logs (~/.claude/projects) and builds an in-memory state model:
// sessions, sub-agents, workflow runs, the event feed, tool-call ticks, usage counters.
// The byte offset reached in each file is kept; only new lines are processed. Heavy lines (attachments,
// tool results) are skipped by looking at the first few hundred bytes, without converting to JSON.
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, CODEX_SESSIONS_DIR, GEMINI_TMP_DIR, QWEN_PROJECTS_DIR, COPILOT_SESSIONS_DIR, OPENCODE_DB, CURSOR_DIR, WINDOW_DAYS, MAX_EVENTS, MAX_TICKS, AGENT_STALE_MS } from './config.mjs';
import { classifyForeign, codexPromptText, codexPermission, codexToolCall, codexTotalOut, codexContext, geminiToolCall, geminiPromptText, geminiOutTokens, qwenPromptText, qwenToolCalls, qwenOutTokens, copilotToolCall, copilotTokens, opencodeText, opencodeToolCall, opencodeTokens, cursorPromptText, cursorToolCalls } from './toolLogs.mjs';
import { readLinesFrom, readJson, toMs, truncate, redact, slugify } from './util.mjs';
import { apiErrorOf } from './apierror.mjs';
import { readJobText } from './job-id.mjs';
import { isLocalPath } from './fsutil.mjs';

const HOUR = 3600000;

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
export function programName(command) {
  let s = String(command || '').trim();
  for (let i = 0; i < 8; i++) {
    let hit = false;
    for (const re of ENV_ASSIGN) {
      const m = re.exec(s);
      if (!m) continue;
      if (RISKY_VALUE.test(m[1] || '')) return '';
      s = s.slice(m[0].length);
      hit = true;
      break;
    }
    if (!hit) break;
  }
  s = s.replace(/^&\s*/, ''); // PowerShell call operator: & "C:\...\x.exe"
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

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b?.type === 'text' && b.text) parts.push(b.text);
    else if (b?.type === 'image') parts.push('[image]');
  }
  return parts.join(' ');
}

function parseLine(buf, a, b) {
  try {
    return JSON.parse(buf.toString('utf8', a, b));
  } catch {
    return null;
  }
}

export class Ingest {
  constructor(catalog) {
    this.catalog = catalog;
    this.cutoff = Date.now() - WINDOW_DAYS * 86400000;
    this.files = new Map();
    // Other AI tools' session logs (server/toolLogs.mjs); a test points them at its own folders
    this.foreignDirs = { codex: CODEX_SESSIONS_DIR, gemini: GEMINI_TMP_DIR, qwen: QWEN_PROJECTS_DIR, copilot: COPILOT_SESSIONS_DIR, opencode: OPENCODE_DB, cursor: CURSOR_DIR };
    // OpenCode's database, read on the scans when it changed (scanOpenCode)
    this.oc = { mtime: 0, since: 0, seen: new Map(), out: new Map(), off: false };
    this.geminiRoots = new Map(); // Gemini's project name -> its folder (or null)
    this.sessions = new Map();
    this.agents = new Map();
    this.workflows = new Map();
    this.sessionAgents = new Map(); // sessionId -> Set(agentId)
    this.projectSessions = new Map(); // projectId -> Set(sessionId)
    this.projectAgents = new Map(); // projectId -> Set(agentId)
    this.agentCalls = new Map(); // Agent tool_use id -> {type, description, prompt}
    this.events = [];
    this.ticks = [];
    this.pendingEvents = [];
    this.pendingTicks = [];
    this.hourly = new Map(); // metric -> Map(hour -> n)
    this.projHourly = new Map(); // projectId -> Map(metric -> Map(hour -> n))
    this.usage = { skills: new Map(), agents: new Map(), commands: new Map() };
    this.dirty = { sessions: new Set(), agents: new Set(), workflows: new Set(), projects: new Set() };
    this.removed = { sessions: [], agents: [], workflows: [] }; // those that dropped out of the window (sent to the client as a patch)
    this.queue = new Set();
    this.initial = true;
    this.seq = 0;
    this.tickSeq = 0;
    this.scan = { state: 'idle', done: 0, total: 0, startedAt: 0, finishedAt: 0 };
    // Usage ledger (server/usage.mjs), set by server/index.mjs: every assistant line with usage is handed over
    this.ledger = null;
  }

  // ---------- file classification ----------
  classify(abs) {
    const rel = path.relative(PROJECTS_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return classifyForeign(abs, this.foreignDirs);
    const parts = rel.split(path.sep);
    if (parts.includes('tool-results') || parts.includes('memory')) return null;
    const name = parts[parts.length - 1];
    if (parts.length === 2 && name.endsWith('.jsonl')) return { kind: 'main', slug: parts[0], sessionId: name.slice(0, -6) };
    if (parts.length >= 4 && parts[2] === 'subagents' && /^agent-.+\.jsonl$/.test(name)) {
      const wf = parts.length === 6 && parts[3] === 'workflows' ? parts[4] : null;
      return { kind: 'agent', slug: parts[0], sessionId: parts[1], agentId: name.slice(6, -6), workflowRunId: wf };
    }
    if (parts.length === 4 && parts[2] === 'workflows' && /^wf_.+\.json$/.test(name)) {
      return { kind: 'workflow', slug: parts[0], sessionId: parts[1], runId: name.slice(0, -5) };
    }
    return null;
  }

  // ---------- entities ----------
  getSession(id, slug) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        slug,
        // Which AI tool's log this session comes from (claude: ~/.claude/projects; codex, gemini: server/toolLogs.mjs)
        tool: 'claude',
        projectId: null,
        cwd: null,
        title: null,
        firstPrompt: null,
        jobId: null,
        lastPrompt: null,
        lastPromptAt: 0,
        prompts: [],
        promptCount: 0,
        startedAt: 0,
        lastAt: 0,
        model: null,
        tokensOut: 0,
        contextTokens: 0,
        toolCalls: 0,
        toolCounts: {},
        skills: {},
        workflows: [],
        branch: null,
        version: null,
        live: null,
        compacts: 0,
        permissionMode: null, // Claude Code's permission mode at the person's last line (plan, default, acceptEdits, auto, ...)
        permissionModeAt: 0,
        apiError: null, // { kind, t, resetsAt?, text? } while Claude Code's last word was an error (server/apierror.mjs)
        isAgent: false,
      };
      this.sessions.set(id, s);
      // Assign at once only if it matches a registered project; otherwise wait for the first cwd line
      if (slug) this.assignSessionProject(s, this.catalog.resolve(null, slug));
    }
    return s;
  }

  assignSessionProject(s, pid) {
    if (!pid || s.projectId === pid) return;
    if (s.projectId) this.projectSessions.get(s.projectId)?.delete(s.id);
    s.projectId = pid;
    if (!this.projectSessions.has(pid)) this.projectSessions.set(pid, new Set());
    this.projectSessions.get(pid).add(s.id);
    this.dirty.projects.add(pid);
    // This session's agents belong to the same project too
    for (const aid of this.sessionAgents.get(s.id) || []) {
      const ag = this.agents.get(aid);
      if (ag) this.assignAgentProject(ag, pid);
    }
  }

  assignAgentProject(ag, pid) {
    if (!pid || ag.projectId === pid) return;
    if (ag.projectId) this.projectAgents.get(ag.projectId)?.delete(ag.id);
    ag.projectId = pid;
    if (!this.projectAgents.has(pid)) this.projectAgents.set(pid, new Set());
    this.projectAgents.get(pid).add(ag.id);
    this.dirty.projects.add(pid);
  }

  getAgent(c, abs) {
    let ag = this.agents.get(c.agentId);
    if (ag) return ag;
    const meta = readJson(abs.replace(/\.jsonl$/, '.meta.json')) || {};
    const call = meta.toolUseId ? this.agentCalls.get(meta.toolUseId) : null;
    if (call) this.agentCalls.delete(meta.toolUseId); // linked to the agent, no longer needed
    ag = {
      id: c.agentId,
      sessionId: c.sessionId,
      slug: c.slug,
      projectId: null,
      type: meta.agentType || call?.type || (c.workflowRunId ? 'workflow-subagent' : 'general-purpose'),
      description: meta.description || call?.description || '',
      prompt: call?.prompt || '',
      depth: meta.spawnDepth || 1,
      workflowRunId: c.workflowRunId,
      toolUseId: meta.toolUseId || null,
      background: meta.requestShape === 'background' || !!call?.background,
      startedAt: 0,
      lastAt: 0,
      toolCalls: 0,
      toolCounts: {},
      tokensOut: 0,
      contextTokens: 0,
      lastStop: null,
      model: null,
      status: 'running',
      doneEmitted: false,
      cwd: null,
      isAgent: true,
    };
    this.agents.set(ag.id, ag);
    if (!this.sessionAgents.has(ag.sessionId)) this.sessionAgents.set(ag.sessionId, new Set());
    this.sessionAgents.get(ag.sessionId).add(ag.id);
    const parent = this.sessions.get(ag.sessionId);
    this.assignAgentProject(ag, parent?.projectId || this.catalog.resolve(null, c.slug));
    if (ag.workflowRunId) this.ensureWorkflow(ag.workflowRunId, ag.sessionId, c.slug);
    return ag;
  }

  ensureWorkflow(runId, sessionId, slug) {
    let w = this.workflows.get(runId);
    if (!w) {
      const parent = this.sessions.get(sessionId);
      w = {
        id: runId,
        sessionId,
        projectId: parent?.projectId || this.catalog.resolve(null, slug),
        name: null,
        status: 'running',
        agentCount: 0,
        phases: [],
        totalTokens: 0,
        totalToolCalls: 0,
        durationMs: 0,
        startedAt: 0,
        endedAt: 0,
        summary: '',
        model: null,
        doneEmitted: false,
      };
      this.workflows.set(runId, w);
    }
    this.dirty.workflows.add(runId);
    return w;
  }

  // ---------- events and counters ----------
  bump(metric, projectId, t, n = 1) {
    const h = Math.floor(t / HOUR);
    let m = this.hourly.get(metric);
    if (!m) this.hourly.set(metric, (m = new Map()));
    m.set(h, (m.get(h) || 0) + n);
    if (!projectId) return;
    let pm = this.projHourly.get(projectId);
    if (!pm) this.projHourly.set(projectId, (pm = new Map()));
    let mm = pm.get(metric);
    if (!mm) pm.set(metric, (mm = new Map()));
    mm.set(h, (mm.get(h) || 0) + n);
  }

  addEvent(ev) {
    if (!ev.t || ev.t < this.cutoff) return;
    ev.id = ++this.seq;
    ev.text = redact(ev.text || '');
    this.events.push(ev);
    if (!this.initial) {
      this.pendingEvents.push(ev);
      if (this.events.length > MAX_EVENTS * 1.25) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.bump(ev.kind, ev.projectId, ev.t);
  }

  // Tick = [time, actor, category, project, sequence no]. Command/file detail is deliberately not carried:
  // the UI does not use it and it should not be exposed needlessly. The client de-duplicates by sequence no.
  addTick(t, actor, cat, projectId) {
    if (!t || t < this.cutoff) return;
    const tick = [t, actor, cat, projectId || '', ++this.tickSeq];
    this.ticks.push(tick);
    if (!this.initial) {
      this.pendingTicks.push(tick);
      if (this.ticks.length > MAX_TICKS * 1.25) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
    }
    this.bump('tools', projectId, t);
  }

  // Usage is kept in daily buckets: even if the server stays up for days, the count stays bounded by the window
  bumpUsage(map, key, t, projectId, text) {
    if (!key || !t || t < this.cutoff) return;
    let u = map.get(key);
    if (!u) map.set(key, (u = { days: new Map(), lastAt: 0, projects: new Set(), recent: [] }));
    const day = Math.floor(t / 86400000);
    u.days.set(day, (u.days.get(day) || 0) + 1);
    if (t > u.lastAt) u.lastAt = t;
    if (projectId) u.projects.add(projectId);
    if (text) {
      u.recent.push({ t, projectId, text: truncate(redact(text), 140) });
      if (u.recent.length > 8) u.recent.shift();
    }
  }

  touch(ctx, t) {
    if (!t) return;
    if (!ctx.startedAt || t < ctx.startedAt) ctx.startedAt = t;
    if (t > ctx.lastAt) ctx.lastAt = t;
  }

  // The job's own words for a session the app started for a job (job-id.mjs readJobText), read once both its job and
  // its folder are known; the page names the session by them instead of a title that carries the raw job id
  noteJobText(ctx) {
    if (ctx.jobText !== undefined || !ctx.jobId || !ctx.cwd || ctx.isAgent) return;
    // A folder on this computer only (a network path from a log is not opened); the words redacted as a prompt is
    // (a key pasted into the job is not shown) (review 2026-10-08)
    const text = isLocalPath(ctx.cwd) ? readJobText(ctx.cwd, ctx.jobId) : null;
    ctx.jobText = text ? truncate(redact(text), 120) || null : null;
    if (ctx.jobText) this.dirty.sessions.add(ctx.id);
  }

  setCwd(ctx, cwd) {
    if (!cwd || ctx.cwd) return;
    ctx.cwd = cwd;
    this.noteJobText(ctx);
    if (ctx.isAgent) {
      const parent = this.sessions.get(ctx.sessionId);
      this.assignAgentProject(ctx, parent?.projectId || this.catalog.resolve(cwd, ctx.slug));
    } else {
      this.assignSessionProject(ctx, this.catalog.resolve(cwd, ctx.slug));
    }
  }

  markDirty(ctx) {
    if (ctx.isAgent) this.dirty.agents.add(ctx.id);
    else this.dirty.sessions.add(ctx.id);
    if (ctx.projectId) this.dirty.projects.add(ctx.projectId);
  }

  // ---------- line processing ----------
  line(ctx, st, buf, a, b) {
    const head = buf.toString('latin1', a, Math.min(b, a + 460));
    if (head.startsWith('{"type":"')) {
      if (head.startsWith('{"type":"ai-title"')) {
        const o = parseLine(buf, a, b);
        if (o?.aiTitle && !ctx.isAgent) this.setTitle(ctx, o.aiTitle);
      }
      // A mode change the tool makes itself (the plan approved in its terminal, Shift+Tab): a line of its own, with no
      // time, after which the mode holds until the person's next line (seen when using the app, 2026-10-08: after the
      // plan was approved the drawer still said "plan only, touches no file" while the AI wrote files)
      if (head.startsWith('{"type":"permission-mode"')) {
        const o = parseLine(buf, a, b);
        if (o && !ctx.isAgent && typeof o.permissionMode === 'string' && /^[A-Za-z]{1,30}$/.test(o.permissionMode) && o.permissionMode !== ctx.permissionMode) {
          ctx.permissionMode = o.permissionMode;
          ctx.permissionModeAt = Math.max(ctx.permissionModeAt || 0, ctx.lastAt || 0);
          this.dirty.sessions.add(ctx.id);
        }
      }
      return;
    }
    if (head.includes('"attachment":{')) return;
    if (head.includes('"role":"assistant"') || head.includes('"message":{"model"')) {
      const o = parseLine(buf, a, b);
      if (o) this.assistant(ctx, st, o);
      return;
    }
    if (head.includes('"type":"user"')) {
      if (head.includes('"content":[{"tool_use_id"') || head.includes('"content":[{"type":"tool_result"')) return;
      const o = parseLine(buf, a, b);
      if (o) this.user(ctx, o);
      return;
    }
    if (head.includes('"type":"system"') && head.includes('compact_boundary')) {
      const o = parseLine(buf, a, b);
      if (o && !ctx.isAgent) {
        const t = toMs(o.timestamp);
        ctx.compacts++;
        this.addEvent({ t, kind: 'compact', projectId: ctx.projectId, sessionId: ctx.id, actor: 's:' + ctx.id, text: 'Context compacted (/compact)' });
      }
    }
  }

  setTitle(s, title) {
    if (s.title === title) return;
    const had = s.title;
    s.title = truncate(title, 120);
    if (had && !this.initial) {
      this.addEvent({ t: Date.now(), kind: 'title', projectId: s.projectId, sessionId: s.id, actor: 's:' + s.id, text: s.title });
    }
    this.dirty.sessions.add(s.id);
  }

  assistant(ctx, st, o) {
    const t = toMs(o.timestamp);
    this.touch(ctx, t);
    this.setCwd(ctx, o.cwd);
    if (!ctx.isAgent) {
      if (o.gitBranch) ctx.branch = o.gitBranch;
      if (o.version) ctx.version = o.version;
    }
    const m = o.message;
    if (!m) return;
    if (m.model && m.model !== '<synthetic>') ctx.model = m.model;
    // An error in place of an answer (a limit, sign-in, the connection: server/apierror.mjs): the lead's newest record
    // decides, and a real answer after it clears it
    if (!ctx.isAgent && (!ctx.apiError || t >= ctx.apiError.t)) {
      const e = apiErrorOf(o, t);
      if (e) {
        const fresh = !ctx.apiError || ctx.apiError.t !== e.t;
        ctx.apiError = e;
        // Said once as it happens (a notice for the person); never for the logs read at start
        if (fresh && !this.initial) this.addEvent({ t, kind: 'ai_error', projectId: ctx.projectId, sessionId: ctx.id, actor: 's:' + ctx.id, text: e.kind, meta: { kind: e.kind } });
      } else if (ctx.apiError && m.model && m.model !== '<synthetic>') ctx.apiError = null;
    }
    const u = m.usage;
    if (u && m.id) {
      const out = u.output_tokens || 0;
      if (st.lastMsgId !== m.id) {
        st.lastMsgId = m.id;
        st.lastMsgOut = 0;
      }
      if (out > st.lastMsgOut) {
        const d = out - st.lastMsgOut;
        ctx.tokensOut += d;
        st.lastMsgOut = out;
        this.bump('tokens', ctx.projectId, t, d);
      }
      ctx.contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      // The ledger dedupes by message and request id itself (a line read twice is not counted twice). fileKey names
      // this log file for a message without a request id; the project is the one this session got above.
      if (this.ledger) this.ledger.line(o, { fileKey: st.agentId ? `${st.sessionId}/${st.agentId}` : st.sessionId || ctx.id, projectId: ctx.projectId });
    }
    if (m.stop_reason) ctx.lastStop = m.stop_reason;
    if (Array.isArray(m.content)) {
      for (const block of m.content) if (block?.type === 'tool_use') this.toolUse(ctx, block, t);
    }
  }

  toolUse(ctx, block, t) {
    const name = block.name || '?';
    const input = block.input || {};
    ctx.toolCalls++;
    ctx.toolCounts[name] = (ctx.toolCounts[name] || 0) + 1;
    const actor = (ctx.isAgent ? 'a:' : 's:') + ctx.id;
    const sessionId = ctx.isAgent ? ctx.sessionId : ctx.id;
    const cat = toolCategory(name);
    this.addTick(t, actor, cat, ctx.projectId);
    if (!ctx.lastAction || t >= ctx.lastAction.t) ctx.lastAction = { t, tool: name, cat, text: truncate(redact(actionText(name, input)), 90) };
    // The plan a session shows for approval (Claude Code's plan mode, docs/simplify.md): the building shows it while the
    // session waits on it. Only a lead's plan; the newest one counts
    if (name === 'ExitPlanMode' && !ctx.isAgent && typeof input.plan === 'string' && (!ctx.plan || t >= ctx.plan.t)) ctx.plan = { t, text: truncate(redact(input.plan), PLAN_MAX) };

    if (name === 'Agent' || name === 'Task') {
      const type = input.subagent_type || 'general-purpose';
      const call = { t, type, description: input.description || '', prompt: truncate(redact(input.prompt), 500), background: !!input.run_in_background };
      this.agentCalls.set(block.id, call);
      this.bumpUsage(this.usage.agents, type, t, ctx.projectId, input.description);
      this.addEvent({ t, kind: 'agent_start', projectId: ctx.projectId, sessionId, actor, text: input.description || type, meta: { type, toolUseId: block.id } });
      // If the agent file was read earlier, complete the description
      for (const ag of this.agents.values()) {
        if (ag.toolUseId === block.id) {
          if (!ag.description) ag.description = call.description;
          if (!ag.prompt) ag.prompt = call.prompt;
          this.dirty.agents.add(ag.id);
        }
      }
    } else if (name === 'Skill') {
      const skill = input.skill || input.name;
      if (!ctx.isAgent) ctx.skills[skill] = (ctx.skills[skill] || 0) + 1;
      this.bumpUsage(this.usage.skills, skill, t, ctx.projectId, input.args || '');
      this.addEvent({ t, kind: 'skill', projectId: ctx.projectId, sessionId, actor, text: skill, meta: { args: truncate(redact(input.args), 120) } });
    } else if (name === 'Workflow') {
      const wfName = workflowNameOf(input) || 'workflow';
      if (!ctx.isAgent) ctx.workflows.push({ t, name: wfName });
      this.addEvent({ t, kind: 'workflow_start', projectId: ctx.projectId, sessionId, actor, text: wfName });
    }
  }

  user(ctx, o) {
    const t = toMs(o.timestamp);
    this.touch(ctx, t);
    this.setCwd(ctx, o.cwd);
    const text = extractText(o.message?.content);
    if (ctx.isAgent) {
      ctx.lastStop = null; // new message: the agent is working again
      if (!ctx.prompt && text) ctx.prompt = truncate(redact(text), 500);
      if (!ctx.description && text) ctx.description = truncate(redact(text.split('\n').find((l) => l.trim()) || ''), 90);
      return;
    }
    // The permission mode Claude Code ran in when the person last wrote (plan, default, acceptEdits, auto, ...): the
    // newest line decides; the page says it in plain words (public/js/permMode.js)
    if (typeof o.permissionMode === 'string' && /^[A-Za-z]{1,30}$/.test(o.permissionMode) && t >= (ctx.permissionModeAt || 0)) {
      ctx.permissionMode = o.permissionMode;
      ctx.permissionModeAt = t;
    }
    // System attachments, /compact summaries and lines that show only in the transcript are not your command
    if (o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly || !text) return;
    if (/^\s*\[Request interrupted/.test(text)) return;
    const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
    if (cmd) {
      const name = cmd[1].trim();
      const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] || '').trim();
      this.bumpUsage(this.usage.commands, name, t, ctx.projectId, args);
      const line = truncate(redact(`/${name} ${args}`), 200);
      ctx.lastPrompt = line;
      ctx.lastPromptAt = t;
      ctx.promptCount++;
      ctx.prompts.push({ t, text: line });
      if (ctx.prompts.length > 40) ctx.prompts.shift();
      this.addEvent({ t, kind: 'command', projectId: ctx.projectId, sessionId: ctx.id, actor: 's:' + ctx.id, text: line });
      return;
    }
    const trimmed = text.trim();
    if (/^<(local-command-std|task-notification|agent-message|bash-|user-memory-input)/.test(trimmed) || trimmed.startsWith('Caveat:')) return;
    this.addPrompt(ctx, t, text);
  }

  // A prompt the person wrote, whatever the tool (Claude Code's user lines, server/toolLogs.mjs for the others): cut
  // short and redacted; the first one names the session's app job when it was started for one
  addPrompt(ctx, t, text) {
    const clean = truncate(redact(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/<[^>]{1,60}>/g, ' ')), 280);
    if (!clean) return;
    ctx.promptCount++;
    // The app job a session was started for: its first prompt names the job's file (launch.mjs launchPrompt). Read
    // from the text before redact, which takes a 33-character id for a secret; the id is random, not a secret.
    if (!ctx.firstPrompt) ctx.jobId = /\bjob-(J[0-9a-f]{32})\.md\b/.exec(text)?.[1] || null;
    if (!ctx.firstPrompt) ctx.firstPrompt = clean;
    this.noteJobText(ctx);
    ctx.lastPrompt = clean;
    ctx.lastPromptAt = t;
    ctx.prompts.push({ t, text: clean });
    if (ctx.prompts.length > 40) ctx.prompts.shift();
    this.addEvent({ t, kind: 'prompt', projectId: ctx.projectId, sessionId: ctx.id, actor: 's:' + ctx.id, text: clean });
  }

  // ---------- other AI tools' logs (server/toolLogs.mjs) ----------
  foreignSession(tool, id) {
    const s = this.getSession(id, null);
    s.tool = tool;
    return s;
  }

  // A tool call of another tool: counted under its own name; its category and one line come from the Claude Code
  // name it matches (Bash, Edit, Read...)
  foreignTool(ctx, call, t) {
    ctx.toolCalls++;
    ctx.toolCounts[call.raw] = (ctx.toolCounts[call.raw] || 0) + 1;
    const cat = toolCategory(call.mapped);
    this.addTick(t, 's:' + ctx.id, cat, ctx.projectId);
    if (!ctx.lastAction || t >= ctx.lastAction.t) ctx.lastAction = { t, tool: call.raw, cat, text: truncate(redact(actionText(call.mapped, call.input)), 90) };
    if (call.mapped === 'ExitPlanMode' && typeof call.input?.plan === 'string' && (!ctx.plan || t >= ctx.plan.t)) ctx.plan = { t, text: truncate(redact(call.input.plan), PLAN_MAX) };
  }

  // One request of another tool into the usage ledger (server/usage.mjs), in Claude Code's shape: these tools count the
  // cached input inside the input (OpenAI's and Gemini's way), so it is taken out of it as Claude's logs keep it apart.
  // key: unique per request, so a line read twice is counted once. The model is the tool's own (a price only when
  // server/prices.mjs knows it; otherwise the strip lists it as without a price).
  // cacheWrite: the input written to the cache (a tool that reports it apart: Copilot CLI)
  foreignUsage(ctx, key, t, model, { input = 0, cached = 0, output = 0, cacheWrite = 0 } = {}) {
    if (!this.ledger || !key) return;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const c = Math.min(n(cached), n(input));
    const usage = { input_tokens: n(input) - c, cache_read_input_tokens: c, output_tokens: n(output) };
    if (n(cacheWrite)) usage.cache_creation_input_tokens = n(cacheWrite);
    this.ledger.add({ key, t, projectId: ctx.projectId, model: model || ctx.model || ctx.tool, usage });
  }

  foreignTokens(ctx, t, out, context) {
    if (out > ctx.tokensOut) {
      this.bump('tokens', ctx.projectId, t, out - ctx.tokensOut);
      ctx.tokensOut = out;
    }
    if (context != null) ctx.contextTokens = context;
  }

  // One Codex log line ({ timestamp, type, payload }). A sub-agent's own thread (source.subagent) is left out: its
  // lead's session stands for the work.
  codexRecord(st, o) {
    const t = toMs(o.timestamp);
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      // Left out: a sub-agent's own thread (source.subagent, or Codex's guardian reviewer), and a history the Codex
      // desktop app imported (no thread_source: on this computer 125 such files, never a turn Codex ran, many of them
      // Claude Code's own conversations; counting them would show that work twice). A session Codex runs says where it
      // came from (thread_source user, ...), and the CLI's too.
      const sub = (p.source && typeof p.source === 'object' && p.source.subagent) || p.source === 'subagent' || p.thread_source === 'subagent' || p.thread_source === 'guardian_review';
      const imported = !p.thread_source && /desktop/i.test(String(p.originator || ''));
      if (sub || imported) {
        st.skip = true;
        return;
      }
      const id = String(p.id || p.session_id || st.sessionId || '').toLowerCase();
      if (!id) return;
      st.ctx = this.foreignSession('codex', id);
      if (typeof p.cli_version === 'string') st.ctx.version = p.cli_version.slice(0, 40);
      this.setCwd(st.ctx, p.cwd);
      this.touch(st.ctx, toMs(p.timestamp) || t);
      return;
    }
    if (st.skip) return;
    if (!st.ctx && st.sessionId) st.ctx = this.foreignSession('codex', st.sessionId);
    const ctx = st.ctx;
    if (!ctx) return;
    this.touch(ctx, t);
    if (o.type === 'turn_context') {
      this.setCwd(ctx, p.cwd);
      if (typeof p.model === 'string' && p.model) ctx.model = p.model.slice(0, 60);
      const mode = codexPermission(p.approval_policy, p.sandbox_policy);
      if (mode && t >= (ctx.permissionModeAt || 0)) {
        ctx.permissionMode = mode;
        ctx.permissionModeAt = t;
      }
    } else if (o.type === 'response_item') {
      const text = codexPromptText(p);
      if (text) this.addPrompt(ctx, t, text);
      const call = codexToolCall(p);
      if (call) this.foreignTool(ctx, call, t);
    } else if (o.type === 'event_msg') {
      if (p.type === 'token_count') {
        const out = codexTotalOut(p);
        if (out != null) this.foreignTokens(ctx, t, out, codexContext(p));
        // The last request's usage; the session's running total names it (the same event written again counts once)
        const last = p.info?.last_token_usage;
        const total = p.info?.total_token_usage;
        if (last && total) this.foreignUsage(ctx, `codex|${ctx.id}|${Number(total.total_tokens) || 0}|${Number(total.output_tokens) || 0}`, t, ctx.model, { input: last.input_tokens, cached: last.cached_input_tokens, output: last.output_tokens });
      } else if (p.type === 'task_started') ctx.lastStop = null;
      else if (p.type === 'task_complete') ctx.lastStop = 'end_turn';
    }
  }

  // The folder a Gemini project name stands for: <tmp>/<name>/.project_root, else ~/.gemini/projects.json
  geminiRoot(slug) {
    if (!slug) return null;
    if (this.geminiRoots.has(slug)) return this.geminiRoots.get(slug);
    let root = null;
    try {
      root = fs.readFileSync(path.join(this.foreignDirs.gemini, slug, '.project_root'), 'utf8').trim() || null;
    } catch {
      try {
        const map = JSON.parse(fs.readFileSync(path.join(path.dirname(this.foreignDirs.gemini), 'projects.json'), 'utf8'))?.projects || {};
        root = Object.keys(map).find((k) => map[k] === slug) || null;
      } catch {
        /* no map: the session stays without a project */
      }
    }
    this.geminiRoots.set(slug, root);
    return root;
  }

  // One Gemini record: the metadata line, a message (the same id may come again with more in it: st.seen keeps what
  // was counted), a $set (it may hold the whole message list), a $rewindTo (nothing to undo here); an old whole-file
  // session is the metadata with its messages
  geminiRecord(st, o) {
    if (!o || typeof o !== 'object' || st.skip) return;
    if (typeof o.sessionId === 'string' && o.sessionId && !o.type && !o.$set) {
      // Another program's agent server writes here too (kind a2a-serv: one setup message, no person): not a session
      if (typeof o.kind === 'string' && /a2a/i.test(o.kind)) {
        st.skip = true;
        return;
      }
      st.ctx = this.foreignSession('gemini', o.sessionId.toLowerCase().slice(0, 80));
      this.setCwd(st.ctx, this.geminiRoot(st.slug));
      this.touch(st.ctx, toMs(o.startTime));
      this.touch(st.ctx, toMs(o.lastUpdated));
      if (Array.isArray(o.messages)) for (const m of o.messages) this.geminiMessage(st, m);
      return;
    }
    if (o.$set && typeof o.$set === 'object') {
      if (Array.isArray(o.$set.messages)) for (const m of o.$set.messages) this.geminiMessage(st, m);
      if (st.ctx) this.touch(st.ctx, toMs(o.$set.lastUpdated));
      return;
    }
    if (typeof o.id === 'string' && typeof o.type === 'string') this.geminiMessage(st, o);
  }

  geminiMessage(st, m) {
    const ctx = st.ctx;
    if (!ctx || !m || typeof m.id !== 'string') return;
    const t = toMs(m.timestamp);
    this.touch(ctx, t);
    let seen = st.seen.get(m.id);
    if (!seen) {
      seen = { user: false, tokens: false, tools: new Set() };
      st.seen.set(m.id, seen);
    }
    if (m.type === 'user') {
      if (seen.user) return;
      const text = geminiPromptText(m.content);
      if (text) {
        seen.user = true;
        this.addPrompt(ctx, t, text);
      }
      return;
    }
    if (m.type !== 'gemini') return;
    ctx.lastStop = Array.isArray(m.toolCalls) && m.toolCalls.length ? null : 'end_turn';
    if (typeof m.model === 'string' && m.model) ctx.model = m.model.slice(0, 60);
    if (m.tokens && !seen.tokens) {
      seen.tokens = true;
      this.foreignTokens(ctx, t, ctx.tokensOut + geminiOutTokens(m.tokens), Number(m.tokens.input) || null);
      this.foreignUsage(ctx, `gemini|${ctx.id}|${m.id}`, t, m.model, { input: m.tokens.input, cached: m.tokens.cached, output: geminiOutTokens(m.tokens) });
    }
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const call = geminiToolCall(tc);
      const key = call?.id || `${m.id}:${call?.raw}:${seen.tools.size}`;
      if (!call || seen.tools.has(key)) continue;
      seen.tools.add(key);
      this.foreignTool(ctx, call, toMs(tc.timestamp) || t);
    }
  }

  // One Qwen Code record (server/toolLogs.mjs): each line its own record, read once (the offset, which the reader keeps
  // past every line it read; no list of seen records is kept)
  qwenRecord(st, o) {
    if (!o || typeof o.sessionId !== 'string' || !o.sessionId) return;
    if (!st.ctx || st.ctx.id !== o.sessionId.toLowerCase()) st.ctx = this.foreignSession('qwen', o.sessionId.toLowerCase().slice(0, 80));
    const ctx = st.ctx;
    const t = toMs(o.timestamp);
    this.touch(ctx, t);
    this.setCwd(ctx, o.cwd);
    if (typeof o.version === 'string' && o.version !== 'unknown') ctx.version = o.version.slice(0, 40);
    if (typeof o.gitBranch === 'string' && o.gitBranch) ctx.branch = o.gitBranch.slice(0, 120);
    const text = qwenPromptText(o);
    if (text) this.addPrompt(ctx, t, text);
    if (o.type !== 'assistant') return;
    const calls = qwenToolCalls(o);
    // A turn that calls a tool goes on; one without is its answer
    ctx.lastStop = calls.length ? null : 'end_turn';
    if (typeof o.model === 'string' && o.model) ctx.model = o.model.slice(0, 60);
    if (o.usageMetadata) {
      const u = o.usageMetadata;
      this.foreignTokens(ctx, t, ctx.tokensOut + qwenOutTokens(u), Number(u.promptTokenCount) || null);
      this.foreignUsage(ctx, `qwen|${ctx.id}|${o.uuid || t}`, t, o.model, { input: u.promptTokenCount, cached: u.cachedContentTokenCount, output: qwenOutTokens(u) });
    }
    for (const call of calls) this.foreignTool(ctx, call, t);
  }

  // OpenCode keeps its sessions in one SQLite database (server/toolLogs.mjs): read read-only on the start and on every
  // rescan when the database (or its write-ahead log) changed, only the rows updated since the last read. A sub-agent's
  // session (parent_id) is left out. Without node:sqlite (an old Node) OpenCode is simply not read.
  async scanOpenCode() {
    const file = this.foreignDirs.opencode;
    if (!file || this.oc.off) return;
    let mt = 0;
    for (const f of [file, `${file}-wal`]) {
      try {
        mt = Math.max(mt, (await stat(f)).mtimeMs);
      } catch {
        /* no such file */
      }
    }
    if (!mt || mt === this.oc.mtime) return;
    let Db;
    try {
      ({ DatabaseSync: Db } = await import('node:sqlite'));
    } catch {
      this.oc.off = true;
      return;
    }
    let db = null;
    try {
      db = new Db(file, { readOnly: true });
      const since = Math.max(this.cutoff, this.oc.since - 5000);
      // A session whose own row, or any of its messages or parts, changed since (a tool part completes after the
      // session row was last written: review 2026-10-07)
      const rows = db
        .prepare('SELECT id, parent_id, directory, title, version, tokens_output, tokens_reasoning, time_created, time_updated FROM session WHERE time_updated >= ? OR id IN (SELECT session_id FROM message WHERE time_updated >= ?) OR id IN (SELECT session_id FROM part WHERE time_updated >= ?)')
        .all(since, since, since);
      for (const r of rows) if (!r.parent_id) this.opencodeSession(db, r, since);
      const latest = db.prepare('SELECT MAX(t) AS t FROM (SELECT MAX(time_updated) AS t FROM session UNION ALL SELECT MAX(time_updated) FROM message UNION ALL SELECT MAX(time_updated) FROM part)').get()?.t;
      this.oc.since = Math.max(this.oc.since, Number(latest) || 0);
      this.oc.mtime = mt;
    } catch (e) {
      // Locked while OpenCode writes, or another schema: tried again on the next rescan
      this.lineErrors = (this.lineErrors || 0) + 1;
      if (this.lineErrors === 1) console.warn(`[ingest] OpenCode database skipped: ${e?.message || e}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* closed */
      }
    }
  }

  opencodeSession(db, r, since) {
    const ctx = this.foreignSession('opencode', String(r.id).slice(0, 80));
    const json = (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    this.setCwd(ctx, r.directory);
    if (typeof r.version === 'string') ctx.version = r.version.slice(0, 40);
    // OpenCode names a new session "New session - <time>" until it gives it a title
    if (typeof r.title === 'string' && r.title && !/^New session - /.test(r.title)) this.setTitle(ctx, r.title);
    this.touch(ctx, Number(r.time_created) || 0);
    this.touch(ctx, Number(r.time_updated) || 0);
    let seen = this.oc.seen.get(ctx.id);
    if (!seen) this.oc.seen.set(ctx.id, (seen = { prompts: new Set(), tools: new Set() }));
    for (const m of db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? AND time_updated >= ? ORDER BY time_created').all(r.id, since)) {
      const d = json(m.data);
      if (!d) continue;
      const t = Number(m.time_created) || 0;
      this.touch(ctx, t);
      if (d.role === 'user') {
        if (seen.prompts.has(m.id)) continue;
        const text = opencodeText(db.prepare('SELECT data FROM part WHERE message_id = ?').all(m.id).map((p) => json(p.data)));
        if (!text) continue;
        seen.prompts.add(m.id);
        this.addPrompt(ctx, t, text);
      } else if (d.role === 'assistant') {
        if (typeof d.modelID === 'string' && d.modelID) ctx.model = d.modelID.slice(0, 60);
        ctx.lastStop = d.time?.completed ? 'end_turn' : null;
        const k = opencodeTokens(d.tokens);
        // Its cached input is kept apart already: given whole, the cached part apart (the ledger keeps the largest
        // value of a key, so a message read again while it grows is counted once)
        if (k && (k.input || k.output || k.cacheRead)) this.foreignUsage(ctx, `opencode|${m.id}`, t, d.modelID, { input: k.input + k.cacheRead, cached: k.cacheRead, output: k.output });
      }
    }
    // Tool parts only, and only their name, id, status and input (a part's text, reasoning and tool output can be large:
    // never parsed here). A tool still pending or running is counted once it ended, with its input
    let tools;
    try {
      tools = db
        .prepare("SELECT id, time_created, json_extract(data, '$.tool') AS tool, json_extract(data, '$.callID') AS callID, json_extract(data, '$.state.status') AS status, json_extract(data, '$.state.input') AS input FROM part WHERE session_id = ? AND time_updated >= ? AND json_extract(data, '$.type') = 'tool'")
        .all(r.id, since);
    } catch {
      tools = []; // an SQLite without JSON functions: no tool calls, the rest stays
    }
    for (const p of tools) {
      if (seen.tools.has(p.id) || (p.status !== 'completed' && p.status !== 'error')) continue;
      const call = opencodeToolCall({ type: 'tool', tool: p.tool, callID: p.callID, state: { input: typeof p.input === 'string' ? json(p.input) : null } });
      if (!call) continue;
      seen.tools.add(p.id);
      this.foreignTool(ctx, call, Number(p.time_created) || 0);
    }
    // A session that fell out of the window and came back goes on from its own count (its tokens are a running total)
    const total = (Number(r.tokens_output) || 0) + (Number(r.tokens_reasoning) || 0);
    if (!ctx.tokensOut && this.oc.out.has(ctx.id)) ctx.tokensOut = this.oc.out.get(ctx.id);
    this.foreignTokens(ctx, Number(r.time_updated) || 0, total, null);
    this.oc.out.set(ctx.id, Math.max(total, this.oc.out.get(ctx.id) || 0));
    this.markDirty(ctx);
  }

  // Cursor CLI's meta.json of a session (chats/<hash>/<uuid>/meta.json: its folder and times). Looked for once per
  // session (st.metaFile keeps where it is), then only that file is read again (review 2026-10-07)
  cursorMeta(st) {
    const read = (file) => {
      try {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        return m && typeof m === 'object' ? m : null;
      } catch {
        return null;
      }
    };
    if (st.metaFile) return read(st.metaFile);
    if (st.metaMissing) return null;
    const chats = path.join(this.foreignDirs.cursor, 'chats');
    let hashes = [];
    try {
      hashes = fs.readdirSync(chats);
    } catch {
      hashes = [];
    }
    for (const h of hashes) {
      const file = path.join(chats, h, st.sessionId, 'meta.json');
      const m = read(file);
      if (m) {
        st.metaFile = file;
        return m;
      }
    }
    st.metaMissing = true; // looked for once; the transcript's own time stands in
    return null;
  }

  // One line of a Cursor CLI transcript (server/toolLogs.mjs). The lines have no time: the session's times come from
  // its meta.json, read again whenever the transcript grew
  cursorRecord(st, o) {
    if (!st.ctx) st.ctx = this.foreignSession('cursor', st.sessionId);
    const ctx = st.ctx;
    if (!st.metaRead) {
      st.metaRead = true;
      const m = this.cursorMeta(st);
      if (m) {
        this.setCwd(ctx, m.cwd);
        st.created = Number(m.createdAtMs) || 0;
        this.touch(ctx, st.created);
        this.touch(ctx, Number(m.updatedAtMs) || 0);
      }
      // The transcript's own time: the lines have none, and meta.json may lag behind a turn
      this.touch(ctx, st.fileTime || 0);
    }
    const t = ctx.lastAt || st.created || 0;
    const text = cursorPromptText(o);
    if (text) {
      ctx.lastStop = null;
      this.addPrompt(ctx, t, text);
    }
    for (const call of cursorToolCalls(o)) this.foreignTool(ctx, call, t);
    if (o?.type === 'turn_ended') ctx.lastStop = 'end_turn';
  }

  // One Copilot CLI event (server/toolLogs.mjs). Its tokens come at each shutdown, that run's own (one ledger record per
  // shutdown event)
  copilotRecord(st, o) {
    const d = o?.data || {};
    if (!st.ctx) st.ctx = this.foreignSession('copilot', String(d.sessionId || st.sessionId || '').toLowerCase().slice(0, 80) || st.sessionId);
    const ctx = st.ctx;
    if (!ctx) return;
    const t = toMs(o.timestamp);
    this.touch(ctx, t);
    if (o.type === 'session.start') {
      this.setCwd(ctx, d.context?.cwd);
      if (typeof d.copilotVersion === 'string') ctx.version = d.copilotVersion.slice(0, 40);
    } else if (o.type === 'session.model_change' && typeof d.newModel === 'string') ctx.model = d.newModel.slice(0, 60);
    else if (o.type === 'user.message' && typeof d.content === 'string' && d.content.trim()) {
      ctx.lastStop = null;
      this.addPrompt(ctx, t, d.content.trim());
    } else if (o.type === 'assistant.message' && typeof d.model === 'string' && d.model) ctx.model = d.model.slice(0, 60);
    else if (o.type === 'tool.execution_start') {
      const call = copilotToolCall(d);
      if (call) this.foreignTool(ctx, call, t);
    } else if (o.type === 'assistant.turn_end') ctx.lastStop = 'end_turn';
    else if (o.type === 'session.shutdown') {
      const k = copilotTokens(d.tokenDetails);
      if (k) {
        // Each shutdown holds that run's own tokens, not the session's total (checked on a session continued here:
        // its second shutdown had only the second run's output): the session's count adds them up
        this.foreignTokens(ctx, t, ctx.tokensOut + k.output, null);
        // Its input is already without the cached part (as Claude's): given whole, the cached part apart
        this.foreignUsage(ctx, `copilot|${ctx.id}|${o.id || t}`, t, d.currentModel || ctx.model, { input: k.input + k.cacheRead, cached: k.cacheRead, output: k.output, cacheWrite: k.cacheWrite });
      }
    }
  }

  async processForeign(abs, st) {
    // The session fell out of the window (sweep) and its log grew again (a resumed session): it comes back with its
    // folder, never written into an object the page no longer sees (review 2026-10-07)
    if (st.ctx && this.sessions.get(st.ctx.id) !== st.ctx) {
      const old = st.ctx;
      st.ctx = this.foreignSession(st.tool, old.id);
      if (old.version) st.ctx.version = old.version;
      // Codex's tokens are a running total: the session goes on from its own count, never counts it all again
      st.ctx.tokensOut = old.tokensOut;
      st.ctx.contextTokens = old.contextTokens;
      this.setCwd(st.ctx, old.cwd);
    }
    // A Cursor transcript that grew: its meta.json (the session's times) is read again
    if (st.tool === 'cursor') {
      st.metaRead = false;
      try {
        st.fileTime = (await stat(abs)).mtimeMs;
      } catch {
        /* deleted meanwhile */
      }
    }
    if (st.whole) {
      // An old Gemini session file is written whole: read again when it changed; st.seen keeps it from counting twice
      const o = await readJson(abs);
      if (o) this.geminiRecord(st, o);
      return;
    }
    st.offset = await readLinesFrom(abs, st.offset, (buf, a, b) => {
      try {
        // A tool's output (often large) holds nothing the session keeps: not parsed
        if (st.tool === 'codex' && /"payload":\{"type":"(?:function_call_output|custom_tool_call_output)"/.test(buf.toString('latin1', a, Math.min(b, a + 200)))) return;
        const o = parseLine(buf, a, b);
        if (!o) return;
        if (st.tool === 'codex') this.codexRecord(st, o);
        else if (st.tool === 'qwen') this.qwenRecord(st, o);
        else if (st.tool === 'copilot') this.copilotRecord(st, o);
        else if (st.tool === 'cursor') this.cursorRecord(st, o);
        else this.geminiRecord(st, o);
      } catch (e) {
        this.lineErrors = (this.lineErrors || 0) + 1;
        if (this.lineErrors === 1) console.warn(`[ingest] line skipped (${path.basename(abs)}): ${e?.message || e}`);
      }
    });
  }

  // Codex's YYYY/MM/DD folders: a day before the window is not looked into (a heavy user has thousands of logs, and
  // the rescan runs every 15 s); a folder that is not a date is walked as usual
  async walkCodex(dir, out, depth = 0, date = []) {
    if (depth > 4) return out;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const d = /^\d{1,4}$/.test(e.name) ? [...date, Number(e.name)] : date;
        // The day after this folder's last day (a year or a month counts to its end): older than the window, skipped
        if (d.length === date.length + 1 && d.length <= 3) {
          const end = Date.UTC(d[0], d.length > 1 ? d[1] - 1 : 12, d.length > 2 ? d[2] + 1 : d.length > 1 ? 32 : 1);
          if (Number.isFinite(end) && end < this.cutoff - 86400000) continue;
        }
        await this.walkCodex(abs, out, depth + 1, d);
      } else if (e.name.endsWith('.jsonl')) {
        try {
          const s = await stat(abs);
          out.push({ abs, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* deleted in a race */
        }
      }
    }
    return out;
  }

  // The other tools' log files (with their size and time), within the window
  async walkForeign() {
    const out = [];
    if (this.foreignDirs.codex) await this.walkCodex(this.foreignDirs.codex, out);
    // Gemini CLI and Qwen Code: <root>/<project>/chats/<file>
    for (const root of [this.foreignDirs.gemini, this.foreignDirs.qwen]) if (root) await this.walkChats(root, out);
    if (this.foreignDirs.copilot) await this.walkCopilot(this.foreignDirs.copilot, out);
    if (this.foreignDirs.cursor) await this.walkCursor(this.foreignDirs.cursor, out);
    return out.filter((f) => this.classify(f.abs)?.kind === 'foreign');
  }

  // Cursor CLI: <cursor>/projects/<folder>/agent-transcripts/<uuid>/<uuid>.jsonl
  async walkCursor(root, out) {
    let projects = [];
    try {
      projects = await readdir(path.join(root, 'projects'), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const tr = path.join(root, 'projects', p.name, 'agent-transcripts');
      let ids = [];
      try {
        ids = await readdir(tr);
      } catch {
        continue;
      }
      for (const id of ids) {
        const abs = path.join(tr, id, `${id}.jsonl`);
        try {
          const s = await stat(abs);
          out.push({ abs, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* not a transcript */
        }
      }
    }
    return out;
  }

  // Copilot CLI: <session-state>/<uuid>/events.jsonl
  async walkCopilot(root, out) {
    let dirs = [];
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const abs = path.join(root, d.name, 'events.jsonl');
      try {
        const s = await stat(abs);
        out.push({ abs, mtime: s.mtimeMs, size: s.size });
      } catch {
        /* a VS Code chat's folder: no events file */
      }
    }
    return out;
  }

  async walkChats(root, out) {
    let slugs = [];
    try {
      slugs = await readdir(root, { withFileTypes: true });
    } catch {
      return out; // the tool is not here
    }
    for (const d of slugs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name, 'chats');
      let ents = [];
      try {
        ents = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of ents) {
        if (!/\.jsonl?$/.test(name)) continue;
        const abs = path.join(dir, name);
        try {
          const s = await stat(abs);
          out.push({ abs, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* deleted in a race */
        }
      }
    }
    return out;
  }

  // ---------- ajan durumu ----------
  agentStatus(ag, now = Date.now()) {
    if (ag.lastStop === 'end_turn' || ag.lastStop === 'stop_sequence') return 'done';
    // Its session's process ended (the terminal was closed): an agent runs inside it, so it stopped there, unless a line
    // came later (the session was resumed)
    if (ag.parentClosedAt && !(ag.lastAt > ag.parentClosedAt)) return 'stopped';
    // No timed line at all (every line of its file fell before the window): nothing shows it runs, so it is stopped and
    // the sweep prunes it. A new line sets lastAt and makes it run again.
    if (ag.lastAt && now - ag.lastAt < AGENT_STALE_MS) return 'running';
    return 'stopped';
  }

  refreshAgentStatus(ag) {
    const prev = ag.status;
    const next = this.agentStatus(ag);
    if (prev === next) return;
    ag.status = next;
    this.dirty.agents.add(ag.id);
    if (ag.projectId) this.dirty.projects.add(ag.projectId);
    // One "done" event per agent: an agent that finishes again after re-running via SendMessage must not inflate the counter
    if (next === 'done' && !ag.workflowRunId && !ag.doneEmitted) {
      ag.doneEmitted = true;
      this.addEvent({
        t: ag.lastAt || Date.now(),
        kind: 'agent_done',
        projectId: ag.projectId,
        sessionId: ag.sessionId,
        actor: 'a:' + ag.id,
        text: ag.description || ag.type,
        meta: { type: ag.type, toolCalls: ag.toolCalls, tokensOut: ag.tokensOut, durationMs: Math.max(0, ag.lastAt - ag.startedAt) },
      });
    }
  }

  // ---------- workflow record ----------
  processWorkflow(abs, st) {
    const d = readJson(abs);
    if (!d) return;
    const w = this.ensureWorkflow(st.runId, st.sessionId, st.slug);
    w.name = d.workflowName || w.name;
    w.status = d.status || w.status;
    w.agentCount = d.agentCount ?? w.agentCount;
    w.phases = Array.isArray(d.phases) ? d.phases.map((p) => p.title || p) : w.phases;
    w.totalTokens = d.totalTokens || 0;
    w.totalToolCalls = d.totalToolCalls || 0;
    w.durationMs = d.durationMs || 0;
    w.startedAt = toMs(d.startTime) || toMs(d.timestamp) || w.startedAt;
    w.endedAt = w.startedAt && w.durationMs ? w.startedAt + w.durationMs : toMs(d.timestamp);
    w.summary = truncate(redact(d.summary), 400);
    w.model = d.defaultModel || w.model;
    if (w.status !== 'running' && !w.doneEmitted) {
      w.doneEmitted = true;
      this.addEvent({
        t: w.endedAt || Date.now(),
        kind: 'workflow_done',
        projectId: w.projectId,
        sessionId: w.sessionId,
        actor: 'w:' + w.id,
        text: w.name || w.id,
        meta: { status: w.status, agentCount: w.agentCount, totalTokens: w.totalTokens },
      });
    }
    this.dirty.workflows.add(w.id);
    if (w.projectId) this.dirty.projects.add(w.projectId);
  }

  // ---------- file reading ----------
  async processFile(abs) {
    const c = this.classify(abs);
    if (!c) return;
    let st = this.files.get(abs);
    if (!st) {
      st = { ...c, offset: 0, lastMsgId: null, lastMsgOut: 0, busy: false, again: false, seen: new Map(), ctx: null };
      this.files.set(abs, st);
    }
    if (st.busy) {
      st.again = true;
      return;
    }
    st.busy = true;
    try {
      do {
        st.again = false;
        if (c.kind === 'workflow') {
          this.processWorkflow(abs, st);
          continue;
        }
        if (c.kind === 'foreign') {
          try {
            await this.processForeign(abs, st);
          } catch {
            // locked or deleted: retried on the next scan
          }
          if (st.ctx && !st.skip) this.markDirty(st.ctx);
          continue;
        }
        const ctx = c.kind === 'main' ? this.getSession(c.sessionId, c.slug) : this.getAgent(c, abs);
        try {
          // Errors are caught per line: if one broken line cut the read short and left the offset behind,
          // earlier lines of the same chunk would be reprocessed and double-counted on every scan
          st.offset = await readLinesFrom(abs, st.offset, (buf, a, b) => {
            try {
              this.line(ctx, st, buf, a, b);
            } catch (e) {
              // The first error is logged once (so it is not swallowed and forgotten)
              this.lineErrors = (this.lineErrors || 0) + 1;
              if (this.lineErrors === 1) console.warn(`[ingest] line skipped (${path.basename(abs)}): ${e?.message || e}`);
            }
          });
        } catch {
          // the file may be locked or deleted; it is retried on the next scan
        }
        if (ctx.isAgent) {
          this.refreshAgentStatus(ctx);
          if (ctx.workflowRunId) this.touchWorkflowFromAgent(ctx);
        }
        this.markDirty(ctx);
      } while (st.again);
    } finally {
      st.busy = false;
    }
  }

  touchWorkflowFromAgent(ag) {
    const w = this.workflows.get(ag.workflowRunId);
    if (!w) return;
    if (!w.projectId && ag.projectId) w.projectId = ag.projectId;
    if (ag.startedAt && (!w.startedAt || ag.startedAt < w.startedAt)) w.startedAt = ag.startedAt;
    if (w.status === 'running') {
      let n = 0;
      for (const aid of this.sessionAgents.get(ag.sessionId) || []) if (this.agents.get(aid)?.workflowRunId === w.id) n++;
      w.agentCount = n;
      if (ag.lastAt > w.endedAt) w.endedAt = ag.lastAt;
    }
    this.dirty.workflows.add(w.id);
  }

  async walk(dir, out = [], depth = 0) {
    if (depth > 6) return out;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (e.name === 'tool-results' || e.name === 'memory' || e.name === 'scripts') continue;
        await this.walk(path.join(dir, e.name), out, depth + 1);
      } else if (e.name.endsWith('.jsonl') || /^wf_.+\.json$/.test(e.name)) {
        const abs = path.join(dir, e.name);
        try {
          const s = await stat(abs);
          out.push({ abs, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* deleted in a race */
        }
      }
    }
    return out;
  }

  async initialScan(onProgress) {
    this.scan = { state: 'loading', done: 0, total: 0, startedAt: Date.now(), finishedAt: 0 };
    const all = [...(await this.walk(PROJECTS_DIR)), ...(await this.walkForeign())];
    const rank = { main: 0, foreign: 0, agent: 1, workflow: 2 };
    const cand = all
      .filter((f) => f.mtime >= this.cutoff)
      .map((f) => ({ ...f, c: this.classify(f.abs) }))
      .filter((f) => f.c)
      .sort((x, y) => rank[x.c.kind] - rank[y.c.kind] || x.mtime - y.mtime);
    this.scan.total = cand.length;
    this.scan.bytes = cand.reduce((s, f) => s + f.size, 0);
    let last = Date.now();
    for (const f of cand) {
      await this.processFile(f.abs);
      this.scan.done++;
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress?.(this.scan);
        await new Promise((r) => setImmediate(r));
      }
    }
    // OpenCode's database (not a log file)
    await this.scanOpenCode();
    // Latest agent state and "done" events
    for (const ag of this.agents.values()) this.refreshAgentStatus(ag);
    this.events.sort((a, b) => a.t - b.t);
    this.ticks.sort((a, b) => a[0] - b[0]);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
    this.initial = false;
    this.pendingEvents = [];
    this.pendingTicks = [];
    for (const k of Object.keys(this.dirty)) this.dirty[k].clear();
    this.scan.state = 'ready';
    this.scan.finishedAt = Date.now();
    onProgress?.(this.scan);
  }

  startWatching() {
    try {
      this.watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_evt, fname) => {
        if (!fname) return;
        const f = String(fname);
        if (f.includes('tool-results') || !/(\.jsonl|wf_[^\\/]+\.json)$/.test(f)) return;
        this.queue.add(path.join(PROJECTS_DIR, f));
      });
      this.watcher.on('error', () => {});
    } catch {
      /* izleme yoksa periyodik tarama yeter */
    }
    // The other tools' logs: their folders may not exist (the tool is not installed); the 15 s rescan finds new ones
    this.foreignWatchers = [];
    for (const dir of [this.foreignDirs.codex, this.foreignDirs.gemini, this.foreignDirs.qwen, this.foreignDirs.copilot, this.foreignDirs.cursor && path.join(this.foreignDirs.cursor, 'projects')]) {
      if (!dir) continue;
      try {
        const w = fs.watch(dir, { recursive: true }, (_evt, fname) => {
          if (!fname) return;
          const abs = path.join(dir, String(fname));
          if (this.classify(abs)?.kind === 'foreign') this.queue.add(abs);
        });
        w.on('error', () => {});
        this.foreignWatchers.push(w);
      } catch {
        /* missing folder: the rescan is enough */
      }
    }
    setInterval(() => this.drain(), 400).unref();
    setInterval(() => this.rescan(), 15000).unref();
    setInterval(() => this.sweep(), 15000).unref();
  }

  async drain() {
    if (this.draining || !this.queue.size) return;
    this.draining = true;
    try {
      const items = [...this.queue];
      this.queue.clear();
      for (const f of items) await this.processFile(f);
    } finally {
      this.draining = false;
    }
  }

  async rescan() {
    const all = [...(await this.walk(PROJECTS_DIR)), ...(await this.walkForeign())];
    for (const f of all) {
      if (f.mtime < this.cutoff) continue;
      const st = this.files.get(f.abs);
      // A file written whole (a workflow record, an old Gemini session) is read again when its time changed
      const whole = st && (st.kind === 'workflow' || st.whole);
      if (!st || (!whole && f.size !== st.offset) || (whole && f.mtime > (st.mtime || 0))) {
        if (whole) st.mtime = f.mtime;
        this.queue.add(f.abs);
      }
    }
    await this.scanOpenCode();
  }

  // Periodic maintenance: count quiet agents as "stopped", close stuck workflows, prune everything
  // that fell out of the window (so memory and "last N days" stay right even if the server stays up for days).
  sweep() {
    const now = Date.now();
    for (const ag of this.agents.values()) if (ag.status === 'running') this.refreshAgentStatus(ag);

    // A workflow that dies before its record file (wf_*.json) is ever written must not stay "running" forever
    for (const w of this.workflows.values()) {
      if (w.status !== 'running') continue;
      let active = false;
      let last = w.endedAt || w.startedAt || 0;
      for (const aid of this.sessionAgents.get(w.sessionId) || []) {
        const a = this.agents.get(aid);
        if (!a || a.workflowRunId !== w.id) continue;
        if (a.status === 'running') active = true;
        if (a.lastAt > last) last = a.lastAt;
      }
      // No time at all (only agents with no timed line in the window): stopped as well, and pruned below
      if (!active && (!last || now - last > AGENT_STALE_MS)) {
        w.status = 'stopped';
        w.endedAt = last;
        this.dirty.workflows.add(w.id);
        if (w.projectId) this.dirty.projects.add(w.projectId);
      }
    }

    this.cutoff = now - WINDOW_DAYS * 86400000;
    const cut = this.cutoff;
    for (const [id, s] of this.sessions) {
      if (s.live || (s.lastAt || s.startedAt || 0) >= cut) continue;
      this.sessions.delete(id);
      // OpenCode's per-session memory of what was counted goes with it (its rows older than the window are not read
      // again); its running total stays in oc.out, one number a session
      this.oc.seen.delete(id);
      if (s.projectId) {
        this.projectSessions.get(s.projectId)?.delete(id);
        this.dirty.projects.add(s.projectId);
      }
      this.dirty.sessions.delete(id);
      this.removed.sessions.push(id);
    }
    for (const [id, a] of this.agents) {
      if (a.status === 'running' || (a.lastAt || a.startedAt || 0) >= cut) continue;
      this.agents.delete(id);
      this.sessionAgents.get(a.sessionId)?.delete(id);
      if (a.projectId) {
        this.projectAgents.get(a.projectId)?.delete(id);
        this.dirty.projects.add(a.projectId);
      }
      this.dirty.agents.delete(id);
      this.removed.agents.push(id);
    }
    for (const [sid, set] of this.sessionAgents) if (!set.size && !this.sessions.has(sid)) this.sessionAgents.delete(sid);
    for (const [id, w] of this.workflows) {
      if (w.status === 'running' || (w.endedAt || w.startedAt || 0) >= cut) continue;
      this.workflows.delete(id);
      this.dirty.workflows.delete(id);
      this.removed.workflows.push(id);
    }
    for (const [k, c] of this.agentCalls) if ((c.t || 0) < cut) this.agentCalls.delete(k);
    // File offsets (this.files) are deliberately not pruned: if one is removed, a rescan reads the file from the start and
    // recreates the pruned session every 15 s. The record is a few hundred bytes per file and
    // bounded by the file count; if a line is appended to a file, only those lines are read.
    if (this.events.length && this.events[0].t < cut) this.events = this.events.filter((e) => e.t >= cut);
    if (this.ticks.length && this.ticks[0][0] < cut) this.ticks = this.ticks.filter((t) => t[0] >= cut);

    const minHour = Math.floor(cut / HOUR) - 24;
    const minDay = Math.floor(cut / 86400000);
    const prune = (m) => {
      for (const h of m.keys()) if (h < minHour) m.delete(h);
    };
    for (const m of this.hourly.values()) prune(m);
    for (const pm of this.projHourly.values()) for (const m of pm.values()) prune(m);
    for (const map of Object.values(this.usage)) {
      for (const [k, u] of map) {
        for (const d of u.days.keys()) if (d < minDay) u.days.delete(d);
        u.recent = u.recent.filter((r) => r.t >= cut);
        if (!u.days.size) map.delete(k);
      }
    }
  }

  // Feeds live session records (~/.claude/sessions) into the model
  setLive(liveMap) {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.live && !liveMap.has(s.id)) {
        s.live = null;
        this.dirty.sessions.add(s.id);
        if (s.projectId) this.dirty.projects.add(s.projectId);
        this.addEvent({ t: now, kind: 'live', projectId: s.projectId, sessionId: s.id, actor: 's:' + s.id, text: 'Session closed', meta: { status: 'closed' } });
        // Its agents end with it (seen 2026-10-01: a closed terminal left a background agent "running" for ten minutes)
        for (const aid of this.sessionAgents.get(s.id) || []) {
          const ag = this.agents.get(aid);
          if (!ag || ag.status !== 'running') continue;
          ag.parentClosedAt = now;
          this.refreshAgentStatus(ag);
        }
      }
    }
    for (const [id, l] of liveMap) {
      const s = this.getSession(id, slugify(l.cwd || ''));
      if (!s.cwd && l.cwd) this.setCwd(s, l.cwd);
      if (!s.startedAt) s.startedAt = l.startedAt || now;
      const prev = s.live?.status;
      const changed = !s.live || s.live.status !== l.status || s.live.pid !== l.pid || s.live.name !== l.name || (s.live.waitingFor || '') !== (l.waitingFor || '');
      s.live = l;
      if (changed) {
        this.dirty.sessions.add(s.id);
        if (s.projectId) this.dirty.projects.add(s.projectId);
        if (prev !== l.status) {
          const text = !prev ? 'Session open' : l.status === 'busy' ? 'Working' : l.status === 'waiting' ? `Waiting for you${l.waitingFor ? ': ' + l.waitingFor : ''}` : 'Finished its turn, waiting';
          this.addEvent({ t: l.statusUpdatedAt || now, kind: 'live', projectId: s.projectId, sessionId: s.id, actor: 's:' + s.id, text, meta: { status: l.status, prev: prev || null } });
        }
      }
    }
  }
}
