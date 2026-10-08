# Tool view

Which AI tools see a project or a skill, agent or plugin (backlog "Tool UI", adapters wave 1; done 2026-09-29).

## Data

The server already tags every project with the adapters that found it (`via`) and every roster item with the adapters
that read it (`tools`); the snapshot's `tools` lists the adapters with `detected` and their counts (`toolsView`,
`server/views.mjs`). The minute roster broadcast now carries `tools` too, so the counts stay fresh; the page keeps them
in `store.tools`.

## What the page shows

`public/js/toolTags.js` (pure, `test/tool-view.test.mjs`):

- **Only when more than one tool left traces here** (`multiTool`): with one tool every card would carry the same tag,
  so neither the tags nor the filter appear.
- **Tags**: short names in a fixed color per tool (no logos, no brand art): Claude, Codex, Gemini, Copilot, Cursor,
  Antigravity; a new adapter shows its own name. At most three and "+N"; the full names are in the title. On the
  project cards (footer) and on the roster rows (after the source and category).
- **Filter**: a select in the Projects and Roster toolbars, "All AI tools" then each tool that tags at least one item
  with its count, the most first. A choice that disappears falls back to all. The roster filter is `f.tool` in
  `matchesFilter` (`rosterModel.js`).
- **AI tools panel**: each tool card says what its own traces show here ("Sees here: N projects · N skills · N
  agents"); an installed tool with nothing found says so; a tool not installed gets the line only when it left traces.
  The start-with-AI tool ids map to the adapter ids in `ADAPTER_OF_TOOL`.

## Open

- Same-named plugins of different tools still merge into one roster item (backlog).
- The drawer does not list the tools yet.

## Sessions of every tool (2026-10-07)

Before, only Claude Code's sessions were read (`~/.claude/projects`); the adapters saw the other tools' projects and
items but, by their contract, never a session's content. `server/toolLogs.mjs` (pure) and `server/ingest.mjs` now read
Codex CLI's and Gemini CLI's own session logs with the same session model:

- **Codex:** `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`. The project from `session_meta.cwd`; the
  model and the permission mode from `turn_context` (`approval_policy` and `sandbox_policy` in the page's existing
  words, `codexPermission`); the output tokens from the cumulative `token_count` (answers and reasoning); tool calls
  (`exec`, `apply_patch`, `local_shell_call`...) under their own name, with the category and the one-line description
  of the Claude Code tool they match. Codex writes its own context into user messages (`# AGENTS.md instructions`,
  `<environment_context>`): left out, so the first real prompt names the app job as Claude Code's does. A sub-agent's
  own thread (`source.subagent`, the guardian reviewer's `thread_source`) is left out, and so is a history the Codex
  desktop app imported (no `thread_source`, never a turn Codex ran: on this computer 125 of 136 files, many of them
  Claude Code's own conversations, which would otherwise show twice).
- **Gemini CLI:** `~/.gemini/tmp/<project>/chats/session-*.jsonl` (0.61: a metadata line, message records that may be
  written again with the same id, `$set`, `$rewindTo`; counted once per message and tool call id), and the older
  whole-file `session-*.json` (read again when it changed). The project from `<project>/.project_root`, else
  `~/.gemini/projects.json`. Another program's agent server writes there too (`kind: a2a-serv`): not a session.
- **What is kept** is what Claude Code's sessions keep: the person's prompts, cut and redacted, the counts, the model,
  the last action's one line. Never the AI's answers or the files it read.
- **Qwen Code** (0.25, checked in its package's ChatRecordingService): `~/.qwen/projects/<project>/chats/<id>.jsonl`,
  one record a line (`cwd`, `model`, `message.parts` with text or `functionCall`, Gemini-style `usageMetadata`); the
  real user's prompts only (`provenance`), its tools have Gemini CLI's names; `*.ledger.jsonl` is not a log.
- **Each session says its tool** (`tool`: claude, codex, gemini, qwen). The drawer tags another tool's session and
  names its version row after the tool (`jobId.js` `SESSION_TOOL_NAMES`).
- **Continuing a session uses its own tool** (2026-10-07, step C): each tool's resume arguments are part of its record
  (`server/tools.mjs` `resume`, checked on each tool's `--help`: claude `--resume <id>`, codex `resume <id>`, gemini
  `--resume <uuid>`, copilot `--resume <id>`, cursor `--resume <chatId>`, qwen `--resume <id>`, opencode
  `--session <id>`; `resumeMin` the version they were checked on). The menu, the job box (`resumeCandidate`,
  `jobSession`: the job's own tool's sessions), the terminal tab that ended (`tabResumeSession` with its tool) and
  `main.js resumeSession` continue a session with its own tool through start-ai; the server refuses another tool's
  session (`resume-other-tool`) and an older version (`resume-version`). Windows Terminal's continue and the copy
  (fork) stay Claude Code's (`resume-claude-only`). A session can be continued only when its log is read (Claude
  Code, Codex, Gemini CLI, Qwen Code: `canContinueTool`).
- **Plan mode** for Qwen Code (`--approval-mode plan`, 0.25) and Cursor CLI (`--plan`, 2026.10.01) too.
- **Copilot CLI** (1.0.92, checked on two sessions run here 2026-10-07): `<COPILOT_HOME or ~/.copilot>/session-state/
  <uuid>/events.jsonl` (session.start cwd and version, model_change, user.message the typed text, tool.execution_start,
  session.shutdown tokens). It continues with `copilot --resume=<id>` (`launch.mjs resumeArgs`; the launcher takes an
  option joined to a UUID only).
- **OpenCode** (1.18.35, checked on a session run here): one SQLite database `<XDG_DATA_HOME or ~/.local/share>/
  opencode/opencode.db`, read read-only with `node:sqlite` on the start and each rescan when it changed, only the rows
  updated since (`ingest.mjs scanOpenCode`). Its session ids (`ses_...`) are not UUIDs, so its sessions are shown but
  not continued from SiberSentez (`jobId.js canContinueTool`). Its tool part's fields are OpenCode's documented shape,
  not yet seen in a local session.
- **Cursor CLI** (2026.10.01, checked on a session run here): `~/.cursor/projects/<folder>/agent-transcripts/<uuid>/
  <uuid>.jsonl` (role and content only; the person's words inside `<user_query>`), its folder and times from
  `~/.cursor/chats/<hash>/<uuid>/meta.json`. No model per session. It continues with `cursor-agent --resume <chatId>`.
- **Second test (2026-10-07, after the sign-ins):** Gemini CLI with an API key (Google ended the personal sign-in for
  it), Cursor CLI, OpenCode answered; Qwen Code, whose free sign-in ended 2026-04-15, was set to NVIDIA's OpenAI-like
  endpoint (`~/.qwen/settings.json` modelProviders, `envKey: NVIDIA_API_KEY`, the key never written there) but NVIDIA
  answered nothing within 90 s at the time. All seven tools' sessions are read.
- **Tested 2026-10-07** with one short prompt each in a temporary folder: Claude Code, Codex (exec), Copilot CLI and
  OpenCode wrote sessions that the reader shows; Gemini CLI stopped on its account check
  (`throwIneligibleOrProjectIdError`), Qwen Code and Cursor CLI were not signed in.
- **Not yet:** whether such a session is open now (Claude Code's own live files have no counterpart; an AI tab in
  SiberSentez's terminal says it, `attention.js dockWaiting`); Cursor's model per session.

Tests: `test/tool-logs.test.mjs`.

## Agents for every tool (2026-10-07)

Agents (sub-agents) were installed into `.claude/agents` only. Copilot CLI and Cursor CLI read that folder too (their
adapters), so they already saw them. Gemini CLI, Qwen Code, OpenCode and Codex read their own folder in their own
shape; `server/agentFormats.mjs` converts a Claude Code agent for each, checked in the installed tool:

| Tool | File | Shape |
|---|---|---|
| Gemini CLI 0.61 | `.gemini/agents/<name>.md` | name (a slug), description; its schema is strict, so license, metadata and Claude's tool names are left out |
| Qwen Code 0.25 | `.qwen/agents/<name>.md` | name, description |
| OpenCode 1.18 | `.opencode/agents/<name>.md` | description, `mode: subagent` (its `tools` is a map, not Claude's list) |
| Codex 0.160 | `.codex/agents/<name>.toml` | name, description, `developer_instructions` (Codex says it must define it) |

Tools are left out everywhere (each tool names its own; a wrong name stops the agent from loading); the comment lines
of the frontmatter (the kit's license notice) are kept; the body is the agent's prompt. `server/install.mjs` has the
four as agent-only targets: an agent goes to `.claude` always and to the converted target asked for; the converted
text is written under a staging name in the tool folder and placed like any copy; the record keeps the source's hash
apart (`srcHash`), so an unchanged source is up to date and a changed written file is the person's. A job asks for its
own tool's target (`job.js jobTargets`: a Codex job gets `agents` and `codex`). Checked here: OpenCode listed the
converted `backend-builder`; Gemini CLI started without an agent load error (its model answered 503 at the time).
Tests: `test/agent-formats.test.mjs`.

**Cursor's model (roadmap F4, 2026-10-08): not shown, on purpose.** Its `meta.json` holds no model; its `store.db`
holds only a name, a mode and the times in plain fields, and the conversation itself in encrypted blobs
(`blobEncryptionKey`). Reading the model would mean decrypting the person's conversation, which SiberSentez does not do.
