// The kit is written from scratch (docs/kit.md §1, docs/kit-v2.md §7.1): no run of 8 or more words may be shared
// with the study material a kit writer might have seen. The material is not in this repository, so the check runs
// only when KIT_ORIGINALITY_DIRS names its folders (separated by ';'); otherwise it is skipped. Code blocks, inline
// code, links and frontmatter keys are left out on both sides: commands and identifiers are allowed to match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const RUN = 8;
const DIRS = (process.env.KIT_ORIGINALITY_DIRS || '').split(';').map((d) => d.trim()).filter(Boolean);
// The kit's own shared text: the notices and the ground rules repeat in every item on purpose
const OWN = /^(#|license:)|copyright \(c\)|required notice|sibersentez license|polyform|agpl|gnu affero/i;

function mdFiles(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== 'node_modules' && !d.name.startsWith('.git')) mdFiles(p, out);
    } else if (/\.md$/i.test(d.name) && d.name !== 'LICENSE.md') out.push(p);
  }
  return out;
}

// Prose words only: fenced code, inline code, links' targets and frontmatter keys are dropped
export function proseWords(text) {
  const prose = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    // A menu path of a program ("Edit > Project Settings > Editor") and the setting names after it are what the
    // screen says, like a command: the path, and the capitalized words right after it, are left out
    .replace(/(?:[A-Z][\w ]*? > )+[A-Z][\w ]*(?:[^\n\w]{1,6}(?:[A-Z][\w]*[ ]?)+)*/g, ' ')
    .replace(/"[A-Z][\w ]{0,40}"/g, ' ')
    .split(/\r?\n/)
    .filter((l) => !OWN.test(l.trim()))
    .map((l) => l.replace(/^\s*[\w-]+:\s/, ' '))
    .join(' ');
  return prose.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
}

export function runs(words, n = RUN) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

test('originality: runs are counted on prose only (code, links and keys left out)', () => {
  const w = proseWords('---\nname: x\n---\nRead the `npm run build` output [here](https://a.b/c) and ```\ncode here\n``` fix it');
  assert.deepEqual(w, ['x', 'read', 'the', 'output', 'here', 'and', 'fix', 'it']);
  assert.equal(runs(['a', 'b', 'c'], 2).size, 2);
  assert.deepEqual(proseWords('Open Edit > Project Settings > Editor: Version Control mode "Visible Meta Files" now'), ['mode', 'now']);
});

test('originality: no kit file shares a run of 8 or more words with the study material', { skip: DIRS.length ? false : 'KIT_ORIGINALITY_DIRS is not set' }, () => {
  const seen = new Map(); // run -> a file of the material
  for (const dir of DIRS) {
    assert.ok(fs.existsSync(dir), `study folder ${dir} exists`);
    for (const f of mdFiles(dir)) for (const r of runs(proseWords(fs.readFileSync(f, 'utf8')))) if (!seen.has(r)) seen.set(r, f);
  }
  const hits = [];
  for (const f of mdFiles(KIT)) {
    for (const r of runs(proseWords(fs.readFileSync(f, 'utf8')))) if (seen.has(r)) hits.push(`${path.relative(KIT, f)}: "${r}" (also in ${seen.get(r)})`);
  }
  assert.deepEqual(hits.slice(0, 20), [], `${hits.length} shared run(s)`);
});
