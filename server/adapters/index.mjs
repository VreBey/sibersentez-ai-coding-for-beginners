// @ts-check
// Source adapters: one per AI coding tool. The catalog knows no tool; it asks every adapter whose tool is present
// for projects and items, and remembers every project folder it was shown (memory.mjs), so a project stays listed
// after a tool deletes its own logs. Contract of the tool adapters: docs/adapters-wave1.md.
//
// Adapter interface (plain object; every method is synchronous and must not throw for missing files):
//   id                          stable identifier, recorded in the project memory ("via"), e.g. 'claude-code'
//   name                        display name
//   detect(ctx) -> boolean      is the tool present on this computer
//   findProjects(ctx) -> [{ path, lastSeenAt, hint? }]
//                               working folders the tool has been used in; lastSeenAt in ms (0 if unknown);
//                               hint is an optional tool-side key passed on to project matching
//   findItems(projectPath, ctx) -> [{ kind: 'skill'|'agent', name, path, source: 'project', description? }]
//                               items that belong to one project folder
//   findGlobalItems(ctx) -> [{ kind: 'skill'|'agent'|'plugin', name, path, source, category?, description?,
//                               global?, enabled?, plugin?, pluginId? }]
//                               optional: items active outside a single project (personal, plugins, built-in)
//   *globalItemSteps(ctx) -> yields arrays of the same items, in parts (for example one part per plugin)
//                               optional, with findGlobalItems returning them all; the five-minute rescan gives the
//                               loop back between parts when one tool's read is long (catalog.mjs rosterSteps)
// The catalog tags every item with the id of the adapter that reported it (roster "tools").
//
// ctx: { homeDir, claudeDir, projectsDir, env, appDataDir, cache, ls, frontmatter(file), fileMeta(file, kind, read) }
//   env is the environment to read (CODEX_HOME, COPILOT_HOME, ...) and appDataDir the roaming application data
//   folder (env.APPDATA, else <home>/AppData/Roaming). An adapter derives every root from homeDir, claudeDir, env and
//   appDataDir only, never from os.homedir() or process.env, so tests can run against a fake home.
//   cache is a Map private to the adapter that lives as long as the catalog (for folder-level caches);
//   ls is the folder lister of the running pass (fsutil DirLister; absent outside a pass): a folder several adapters
//   read (.agents/skills, .claude/skills) is listed once per pass. Helpers take it through shared.listerOf(ctx).
//   frontmatter(file) returns { name, description, ... }, {} without frontmatter, or null when unreadable;
//   fileMeta(file, kind, read) caches any small file's metadata the same way (by time and size; read returns null for
//   an I/O error, which is not cached).
// The catalog filters project folders (UNC paths, Claude scratchpads, broad folders such as home or a drive root,
// folders that do not exist) before remembering them, so adapters may return raw candidates.
//
// Privacy: adapters read metadata only (contract §3). Chat and session content, later lines of a session log and
// SQLite databases are never opened by them, and nothing is written into a tool's folders. (The session reader is
// another part: server/ingest.mjs with server/toolLogs.mjs reads the tools' session logs, and OpenCode's database
// read-only, for the live view and the usage ledger; README "Privacy and security".)
import { claudeCode } from './claude-code.mjs';
import { codex } from './codex.mjs';
import { geminiCli } from './gemini-cli.mjs';
import { copilot } from './copilot.mjs';
import { cursor } from './cursor.mjs';
import { antigravity } from './antigravity.mjs';
import { qwen } from './qwen.mjs';
import { opencode } from './opencode.mjs';

export const ADAPTERS = Object.freeze([claudeCode, codex, geminiCli, copilot, cursor, antigravity, qwen, opencode]);
