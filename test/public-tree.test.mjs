// The public repository is made with `git archive HEAD` (docs/release.md): working notes under docs/internal/ and the
// AI tool's project files under .claude/ stay in the local repository only. This holds the .gitattributes rules that
// keep them out, so a renamed or dropped rule fails here and not after a push.
// Run: node --test test/public-tree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Paths need not exist: check-attr answers from the rules alone, so this also runs on the public tree
const attr = (paths) =>
  execFileSync('git', ['check-attr', 'export-ignore', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n')
    .map((line) => line.split(': '))
    .reduce((acc, [p, , value]) => ({ ...acc, [p]: value }), /** @type {Record<string, string>} */ ({}));

test('working notes and the AI tool project files are left out of the public tree', () => {
  const got = attr(['docs/internal/backlog.md', 'docs/internal/sub/notes.md', '.claude/rules/language.md', '.claude/settings.json']);
  for (const [p, value] of Object.entries(got)) assert.equal(value, 'set', `${p} is export-ignore`);
});

test('the app, its tests and the public documents stay in the public tree', () => {
  const got = attr(['docs/direction.md', 'docs/release.md', 'README.md', 'server/hub.mjs', 'public/js/main.js', 'test/public-tree.test.mjs', 'kit/LICENSE.md', '.gitattributes']);
  for (const [p, value] of Object.entries(got)) assert.equal(value, 'unspecified', `${p} is published`);
});
