// "What changed" (server/changes.mjs, public/js/changes.js): git status entries and the files of the last 24 hours,
// newest first; heavy and hidden folders are not walked; a repository's own file system monitor never runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePorcelain, gitStatus, recentFiles, projectChanges, MAX_FILES } from '../server/changes.mjs';
import { GIT_SAFE_ARGS, repoConfigSafe, configNamesSafe, configNames, repoCheck, NO_GIT } from '../server/git.mjs';
import { changesSectionHtml, createChanges } from '../public/js/changes.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ork-chg-'));
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

test('porcelain: new, changed, deleted, renamed (its old path skipped), at most the limit', () => {
  const text = ['?? web/index.html', ' M app.js', 'D  old.txt', 'R  new name.js', 'old name.js', 'A  added.css', ''].join('\0');
  assert.deepEqual(parsePorcelain(text).files, [
    { path: path.join('web', 'index.html'), kind: 'new' },
    { path: 'app.js', kind: 'changed' },
    { path: 'old.txt', kind: 'deleted' },
    { path: 'new name.js', kind: 'renamed' },
    { path: 'added.css', kind: 'new' },
  ]);
  const many = Array.from({ length: 40 }, (_, i) => `?? f${i}.txt`).join('\0');
  const r = parsePorcelain(many);
  assert.deepEqual([r.files.length, r.more], [MAX_FILES, true]);
});

test('without git: the files of the last 24 hours, newest first; packages, builds and hidden folders are not walked', () => {
  const dir = tmp();
  const put = (rel, ageMs) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(f, t, t);
  };
  // The platform's own separator (a backslash is a letter of a name on Linux)
  put('index.html', 60_000);
  put(path.join('src', 'app.js'), 5_000);
  put('old.txt', 3 * 24 * 3600_000);
  put(path.join('node_modules', 'x', 'a.js'), 1_000);
  put(path.join('.cache', 'b.js'), 1_000);
  put(path.join('Library', 'c.asset'), 1_000);
  const r = recentFiles(dir);
  assert.deepEqual(r.files.map((f) => f.path), [path.join('src', 'app.js'), 'index.html']);
  assert.equal(r.more, false);
});

test('git: a repository answers from git status; its own core.fsmonitor program never runs', { skip: !hasGit }, async () => {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  g('init', '-q');
  const marker = path.join(dir, 'monitor-ran.txt');
  // A monitor that would leave a file behind if git started it
  g('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker)}`);
  fs.writeFileSync(path.join(dir, 'hello.py'), 'print(1)');
  // Plain git status does start it (so the check below means something with this git)
  execFileSync('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain'], { stdio: 'ignore', windowsHide: true });
  assert.ok(fs.existsSync(marker), 'a plain git status runs the repository’s monitor');
  fs.rmSync(marker);
  const r = await gitStatus(dir);
  assert.deepEqual(r.files, [{ path: 'hello.py', kind: 'new' }]);
  assert.ok(!fs.existsSync(marker), 'the file system monitor did not run');
  assert.ok(GIT_SAFE_ARGS.join(' ').includes('-c core.fsmonitor=false -c log.showSignature=false'));
});

test('the route: git first, then the time walk; nothing for a broad, missing or network folder; not a project', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const projects = [{ id: 'g', path: dir }, { id: 'b', path: dir, broad: true }, { id: 'n', path: '\\\\server\\share\\p' }];
  const catalog = { getProject: (id) => projects.find((p) => p.id === id) || null };
  const status = async () => ({ files: [{ path: 'gone.txt', kind: 'deleted' }, { path: 'a.txt', kind: 'new' }], more: false });
  const r = await projectChanges({ catalog, projectId: 'g', status, safe: () => true });
  assert.equal(r.body.via, 'git');
  assert.deepEqual(r.body.files.map((f) => f.path), ['a.txt', 'gone.txt'], 'newest first, a deleted file last');
  const noGit = await projectChanges({ catalog, projectId: 'g', status: async () => null, safe: () => true, recent: () => ({ files: [], more: false }) });
  assert.equal(noGit.body.via, 'time', 'git could not answer: the time walk');
  for (const id of ['b', 'n']) assert.equal((await projectChanges({ catalog, projectId: id, status })).body.via, null, id);
  assert.equal((await projectChanges({ catalog, projectId: 'x' })).status, 404);
});

test('the section: both languages, the kind of each file, escaped names; nothing for an unreadable folder', () => {
  const p = { id: 'a', path: 'C:\\p' };
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = changesSectionHtml(p, { via: 'git', files: [{ path: 'src\\<b>.js', kind: 'new', t: Date.now() - 5000 }, { path: 'x.js', kind: 'odd' }], more: true });
      assert.ok(h.includes(S.chgTitle) && h.includes(S.chgViaGit) && h.includes(S.chgKind_new) && h.includes(S.chgMoreMany), lang);
      assert.ok(h.includes('src\\&lt;b&gt;.js') && !h.includes('x.js'), 'escaped; an unknown kind is left out');
      assert.ok(changesSectionHtml(p, { via: 'time', files: [] }).includes(S.chgNoneTime), lang);
      assert.ok(changesSectionHtml(p, null).includes(S.chgLoading), lang);
      for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('chg'))) assert.ok(S[k], `${lang} ${k}`);
    }
  } finally {
    setLanguage('en');
  }
  assert.equal(changesSectionHtml(p, { via: null, files: [] }), '');
  const many = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, kind: 'changed' }));
  assert.ok(changesSectionHtml(p, { via: 'time', files: many, more: false }).includes(STRINGS.en.chgMore.replace('{count}', '3')));
});

test('the cache: asked once within 20 s; a failure reads as unreadable', async () => {
  let calls = 0;
  const c = createChanges({ fetchJson: async () => (calls++, { via: 'time', files: [] }) });
  c.get('a');
  c.get('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  const bad = createChanges({ fetchJson: async () => Promise.reject(new Error('x')) });
  bad.get('b');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bad.get('b').data.via, null);
});

test('config names: nothing that can start a program, no include (pure)', () => {
  assert.equal(configNamesSafe(['core.bare', 'remote.origin.url', 'branch.main.remote', 'submodule.lib.url', 'user.name']), true);
  for (const n of ['filter.a.clean', 'include.path', 'includeif.gitdir:c:/.path', 'core.fsmonitor', 'gpg.program', 'gpg.ssh.program', 'log.showsignature', 'diff.bin.textconv', 'core.sshcommand', 'core.hookspath', 'core.pager', 'extensions.worktreeconfig', 'Filter.A.Clean']) assert.equal(configNamesSafe(['core.bare', n]), false, n);
  assert.equal(configNamesSafe(null), false, 'git could not read it');
});

test('repository check: a whole repository of its own, read by git’s parser; chained headers and commondir do not get past it', { skip: !hasGit }, async () => {
  const repo = (config, { gitFile = false, bare = false } = {}) => {
    const dir = tmp();
    if (gitFile) {
      fs.writeFileSync(path.join(dir, '.git'), 'gitdir: D:/elsewhere/.git\n');
      return dir;
    }
    const g = path.join(dir, '.git');
    fs.mkdirSync(g);
    if (!bare) {
      fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
      fs.mkdirSync(path.join(g, 'objects'));
      fs.mkdirSync(path.join(g, 'refs'));
    }
    if (config !== null) fs.writeFileSync(path.join(g, 'config'), config);
    return dir;
  };
  const plain = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/r\n[submodule "lib"]\n\turl = ../lib\n';
  assert.equal(await repoConfigSafe(repo(plain)), true, 'an ordinary config (a submodule too)');
  for (const bad of [
    '[filter "x"]\n\tclean = evil\n',
    '[core][filter "a"] clean = evil.exe\n',
    '[core][includeIf "gitdir:C:/"] path = ../x.cfg\n',
    '[core][gpg]program=x\n',
    '[include]\n\tpath = ../other\n',
    '[core]\n\tfsmonitor = evil\n',
    '[log]\n\tshowSignature = true\n',
    '[diff "bin"]\n\ttextconv = evil\n',
    '[core]\n\tsshCommand = evil\n',
  ]) assert.equal(await repoConfigSafe(repo(plain + bad)), false, bad.trim());
  assert.equal(await repoConfigSafe(repo('[core\n\tbroken')), false, 'git cannot parse it');
  assert.equal(await repoConfigSafe(repo(null)), false, 'no config');
  assert.equal(await repoConfigSafe(repo(plain, { bare: true })), false, 'no HEAD, objects, refs: not a repository of its own');
  assert.equal(await repoConfigSafe(repo(null, { gitFile: true })), false, 'a .git file points elsewhere');
  assert.equal(await repoConfigSafe(repo(`${plain}#${'x'.repeat(70 * 1024)}\n`)), false, 'too big to read');
  const common = repo(plain);
  fs.writeFileSync(path.join(common, '.git', 'commondir'), '../evil\n');
  assert.equal(await repoConfigSafe(common), false, 'commondir: git would read another folder’s config');
  const wt = repo(plain);
  fs.writeFileSync(path.join(wt, '.git', 'config.worktree'), '[filter "y"]\n\tsmudge = evil\n');
  assert.equal(await repoConfigSafe(wt), false, 'the worktree config is read too');
});
test('a clean filter in the repository config: plain git status runs it, SiberSentez never gives that repository to git', { skip: !hasGit }, async () => {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 'a');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=x\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  const marker = path.join(dir, 'filter-ran.txt');
  g('config', 'filter.x.clean', `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker)}`);
  // Same size, older time, new content: git has to clean the file to compare it
  const touch = () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.utimesSync(path.join(dir, 'a.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  };
  touch();
  execFileSync('git', [...GIT_SAFE_ARGS, '-C', dir, 'status', '--porcelain'], { stdio: 'ignore', windowsHide: true });
  assert.ok(fs.existsSync(marker), 'git status with the safe flags still runs a clean filter: the config check is needed');
  fs.rmSync(marker);
  touch();
  const catalog = { getProject: (id) => ({ id, path: dir }) };
  const r = await projectChanges({ catalog, projectId: 'p' });
  assert.deepEqual([r.body.via, r.body.gitSkipped], ['time', true]);
  assert.ok(!fs.existsSync(marker), 'the filter did not run');
});

test('no git on the computer is not an unsafe repository; the answer is kept while the config files stay the same', async () => {
  assert.equal(await configNames('x', { run: (cmd, args, opts, cb) => cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) }), NO_GIT);
  assert.equal(await configNames('x', { run: (cmd, args, opts, cb) => cb(Object.assign(new Error('bad config'), { code: 128 })) }), null);
  const dir = tmp();
  const g = path.join(dir, '.git');
  fs.mkdirSync(path.join(g, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(g, 'refs'));
  fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(g, 'config'), '[core]\n\tbare = false\n');
  assert.equal(await repoCheck(dir, { names: async () => NO_GIT }), 'no-git');
  assert.equal(await repoCheck(dir, { names: async () => ['filter.a.clean'] }), 'unsafe');
  assert.equal(await repoCheck(dir, { names: async () => ['core.bare'] }), 'safe');
  if (!hasGit) return;
  assert.equal(await repoCheck(dir), 'safe');
  // Same files: the kept answer (a changed config is read again)
  fs.writeFileSync(path.join(g, 'config'), '[core]\n\tbare = false\n[filter "a"]\n\tclean = evil\n');
  fs.utimesSync(path.join(g, 'config'), new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.equal(await repoCheck(dir), 'unsafe', 'a changed config is checked again');
});

test('server cache of "What changed": one answer per project for a few seconds, one run while one is running, an error is not kept', async () => {
  const { createChangesCache, CHANGES_TTL_MS } = await import('../server/changes.mjs');
  let clock = 0;
  let runs = 0;
  let answer = { status: 200, body: { via: 'git', files: [] } };
  const c = createChangesCache({ now: () => clock, run: async () => (runs++, answer) });
  const [a, b] = await Promise.all([c.get({ projectId: 'p' }), c.get({ projectId: 'p' })]);
  assert.equal(runs, 1, 'a request while one runs waits for it');
  assert.equal(a, b);
  clock += CHANGES_TTL_MS - 1;
  await c.get({ projectId: 'p' });
  assert.equal(runs, 1, 'still fresh');
  clock += 1;
  await c.get({ projectId: 'p' });
  assert.equal(runs, 2, 'asked again after the ttl');
  await c.get({ projectId: 'q' });
  assert.equal(runs, 3, 'per project');
  answer = { status: 404, body: { error: 'not-a-project' } };
  await c.get({ projectId: 'gone' });
  await c.get({ projectId: 'gone' });
  assert.equal(runs, 5, 'an error answer is not kept');
});

test('an open drawer stays current: refresh asks again at once; a started AI tool sends the event the drawer listens to', async () => {
  let calls = 0;
  const c = createChanges({ fetchJson: async () => (calls++, { via: 'time', files: [] }), now: () => 1000 });
  c.get('p1');
  await new Promise((r) => setTimeout(r, 0));
  c.get('p1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, 'cached within its time');
  c.refresh('p1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2, 'refresh does not wait for the cache');
  const menu = fs.readFileSync(new URL('../public/js/contextmenu.js', import.meta.url), 'utf8');
  assert.match(menu, /it\.action === 'start-ai' && r\?\.ok && it\.payload\?\.projectId/);
  assert.match(menu, /new CustomEvent\(AI_STARTED_EVENT/);
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.match(drawer, /addEventListener\?\.\(AI_STARTED_EVENT, [^]*restore\.refresh\(id\);\s*changes\.refresh\(id\);/);
  // Not while the window is hidden (whileVisible.js, plan D5): once when it shows again
  assert.match(drawer, /everyVisible\(\(\) => \{\s*if \(current\?\.type === 'project'\) render\(\);\s*\}, PROJECT_TICK_MS\);/);
});

test('a project whose folder is gone says so first in its drawer, in both languages', async () => {
  const { folderMissingHtml } = await import('../public/js/views/drawer.js');
  assert.equal(folderMissingHtml({ path: 'C:/x', exists: true }), '');
  assert.equal(folderMissingHtml({ path: 'C:/x' }), '', 'unknown is not gone');
  assert.match(folderMissingHtml({ path: 'C:/x', exists: false }), /class="dr-missing" role="status"/);
  for (const lang of ['en', 'tr']) for (const k of ['drFolderMissingTitle', 'drFolderMissingBody']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});
