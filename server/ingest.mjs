// @ts-check
// Incrementally reads Claude Code session logs (~/.claude/projects) and builds an in-memory state model:
// sessions, sub-agents, workflow runs, the event feed, tool-call ticks, usage counters.
// The byte offset reached in each file is kept; only new lines are processed. Heavy lines (attachments,
// tool results) are skipped by looking at the first few hundred bytes, without converting to JSON.
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, CODEX_SESSIONS_DIR, GEMINI_TMP_DIR, QWEN_PROJECTS_DIR, COPILOT_SESSIONS_DIR, OPENCODE_DB, CURSOR_DIR, WINDOW_DAYS, MAX_EVENTS, MAX_TICKS, AGENT_STALE_MS } from './config.mjs';
import { classifyForeign } from './toolLogs.mjs';
import { readLinesFrom, readJson, toMs, truncate, redact, slugify } from './util.mjs';
import { apiErrorOf } from './apierror.mjs';
import { readJobText } from './job-id.mjs';
import { isLocalPath } from './fsutil.mjs';
import { commandLabel, commandKey, shellOutcome, backgroundEnd, jobCommandsSummary, COMMANDS_MAX, BG_WAIT_MAX_MS } from './jobCommands.mjs';
import { isReviewerType, blockVerdict, jobReviewersSummary, VERDICTS_KEPT } from './jobReviewers.mjs';
import { ForeignReaders } from './ingestForeign.mjs';
import { PLAN_MAX, toolCategory, programName, actionText, extractText, parseLine, workflowNameOf } from './ingestText.mjs';
// Imported from here by tests and other modules before the split
export { PLAN_MAX, toolCategory, programRest, programName, actionText } from './ingestText.mjs';

const HOUR = 3600000;
// The key that names a tool result's call, as it stands unescaped in a log line (server/jobCommands.mjs)
const TOOL_USE_ID_KEY = Buffer.from('"tool_use_id":"');

export class Ingest extends ForeignReaders {
  constructor(catalog) {
    super();
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

  // The catalog's ids moved (a project linked to its new folder, relinks.mjs): every session with a known folder takes
  // the project its folder resolves to now (its agents follow it in assignSessionProject). Returns how many moved
  reresolveProjects() {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!s.cwd) continue;
      const pid = this.catalog.resolve(s.cwd, s.slug);
      if (pid && pid !== s.projectId) {
        this.assignSessionProject(s, pid);
        this.dirty.sessions.add(s.id);
        n++;
      }
    }
    return n;
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
    if (ctx.shellWait?.size) this.shellLine(ctx, buf, a, b, head);
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
      if (head.includes('"content":[{"tool_use_id"') || head.includes('"content":[{"type":"tool_result"')) {
        // Tool results are skipped, except the one that hands an agent's work back (Claude Code 2.1.29x:
        // SubagentHandback, marked toolEndsTurn): the agent's last line, so it is done. No end_turn comes then (tried
        // on Linux, 2026-10-09: finished agents ran on for ten minutes, then counted as stopped). Looked for within this
        // line only (a subarray, no copy): the buffer holds megabytes of lines after it
        if (ctx.isAgent && buf.subarray(a, b).includes('"toolEndsTurn":true')) {
          const o = parseLine(buf, a, b);
          if (o?.toolEndsTurn === true) {
            this.touch(ctx, toMs(o.timestamp));
            ctx.lastStop = 'end_turn';
          }
        }
        return;
      }
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
      for (const block of m.content) if (block?.type === 'tool_use') this.toolUse(ctx, block, t, o.cwd);
      if (ctx.isAgent && isReviewerType(ctx.type)) this.reviewerAnswer(ctx, m.content, t);
    }
  }

  // A reviewer agent's answer (server/jobReviewers.mjs, plan E4): the verdict its last text or its hand-back says, kept
  // with when it said it; nothing else of the answer
  reviewerAnswer(ctx, content, t) {
    for (const block of content) {
      const v = blockVerdict(block);
      if (!v) continue;
      if (!ctx.verdicts) ctx.verdicts = [];
      if (ctx.verdicts.some((x) => x.at === t && x.value === v.value)) continue;
      ctx.verdicts.push({ value: v.value, jobId: v.jobId, at: t });
      ctx.verdicts.sort((x, y) => x.at - y.at);
      if (ctx.verdicts.length > VERDICTS_KEPT) ctx.verdicts.shift();
    }
  }

  toolUse(ctx, block, t, cwd = null) {
    const name = block.name || '?';
    const input = block.input || {};
    ctx.toolCalls++;
    ctx.toolCounts[name] = (ctx.toolCounts[name] || 0) + 1;
    const actor = (ctx.isAgent ? 'a:' : 's:') + ctx.id;
    const sessionId = ctx.isAgent ? ctx.sessionId : ctx.id;
    const cat = toolCategory(name);
    this.addTick(t, actor, cat, ctx.projectId);
    if (!ctx.lastAction || t >= ctx.lastAction.t) ctx.lastAction = { t, tool: name, cat, text: truncate(redact(actionText(name, input)), 90) };
    if ((name === 'Bash' || name === 'PowerShell') && typeof block.id === 'string') this.noteShell(ctx, block.id, input, t, cwd);
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

  // A shell call of a job's session or of its agents (server/jobCommands.mjs): kept with a label, waiting for its
  // result. Only for a job (no other session pays for it); at most COMMANDS_MAX per session or agent, the oldest
  // dropped (the counts keep every one that ended)
  noteShell(ctx, id, input, t, cwd = null) {
    const jobId = ctx.isAgent ? this.sessions.get(ctx.sessionId)?.jobId : ctx.jobId;
    if (!jobId) return;
    if (!ctx.shellWait) {
      ctx.shellWait = new Map(); // tool-use id -> entry, while its end is not known
      ctx.commands = new Map(); // tool-use id -> entry, in the order the calls came
      ctx.commandsDropped = { ok: 0, failed: 0, 'not-run': 0, 'no-code': 0 };
      ctx.bgWaits = 0;
    }
    if (ctx.commands.has(id)) return;
    const { label, more, joins } = commandLabel(input.command);
    const e = { id, label, more, joins, key: commandKey(input.command, cwd || ctx.cwd), at: t, end: 'running', code: null, bg: input.run_in_background === true, bgWait: false, bgAt: 0 };
    ctx.commands.set(id, e);
    ctx.shellWait.set(id, e);
    if (ctx.commands.size > COMMANDS_MAX) {
      // The oldest leaves the list but not the counts; one still waiting counts as ended with no known code
      const [oldId, old] = ctx.commands.entries().next().value;
      ctx.commands.delete(oldId);
      if (ctx.shellWait.delete(oldId) && old.bgWait) ctx.bgWaits--;
      ctx.commandsDropped[old.end === 'running' ? 'no-code' : old.end]++;
    }
  }

  // A line of a session that waits on shell calls: their result (tool_result), or a background command's end
  // (<task-notification>: a queue-operation line, a queued_command attachment or a user line). The results' ids are
  // found in one pass over the line ("tool_use_id":" unescaped: the key itself, not a quote of it in some output); the
  // line is parsed only when one of them waits (tool results can be large)
  shellLine(ctx, buf, a, b, head) {
    if (head.includes('"type":"tool_result"') || head.includes('"tool_use_id"')) {
      const line = buf.subarray(a, b);
      let o;
      let parsed = false;
      for (let at = line.indexOf(TOOL_USE_ID_KEY); at >= 0; at = line.indexOf(TOOL_USE_ID_KEY, at + TOOL_USE_ID_KEY.length)) {
        const from = at + TOOL_USE_ID_KEY.length;
        const end = line.indexOf(0x22, from);
        if (end < 0 || end - from > 80) continue;
        const id = line.toString('latin1', from, end);
        const e = ctx.shellWait.get(id);
        if (!e || e.bgWait) continue;
        if (!parsed) {
          o = parseLine(buf, a, b);
          parsed = true;
        }
        const content = o?.message?.content;
        const block = Array.isArray(content) ? content.find((x) => x?.type === 'tool_result' && x.tool_use_id === id) : null;
        if (block) this.endShell(ctx, id, e, shellOutcome(o, block, e.bg), toMs(o.timestamp));
      }
      return;
    }
    if (!ctx.bgWaits || !(head.includes('"type":"queue-operation"') || head.includes('"attachment":{"type":"queued_command"') || head.includes('"type":"user"'))) return;
    // A background command whose end never came is not waited for forever (each line of its session would be searched)
    for (const [id, e] of ctx.shellWait) if (e.bgWait && ctx.lastAt - e.bgAt > BG_WAIT_MAX_MS) this.endShell(ctx, id, e, { end: 'no-code' }, 0);
    if (!ctx.bgWaits || !buf.subarray(a, b).includes('<task-notification>')) return;
    let t = 0;
    for (const part of buf.toString('utf8', a, b).split('<task-notification>').slice(1)) {
      const r = backgroundEnd(part);
      const e = r && ctx.shellWait.get(r.id);
      if (!e?.bgWait) continue;
      t ||= toMs(parseLine(buf, a, b)?.timestamp);
      this.endShell(ctx, r.id, e, r, t);
    }
  }

  endShell(ctx, id, e, r, t) {
    if (r.end === 'background') {
      e.bgWait = true;
      e.bgAt = t || ctx.lastAt;
      ctx.bgWaits++;
      return;
    }
    ctx.shellWait.delete(id);
    if (e.bgWait) ctx.bgWaits--;
    e.bgWait = false;
    e.end = r.end;
    if (Number.isInteger(r.code)) e.code = r.code;
    if (t) e.endAt = t;
  }

  // The commands of a job's sessions and their agents (server/jobCommands.mjs jobCommandsSummary); null when no
  // session of the job is known. A Job-ID is random and unique, so the job's sessions are found by it alone
  jobCommands(jobId) {
    const sessions = [];
    for (const s of this.sessions.values()) if (s.jobId === jobId) sessions.push(s);
    return jobCommandsSummary(sessions, (sid) => [...(this.sessionAgents.get(sid) || [])].map((aid) => this.agents.get(aid)).filter(Boolean));
  }

  // How many sessions of a project other than the job's own were open in [from, to), from their start to their last line
  // (server/jobCost.mjs: their usage in those hours counts toward the job's); null when that span starts before the log
  // window or the first scan runs
  otherSessionsIn(projectId, from, to, jobId) {
    if (this.scan.state === 'loading' || !(from >= this.cutoff)) return null;
    let n = 0;
    for (const sid of this.projectSessions.get(projectId) || []) {
      const s = this.sessions.get(sid);
      if (s && s.jobId !== jobId && s.startedAt && s.startedAt < to && s.lastAt >= from) n++;
    }
    return n;
  }

  // A job's reviewer agents and what their own last answer said (server/jobReviewers.mjs jobReviewersSummary); null
  // when no session of the job is known, and while the first scan runs (sessions are read before their agents: "no
  // reviewer seen" would be said too soon, and kept in the record). before: REVIEW.md's write time
  jobReviewers(jobId, { before = null } = {}) {
    if (this.scan.state === 'loading') return null;
    const sessions = [];
    for (const s of this.sessions.values()) if (s.jobId === jobId) sessions.push(s);
    return jobReviewersSummary(sessions, (sid) => [...(this.sessionAgents.get(sid) || [])].map((aid) => this.agents.get(aid)).filter(Boolean), { before, jobId });
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

  // ---------- other AI tools' logs: server/ingestForeign.mjs (the class this one extends) ----------

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
          }, { onSkip: (n) => this.longLine(abs, n) });
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
