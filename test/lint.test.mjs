// Plan D7: the small lint (tools/lint.mjs) finds what it says, and the repository has no finding; the type check's
// set-up stays as decided (opt-in per file, never in the packaged app).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importedNames, lintText, lintAll } from '../tools/lint.mjs';

const ruleOf = (rel, text, opts) => lintText(rel, text, opts).map((x) => `${x.rule}:${x.text}`);

test('the names an import brings in', () => {
  assert.deepEqual(importedNames(`import fs from 'node:fs';`), ['fs']);
  assert.deepEqual(importedNames(`import { a, b as c } from './x.mjs';`), ['a', 'c']);
  assert.deepEqual(importedNames(`import d, { e } from './x.mjs';`), ['e', 'd']);
  assert.deepEqual(importedNames(`import * as ns from './x.mjs';`), ['ns']);
  assert.deepEqual(importedNames(`import './side-effect.mjs';`), []);
});

test('an unused import, a debugger and a narrowed test are found; a spread, a template and a property are not mistaken', () => {
  const none = new Set();
  assert.deepEqual(ruleOf('server/x.mjs', `// @ts-check\nimport { a, b } from './y.mjs';\nexport const z = a();\n`, { unchecked: none }), ['unused-import:b']);
  assert.deepEqual(ruleOf('server/x.mjs', `// @ts-check\nimport { a, b, c } from './y.mjs';\nexport const z = [...a()];\nexport const t = \`\${b}\`;\nexport const p = { c };\n`, { unchecked: none }), []);
  assert.deepEqual(ruleOf('server/x.mjs', `// @ts-check\nimport { a } from './y.mjs';\nexport const z = q.a;\n`, { unchecked: none }), ['unused-import:a'], 'q.a is another a');
  assert.deepEqual(ruleOf('server/x.mjs', `// @ts-check\nfunction f() {\n  debugger;\n}\n`, { unchecked: none }), ['debugger:debugger;']);
  // Written in two parts, so this file is not a finding itself
  const narrowed = `test.${'only'}('x', () => {});`;
  assert.deepEqual(ruleOf('test/x.test.mjs', `${narrowed}\n`, { unchecked: none }), [`only:${narrowed}`]);
});

test('a source file starts with // @ts-check unless it is on the list, and a checked one leaves the list', () => {
  assert.deepEqual(ruleOf('public/js/x.js', `export const a = 1;\n`, { unchecked: new Set() }), ['ts-check:the first line is not // @ts-check']);
  assert.deepEqual(ruleOf('public/js/x.js', `export const a = 1;\n`, { unchecked: new Set(['public/js/x.js']) }), []);
  assert.deepEqual(ruleOf('public/js/x.js', `// @ts-check\nexport const a = 1;\n`, { unchecked: new Set(['public/js/x.js']) }), ['ts-check:checked now: take it off UNCHECKED in tools/lint.mjs']);
  assert.deepEqual(ruleOf('test/x.test.mjs', `export const a = 1;\n`, { unchecked: new Set() }), [], 'tests and tools are not type checked');
});

test('the repository: no lint finding; the type check is opt-in and never packaged', () => {
  const { files, found } = lintAll();
  assert.ok(files > 200);
  assert.deepEqual(found, []);
  const ts = JSON.parse(fs.readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.equal(ts.compilerOptions.checkJs, false, 'only files with // @ts-check');
  assert.equal(ts.compilerOptions.noEmit, true);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.equal(pkg.scripts.lint, 'node tools/lint.mjs');
  assert.ok(!pkg.build.files.some((f) => /types|tsconfig|tools/.test(f)), 'nothing of it ships');
  const ci = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(ci, /- run: npm run typecheck\n\s+- run: npm run lint/);
});

test('a name only in a comment, a string, a template\'s text or a regular expression is not a use; a template\'s ${} is (review D)', async () => {
  const { codeOnly } = await import('../tools/lint.mjs');
  const none = new Set();
  const src = (body) => `// @ts-check\nimport { a } from './y.mjs';\n${body}\n`;
  for (const body of ['// a', '/* a */', "const s = 'a';", 'const s = "a";', 'const s = `a`;', 'const r = /a/;', 'const u = `http://x/${1}`;'])
    assert.deepEqual(ruleOf('server/x.mjs', src(body), { unchecked: none }), ['unused-import:a'], body);
  for (const body of ['const s = `"${a}"`;', 'const s = `x ${`y ${a}`}`;', 'const d = 4 / a / 2;', "const s = 'it''s'; f(a);"])
    assert.deepEqual(ruleOf('server/x.mjs', src(body), { unchecked: none }), [], body);
  assert.equal(codeOnly('a\n// b\nc').split('\n').length, 3, 'line numbers hold');
  assert.deepEqual(ruleOf('test/x.test.mjs', `const s = 'test.${'only'}(';\n`, { unchecked: none }), [], 'in a string: not a narrowed test');
  assert.deepEqual(ruleOf('test/x.test.mjs', `describe.${'only'} ('x', () => {});\n`, { unchecked: none }).map((x) => x.split(':')[0]), ['only']);
});

test('the sandboxed preload keeps the same project id rule as server/util.mjs (review D)', async () => {
  const { PROJECT_ID_RE } = await import('../server/util.mjs');
  const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.ok(preload.includes(`const PROJECT_ID = /${PROJECT_ID_RE.source}/;`));
});
