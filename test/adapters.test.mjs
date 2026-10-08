// Discovery adapter tests, wave 1 (contract docs/adapters-wave1.md §6): Codex, Gemini CLI, GitHub Copilot, Cursor and
// Antigravity next to Claude Code. Run: node --test test/adapters.test.mjs
// Hermetic: every catalog and adapter call gets a fake home, Claude folder and environment (APPDATA, CODEX_HOME,
// COPILOT_HOME pointing into the fixture, or absent) built under the system temp folder. The real home, %APPDATA% and
// the tool folders are never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalog, BUILTIN_AGENTS } from '../server/catalog.mjs';
import { ADAPTERS } from '../server/adapters/index.mjs';
import { codex, compareVersions, rolloutCwd, tomlNameDescription, CHUNK, FIRST_LINE_MAX } from '../server/adapters/codex.mjs';
import { geminiCli } from '../server/adapters/gemini-cli.mjs';
import { copilot, workspaceYamlCwd, yamlScalar } from '../server/adapters/copilot.mjs';
import { cursor } from '../server/adapters/cursor.mjs';
import { antigravity } from '../server/adapters/antigravity.mjs';
import { qwen } from '../server/adapters/qwen.mjs';
import { opencode } from '../server/adapters/opencode.mjs';
import { cleanPath, folderFromUri, onDiskCase, vscodeWorkspaces } from '../server/adapters/shared.mjs';
import { ProjectMemory } from '../server/memory.mjs';
import { normPath } from '../server/util.mjs';
import { Ingest } from '../server/ingest.mjs';
import { snapshot } from '../server/views.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-adapters-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const DAY = 86400000;

// ---------------- fixture helpers ----------------
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const mkdir = (...parts) => {
  const d = path.join(...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const skill = (dir, folder, name = folder) => write(path.join(dir, folder, 'SKILL.md'), fm(name));
const mdAgent = (file, name) => write(file, fm(name));
// Sets a file or folder time to `daysAgo` days back and returns the time read back
const age = (p, daysAgo) => {
  const t = new Date(Date.now() - daysAgo * DAY);
  fs.utimesSync(p, t, t);
  return fs.statSync(p).mtimeMs;
};
const norm = (list) => list.map((p) => normPath(p)).sort();
const pathsOf = (found) => norm(found.map((f) => f.path));
const names = (items) => items.map((i) => i.name).sort();

let seq = 0;
// A fake machine: home (with AppData\Roaming), a work folder for projects and the environment the catalog reads
function world(name) {
  const base = mkdir(ROOT, `${name}-${++seq}`);
  const home = mkdir(base, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const w = { base, home, appData, claude: path.join(home, '.claude'), work: mkdir(base, 'work'), env: { APPDATA: appData } };
  w.catalog = (opts = {}) => new Catalog({ hubDir: null, claudeDir: w.claude, homeDir: home, env: w.env, ...opts });
  w.ctx = (adapter) => w.catalog().adapterCtx(adapter);
  return w;
}

// Codex rollout: the first line, then later lines (message content that must never be read)
const meta = (cwd, extra = {}) => ({ timestamp: '2026-09-07T20:51:09.000Z', type: 'session_meta', payload: { id: 'x', cwd, originator: 'codex_desktop', ...extra } });
const LATER = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a secret prompt' }] } };
const rollout = (file, first, later = [LATER]) => write(file, [first, ...later].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const rolloutAt = (root, day, name) => path.join(root, 'sessions', '2026', '09', day, `rollout-2026-09-${day}T10-00-00-${name}.jsonl`);

// VS Code-style workspace URI as the editors write it: file:///c%3A/Users/...
const fileUri = (p) => `file:///${p[0].toLowerCase()}%3A/${p.slice(3).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
// One workspaceStorage hash folder; json undefined: no workspace.json. chat / editing: entry names; emptyChat: an
// empty chatSessions folder
function ws(appData, app, hash, json, { chat = [], editing = [], emptyChat = false } = {}) {
  const dir = mkdir(appData, app, 'User', 'workspaceStorage', hash);
  if (json !== undefined) write(path.join(dir, 'workspace.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const n of chat) write(path.join(dir, 'chatSessions', n), '{"requests":[{"message":"a secret chat"}]}');
  for (const n of editing) write(path.join(dir, 'chatEditingSessions', n, 'state.json'), '{}');
  if (emptyChat) mkdir(dir, 'chatSessions');
  return dir;
}

// Every tool of this wave present (their marker folders only)
function allTools(w) {
  mkdir(w.claude);
  mkdir(w.home, '.codex');
  write(path.join(w.home, '.gemini', 'projects.json'), '{"projects":{}}');
  mkdir(w.home, '.copilot');
  mkdir(w.home, '.cursor');
  mkdir(w.appData, 'Antigravity IDE', 'User');
  write(path.join(w.home, '.qwen', 'settings.json'), '{}');
  mkdir(w.home, '.config', 'opencode');
}

// ---------------- detect ----------------
test('detect: every adapter is false on an empty fake home; each tool is found by each of its markers; roots come from ctx.env', () => {
  const empty = world('detect-empty');
  for (const a of ADAPTERS) assert.equal(a.detect(empty.ctx(a)), false, a.id);
  const cases = [
    [codex, (w) => mkdir(w.home, '.codex')],
    [codex, (w) => (w.env.CODEX_HOME = mkdir(w.base, 'codex-root'))],
    [geminiCli, (w) => write(path.join(w.home, '.gemini', 'projects.json'), '{}')],
    [geminiCli, (w) => mkdir(w.home, '.gemini', 'tmp')],
    [geminiCli, (w) => mkdir(w.home, '.gemini', 'skills')],
    [geminiCli, (w) => mkdir(w.home, '.gemini', 'extensions')],
    [copilot, (w) => mkdir(w.home, '.copilot')],
    [copilot, (w) => (w.env.COPILOT_HOME = mkdir(w.base, 'copilot-root'))],
    [copilot, (w) => mkdir(w.appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat')],
    [cursor, (w) => mkdir(w.appData, 'Cursor', 'User')],
    [cursor, (w) => mkdir(w.home, '.cursor')],
    [antigravity, (w) => mkdir(w.appData, 'Antigravity IDE', 'User')],
    [antigravity, (w) => mkdir(w.home, '.gemini', 'config')],
    [antigravity, (w) => mkdir(w.home, '.gemini', 'antigravity-cli')],
  ];
  for (const [i, [a, make]] of cases.entries()) {
    const w = world('detect');
    make(w);
    assert.equal(a.detect(w.ctx(a)), true, `${a.id}, marker ${i}`);
  }
  // A root variable wins over the default folder; a relative value is ignored
  const w = world('detect-override');
  mkdir(w.home, '.codex');
  mkdir(w.home, '.copilot');
  w.env.CODEX_HOME = path.join(w.base, 'missing-codex');
  w.env.COPILOT_HOME = path.join(w.base, 'missing-copilot');
  assert.equal(codex.detect(w.ctx(codex)), false, 'CODEX_HOME points to a missing folder');
  assert.equal(copilot.detect(w.ctx(copilot)), false, 'COPILOT_HOME points to a missing folder');
  w.env.CODEX_HOME = 'relative-codex';
  assert.equal(codex.detect(w.ctx(codex)), true, 'a relative CODEX_HOME falls back to ~/.codex');
  // APPDATA from the environment; without it <home>/AppData/Roaming
  assert.equal(w.catalog().appDataDir, w.appData);
  assert.equal(new Catalog({ hubDir: null, claudeDir: w.claude, homeDir: w.home, env: {} }).appDataDir, path.join(w.home, 'AppData', 'Roaming'));
});

// ---------------- Codex projects ----------------
test('codex projects: the first line only (payload.cwd, else a top-level cwd) of sessions and archived_sessions rollouts; broken, empty and later-line cwd files skipped; lastSeenAt is the file time', () => {
  const w = world('codex-projects');
  const root = path.join(w.home, '.codex');
  const alpha = mkdir(w.work, 'alpha');
  const beta = mkdir(w.work, 'beta arşiv');
  const later = mkdir(w.work, 'later-only');
  const nested = mkdir(w.work, 'nested archive');
  const gone = path.join(w.work, 'deleted');
  const fa = rollout(rolloutAt(root, '07', 'a'), meta(alpha), [LATER, { cwd: later }]);
  const ta = age(fa, 3);
  const fb = rollout(path.join(root, 'archived_sessions', 'rollout-2026-08-01T10-00-00-b.jsonl'), { type: 'session_meta', cwd: beta.replace(/^C:/, 'c:') });
  const tb = age(fb, 40);
  rollout(path.join(root, 'archived_sessions', '2026', '08', '02', 'rollout-2026-08-02T10-00-00-n.jsonl'), meta(nested));
  // cwd only on a later line (never parsed)
  rollout(rolloutAt(root, '08', 'c'), { type: 'session_meta', payload: { id: 'c' } }, [{ type: 'turn_context', payload: { cwd: later } }, { cwd: later }]);
  // Broken first line (a good one follows), an empty file, a name that is not a rollout, a hidden folder
  write(rolloutAt(root, '09', 'broken'), '{broken\n' + JSON.stringify(meta(later)) + '\n');
  write(rolloutAt(root, '09', 'empty'), '');
  rollout(path.join(root, 'sessions', '2026', '09', '09', 'history.jsonl'), meta(later));
  rollout(path.join(root, 'sessions', '.tmp', 'rollout-hidden.jsonl'), meta(later));
  // A folder that no longer exists: reported by the adapter, dropped by the catalog
  rollout(rolloutAt(root, '10', 'gone'), meta(gone));
  const found = codex.findProjects(w.ctx(codex));
  assert.deepEqual(pathsOf(found), norm([alpha, beta, nested, gone]));
  assert.equal(found.find((f) => normPath(f.path) === normPath(alpha)).lastSeenAt, ta);
  const b = found.find((f) => normPath(f.path) === normPath(beta));
  assert.equal(b.lastSeenAt, tb);
  assert.equal(b.path, beta, 'a lower-case drive letter is upper-cased');
  const c = w.catalog();
  c.load();
  const listed = c.allProjects().filter((p) => p.via?.includes('codex'));
  assert.deepEqual(norm(listed.map((p) => p.path)), norm([alpha, beta, nested]), 'a missing folder is not remembered');
  assert.ok(listed.every((p) => p.via.length === 1));
});

test('codex projects: a first line longer than 256 KiB gives its early cwd; a cwd past the read limit is not used; spaces, Turkish letters and escapes survive', () => {
  const w = world('codex-long');
  const root = mkdir(w.base, 'codex-root');
  w.env.CODEX_HOME = root; // the root comes from ctx.env
  const early = mkdir(w.work, 'uzun yol çalışma ğüş');
  const late = mkdir(w.work, 'late');
  const LIMIT = 256 * 1024; // the contract's read limit (not the constant under test)
  assert.equal(FIRST_LINE_MAX, LIMIT);
  const big = 'x'.repeat(LIMIT + 1000);
  const line1 = JSON.stringify({ type: 'session_meta', payload: { cwd: early, instructions: big } });
  const f1 = rollout(rolloutAt(root, '11', 'early'), line1);
  const f2 = rollout(rolloutAt(root, '11', 'late'), { type: 'session_meta', payload: { instructions: big, cwd: late } });
  assert.ok(Buffer.byteLength(line1) > LIMIT, 'precondition: the first line is longer than the limit');
  assert.ok(fs.readFileSync(f2).indexOf('"cwd"') > LIMIT, 'precondition: the cwd starts beyond the limit');
  assert.equal(rolloutCwd(f1).cwd, early);
  assert.equal(rolloutCwd(f2).cwd, null);
  assert.deepEqual(pathsOf(codex.findProjects(w.ctx(codex))), norm([early]));
});

test('codex cache: a rollout is read once (cached by path); an incomplete first line is read again when the file grows; a removed rollout leaves the cache', () => {
  const w = world('codex-cache');
  const root = path.join(w.home, '.codex');
  const one = mkdir(w.work, 'one');
  const two = mkdir(w.work, 'two');
  const f = rollout(rolloutAt(root, '01', 'one'), meta(one));
  const ctx = w.ctx(codex);
  assert.deepEqual(pathsOf(codex.findProjects(ctx)), norm([one]));
  rollout(f, meta(two)); // a rollout's first line never changes in practice: the cached folder is kept
  assert.deepEqual(pathsOf(codex.findProjects(ctx)), norm([one]), 'not read again');
  fs.rmSync(f);
  assert.deepEqual(codex.findProjects(ctx), []);
  assert.equal(ctx.cache.rollouts.size, 0, 'the entry of a removed rollout is dropped');
  const g = write(rolloutAt(root, '02', 'growing'), JSON.stringify(meta(two)).slice(0, 40));
  assert.deepEqual(codex.findProjects(ctx), [], 'incomplete first line');
  rollout(g, meta(two));
  assert.deepEqual(pathsOf(codex.findProjects(ctx)), norm([two]), 'read again once the first line is complete');
});

// ---------------- Gemini CLI projects ----------------
test('gemini projects: projects.json keys and .project_root markers (tmp and history); lower-cased paths take the on-disk casing, Turkish İ included; lastSeenAt from chats entries, else the tmp folder, else 0', () => {
  const w = world('gemini-projects');
  const g = path.join(w.home, '.gemini');
  const alpha = mkdir(w.work, 'Alpha Proje');
  const turkish = mkdir(w.work, 'İŞLERİM', 'Yeni Proje');
  const beta = mkdir(w.work, 'Beta');
  const hist = mkdir(w.work, 'History Only');
  const gone = path.join(w.work, 'Gone');
  write(
    path.join(g, 'projects.json'),
    JSON.stringify({ projects: { [alpha.toLowerCase()]: 'alpha-proje', [turkish.toLowerCase()]: 'yeni-proje', [gone]: 'gone', 'relative\\folder': 'rel', [beta]: 42 } }),
  );
  assert.equal(fs.existsSync(turkish.toLowerCase()), false, 'precondition: the lower-cased Turkish path does not exist as written');
  const chat = write(path.join(g, 'tmp', 'alpha-proje', 'chats', 'session-2026-09-01T10-00-abcd1234.jsonl'), '{"secret":"chat"}\n');
  const tChat = age(chat, 2);
  age(path.join(g, 'tmp', 'alpha-proje', 'chats'), 9);
  age(path.join(g, 'tmp', 'alpha-proje'), 10);
  write(path.join(g, 'tmp', 'beta', '.project_root'), beta.toLowerCase() + '\n');
  const tBeta = age(path.join(g, 'tmp', 'beta'), 5);
  write(path.join(g, 'history', 'history-only', '.project_root'), `  ${hist}  \r\n`);
  const found = geminiCli.findProjects(w.ctx(geminiCli));
  const by = new Map(found.map((f) => [normPath(f.path), f]));
  assert.deepEqual([...by.keys()].sort(), norm([alpha, turkish, beta, hist, gone]));
  assert.equal(by.get(normPath(alpha)).path, alpha, 'on-disk casing');
  assert.equal(by.get(normPath(turkish)).path, turkish, '"i" + U+0307 walked back to the on-disk "İ"');
  assert.equal(by.get(normPath(beta)).path, beta);
  assert.equal(by.get(normPath(alpha)).lastSeenAt, tChat, 'newest chats entry (stat only)');
  assert.equal(by.get(normPath(beta)).lastSeenAt, tBeta, 'no chats: the tmp/<id> folder time');
  assert.equal(by.get(normPath(hist)).lastSeenAt, 0, 'no tmp folder');
  assert.equal(by.get(normPath(gone)).path, gone, 'a missing folder keeps the stored path (the catalog drops it)');
});

test('gemini projects: a lower-cased stored path with a junction on the way takes the on-disk spelling of every name (the junction is walked by name, never followed); a broken projects.json and bad ids never throw', () => {
  const w = world('gemini-junction');
  const g = path.join(w.home, '.gemini');
  const target = mkdir(w.work, 'Target Dir');
  mkdir(target, 'Sub Folder');
  const link = path.join(w.work, 'Linked Dir');
  fs.symlinkSync(target, link, 'junction');
  const inside = path.join(link, 'Sub Folder');
  // The spelling on disk: the work folder as realpath names it, then the names as they are listed
  const onDisk = (...names) => path.join(fs.realpathSync.native(w.work), ...names);
  write(path.join(g, 'projects.json'), JSON.stringify({ projects: { [link.toLowerCase()]: '../../escape', [inside.toLowerCase()]: 'inside', [target]: 'a/b' } }));
  assert.notEqual(normPath(fs.realpathSync.native(inside)), normPath(inside), 'precondition: realpath names the junction target');
  const found = geminiCli.findProjects(w.ctx(geminiCli));
  assert.deepEqual(pathsOf(found), norm([link, inside, target]));
  const by = new Map(found.map((f) => [normPath(f.path), f.path]));
  assert.equal(by.get(normPath(link)), onDisk('Linked Dir'), 'the junction itself: its own on-disk name');
  assert.equal(by.get(normPath(inside)), onDisk('Linked Dir', 'Sub Folder'), 'a folder below a junction: every name as on disk, not lower-cased');
  assert.equal(onDiskCase(inside.toLowerCase()), onDisk('Linked Dir', 'Sub Folder'));
  assert.ok(found.every((f) => !normPath(f.path).includes('/target dir/')), 'the junction is not followed');
  assert.ok(found.every((f) => f.lastSeenAt === 0), 'ids that are paths are not used');
  write(path.join(g, 'projects.json'), '{broken');
  write(path.join(g, 'tmp', 'marker', '.project_root'), target);
  assert.deepEqual(pathsOf(geminiCli.findProjects(w.ctx(geminiCli))), norm([target]));
  write(path.join(g, 'projects.json'), JSON.stringify({ projects: ['not', 'an', 'object'] }));
  assert.doesNotThrow(() => geminiCli.findProjects(w.ctx(geminiCli)));
});

// ---------------- GitHub Copilot projects ----------------
test('copilot projects: only the top-level cwd: line of session-state/<id>/workspace.yaml (plain, double- or single-quoted); lastSeenAt is the session folder time', () => {
  const w = world('copilot-projects');
  const root = mkdir(w.base, 'copilot-root');
  w.env.COPILOT_HOME = root;
  const one = mkdir(w.work, 'one proj');
  const two = mkdir(w.work, 'iki ş');
  const three = mkdir(w.work, "it's");
  const four = mkdir(w.work, 'four');
  const ss = path.join(root, 'session-state');
  write(path.join(ss, 's1', 'workspace.yaml'), `id: s1\ncwd: ${one.replace(/^C:/, 'c:')}\ngit_root: ${four}\nbranch: main\nsummary: a secret summary\n`);
  const t1 = age(path.join(ss, 's1'), 4);
  write(path.join(ss, 's2', 'workspace.yaml'), `id: s2\ncwd: ${JSON.stringify(two)}\n`);
  write(path.join(ss, 's3', 'workspace.yaml'), `cwd: '${three.replace(/'/g, "''")}' # quoted\n`);
  // Not used: git_root only, an indented cwd, no workspace.yaml (events.jsonl only)
  write(path.join(ss, 's4', 'workspace.yaml'), `id: s4\ngit_root: ${four}\nnested:\n  cwd: ${four}\n`);
  write(path.join(ss, 's5', 'events.jsonl'), JSON.stringify({ cwd: four }) + '\n');
  const found = copilot.findProjects(w.ctx(copilot));
  assert.deepEqual(pathsOf(found), norm([one, two, three]));
  const f1 = found.find((f) => normPath(f.path) === normPath(one));
  assert.equal(f1.path, one, 'drive letter upper-cased');
  assert.equal(f1.lastSeenAt, t1);
  assert.equal(yamlScalar(' C:\\x\\y # a note'), 'C:\\x\\y');
  assert.equal(yamlScalar(' "C:\\\\a \\"b\\""'), 'C:\\a "b"');
  assert.equal(yamlScalar(" 'it''s'"), "it's");
  assert.equal(yamlScalar(' "unterminated'), null);
  assert.equal(yamlScalar('   '), null);
  assert.equal(workspaceYamlCwd(path.join(ss, 'missing.yaml')), null);
});

// ---------------- VS Code-style workspaces ----------------
test('VS Code workspaces: file URIs decoded (%3A, spaces, non-ASCII); remote, virtual and multi-root skipped; Copilot needs chat traces, Cursor and Antigravity do not', () => {
  const w = world('vscode');
  const spaced = mkdir(w.work, 'site ve mobil');
  const turkish = mkdir(w.work, 'ÖZ GEÇMİŞ');
  const edit = mkdir(w.work, 'edit only');
  const quiet = mkdir(w.work, 'no chat');
  ws(w.appData, 'Code', 'h1', { folder: fileUri(spaced) }, { chat: ['a.jsonl'] });
  ws(w.appData, 'Code', 'h2', { folder: fileUri(turkish) }, { chat: ['b.json'] });
  ws(w.appData, 'Code', 'h3', { folder: fileUri(edit) }, { editing: ['x'] });
  ws(w.appData, 'Code', 'h4', { folder: fileUri(quiet) }, { emptyChat: true });
  ws(w.appData, 'Code', 'h5', { folder: 'vscode-remote://ssh-remote%2Bhost/opt/app' }, { chat: ['c'] });
  ws(w.appData, 'Code', 'h6', { folder: 'vscode-vfs://github/owner/repo' }, { chat: ['c'] });
  ws(w.appData, 'Code', 'h7', { workspace: fileUri(path.join(w.work, 'multi.code-workspace')) }, { chat: ['c'] });
  ws(w.appData, 'Code', 'h8', '{broken', { chat: ['c'] });
  ws(w.appData, 'Code', 'h9', undefined, { chat: ['c'] });
  const cp = copilot.findProjects(w.ctx(copilot));
  assert.deepEqual(pathsOf(cp), norm([spaced, turkish, edit]), 'only workspaces with chat traces');
  assert.equal(cp.find((f) => normPath(f.path) === normPath(turkish)).path, turkish, 'non-ASCII decoded exactly, drive upper-cased');
  ws(w.appData, 'Cursor', 'c1', { folder: fileUri(quiet) });
  ws(w.appData, 'Cursor', 'empty-window', undefined);
  ws(w.appData, 'Cursor', 'c2', { folder: 'vscode-remote://wsl%2Bubuntu/c%3A/Users/u/proj' });
  ws(w.appData, 'Antigravity IDE', 'g1', { folder: fileUri(spaced) });
  ws(w.appData, 'Antigravity IDE', 'g2', { workspace: fileUri(path.join(w.work, 'Workspaces', 'workspace.json')) });
  assert.deepEqual(pathsOf(cursor.findProjects(w.ctx(cursor))), norm([quiet]));
  assert.deepEqual(pathsOf(antigravity.findProjects(w.ctx(antigravity))), norm([spaced]));
  assert.equal(folderFromUri('file:///c%3A/A%20B/%C3%96z'), 'C:\\A B\\Öz');
  assert.equal(folderFromUri('vscode-remote://wsl%2Bubuntu/c%3A/Users/u/proj'), null);
  assert.equal(folderFromUri('vscode-vfs://github/o/r'), null);
  assert.equal(folderFromUri(42), null);
});

test('workspace.json and workspace.yaml are cached by modification time; entries of removed files are dropped', () => {
  const w = world('ws-cache');
  const a = mkdir(w.work, 'a');
  const b = mkdir(w.work, 'b');
  const cache = new Map();
  const dir = ws(w.appData, 'Cursor', 'c1', { folder: fileUri(a) });
  const file = path.join(dir, 'workspace.json');
  const t = new Date(Math.floor(Date.now() / 1000) * 1000 - DAY); // whole seconds: the time survives a round trip
  fs.utimesSync(file, t, t);
  assert.deepEqual(pathsOf(vscodeWorkspaces(w.appData, 'Cursor', { cache })), norm([a]));
  write(file, JSON.stringify({ folder: fileUri(b) }));
  fs.utimesSync(file, t, t);
  assert.deepEqual(pathsOf(vscodeWorkspaces(w.appData, 'Cursor', { cache })), norm([a]), 'same time: not read again');
  age(file, -1);
  assert.deepEqual(pathsOf(vscodeWorkspaces(w.appData, 'Cursor', { cache })), norm([b]), 'new time: read again');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(vscodeWorkspaces(w.appData, 'Cursor', { cache }), []);
  assert.equal(cache.size, 0);
  // Copilot session-state
  const yaml = write(path.join(w.home, '.copilot', 'session-state', 's1', 'workspace.yaml'), `cwd: ${a}\n`);
  const ctx = w.ctx(copilot);
  fs.utimesSync(yaml, t, t);
  assert.deepEqual(pathsOf(copilot.findProjects(ctx)), norm([a]));
  write(yaml, `cwd: ${b}\n`);
  fs.utimesSync(yaml, t, t);
  assert.deepEqual(pathsOf(copilot.findProjects(ctx)), norm([a]), 'same time: cached');
  age(yaml, -1);
  assert.deepEqual(pathsOf(copilot.findProjects(ctx)), norm([b]));
  fs.rmSync(path.dirname(yaml), { recursive: true, force: true });
  assert.deepEqual(copilot.findProjects(ctx), []);
  assert.equal(ctx.cache.sessions.size, 0);
});

// ---------------- items ----------------
test('codex items: .agents/skills and .codex/agents/*.toml of a project; ~/.agents/skills and <codex>/skills personal, .system built-in, toml agents, cached plugins with their skills (highest version)', () => {
  const w = world('codex-items');
  const root = path.join(w.home, '.codex');
  const proj = mkdir(w.work, 'proj');
  skill(path.join(proj, '.agents', 'skills'), 'p-skill');
  write(path.join(proj, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = """\nChecks diffs.\nSecond line.\n"""\ndeveloper_instructions = "x"\n');
  write(path.join(proj, '.codex', 'agents', 'plain.toml'), "description = 'a literal description'\n");
  write(path.join(proj, '.codex', 'agents', 'notes.md'), fm('not-an-agent'));
  const items = codex.findItems(proj, w.ctx(codex));
  assert.deepEqual(names(items), ['p-skill', 'plain', 'reviewer']);
  assert.ok(items.every((i) => i.source === 'project'));
  assert.equal(items.find((i) => i.name === 'reviewer').description, 'Checks diffs.');
  assert.equal(items.find((i) => i.name === 'plain').description, 'a literal description');
  assert.equal(items.find((i) => i.name === 'plain').kind, 'agent');

  skill(path.join(w.home, '.agents', 'skills'), 'shared-skill');
  skill(path.join(root, 'skills'), 'mine');
  skill(path.join(root, 'skills', '.system'), 'imagegen');
  write(path.join(root, 'agents', 'helper.toml'), 'name = "helper" # trailing comment\ndescription = """one line"""\n');
  write(path.join(root, 'agents', 'escaped.toml'), 'name = "esc\\u00e7"\ndescription = "tab\\there"\n[table]\nname = "ignored"\n');
  const cache = path.join(root, 'plugins', 'cache', 'market');
  skill(path.join(cache, 'plug', '1.2.0', 'skills'), 'old-skill');
  skill(path.join(cache, 'plug', '1.10.0', 'skills'), 'new-skill');
  write(path.join(cache, 'plug', '1.10.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'plug', description: 'A Codex plugin' }));
  skill(path.join(cache, 'solo', 'latest', 'skills'), 'solo-skill');
  const g = codex.findGlobalItems(w.ctx(codex));
  // In parts (the stepped rescan): the same items, one part for the personal ones and one per cached plugin
  const parts = [...codex.globalItemSteps(w.ctx(codex))];
  assert.deepEqual(parts.flat(), g);
  assert.equal(parts.length, 3, 'personal and built-in, plug, solo');
  const by = new Map(g.map((i) => [`${i.kind}:${i.name}`, i]));
  assert.equal(by.get('skill:shared-skill').source, 'personal');
  assert.equal(by.get('skill:mine').source, 'personal');
  assert.equal(by.get('skill:imagegen').source, 'builtin', '.system skills are built in');
  assert.equal(g.filter((i) => i.name === 'imagegen').length, 1, '.system is not a personal skill folder');
  assert.equal(by.get('agent:helper').description, 'one line');
  assert.equal(by.get('agent:esc\u00e7').description, 'tab\there');
  assert.ok(g.every((i) => i.global === true));
  const plug = by.get('plugin:plug');
  assert.deepEqual({ ...plug, path: path.basename(plug.path) }, { kind: 'plugin', name: 'plug', path: '1.10.0', description: 'A Codex plugin', source: 'plugin', category: 'codex', global: true });
  assert.equal(by.get('skill:plug:new-skill').plugin, 'plug');
  assert.equal(by.get('skill:plug:new-skill').category, 'codex');
  assert.ok(!('pluginId' in by.get('skill:plug:new-skill')) && !('enabled' in by.get('skill:plug:new-skill')));
  assert.equal(by.get('skill:plug:old-skill'), undefined, 'one version per plugin: the highest');
  assert.ok(by.get('skill:solo:solo-skill'), '"latest" when it is the only version folder');
  assert.deepEqual(tomlNameDescription(path.join(root, 'agents', 'missing.toml')), null);
});

test('gemini items: .gemini/skills, .agents/skills and .gemini/agents of a project; ~/.gemini and ~/.agents personal; extensions with their skills and agents', () => {
  const w = world('gemini-items');
  const g = path.join(w.home, '.gemini');
  const proj = mkdir(w.work, 'proj');
  skill(path.join(proj, '.gemini', 'skills'), 'g-skill');
  skill(path.join(proj, '.agents', 'skills'), 'a-skill');
  mdAgent(path.join(proj, '.gemini', 'agents', 'planner.md'), 'planner');
  write(path.join(proj, '.gemini', 'agents', 'no-frontmatter.md'), '# plain\n');
  write(path.join(proj, '.gemini', 'agents', 'README.md'), '# readme\n');
  mdAgent(path.join(proj, '.gemini', 'agents', 'deep', 'nested.md'), 'nested');
  const items = geminiCli.findItems(proj, w.ctx(geminiCli));
  assert.deepEqual(names(items), ['a-skill', 'g-skill', 'no-frontmatter', 'planner'], 'agents: *.md directly in the folder, README excluded');
  skill(path.join(g, 'skills'), 'gs');
  skill(path.join(w.home, '.agents', 'skills'), 'shared');
  mdAgent(path.join(g, 'agents', 'ga.md'), 'ga');
  const ext = path.join(g, 'extensions', 'ext-folder');
  write(path.join(ext, 'gemini-extension.json'), JSON.stringify({ name: 'my-ext', version: '1.0.0', description: 'An extension' }));
  skill(path.join(ext, 'skills'), 'es');
  mdAgent(path.join(ext, 'agents', 'ea.md'), 'ea');
  skill(path.join(g, 'extensions', 'not-an-extension', 'skills'), 'nope');
  const gl = geminiCli.findGlobalItems(w.ctx(geminiCli));
  assert.deepEqual(names(gl), ['ga', 'gs', 'my-ext', 'my-ext:ea', 'my-ext:es', 'shared']);
  const e = gl.find((i) => i.name === 'my-ext');
  assert.equal(e.kind, 'plugin');
  assert.equal(e.category, 'gemini-cli');
  assert.equal(e.description, 'An extension');
  assert.equal(gl.find((i) => i.name === 'my-ext:ea').plugin, 'my-ext');
  assert.equal(gl.find((i) => i.name === 'gs').source, 'personal');
});

test('copilot items: .github, .claude and .agents of a project (.agent.md and legacy .chatmode.md); personal copilot, ~/.claude (not synced) and ~/.agents; plugins', () => {
  const w = world('copilot-items');
  const root = path.join(w.home, '.copilot');
  const proj = mkdir(w.work, 'proj');
  skill(path.join(proj, '.github', 'skills'), 'gh-skill');
  skill(path.join(proj, '.claude', 'skills'), 'cl-skill');
  skill(path.join(proj, '.agents', 'skills'), 'ag-skill');
  write(path.join(proj, '.github', 'agents', 'coder.agent.md'), '# no frontmatter\n');
  write(path.join(proj, '.github', 'agents', 'legacy.chatmode.md'), '# old\n');
  mdAgent(path.join(proj, '.github', 'agents', 'plain.md'), 'plain-md');
  mdAgent(path.join(proj, '.claude', 'agents', 'cl-agent.md'), 'cl-agent');
  const items = copilot.findItems(proj, w.ctx(copilot));
  assert.deepEqual(names(items), ['ag-skill', 'cl-agent', 'cl-skill', 'coder', 'gh-skill', 'legacy'], '"x.agent.md" -> "x"; a plain .md in .github/agents is not an agent');
  skill(path.join(root, 'skills'), 'co-skill');
  mdAgent(path.join(root, 'agents', 'co.agent.md'), 'co-agent');
  mdAgent(path.join(root, 'agents', 'other.md'), 'not-copilot');
  skill(path.join(w.claude, 'skills'), 'claude-personal');
  skill(path.join(w.claude, 'skills', 'synced'), 'synced-skill');
  mdAgent(path.join(w.claude, 'agents', 'ca.md'), 'ca');
  skill(path.join(w.home, '.agents', 'skills'), 'shared');
  mkdir(root, 'installed-plugins', 'market', 'cop-plugin');
  mkdir(root, 'installed-plugins', '_direct', 'direct-plugin');
  const gl = copilot.findGlobalItems(w.ctx(copilot));
  assert.deepEqual(names(gl), ['ca', 'claude-personal', 'co-agent', 'co-skill', 'cop-plugin', 'direct-plugin', 'shared']);
  assert.ok(gl.filter((i) => i.kind === 'plugin').every((i) => i.category === 'copilot' && i.source === 'plugin' && !('pluginId' in i)));
});

test('cursor items: .cursor/skills up to 3 levels, .agents, .claude and .codex skills of a project; personal folders, ~/.codex/skills without .system; skills-cursor built in', () => {
  const w = world('cursor-items');
  const proj = mkdir(w.work, 'proj');
  skill(path.join(proj, '.cursor', 'skills'), 'top');
  skill(path.join(proj, '.cursor', 'skills', 'group', 'sub'), 'level3');
  skill(path.join(proj, '.cursor', 'skills', 'a', 'b', 'c'), 'too-deep');
  skill(path.join(proj, '.agents', 'skills'), 'ag');
  skill(path.join(proj, '.claude', 'skills'), 'cl');
  skill(path.join(proj, '.codex', 'skills'), 'cx');
  mdAgent(path.join(proj, '.cursor', 'agents', 'cu.md'), 'cu-agent');
  mdAgent(path.join(proj, '.claude', 'agents', 'cla.md'), 'cla-agent');
  const items = cursor.findItems(proj, w.ctx(cursor));
  assert.deepEqual(names(items), ['ag', 'cl', 'cla-agent', 'cu-agent', 'cx', 'level3', 'top']);
  skill(path.join(w.home, '.cursor', 'skills'), 'cs');
  skill(path.join(w.home, '.cursor', 'skills-cursor'), 'babysit');
  skill(path.join(w.home, '.codex', 'skills'), 'codex-personal');
  skill(path.join(w.home, '.codex', 'skills', '.system'), 'codex-system');
  skill(path.join(w.claude, 'skills', 'synced'), 'synced-skill');
  skill(path.join(w.home, '.agents', 'skills'), 'shared');
  mdAgent(path.join(w.home, '.cursor', 'agents', 'ca.md'), 'cursor-agent');
  const gl = cursor.findGlobalItems(w.ctx(cursor));
  assert.deepEqual(names(gl), ['babysit', 'codex-personal', 'cs', 'cursor-agent', 'shared']);
  assert.equal(gl.find((i) => i.name === 'babysit').source, 'builtin');
  assert.equal(gl.find((i) => i.name === 'cs').source, 'personal');
});

test('antigravity items: .agents/skills, legacy .agent/skills, .agents/agents (*.md and <name>/agent.md); ~/.gemini/config, legacy and CLI personal folders; plugins with their skills', () => {
  const w = world('antigravity-items');
  const g = path.join(w.home, '.gemini');
  const proj = mkdir(w.work, 'proj');
  skill(path.join(proj, '.agents', 'skills'), 'ag');
  skill(path.join(proj, '.agent', 'skills'), 'legacy');
  mdAgent(path.join(proj, '.agents', 'agents', 'flat.md'), 'flat-agent');
  write(path.join(proj, '.agents', 'agents', 'folder-agent', 'agent.md'), '# no frontmatter\n');
  mkdir(proj, '.agents', 'agents', 'no-agent-md');
  const items = antigravity.findItems(proj, w.ctx(antigravity));
  assert.deepEqual(names(items), ['ag', 'flat-agent', 'folder-agent', 'legacy']);
  skill(path.join(g, 'config', 'skills'), 'cfg');
  skill(path.join(g, 'antigravity', 'skills'), 'old');
  skill(path.join(g, 'antigravity-cli', 'skills'), 'cli');
  mdAgent(path.join(g, 'config', 'agents', 'x.md'), 'cfg-agent');
  const plug = path.join(g, 'config', 'plugins', 'vendor.tools');
  write(path.join(plug, 'plugin.json'), JSON.stringify({ name: 'vendor.tools', description: 'Vendor tools' }));
  skill(path.join(plug, 'skills'), 'vs');
  skill(path.join(g, 'antigravity-cli', 'plugins', 'cli-plug', 'skills'), 'cps');
  const gl = antigravity.findGlobalItems(w.ctx(antigravity));
  assert.deepEqual(names(gl), ['cfg', 'cfg-agent', 'cli', 'cli-plug', 'cli-plug:cps', 'old', 'vendor.tools', 'vendor.tools:vs']);
  assert.equal(gl.find((i) => i.name === 'vendor.tools').description, 'Vendor tools');
  assert.equal(gl.find((i) => i.name === 'vendor.tools:vs').category, 'antigravity');
});

test('copilot and cursor: a project whose .claude is the personal folder yields no .claude project items; another project .claude does', () => {
  const w = world('claude-personal');
  const proj = mkdir(w.work, 'holder');
  skill(path.join(proj, '.claude', 'skills'), 'here');
  mdAgent(path.join(proj, '.claude', 'agents', 'a.md'), 'a-agent');
  const other = mkdir(w.work, 'other');
  skill(path.join(other, '.claude', 'skills'), 'there');
  const c = new Catalog({ hubDir: null, claudeDir: path.join(proj, '.claude'), homeDir: w.home, env: w.env });
  for (const a of [copilot, cursor]) {
    assert.deepEqual(a.findItems(proj, c.adapterCtx(a)), [], a.id);
    assert.deepEqual(names(a.findItems(other, c.adapterCtx(a))), ['there'], a.id);
  }
  // ~/.claude is the personal folder of Copilot and Cursor even when Claude Code uses another folder
  assert.deepEqual(copilot.findItems(w.home, c.adapterCtx(copilot)), []);
});

// ---------------- cross-tool ----------------
test('cross-tool: ~/.agents/skills/x reported by four adapters is one roster item with four tools; ~/.claude/skills by three (adapter order)', () => {
  const w = world('cross-personal');
  allTools(w);
  skill(path.join(w.home, '.agents', 'skills'), 'x');
  skill(path.join(w.claude, 'skills'), 'y');
  const c = w.catalog();
  c.load();
  assert.deepEqual(c.active.map((a) => a.id), ADAPTERS.map((a) => a.id), 'every tool detected');
  const x = c.roster.get('skill:x');
  assert.deepEqual(x.tools, ['codex', 'gemini-cli', 'copilot', 'cursor']);
  assert.deepEqual(x.sources, ['personal']);
  assert.equal(x.global, true);
  assert.deepEqual(c.roster.get('skill:y').tools, ['claude-code', 'copilot', 'cursor']);
  assert.deepEqual(c.roster.get('agent:general-purpose').tools, ['claude-code']);
  // The order follows the catalog's adapters, not the order they answered in
  const r = w.catalog({ adapters: [...ADAPTERS].reverse() });
  r.load();
  assert.deepEqual(r.roster.get('skill:x').tools, ['cursor', 'copilot', 'gemini-cli', 'codex']);
});

test('cross-tool: a project .claude/skills/y is counted once for the project with tools claude-code, copilot, cursor; .agents/skills/z has six tools', () => {
  const w = world('cross-project');
  allTools(w);
  const proj = mkdir(w.work, 'shared proj');
  skill(path.join(proj, '.claude', 'skills'), 'y');
  skill(path.join(proj, '.agents', 'skills'), 'z');
  mdAgent(path.join(proj, '.claude', 'agents', 'r.md'), 'r-agent');
  rollout(rolloutAt(path.join(w.home, '.codex'), '12', 'p'), meta(proj)); // the project is known through Codex only
  const c = w.catalog();
  c.load();
  const y = c.roster.get('skill:y');
  const p = c.getProject(y.installedIn[0]);
  assert.ok(normPath(p.path) === normPath(proj));
  assert.deepEqual(p.via, ['codex']);
  assert.deepEqual(y.tools, ['claude-code', 'copilot', 'cursor', 'opencode'], 'OpenCode reads a project .claude/skills too');
  assert.deepEqual(y.sources, ['project']);
  assert.deepEqual(c.roster.get('agent:r-agent').tools, ['claude-code', 'copilot', 'cursor']);
  assert.deepEqual(c.roster.get('skill:z').tools, ['codex', 'gemini-cli', 'copilot', 'cursor', 'antigravity', 'opencode']);
  assert.deepEqual(p.installed, { skills: 2, agents: 1 }, 'one file is counted once, however many tools read it');
});

// ---------------- snapshot ----------------
test('snapshot: tools lists every adapter with detected and its project, skill, agent and plugin counts; roster items carry tools, projects carry via', () => {
  const w = world('snapshot');
  const a = mkdir(w.work, 'a');
  const b = mkdir(w.work, 'b');
  const cc = mkdir(w.work, 'c');
  write(path.join(w.claude, 'projects', 'f-a', 's.jsonl'), JSON.stringify({ type: 'user', cwd: a, sessionId: 's' }) + '\n');
  skill(path.join(w.claude, 'skills'), 'k');
  const codexRoot = path.join(w.home, '.codex');
  rollout(rolloutAt(codexRoot, '13', 'a'), meta(a));
  rollout(rolloutAt(codexRoot, '13', 'c'), meta(cc));
  skill(path.join(w.home, '.agents', 'skills'), 's');
  skill(path.join(codexRoot, 'plugins', 'cache', 'm', 'pl', '1.0.0', 'skills'), 'ps');
  write(path.join(w.home, '.gemini', 'projects.json'), JSON.stringify({ projects: { [b]: 'b' } }));
  mdAgent(path.join(w.home, '.gemini', 'agents', 'ga.md'), 'ga');
  mkdir(w.appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat'); // Copilot Chat present, no project
  const c = w.catalog();
  c.load();
  const snap = snapshot(new Ingest(c), c);
  assert.deepEqual(snap.tools.map((t) => t.id), ADAPTERS.map((x) => x.id));
  const t = Object.fromEntries(snap.tools.map((x) => [x.id, x]));
  const builtins = Object.keys(BUILTIN_AGENTS).length;
  assert.deepEqual(t['claude-code'], { id: 'claude-code', name: 'Claude Code', detected: true, projects: 1, skills: 1, agents: builtins, plugins: 0 });
  assert.deepEqual(t.codex, { id: 'codex', name: 'Codex', detected: true, projects: 2, skills: 2, agents: 0, plugins: 1 });
  assert.deepEqual(t['gemini-cli'], { id: 'gemini-cli', name: 'Gemini CLI', detected: true, projects: 1, skills: 1, agents: 1, plugins: 0 });
  assert.deepEqual(t.copilot, { id: 'copilot', name: 'GitHub Copilot', detected: true, projects: 0, skills: 2, agents: 0, plugins: 0 });
  assert.deepEqual(t.cursor, { id: 'cursor', name: 'Cursor', detected: false, projects: 0, skills: 0, agents: 0, plugins: 0 });
  assert.deepEqual(t.antigravity, { id: 'antigravity', name: 'Antigravity', detected: false, projects: 0, skills: 0, agents: 0, plugins: 0 });
  const pa = snap.projects.find((p) => p.path && normPath(p.path) === normPath(a));
  assert.deepEqual(pa.via, ['claude-code', 'codex']);
  const s = snap.roster.find((r) => r.id === 'skill:s');
  assert.deepEqual(s.tools, ['codex', 'gemini-cli', 'copilot']);
  assert.notEqual(s.tools, c.roster.get('skill:s').tools, 'the view carries a copy');
  assert.ok(snap.roster.every((r) => Array.isArray(r.tools)));
});

// ---------------- privacy and roots ----------------
test('privacy: no adapter opens chat or session content or a database, reads a rollout past its first line, or writes anything', () => {
  const w = world('privacy');
  allTools(w);
  const proj = mkdir(w.work, 'proj');
  const h = ws(w.appData, 'Code', 'h1', { folder: fileUri(proj) }, { chat: ['s.jsonl'], editing: ['e'] });
  write(path.join(h, 'state.vscdb'), 'SQLite format 3');
  write(path.join(ws(w.appData, 'Cursor', 'c1', { folder: fileUri(proj) }), 'state.vscdb'), 'SQLite format 3');
  ws(w.appData, 'Antigravity IDE', 'g1', { folder: fileUri(proj) });
  const g = path.join(w.home, '.gemini');
  write(path.join(g, 'projects.json'), JSON.stringify({ projects: { [proj]: 'proj' } }));
  write(path.join(g, 'tmp', 'proj', 'chats', 'session-1.jsonl'), '{"secret":"chat"}\n');
  write(path.join(g, 'tmp', 'proj', '.project_root'), proj);
  write(path.join(g, 'antigravity-cli', 'conversations', 'c.db'), 'SQLite format 3');
  write(path.join(g, 'antigravity-cli', 'conversation_summaries.db'), 'SQLite format 3');
  const cop = path.join(w.home, '.copilot');
  write(path.join(cop, 'session-state', 's', 'workspace.yaml'), `cwd: ${proj}\n`);
  write(path.join(cop, 'session-state', 's', 'events.jsonl'), '{"secret":"event"}\n');
  write(path.join(cop, 'session-state', 's2', 'workspace.yaml'), 'id: s2\n'); // no cwd: events.jsonl must still not be read
  write(path.join(cop, 'session-state', 's2', 'events.jsonl'), `cwd: ${proj}\n`);
  write(path.join(cop, 'session-store.db'), 'SQLite format 3');
  const cx = path.join(w.home, '.codex');
  const laterLines = Array.from({ length: 1500 }, () => LATER);
  const rf = rollout(rolloutAt(cx, '14', 'p'), meta(proj), laterLines);
  const firstLen = Buffer.byteLength(JSON.stringify(meta(proj))) + 1;
  assert.ok(fs.statSync(rf).size > firstLen + 64 * 1024, 'precondition: the later lines are long');
  write(path.join(cx, 'state_5.sqlite'), 'SQLite format 3');
  write(path.join(cx, 'history.jsonl'), '{"secret":"history"}\n');
  write(path.join(cx, 'session_index.jsonl'), '{"secret":"index"}\n');

  const opened = [];
  const written = [];
  const fdPath = new Map();
  const readBytes = new Map();
  const orig = {};
  const wrap = (name, fn) => {
    orig[name] = fs[name];
    fs[name] = fn(orig[name]);
  };
  wrap('openSync', (o) => function (p, flags, ...rest) {
    opened.push({ p: String(p), flags });
    const fd = o.call(this, p, flags, ...rest);
    fdPath.set(fd, String(p));
    return fd;
  });
  wrap('readSync', (o) => function (fd, ...rest) {
    const n = o.call(this, fd, ...rest);
    const p = fdPath.get(fd);
    if (p) readBytes.set(p, (readBytes.get(p) || 0) + n);
    return n;
  });
  for (const n of ['readFileSync', 'createReadStream']) wrap(n, (o) => function (p, ...rest) {
    opened.push({ p: String(p), flags: 'r' });
    return o.call(this, p, ...rest);
  });
  for (const n of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'cpSync', 'createWriteStream', 'writeSync', 'truncateSync', 'utimesSync', 'symlinkSync'])
    wrap(n, (o) => function (p, ...rest) {
      written.push(`${n} ${p}`);
      return o.call(this, p, ...rest);
    });
  let c;
  try {
    c = w.catalog();
    c.load();
    c.load();
  } finally {
    for (const [n, f] of Object.entries(orig)) fs[n] = f;
  }
  const forbidden = [/[\\/](chatSessions|chatEditingSessions|chats|conversations)[\\/]/i, /events\.jsonl$/i, /\.(sqlite|db|vscdb)(-wal|-shm|-journal)?$/i, /[\\/]\.codex[\\/](history|session_index)\.jsonl$/i];
  assert.deepEqual(opened.filter((o) => forbidden.some((re) => re.test(o.p))).map((o) => o.p), [], 'no chat, session content or database is opened');
  assert.deepEqual(opened.filter((o) => o.flags !== undefined && o.flags !== 'r').map((o) => o.p), [], 'every file is opened read-only');
  assert.deepEqual(written, [], 'nothing is written');
  const readFromRollout = readBytes.get(rf) || 0;
  assert.ok(readFromRollout >= firstLen && readFromRollout - firstLen < 4 * 1024, `the rollout is read up to one 4 KiB chunk past its first line (${readFromRollout} bytes)`);
  // The spy was live: the metadata files were read
  for (const end of ['workspace.yaml', 'workspace.json', '.project_root', 'projects.json']) assert.ok(opened.some((o) => o.p.endsWith(end)), end);
  assert.ok(c.allProjects().some((p) => normPath(p.path) === normPath(proj) && p.via.length === 5), 'the project was found by every tool but Claude Code');
});

test('env-only roots: adapter sources never use os.homedir() or process.env; CODEX_HOME, COPILOT_HOME and APPDATA are read from the catalog environment', () => {
  const dir = path.join(REPO, 'server', 'adapters');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /\bhomedir\b|process\.env|['"]node:os['"]|['"]os['"]/, `${f} derives its roots from ctx only`);
  }
  const w = world('env-roots');
  const codexRoot = path.join(w.base, 'elsewhere', 'codex');
  const copilotRoot = path.join(w.base, 'elsewhere', 'copilot');
  const appData = path.join(w.base, 'elsewhere', 'Roaming');
  w.env = { CODEX_HOME: codexRoot, COPILOT_HOME: copilotRoot, APPDATA: appData };
  const p1 = mkdir(w.work, 'p1');
  const p2 = mkdir(w.work, 'p2');
  const p3 = mkdir(w.work, 'p3');
  rollout(rolloutAt(codexRoot, '15', 'p1'), meta(p1));
  write(path.join(copilotRoot, 'session-state', 's', 'workspace.yaml'), `cwd: ${p2}\n`);
  ws(appData, 'Cursor', 'c1', { folder: fileUri(p3) });
  // The default roots hold other projects: they must not be read
  const decoy = mkdir(w.work, 'decoy');
  rollout(rolloutAt(path.join(w.home, '.codex'), '15', 'd'), meta(decoy));
  write(path.join(w.home, '.copilot', 'session-state', 's', 'workspace.yaml'), `cwd: ${decoy}\n`);
  ws(w.appData, 'Cursor', 'c1', { folder: fileUri(decoy) });
  const c = w.catalog();
  c.load();
  const via = (p) => c.allProjects().find((x) => x.path && normPath(x.path) === normPath(p))?.via || [];
  assert.deepEqual(via(p1), ['codex']);
  assert.deepEqual(via(p2), ['copilot']);
  assert.deepEqual(via(p3), ['cursor']);
  assert.deepEqual(via(decoy), []);
});

// ---------------- catalog filters ----------------
test('discovery: the temp folder itself is broad (never a project); a working folder inside it stays a project of its own', () => {
  const w = world('temp-broad');
  const temp = mkdir(w.home, 'AppData', 'Local', 'Temp');
  const inside = mkdir(temp, 'some-clone');
  const envTemp = mkdir(w.base, 'OtherTemp');
  write(path.join(w.home, '.gemini', 'projects.json'), JSON.stringify({ projects: { [temp.toLowerCase()]: 'temp', [inside]: 'clone', [envTemp]: 'other' } }));
  w.env.TEMP = envTemp;
  const c = w.catalog();
  c.load();
  assert.deepEqual(norm(c.allProjects().map((p) => p.path)), norm([inside]));
  assert.deepEqual(norm(c.memory.list().map((m) => m.path)), norm([inside]), 'the temp folders are not remembered');
  const p = c.allProjects()[0];
  assert.equal(p.broad, false);
  assert.equal(path.basename(p.path), 'some-clone');
});

// ---------------- review round 1 ----------------
// Records the file system calls made while fn runs: [{ name, p, bytes? }] (readSync is mapped back to the file its
// descriptor was opened for). fail(name, path) may return an error to throw instead of the call (a locked file).
function spyFs(fn, { fail } = {}) {
  const calls = [];
  const fdPath = new Map();
  const orig = {};
  for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'readFileSync', 'readSync', 'accessSync', 'realpathSync']) {
    orig[name] = fs[name];
    fs[name] = function (p, ...rest) {
      const file = name === 'readSync' ? fdPath.get(p) : String(p);
      const call = { name, p: file };
      calls.push(call);
      const err = fail?.(name, file);
      if (err) throw err;
      const r = orig[name].call(this, p, ...rest);
      if (name === 'openSync') fdPath.set(r, file);
      if (name === 'readSync') call.bytes = r;
      return r;
    };
  }
  const native = orig.realpathSync.native;
  fs.realpathSync.native = function (p, ...rest) {
    calls.push({ name: 'realpath', p: String(p) });
    return native.call(this, p, ...rest);
  };
  try {
    fn();
  } finally {
    for (const [n, f] of Object.entries(orig)) fs[n] = f;
    fs.realpathSync.native = native;
  }
  return calls;
}
const callsOn = (calls, name, p) => calls.filter((c) => c.name === name && normPath(c.p) === normPath(p)).length;
const bytesRead = (calls, p) => calls.filter((c) => c.name === 'readSync' && normPath(c.p) === normPath(p)).reduce((s, c) => s + c.bytes, 0);
const locked = (file) => Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' });
// A time in whole seconds (it survives a round trip through the file system unchanged)
const wholeSecondsAgo = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000);

test('gemini lastSeen (finding 1): one chats listing per id per pass however many sources name the id; while the chats folder time is unchanged only its newest entry is looked at again', () => {
  const w = world('gemini-lastseen');
  const g = path.join(w.home, '.gemini');
  const proj = mkdir(w.work, 'Busy');
  write(path.join(g, 'projects.json'), JSON.stringify({ projects: { [proj]: 'busy' } }));
  write(path.join(g, 'tmp', 'busy', '.project_root'), proj);
  write(path.join(g, 'history', 'busy', '.project_root'), proj);
  const chats = path.join(g, 'tmp', 'busy', 'chats');
  const files = Array.from({ length: 40 }, (_, i) => write(path.join(chats, `session-${i}.jsonl`), '{}\n'));
  const times = files.map((f, i) => age(f, 40 - i)); // the last file is the newest
  const T1 = wholeSecondsAgo(30);
  fs.utimesSync(chats, T1, T1);
  const ctx = w.ctx(geminiCli);
  const listed = (calls) => callsOn(calls, 'readdirSync', chats);
  const statsInChats = (calls) => calls.filter((c) => c.name === 'statSync' && normPath(path.dirname(c.p)) === normPath(chats)).length;
  let found;
  const pass = () => spyFs(() => (found = geminiCli.findProjects(ctx)));
  let calls = pass();
  assert.equal(found.length, 1);
  assert.equal(found[0].lastSeenAt, times[39]);
  assert.equal(listed(calls), 1, 'projects.json and two markers name the id: the chats folder is listed once');
  assert.equal(statsInChats(calls), 40, 'every entry is looked at once');
  calls = pass();
  assert.equal(listed(calls), 0, 'folder time unchanged: not listed again');
  assert.equal(statsInChats(calls), 1, 'only the newest entry is looked at again');
  assert.equal(found[0].lastSeenAt, times[39]);
  // A running session appends to its file (the folder time does not change)
  const tAppend = age(files[39], 0.5);
  calls = pass();
  assert.equal(found[0].lastSeenAt, tAppend);
  assert.equal(listed(calls), 0);
  // A new session file changes the folder time: listed again
  const fresh = write(path.join(chats, 'session-new.jsonl'), '{}\n');
  const tFresh = age(fresh, 0.1);
  calls = pass();
  assert.equal(listed(calls), 1);
  assert.equal(found[0].lastSeenAt, tFresh);
  // The known newest entry is gone while the folder time looks unchanged: listed again
  const T2 = wholeSecondsAgo(20);
  fs.utimesSync(chats, T2, T2);
  pass();
  fs.rmSync(fresh);
  fs.utimesSync(chats, T2, T2);
  calls = pass();
  assert.equal(listed(calls), 1);
  assert.equal(found[0].lastSeenAt, tAppend);
  // Ids that are gone leave the cache
  fs.rmSync(g, { recursive: true, force: true });
  assert.deepEqual(geminiCli.findProjects(ctx), []);
  assert.equal(ctx.cache.chats.size, 0);
});

test('gemini ids (finding 6b): an id that is a path ("../x", "a/b", "..", ".") is never used, even when the folder it would reach exists and holds chats', () => {
  const w = world('gemini-ids');
  const g = path.join(w.home, '.gemini');
  const ids = { '../outside': path.join(g, 'outside'), 'a/b': path.join(g, 'tmp', 'a', 'b'), '..': g, '.': path.join(g, 'tmp') };
  const projects = {};
  for (const [id, reached] of Object.entries(ids)) {
    age(write(path.join(reached, 'chats', 'c.jsonl'), '{}\n'), 3);
    age(path.join(reached, 'chats'), 3);
    projects[mkdir(w.work, `p-${Object.keys(projects).length}`)] = id;
  }
  write(path.join(g, 'projects.json'), JSON.stringify({ projects }));
  assert.ok(Object.values(ids).every((d) => fs.existsSync(path.join(d, 'chats', 'c.jsonl'))), 'precondition: every reached folder exists');
  const found = geminiCli.findProjects(w.ctx(geminiCli));
  assert.deepEqual(pathsOf(found), norm(Object.keys(projects)));
  assert.deepEqual(found.map((f) => f.lastSeenAt), [0, 0, 0, 0], 'no id that is a path is followed');
});

test('UNC and WSL paths (finding 2): no adapter reports them (file://host URIs, \\\\server\\share, \\\\wsl.localhost), and the catalog never checks one an adapter or an older memory file gives', () => {
  assert.equal(folderFromUri('file://wsl.localhost/Ubuntu/home/u/proj'), null);
  assert.equal(folderFromUri('file://server/share/proj'), null);
  assert.equal(folderFromUri('file:///c%3A/x'), 'C:\\x');
  assert.equal(cleanPath('\\\\server\\share\\x'), null);
  assert.equal(cleanPath('\\\\wsl$\\Ubuntu\\x'), null);
  assert.equal(cleanPath('//server/share/x'), null);
  assert.equal(cleanPath('\\\\?\\C:\\x'), null);
  assert.equal(cleanPath('relative\\x'), null);
  assert.equal(cleanPath(' c:\\x '), 'C:\\x');
  const w = world('unc');
  allTools(w);
  const local = mkdir(w.work, 'local');
  const wsl = '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj';
  const share = '\\\\server\\share\\proj';
  const cx = path.join(w.home, '.codex');
  rollout(rolloutAt(cx, '18', 'wsl'), meta(wsl));
  rollout(rolloutAt(cx, '18', 'local'), meta(local));
  write(path.join(w.home, '.copilot', 'session-state', 's1', 'workspace.yaml'), `cwd: ${share}\n`);
  write(path.join(w.home, '.gemini', 'projects.json'), JSON.stringify({ projects: { [share.toLowerCase()]: 'share', [wsl]: 'wsl' } }));
  write(path.join(w.home, '.gemini', 'tmp', 'm', '.project_root'), '\\\\wsl$\\Ubuntu\\home\\u\\marker');
  ws(w.appData, 'Code', 'h1', { folder: 'file://wsl.localhost/Ubuntu/home/u/proj' }, { chat: ['c'] });
  ws(w.appData, 'Code', 'h2', { folder: 'file://server/share/proj' }, { chat: ['c'] });
  ws(w.appData, 'Cursor', 'c1', { folder: 'file://server/share/proj' });
  ws(w.appData, 'Antigravity IDE', 'g1', { folder: 'file://wsl.localhost/Ubuntu/home/u/proj' });
  const isUnc = (p) => /^(\\\\|\/\/)/.test(String(p));
  for (const a of [codex, geminiCli, copilot, cursor, antigravity]) {
    let found;
    const calls = spyFs(() => (found = a.findProjects(w.ctx(a))));
    assert.ok(!found.some((f) => isUnc(f.path)), `${a.id} reports no UNC path`);
    assert.deepEqual(calls.filter((c) => isUnc(c.p)), [], `${a.id} touches no UNC path`);
  }
  // Any adapter (Claude Code included) goes through the catalog filter; an older memory file may hold UNC paths
  const fake = { id: 'fake', name: 'Fake', detect: () => true, findProjects: () => [{ path: share }, { path: '//server/share/fwd' }, { path: wsl }] };
  const memory = new ProjectMemory();
  memory.record('\\\\server\\share\\old', { via: 'claude-code' });
  const c = w.catalog({ adapters: [...ADAPTERS, fake], memory });
  const calls = spyFs(() => {
    c.load();
    c.load();
  });
  assert.deepEqual(calls.filter((x) => isUnc(x.p)).map((x) => `${x.name} ${x.p}`), [], 'no file system call on a UNC path');
  assert.deepEqual(norm(c.allProjects().filter((p) => p.path).map((p) => p.path)), norm([local]));
  assert.deepEqual(norm(memory.list().map((m) => m.path)), norm(['\\\\server\\share\\old', local]), 'an old entry is kept (never deleted), not listed');
  assert.equal(memory.list().find((m) => isUnc(m.path)).exists, false);
});

test('codex (finding 3): a rollout is read in 4 KiB chunks, so at most one small chunk past the first line is read, however long the file or the first line', () => {
  const CHUNK_LIMIT = 4 * 1024; // contract §3
  assert.equal(CHUNK, CHUNK_LIMIT);
  const w = world('codex-chunk');
  const root = path.join(w.home, '.codex');
  const proj = mkdir(w.work, 'p');
  const later = Array.from({ length: 300 }, () => LATER);
  const cases = [meta(proj), { type: 'session_meta', payload: { cwd: proj, instructions: 'y'.repeat(3 * CHUNK_LIMIT + 123) } }];
  for (const [i, first] of cases.entries()) {
    const f = rollout(rolloutAt(root, '19', `c${i}`), first, later);
    const firstLen = Buffer.byteLength(JSON.stringify(first)) + 1;
    assert.ok(fs.statSync(f).size > firstLen + 4 * CHUNK_LIMIT, 'precondition: long later lines');
    let r;
    const calls = spyFs(() => (r = rolloutCwd(f)));
    assert.equal(r.cwd, proj);
    const n = bytesRead(calls, f);
    assert.ok(n >= firstLen && n - firstLen < CHUNK_LIMIT, `case ${i}: ${n} bytes read for a ${firstLen}-byte first line`);
  }
});

test('copilot (finding 3): workspace.yaml is read only up to its cwd: line (the summary after it is not read); a cwd line longer than a read chunk, CRLF and a BOM work', () => {
  const w = world('copilot-yaml-read');
  const proj = mkdir(w.work, 'yaml proj');
  const head = `\ufeffid: s1\r\ncwd: ${proj}\r\n`;
  const file = write(path.join(w.base, 'a.yaml'), head + 'git_root: x\r\nsummary: ' + 'a secret summary '.repeat(2000) + '\r\n');
  let cwd;
  let calls = spyFs(() => (cwd = workspaceYamlCwd(file)));
  assert.equal(cwd, proj);
  const end = Buffer.byteLength(head);
  const n = bytesRead(calls, file);
  assert.ok(n >= end && n - end < 1024, `read up to the cwd: line and less than 1 KiB past it (${n} of ${fs.statSync(file).size} bytes)`);
  // A cwd line longer than a read chunk (the folder need not exist), split multi-byte letters included
  const long = 'C:\\' + 'uzun klasör ğüşiöç\\'.repeat(40) + 'son';
  const f2 = write(path.join(w.base, 'b.yaml'), `id: s2\ncwd: ${long}\nsummary: ${'x'.repeat(5000)}\n`);
  calls = spyFs(() => (cwd = workspaceYamlCwd(f2)));
  assert.equal(cwd, long);
  assert.ok(bytesRead(calls, f2) < Buffer.byteLength(`id: s2\ncwd: ${long}\n`) + 1024);
  // No cwd: line, a cwd: line without a final line break, an empty value
  assert.equal(workspaceYamlCwd(write(path.join(w.base, 'c.yaml'), 'id: s3\nsummary: x\n')), null);
  assert.equal(workspaceYamlCwd(write(path.join(w.base, 'd.yaml'), `id: s4\ncwd: ${proj}`)), proj);
  assert.equal(workspaceYamlCwd(write(path.join(w.base, 'e.yaml'), 'cwd:\nsummary: C:\\x\n')), null);
});

test('cross-tool (finding 6a): roster tools follow the adapter order even when a later adapter reported the item first (a personal ~/.cursor/skills/z and a project .agents/skills/z)', () => {
  const w = world('tools-order');
  allTools(w);
  const proj = mkdir(w.work, 'ordered');
  skill(path.join(proj, '.agents', 'skills'), 'z');
  skill(path.join(w.home, '.cursor', 'skills'), 'z');
  rollout(rolloutAt(path.join(w.home, '.codex'), '17', 'o'), meta(proj));
  const c = w.catalog();
  c.load();
  const z = c.roster.get('skill:z');
  assert.deepEqual(z.tools, ['codex', 'gemini-cli', 'copilot', 'cursor', 'antigravity', 'opencode'], 'cursor answered first (global items), the order is still the adapter order');
  assert.deepEqual(z.sources, ['personal', 'project']);
});

test('project spelling (finding 8): a project first reported lower-cased takes the on-disk spelling when a later report gives it; the memory keeps and writes the better spelling', () => {
  const w = world('respell');
  const proj = mkdir(w.work, 'My Project');
  const proper = fs.realpathSync.native(proj); // the spelling on disk
  const lower = proper.toLowerCase();
  let reported = lower;
  const fake = { id: 'fake', name: 'Fake', detect: () => true, findProjects: () => [{ path: reported, lastSeenAt: 0 }] };
  const c = w.catalog({ adapters: [fake] });
  c.load();
  const first = c.allProjects().find((p) => p.path && normPath(p.path) === normPath(proj));
  assert.equal(first.path, lower, 'precondition: first seen lower-cased');
  reported = proper;
  c.load();
  const p = c.allProjects().find((x) => x.path && normPath(x.path) === normPath(proj));
  assert.equal(p.id, first.id, 'the same project');
  assert.equal(p.path, proper);
  assert.equal(p.name, 'My Project');
  assert.equal(c.memory.list()[0].path, proper);
  reported = lower;
  c.load();
  assert.equal(c.memory.list()[0].path, proper, 'a lower-cased report never replaces the better spelling');
  assert.equal(c.allProjects().find((x) => x.path && normPath(x.path) === normPath(proj)).path, proper);
});

test('toolSeen: each tool’s newest trace time per project, from this pass only (the building shows another tool at work)', () => {
  const w = world('tool-seen');
  const proj = mkdir(w.work, 'Shared');
  let codexAt = 1000;
  const a = { id: 'codex', name: 'Codex', detect: () => true, findProjects: () => [{ path: proj, lastSeenAt: codexAt }, { path: proj, lastSeenAt: 500 }] };
  const b = { id: 'gemini-cli', name: 'Gemini', detect: () => true, findProjects: () => [{ path: proj, lastSeenAt: 2000 }, { path: proj, lastSeenAt: 0 }] };
  const c = w.catalog({ adapters: [a, b] });
  c.load();
  const p = () => c.allProjects().find((x) => x.path && normPath(x.path) === normPath(proj));
  assert.deepEqual(p().toolSeen, { codex: 1000, 'gemini-cli': 2000 });
  codexAt = 3000;
  c.load();
  assert.deepEqual(p().toolSeen, { codex: 3000, 'gemini-cli': 2000 }, 'the next pass brings the newer time');
});

test('caches (finding 9): Codex .toml agents are read once and then only when they change; a Gemini extension manifest is read once per pass', () => {
  const w = world('toml-cache');
  mkdir(w.claude);
  const root = path.join(w.home, '.codex');
  const proj = mkdir(w.work, 'agents proj');
  rollout(rolloutAt(root, '20', 'a'), meta(proj));
  const pt = write(path.join(proj, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "one"\n');
  const gt = write(path.join(root, 'agents', 'helper.toml'), 'name = "helper"\n');
  const c = w.catalog({ adapters: [codex] });
  let calls = spyFs(() => c.load());
  assert.equal(callsOn(calls, 'openSync', pt), 1);
  assert.equal(callsOn(calls, 'openSync', gt), 1);
  calls = spyFs(() => c.load());
  assert.equal(callsOn(calls, 'openSync', pt), 0, 'unchanged: not reopened');
  assert.equal(callsOn(calls, 'openSync', gt), 0);
  assert.equal(c.roster.get('agent:reviewer').description, 'one');
  write(pt, 'name = "reviewer"\ndescription = "two, longer"\n');
  calls = spyFs(() => c.load());
  assert.equal(callsOn(calls, 'openSync', pt), 1, 'changed: read again');
  assert.equal(c.roster.get('agent:reviewer').description, 'two, longer');
  // Gemini extension: name and description from one read of the manifest
  const ext = path.join(w.home, '.gemini', 'extensions', 'e');
  const manifest = write(path.join(ext, 'gemini-extension.json'), JSON.stringify({ name: 'my-ext', description: 'An extension' }));
  let items;
  calls = spyFs(() => (items = geminiCli.findGlobalItems(w.ctx(geminiCli))));
  assert.equal(callsOn(calls, 'readFileSync', manifest) + callsOn(calls, 'openSync', manifest), 1);
  assert.equal(items.find((i) => i.kind === 'plugin').description, 'An extension');
});

test('shared listing (finding 9): one pass lists a folder once however many adapters read it (.agents/skills, .claude/skills, ~/.agents/skills, ~/.claude/agents) and looks at a SKILL.md once; the next pass lists again and sees changes', () => {
  const w = world('shared-listing');
  allTools(w);
  const proj = mkdir(w.work, 'listed');
  rollout(rolloutAt(path.join(w.home, '.codex'), '21', 'l'), meta(proj));
  const agentsSkills = path.join(proj, '.agents', 'skills');
  const claudeSkills = path.join(proj, '.claude', 'skills');
  const homeAgents = path.join(w.home, '.agents', 'skills');
  const claudeAgents = path.join(w.claude, 'agents');
  skill(agentsSkills, 'z');
  skill(claudeSkills, 'y');
  skill(homeAgents, 'x');
  mdAgent(path.join(claudeAgents, 'a.md'), 'a-agent');
  const zFile = path.join(agentsSkills, 'z', 'SKILL.md');
  const c = w.catalog();
  let calls = spyFs(() => c.load());
  for (const d of [agentsSkills, claudeSkills, homeAgents, claudeAgents]) assert.equal(callsOn(calls, 'readdirSync', d), 1, d);
  assert.equal(callsOn(calls, 'statSync', zFile), 1, 'five tools read the SKILL.md, it is looked at once');
  assert.equal(callsOn(calls, 'openSync', zFile), 1);
  assert.deepEqual(c.roster.get('skill:z').tools, ['codex', 'gemini-cli', 'copilot', 'cursor', 'antigravity', 'opencode']);
  skill(agentsSkills, 'z2');
  calls = spyFs(() => c.load());
  assert.equal(callsOn(calls, 'readdirSync', agentsSkills), 1, 'listed again on the next pass');
  assert.equal(callsOn(calls, 'openSync', zFile), 0, 'unchanged SKILL.md: not reopened');
  assert.deepEqual(c.roster.get('skill:z2')?.tools, ['codex', 'gemini-cli', 'copilot', 'cursor', 'antigravity', 'opencode'], 'the new skill is seen');
  // loadRoster alone runs as a pass of its own
  skill(agentsSkills, 'z3');
  calls = spyFs(() => c.loadRoster());
  assert.equal(callsOn(calls, 'readdirSync', agentsSkills), 1);
  assert.ok(c.roster.get('skill:z3'));
});

test('failed reads (finding 10): a locked Codex rollout, Copilot workspace.yaml, VS Code workspace.json or SKILL.md is not cached; it is read again on the next pass', () => {
  const w = world('io-error');
  allTools(w);
  const pa = mkdir(w.work, 'codex open');
  const pb = mkdir(w.work, 'codex read');
  const pc = mkdir(w.work, 'copilot');
  const pd = mkdir(w.work, 'cursor');
  const cx = path.join(w.home, '.codex');
  const ra = rollout(rolloutAt(cx, '22', 'a'), meta(pa));
  const rb = rollout(rolloutAt(cx, '22', 'b'), meta(pb));
  const yaml = write(path.join(w.home, '.copilot', 'session-state', 's', 'workspace.yaml'), `cwd: ${pc}\n`);
  const wsJson = path.join(ws(w.appData, 'Cursor', 'c1', { folder: fileUri(pd) }), 'workspace.json');
  const skillFile = skill(path.join(w.home, '.agents', 'skills'), 'locked-skill');
  const fail = (name, p) => {
    const n = normPath(p);
    if (name === 'openSync' && [ra, yaml, skillFile].some((f) => normPath(f) === n)) return locked(p);
    if (name === 'readSync' && n === normPath(rb)) return locked(p);
    if (name === 'readFileSync' && n === normPath(wsJson)) return locked(p);
    return null;
  };
  const ctxs = Object.fromEntries([codex, copilot, cursor].map((a) => [a.id, w.ctx(a)]));
  const c = w.catalog();
  const found = {};
  const pass = (opts) =>
    spyFs(() => {
      for (const a of [codex, copilot, cursor]) found[a.id] = pathsOf(a.findProjects(ctxs[a.id]));
      c.load();
    }, opts);
  pass({ fail });
  assert.deepEqual(found.codex, [], 'locked: not found this pass');
  assert.deepEqual(found.copilot, []);
  assert.deepEqual(found.cursor, []);
  assert.equal(c.roster.get('skill:locked-skill'), undefined);
  pass();
  assert.deepEqual(found.codex, norm([pa, pb]), 'read again once unlocked');
  assert.deepEqual(found.copilot, norm([pc]));
  assert.deepEqual(found.cursor, norm([pd]));
  assert.ok(c.roster.get('skill:locked-skill'), 'the SKILL.md is read again');
  assert.deepEqual(rolloutCwd(path.join(cx, 'missing.jsonl')), { error: true });
});

test('codex plugins (finding 11): the version folder is chosen in semantic version order; a pre-release is lower than its release', () => {
  const gt = (a, b) => assert.ok(compareVersions(a, b) > 0 && compareVersions(b, a) < 0, `${a} > ${b}`);
  gt('1.0.0', '1.0.0-beta');
  gt('1.0.0-beta', '1.0.0-alpha.1');
  gt('1.0.0-beta.11', '1.0.0-beta.2');
  gt('1.0.0-beta.2', '1.0.0-beta');
  gt('1.0.0-rc.1', '1.0.0-beta.11');
  gt('1.0.0-alpha.beta', '1.0.0-alpha.1');
  gt('2.0.0-rc.1', '1.9.9');
  gt('1.10.0', '1.9.0');
  gt('26.924.22138', '26.924.20706');
  gt('0.1.0', 'not-a-version');
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  const w = world('semver');
  const cache = path.join(w.home, '.codex', 'plugins', 'cache', 'm');
  for (const v of ['1.0.0-beta', '1.0.0', '1.0.0-alpha.1', '0.9.9']) skill(path.join(cache, 'plug', v, 'skills'), `s-${v}`);
  for (const v of ['1.0.0-beta.2', '1.0.0-beta.11']) skill(path.join(cache, 'pre', v, 'skills'), `s-${v}`);
  const g = codex.findGlobalItems(w.ctx(codex));
  const inner = g.filter((i) => i.kind === 'skill').map((i) => i.name).sort();
  assert.deepEqual(inner, ['plug:s-1.0.0', 'pre:s-1.0.0-beta.11']);
});

// ---------------- Qwen Code and OpenCode (roadmap F4, 2026-10-08) ----------------
test('Qwen Code: found by its folder; projects from the head of each project folder’s newest chat (the cwd only); its own skill, agent and extension folders', () => {
  const w = world('qwen');
  assert.equal(qwen.detect(w.ctx(qwen)), false);
  write(path.join(w.home, '.qwen', 'settings.json'), '{}');
  assert.equal(qwen.detect(w.ctx(qwen)), true);
  const proj = mkdir(w.work, 'tarif sitem');
  const chats = mkdir(w.home, '.qwen', 'projects', 'c--x-tarif-sitem', 'chats');
  const line = (cwd, text) => JSON.stringify({ uuid: 'u', sessionId: 's', timestamp: '2026-10-08T10:00:00.000Z', type: 'user', cwd, message: { parts: [{ text }] } });
  write(path.join(chats, 'old.jsonl'), line(path.join(w.work, 'elsewhere'), 'old') + '\n');
  age(path.join(chats, 'old.jsonl'), 3);
  write(path.join(chats, 'new.jsonl'), line(proj, 'a secret prompt') + '\n' + line(proj, 'later') + '\n');
  const found = qwen.findProjects(w.ctx(qwen));
  assert.deepEqual(pathsOf(found), norm([proj]), 'the newest chat names the folder');
  assert.doesNotMatch(JSON.stringify(found), /secret/, 'nothing of the chat but its folder');
  skill(path.join(proj, '.qwen', 'skills'), 'q-skill');
  mdAgent(path.join(proj, '.qwen', 'agents', 'q-agent.md'), 'q-agent');
  assert.deepEqual(names(qwen.findItems(proj, w.ctx(qwen))), ['q-agent', 'q-skill']);
  skill(path.join(w.home, '.qwen', 'skills'), 'g-skill');
  const ext = mkdir(w.home, '.qwen', 'extensions', 'myext');
  write(path.join(ext, 'qwen-extension.json'), JSON.stringify({ name: 'My Ext', description: 'an extension' }));
  skill(path.join(ext, 'skills'), 'ext-skill');
  const global = qwen.findGlobalItems(w.ctx(qwen));
  assert.ok(global.some((i) => i.name === 'g-skill' && i.source === 'personal'));
  assert.ok(global.some((i) => i.kind === 'plugin'));
});

test('OpenCode: no projects from its database (never opened); its project and personal folders, both spellings; XDG_CONFIG_HOME honoured', () => {
  const w = world('opencode');
  assert.equal(opencode.detect(w.ctx(opencode)), false);
  mkdir(w.home, '.config', 'opencode');
  assert.equal(opencode.detect(w.ctx(opencode)), true);
  assert.deepEqual(opencode.findProjects(w.ctx(opencode)), []);
  const proj = mkdir(w.work, 'oc proj');
  skill(path.join(proj, '.opencode', 'skill'), 's1');
  skill(path.join(proj, '.opencode', 'skills'), 's2');
  mdAgent(path.join(proj, '.opencode', 'agent', 'a1.md'), 'a1');
  mdAgent(path.join(proj, '.opencode', 'agents', 'a2.md'), 'a2');
  assert.deepEqual(names(opencode.findItems(proj, w.ctx(opencode))), ['a1', 'a2', 's1', 's2']);
  skill(path.join(w.home, '.config', 'opencode', 'skills'), 'p1');
  assert.deepEqual(names(opencode.findGlobalItems(w.ctx(opencode))), ['p1']);
  const x = world('opencode-xdg');
  x.env.XDG_CONFIG_HOME = mkdir(x.base, 'cfg');
  skill(path.join(x.env.XDG_CONFIG_HOME, 'opencode', 'skill'), 'xdg-skill');
  assert.deepEqual(names(opencode.findGlobalItems(x.ctx(opencode))), ['xdg-skill']);
  assert.ok(!fs.readFileSync(path.join(REPO, 'server', 'adapters', 'opencode.mjs'), 'utf8').includes('node:sqlite'), 'the database is the session reader’s, never an adapter’s');
});
