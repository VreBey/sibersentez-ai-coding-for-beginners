// A small lint with no dependencies (plan D7), next to the type check (`npm run typecheck`, tsconfig.json): what tsc
// does not say. Every rule is about a mistake that has happened or would slip through a review:
//   unused-import   a name imported and never used in the file
//   debugger        a `debugger;` left in
//   only            a test narrowed with .only (the rest of the suite would be skipped in CI)
//   ts-check        a source file without `// @ts-check` on its first line that is not on the list below (a new file
//                   starts checked; the list only shrinks)
// Run: node tools/lint.mjs (exit 1 on a finding). The CI runs it with the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'dist', 'qa', 'coverage', '.git']);

// Files not under the type check yet (they need more than a few notes); fixing one means removing it from here
export const UNCHECKED = Object.freeze(new Set([
  'electron/actions-mode.mjs',
  'electron/main.mjs',
  'electron/new-project.mjs',
  'electron/qa-window.mjs',
  'electron/server-process.mjs',
  'electron/terminals.mjs',
  'public/js/contextmenu.js',
  'public/js/guide.js',
  'public/js/hints.js',
  'public/js/hq-render.js',
  'public/js/main.js',
  'public/js/palette.js',
  'public/js/actionsSwitch.js',
  'public/js/diagnostics.js',
  'public/js/restore.js',
  'public/js/runHint.js',
  'public/js/terminalDock.js',
  'public/js/tour.js',
  'public/js/views/drawer.js',
  'public/js/views/job.js',
  'public/js/views/newIdea.js',
  'public/js/views/projects.js',
  'public/js/views/roster.js',
  'public/js/views/tools.js',
  'public/js/views/waiting.js',
  'public/js/views/workshop.js',
  'server/actions.mjs',
  'server/catalog.mjs',
  'server/config.mjs',
  'server/fit.mjs',
  'server/github.mjs',
  'server/index.mjs',
  'server/memory.mjs',
  'server/restore.mjs',
  'server/tools.mjs',
  'server/usage.mjs',
]));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// The names an import statement brings in (default, named with `as`, namespace); side-effect imports bring none
export function importedNames(statement) {
  const m = /^import\s+([\s\S]+?)\s+from\s+['"][^'"]+['"]/.exec(statement);
  if (!m) return [];
  const names = [];
  let rest = m[1].trim();
  const ns = /\*\s+as\s+([\w$]+)/.exec(rest);
  if (ns) names.push(ns[1]);
  const braces = /\{([\s\S]*)\}/.exec(rest);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = /\bas\s+([\w$]+)$/.exec(p);
      names.push(as ? as[1] : p.replace(/^type\s+/, ''));
    }
    rest = rest.replace(braces[0], '');
  }
  const def = /^([\w$]+)\s*(,|$)/.exec(rest.replace(/\*\s+as\s+[\w$]+/, '').trim());
  if (def) names.push(def[1]);
  return names;
}

// The code without comments, strings and the text of templates and regular expressions (a template keeps its ${...}
// code), each blanked to spaces so line numbers hold (review D: a name only in a comment or a string counted as used).
// A small scanner: a slash starts a regular expression after an operator or a bracket, else it divides.
export function codeOnly(text) {
  const out = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const stack = []; // open template ${ ... } braces: the brace depth each started at
  let depth = 0;
  let i = 0;
  let last = ''; // the last code character that is not a space
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    let j = i;
    if (c === '/' && n === '/') {
      while (j < text.length && text[j] !== '\n') j++;
      out.push(blank(text.slice(i, j)));
    } else if (c === '/' && n === '*') {
      j = text.indexOf('*/', i + 2);
      j = j < 0 ? text.length : j + 2;
      out.push(blank(text.slice(i, j)));
    } else if (c === "'" || c === '"') {
      j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out.push(c + blank(text.slice(i + 1, j)) + c);
      j++;
      last = c;
    } else if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1] === depth)) {
      // A template's text, from its start (or the end of a ${...}) to its end or the next ${
      if (c === '}') stack.pop();
      j = i + 1;
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
      out.push(c + blank(text.slice(i + 1, j)));
      if (text[j] === '$') {
        out.push('${');
        j += 2;
        stack.push(depth);
      } else {
        out.push('`');
        j++;
      }
      last = '`';
    } else if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j += text[j] === '\\' ? 2 : 1;
      }
      out.push('/' + blank(text.slice(i + 1, j)) + '/');
      j++;
      last = '/';
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (!/\s/.test(c)) last = c;
      out.push(c);
      j = i + 1;
    }
    i = j;
  }
  return out.join('');
}

// Findings of one file's text: [{ rule, line, text }]
export function lintText(rel, text, { unchecked = UNCHECKED } = {}) {
  const out = [];
  const lines = text.split('\n');
  const source = !rel.startsWith('test/') && !rel.startsWith('tools/') && /\.(mjs|js)$/.test(rel);
  if (source && !unchecked.has(rel) && lines[0].trim() !== '// @ts-check') out.push({ rule: 'ts-check', line: 1, text: 'the first line is not // @ts-check' });
  if (source && unchecked.has(rel) && lines[0].trim() === '// @ts-check') out.push({ rule: 'ts-check', line: 1, text: 'checked now: take it off UNCHECKED in tools/lint.mjs' });
  // Imports: the statement may span lines; a name counts as used when it appears anywhere else in the file
  const importRe = /^import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm;
  for (const m of text.matchAll(importRe)) {
    const line = text.slice(0, m.index).split('\n').length;
    const without = codeOnly(text.slice(0, m.index) + text.slice(m.index + m[0].length));
    for (const name of importedNames(m[0])) {
      // A dot before the name is a property (x.name), unless it is a spread (...name)
      if (!new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(without)) out.push({ rule: 'unused-import', line, text: name });
    }
  }
  // Matched in the code only, reported as written
  codeOnly(text).split('\n').forEach((l, i) => {
    if (/^\s*debugger;?\s*$/.test(l)) out.push({ rule: 'debugger', line: i + 1, text: lines[i].trim() });
    if (rel.startsWith('test/') && /\b(test|it|describe)\.only\s*\(/.test(l)) out.push({ rule: 'only', line: i + 1, text: lines[i].trim().slice(0, 80) });
  });
  return out;
}

export function lintAll(root = ROOT) {
  const files = ['server', 'electron', 'public/js', 'test', 'tools'].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []));
  const found = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const x of lintText(rel, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))) found.push({ file: rel, ...x });
  }
  // A name on UNCHECKED that is no longer a file
  for (const rel of UNCHECKED) if (!fs.existsSync(path.join(root, rel))) found.push({ file: rel, rule: 'ts-check', line: 0, text: 'gone: take it off UNCHECKED in tools/lint.mjs' });
  return { files: files.length, found };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, found } = lintAll();
  for (const x of found) console.log(`${x.file}:${x.line}  ${x.rule}  ${x.text}`);
  console.log(`lint: ${files} files, ${found.length} finding${found.length === 1 ? '' : 's'}`);
  process.exit(found.length ? 1 : 0);
}
