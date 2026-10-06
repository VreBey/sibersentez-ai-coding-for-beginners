# Discovery adapters, wave 1 — contract

Status: agreed 2026-09-28. Source research: 13 AI coding tools, their project traces and skill/agent locations
(verified against official docs or source code; community sources marked).

## 1. Goal

SiberSentez must not be tied to Claude Code. Every AI coding tool present on the computer contributes:

- **projects**: the folders the tool has been used in (remembered in `<hub>/registry/discovered.json`, `via` = adapter id);
- **items**: the skills, agents and plugins the tool reads, in user scope (active everywhere) and project scope.

The user sees which tools see which project and which item.

## 2. Adapters in this wave

| id | name | detect (any of) |
|---|---|---|
| `claude-code` | Claude Code | existing, unchanged |
| `codex` | Codex | `<CODEX_HOME or ~/.codex>` exists |
| `gemini-cli` | Gemini CLI | `~/.gemini/projects.json`, `~/.gemini/tmp`, `~/.gemini/skills` or `~/.gemini/extensions` exists |
| `copilot` | GitHub Copilot (CLI and VS Code Chat) | `<COPILOT_HOME or ~/.copilot>` exists, or `<APPDATA>/Code/User/globalStorage/github.copilot-chat` exists |
| `cursor` | Cursor | `<APPDATA>/Cursor/User` or `~/.cursor` exists |
| `antigravity` | Antigravity | `<APPDATA>/Antigravity IDE/User`, `~/.gemini/config` or `~/.gemini/antigravity-cli` exists |

Not in this wave (no reliable local project trace or no SQLite reader yet): Cline, Antigravity CLI conversations,
OpenCode, Crush, Qwen Code, Goose, Kiro, Windsurf, Amp.

## 3. Project sources

All sources are plain files. **No SQLite in this wave.**

| Adapter | Source | Folder comes from | lastSeenAt |
|---|---|---|---|
| codex | `<codex>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `<codex>/archived_sessions/**/rollout-*.jsonl` | **first line only** (`SessionMeta`): `payload.cwd`, else top-level `cwd` | file mtime |
| gemini-cli | `~/.gemini/projects.json` → `{"projects": {"<absolute path>": "<id>"}}` | the keys | newest mtime under `tmp/<id>/chats`, else `tmp/<id>` mtime, else 0 |
| gemini-cli | `~/.gemini/tmp/<id>/.project_root`, `~/.gemini/history/<id>/.project_root` | file content (one path, trimmed) | as above |
| copilot | `<copilot>/session-state/<uuid>/workspace.yaml` | the `cwd:` line (plain or quoted scalar; nothing else parsed) | folder mtime |
| copilot | `<APPDATA>/Code/User/workspaceStorage/<hash>/workspace.json` | `folder` URI, **only if** `chatSessions/` or `chatEditingSessions/` in that hash folder has at least one entry | hash folder mtime |
| cursor | `<APPDATA>/Cursor/User/workspaceStorage/<hash>/workspace.json` | `folder` URI (every workspace) | hash folder mtime |
| antigravity | `<APPDATA>/Antigravity IDE/User/workspaceStorage/<hash>/workspace.json` | `folder` URI (every workspace) | hash folder mtime |

Rules:

- A shared helper reads VS Code-style `workspaceStorage` (`vscodeWorkspaces(appDataDir, appName, { requireChat })`).
  `folder` URIs are decoded with `url.fileURLToPath` (handles `file:///c%3A/...`, spaces, non-ASCII);
  the drive letter is upper-cased. `vscode-remote://`, `vscode-vfs://` and other non-`file:` URIs are skipped.
  A `workspace` key (multi-root `.code-workspace`) is skipped in this wave.
- Only local drive-letter paths become projects from editor and tool records. UNC paths (`\\server\share`,
  `\\wsl$`, `\\wsl.localhost`) are skipped: checking them can block on an offline share or wake a WSL distribution.
  (Review round 1, advisory 2.)
- Paths from `projects.json` or `.project_root` may be stored lower-cased. When the folder exists and
  `fs.realpathSync.native` returns the same path compared case-insensitively, use the on-disk casing;
  otherwise keep the stored path (never follow a junction to a different path).
- Caches: a Codex rollout's folder never changes, cache by file path; `workspace.json` and `workspace.yaml` are
  cached by mtime. Cache entries of files that disappeared are dropped (same pattern as `claude-code`).
- Caches keep only results of successful reads: an I/O error (file locked, access denied) is not cached, so the
  file is read again on the next pass. (Review round 1, advisory 10.)
- One pass reads each file and lists each folder at most once, even when several adapters or several markers
  point at it (for example `.agents/skills`, a Gemini id reached from `projects.json` and two markers).
  (Review round 1, advisories 1 and 9.)
- The catalog's existing filters still apply (folder must exist, not broad, not a Claude scratchpad).
- The system temp folder itself (`<home>\AppData\Local\Temp`, `TEMP`, `TMP`) is a broad folder: a tool that once
  ran there must not turn it into a project that swallows every folder under it. (Added in implementation.)
- The project memory keeps the best spelling of a path: when a later report gives the on-disk casing of a path
  that was first stored lower-cased, the stored spelling is updated. (Review round 1, advisory 8.)

### Privacy (hard rule)

- Read only metadata: the first line of a Codex rollout (at most 256 KiB), `workspace.json`, the `cwd:` line of
  `workspace.yaml`, `projects.json`, `.project_root`. Everything else is `stat`/`readdir` only.
- Never open chat or session content: no `chatSessions/*`, no `chats/*`, no `events.jsonl`, no SQLite database.
  The bytes after a rollout's first line that land in the same read chunk are never decoded or parsed; the chunk
  is small (4 KiB). `workspace.yaml` is read only up to its `cwd:` line.
- If a Codex first line is longer than the read limit, extract the first `"cwd":"<json string>"` from the
  read part with a regex and `JSON.parse` the string literal; if not found, skip the file.
- Nothing is ever written into a tool's folders.

## 4. Item sources

`skills` = `<dir>/*/SKILL.md` (a skill is a folder with `SKILL.md`; name = frontmatter `name`, else folder name).
Only `name` and `description` are read; unknown frontmatter keys are ignored.
`md agents` = `*.md` with optional frontmatter (name = frontmatter `name`, else file name without extension).

| Adapter | Project scope (`<p>` = project folder) | User scope (`source`) |
|---|---|---|
| codex | skills `<p>/.agents/skills`; agents `<p>/.codex/agents/*.toml` | skills `~/.agents/skills` (personal), `<codex>/skills/*` except `.system` (personal), `<codex>/skills/.system/*` (builtin); agents `<codex>/agents/*.toml` (personal); plugins `<codex>/plugins/cache/<market>/<plugin>/<version>/` (plugin, with its `skills/`) |
| gemini-cli | skills `<p>/.gemini/skills`, `<p>/.agents/skills`; agents `<p>/.gemini/agents/*.md` | skills `~/.gemini/skills`, `~/.agents/skills` (personal); agents `~/.gemini/agents/*.md` (personal); plugins `~/.gemini/extensions/<dir>/gemini-extension.json` (plugin, with its `skills/` and `agents/`) |
| copilot | skills `<p>/.github/skills`, `<p>/.claude/skills`, `<p>/.agents/skills`; agents `<p>/.github/agents/*.agent.md` and legacy `*.chatmode.md`, `<p>/.claude/agents/*.md` | skills `<copilot>/skills`, `~/.claude/skills` (not `synced`), `~/.agents/skills` (personal); agents `<copilot>/agents/*.agent.md`, `~/.claude/agents/*.md` (personal); plugins `<copilot>/installed-plugins/<marketplace>/<plugin>` and `<copilot>/installed-plugins/_direct/<plugin>` (plugin; layout from the official config-dir reference) |
| cursor | skills `<p>/.cursor/skills` (recursive, max depth 3), `<p>/.agents/skills`, `<p>/.claude/skills`, `<p>/.codex/skills`; agents `<p>/.cursor/agents/*.md`, `<p>/.claude/agents/*.md` | skills `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills` (not `synced`), `~/.codex/skills` (not `.system`) (personal), `~/.cursor/skills-cursor` (builtin); agents `~/.cursor/agents/*.md`, `~/.claude/agents/*.md` (personal) |
| antigravity | skills `<p>/.agents/skills`, legacy `<p>/.agent/skills`; agents `<p>/.agents/agents/*.md` and `<p>/.agents/agents/<name>/agent.md` | skills `~/.gemini/config/skills`, legacy `~/.gemini/antigravity/skills`, `~/.gemini/antigravity-cli/skills` (personal); agents `~/.gemini/config/agents` (personal); plugins `~/.gemini/config/plugins/<dir>`, `~/.gemini/antigravity-cli/plugins/<dir>` (plugin, with its `skills/`) |

- Codex agent `.toml`: read only the `name` and `description` keys (basic `"..."`, literal `'...'` or the first line
  of a `"""..."""` string). Name falls back to the file name.
- `.agent.md` / `.chatmode.md`: name falls back to the file name without the double extension.
- Plugin items of tools other than Claude Code: `kind: 'plugin'`, `source: 'plugin'`, `category: <adapter id>`,
  `plugin: <plugin name>` on their inner items (`<plugin>:<item>` naming as today), `global: true`,
  **no `pluginId`** and no `enabled` (the actions layer only understands Claude Code plugin ids).
- User-scope skills and agents: `global: true`.
- A project whose `.claude` is the personal folder yields no `.claude/*` project items (same rule as `claude-code`,
  applied in every adapter that reads `.claude`).

## 5. Catalog and snapshot changes

- Adapter context gains `env` (object) and `appDataDir` (from `env.APPDATA`, else `<home>/AppData/Roaming`).
  `Catalog` takes an `env` option (default `process.env`). **Adapters derive every root from `ctx.homeDir` and
  `ctx.env` only** (never `os.homedir()` or `process.env` directly), so tests can run against a fake home.
- Every adapter item is tagged with the adapter id. Roster items get `tools: string[]` = union of the adapters that
  reported the item (ADAPTERS order). The roster key stays `kind:name`.
- Project item counts (`installed.skills/agents`) count one file once per project even when several adapters
  report it (dedupe by normalized path; items without a path by `kind:name`).
- Snapshot gains a top-level `tools: [{ id, name, detected, projects, skills, agents, plugins }]` for every adapter
  (counts over listed projects whose `via` includes the id and roster items whose `tools` include it).
  Roster items in the snapshot carry `tools`; projects already carry `via`.
- ADAPTERS order: `claude-code, codex, gemini-cli, copilot, cursor, antigravity`.

## 6. Tests (hermetic)

- Every test that calls `load()`, `loadRoster()` or an adapter passes a fake `homeDir`, `claudeDir` and `env`
  (at least `APPDATA`, `CODEX_HOME`, `COPILOT_HOME` pointing into the fixture, or absent). No test reads the real
  home, `%APPDATA%` or tool folders. Existing tests are audited for this.
- Per adapter: detect true/false; projects (including broken files, missing folders, lower-cased stored paths,
  non-ASCII and space-containing paths, `%3A` URIs, remote URIs skipped, multi-root skipped, VS Code workspace
  without chat traces skipped, Codex first line > 256 KiB with `cwd` early, Codex `cwd` only on a later line → not
  used); items in both scopes.
- Cross-tool: `~/.agents/skills/x` reported by four adapters → one roster item with four tools; a project's
  `.claude/skills/y` → counted once, tools `claude-code, copilot, cursor`.
- Snapshot `tools` counts.
- Mutation evidence: every guard in §3 privacy rules, the `requireChat` filter, the remote-URI skip, the count
  dedupe and the `env`-only roots is reverted once and shown to turn a test red.

## 7. Real-machine check (read-only)

Run the server from the working tree with an isolated hub in `%TEMP%` and a free port in 47700–47799, reading the
real home. Report per tool: detected, projects found (and how many are new versus Claude Code), skills, agents,
plugins. Expected order of magnitude on the development machine: Gemini ≈25 project folders, Codex 15 rollouts,
Copilot 2 CLI sessions + VS Code workspaces with chat traces (≤10), Antigravity IDE ≈32 workspaces, Cursor ≈0
(only an empty window). Explain every large difference.

## 8. Boundaries

- Owned files: `server/adapters/**`, `server/catalog.mjs`, `server/views.mjs`, `server/fsutil.mjs`,
  `server/util.mjs` (only if needed), `test/adapters.test.mjs` (new), `test/catalog.test.mjs` (only for
  hermeticity or changed expectations), `package.json` (`scripts.test` only), `README.md` (discovery section).
- Not touched: `public/`, `electron/`, `build/`, `docs/`, `server/memory.mjs`, the actions layer.
- UI (tool badges and a tool filter) is the next step, built on the snapshot fields of §5.
- Code, comments, test names, logs: English. No new user-facing Turkish strings on the server.
