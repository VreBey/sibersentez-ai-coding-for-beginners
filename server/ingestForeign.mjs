// @ts-check
// The other AI tools' logs (Codex, Gemini CLI, Qwen Code, OpenCode, Cursor, Copilot CLI; server/toolLogs.mjs reads
// their records), moved out of server/ingest.mjs (docs/internal/module-split-plan.md I1). Ingest extends this class, so
// they stay its methods and every call site stays as it was; each one reads the Ingest it belongs to (@this).
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { codexPromptText, codexPermission, codexToolCall, codexTotalOut, codexContext, geminiToolCall, geminiPromptText, geminiOutTokens, qwenPromptText, qwenToolCalls, qwenOutTokens, copilotToolCall, copilotTokens, opencodeText, opencodeToolCall, opencodeTokens, cursorPromptText, cursorToolCalls } from './toolLogs.mjs';
import { readLinesFrom, readJson, toMs, truncate, redact, MAX_LINE_BYTES } from './util.mjs';
import { PLAN_MAX, toolCategory, actionText, parseLine } from './ingestText.mjs';

/** @typedef {import('./ingest.mjs').Ingest} Ingest */

export class ForeignReaders {
  /** @this {Ingest} */
  foreignSession(tool, id) {
    const s = this.getSession(id, null);
    s.tool = tool;
    return s;
  }

  // A tool call of another tool: counted under its own name; its category and one line come from the Claude Code
  // name it matches (Bash, Edit, Read...)
  /** @this {Ingest} */
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
  /** @this {Ingest} */
  foreignUsage(ctx, key, t, model, { input = 0, cached = 0, output = 0, cacheWrite = 0 } = {}) {
    if (!this.ledger || !key) return;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const c = Math.min(n(cached), n(input));
    const usage = { input_tokens: n(input) - c, cache_read_input_tokens: c, output_tokens: n(output) };
    if (n(cacheWrite)) usage.cache_creation_input_tokens = n(cacheWrite);
    this.ledger.add({ key, t, projectId: ctx.projectId, model: model || ctx.model || ctx.tool, usage });
  }

  /** @this {Ingest} */
  foreignTokens(ctx, t, out, context) {
    if (out > ctx.tokensOut) {
      this.bump('tokens', ctx.projectId, t, out - ctx.tokensOut);
      ctx.tokensOut = out;
    }
    if (context != null) ctx.contextTokens = context;
  }

  // One Codex log line ({ timestamp, type, payload }). A sub-agent's own thread (source.subagent) is left out: its
  // lead's session stands for the work.
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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

  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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

  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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

  /** @this {Ingest} */
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
      // An old Gemini session file is written whole: read again when it changed; st.seen keeps it from counting twice.
      // One over the line budget is not read and parsed in one piece
      const bytes = fs.statSync(abs, { throwIfNoEntry: false })?.size ?? 0;
      if (bytes > MAX_LINE_BYTES) {
        this.longLine(abs, bytes);
        return;
      }
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
    }, { onSkip: (n) => this.longLine(abs, n) });
  }

  // A log line over util.mjs MAX_LINE_BYTES was passed over unread: counted, the first one logged
  /** @this {Ingest} */
  longLine(abs, bytes) {
    this.longLines = (this.longLines || 0) + 1;
    if (this.longLines === 1) console.warn(`[ingest] oversized line skipped (${path.basename(abs)}, ${bytes} bytes)`);
  }

  // Codex's YYYY/MM/DD folders: a day before the window is not looked into (a heavy user has thousands of logs, and
  // the rescan runs every 15 s); a folder that is not a date is walked as usual
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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
  /** @this {Ingest} */
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

  /** @this {Ingest} */
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
}
