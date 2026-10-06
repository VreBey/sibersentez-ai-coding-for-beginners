// No string key is written twice in one language of a string table (2026-10-02: a new "dockPreview" silently replaced
// the actions-Preview note of the same name; the later key wins in an object literal and nothing says so).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_RE = /^ {4}(?:'([^']+)'|([A-Za-z_$][\w$-]*)):/;

// Keys of each top-level language block ("  en: {" ... "  },") of a string table file
function blocks(text) {
  const out = new Map();
  let lang = null;
  for (const line of text.split(/\r?\n/)) {
    const open = /^ {2}([a-z]{2}): \{/.exec(line);
    if (open) {
      lang = open[1];
      out.set(lang, []);
      continue;
    }
    if (/^ {2}\},?$/.test(line)) lang = null;
    if (!lang) continue;
    const m = KEY_RE.exec(line);
    if (m) out.get(lang).push(m[1] || m[2]);
  }
  return out;
}

test('every string table: no key twice in one language, in one file or across files', () => {
  const files = [path.join(ROOT, 'public', 'js', 'i18n.js'), ...fs.readdirSync(path.join(ROOT, 'public', 'js', 'strings')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'public', 'js', 'strings', f))];
  const dupes = [];
  let keys = 0;
  // Across files too: i18n.js merges the feature tables with Object.assign, so a key in two files is replaced as well
  const owner = new Map(); // lang:key -> file
  for (const file of files) {
    for (const [lang, list] of blocks(fs.readFileSync(file, 'utf8'))) {
      keys += list.length;
      const seen = new Set();
      for (const k of list) {
        if (seen.has(k)) dupes.push(`${path.basename(file)} ${lang}: ${k}`);
        seen.add(k);
        const prev = owner.get(`${lang}:${k}`);
        if (prev && prev !== file) dupes.push(`${path.basename(prev)} and ${path.basename(file)} ${lang}: ${k}`);
        owner.set(`${lang}:${k}`, file);
      }
    }
  }
  assert.ok(keys > 1000, `the tables were read (${keys} keys)`);
  assert.deepEqual(dupes, []);
});
