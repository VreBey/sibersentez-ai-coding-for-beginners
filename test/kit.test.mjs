// SiberSentez kit checks (docs/kit.md): the kit/ folder follows the Agent Skills specification and the Claude Code agent
// format, catalog.json mirrors the files one to one, every item carries its license notice, no file suggests a
// dangerous flag, the hub library reader and the import scan read kit/ like a hub library, the fit engine derives the
// same stack tags as the metadata, and the Turkish keywords route sample ideas to the right starter (the reference
// matcher here and the server's, server/kit.mjs, agree).
// Run: node --test test/kit.test.mjs
// Hermetic: kit/ is only read; the library tests copy it into a temporary fake hub. With KIT_WRITE_CATALOG=1 the
// test first rewrites kit/catalog.json from the frontmatter (items and count; name, version, license and proposedTags
// stay) and the license notices from the copyright line of kit/LICENSE.md (every skill's LICENSE.md, the comment
// lines at the top of every agent's frontmatter).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLibrary, libraryItems, scanSource, validName, CATEGORY_RE } from '../server/library.mjs';
import { readFrontmatter, truncate } from '../server/util.mjs';
import { TAG_BY_ID, itemTags, isStack, withImplied, primaryStacks, topicsOf } from '../server/tags.mjs';
import { scoreItem, MEDIUM_SCORE } from '../server/fit.mjs';
import { readKit as serverReadKit, kitWords, keywordHits, KIT_OFFERS } from '../server/kit.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const CATALOG_FILE = path.join(KIT, 'catalog.json');

// A skill names the notice bundled with it (the Agent Skills "license" field); an agent is one file, so its notice
// is the comment at the top of its frontmatter (an agents folder must hold agents only)
const LICENSE_LINE = 'MIT (see LICENSE.md)';
const AGENT_LICENSE_LINE = 'MIT (see the notice at the top of this file)';
const NOTICE_FILE = 'LICENSE.md';
// kit/LICENSE.md: the MIT License (the app itself is GPL-3.0-or-later: LICENSE at the repository root)
const LICENSE_TITLE = '# MIT License';
const STAGES = new Set(['start', 'build', 'ship', 'any']);
const SKILL_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const AGENT_KEYS = new Set(['name', 'description', 'tools', 'model', 'license', 'metadata']);
const META_KEYS = ['author', 'version', 'sibersentez-tags', 'sibersentez-stage', 'sibersentez-keywords-tr'];
// Optional metadata: sibersentez-offer (empty-folder: offered in a folder with nothing in it yet, docs/kit.md §6)
const META_OPTIONAL = ['sibersentez-offer'];
// Agent Skills name: 1-64 characters, lower-case letters, digits and single hyphens, no hyphen at either end
const SPEC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
// A Turkish keyword: lower-case words separated by single spaces, optionally a stem ('*' at the end)
const KEYWORD = /^[a-zçğıöşüâîû0-9]+(?: [a-zçğıöşüâîû0-9]+)*\*?$/;
const AGENT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']);
// Body limits: SKILL.md and agents stay short (progressive disclosure), details go to reference files
const MAX_BODY_LINES = 150;
const MAX_REFERENCE_LINES = 250;
// The hub library reader and the fit engine read this much of a description (server/library.mjs, server/fit.mjs)
const ENGINE_DESC_MAX = 400;
// Nothing in the kit may suggest switching off permission prompts, safety checks or history protection
const DANGEROUS = [
  /dangerously/i,
  /skip-permissions/i,
  /bypass-?permissions/i,
  /\byolo\b/i,
  /--full-auto/i,
  /--no-verify/i,
  /--allow-all-tools/i,
  /--force\b/i,
  /\bpush\s+-f\b/i,
  /\brm\s+-r/i,
  /--no-sandbox/i,
  /nodeIntegration\s*:\s*true/i,
  /contextIsolation\s*:\s*false/i,
  /webSecurity\s*:\s*false/i,
  /Set-ExecutionPolicy\b[^\n]*\b(Unrestricted|Bypass)\b/i,
];

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-kit-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------
// Reading the kit
// ---------------------------------------------------------------------------------------------------------------

const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const entries = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byteOrder(a.name, b.name));
const readText = (file) => fs.readFileSync(file, 'utf8');
const lineCount = (text) => (text.replace(/\s+$/, '') ? text.replace(/\s+$/, '').split(/\r?\n/).length : 0);
const list = (s) =>
  String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// A value in the YAML subset the kit uses: a double-quoted string with no quote or backslash inside, or a plain value
// that YAML reads as the same text (no leading indicator, no ': ' or ' #', no trailing ':')
function scalar(raw, where) {
  const quoted = /^"([^"\\]*)"$/.exec(raw);
  if (quoted) return quoted[1];
  if (raw !== raw.trim() || !raw || /^[-?:,[\]{}#&*!|>'"%@`]/.test(raw) || /: | #|:$/.test(raw)) throw new Error(`${where}: value must be quoted: ${raw}`);
  return raw;
}

// Strict frontmatter reader: comment lines ('# ...') right after the opening line only, then top-level `key: value`
// lines and one level of `  key: "value"` lines under a key with no value (metadata). Anything else is an error, so
// every YAML reader sees exactly these values. Returns { data, body, comments }.
function parseFrontmatter(text, where) {
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${where}: byte order mark`);
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`${where}: no frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${where}: frontmatter not closed`);
  const data = {};
  const comments = [];
  let map = null;
  let start = 1;
  while (start < end && lines[start].startsWith('# ')) comments.push(lines[start++].slice(2));
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const at = `${where}:${i + 1}`;
    let m = /^ {2}([a-z][a-z0-9-]*): (.*)$/.exec(line);
    if (m) {
      if (!map) throw new Error(`${at}: indented line outside a map`);
      if (m[1] in map) throw new Error(`${at}: duplicate key ${m[1]}`);
      map[m[1]] = scalar(m[2], at);
      continue;
    }
    m = /^([a-z][a-z0-9-]*):(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`${at}: unreadable line: ${line}`);
    if (m[1] in data) throw new Error(`${at}: duplicate key ${m[1]}`);
    if (m[2] === undefined) {
      data[m[1]] = map = {};
      continue;
    }
    map = null;
    data[m[1]] = scalar(m[2], at);
  }
  return { data, body: lines.slice(end + 1).join('\n'), comments };
}

// Every item of the kit: [{ kind, name (folder or file name), category, rel, file, dir, fm, text }], in catalog order
// (category, skills before agents, name; byte order)
function readKit() {
  const out = [];
  for (const c of entries(KIT).filter((d) => d.isDirectory())) {
    const skillsDir = path.join(KIT, c.name, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const s of entries(skillsDir).filter((d) => d.isDirectory())) {
        const dir = path.join(skillsDir, s.name);
        const file = path.join(dir, 'SKILL.md');
        const text = readText(file);
        out.push({ kind: 'skill', name: s.name, category: c.name, rel: `${c.name}/skills/${s.name}`, file, dir, text, fm: parseFrontmatter(text, `${c.name}/skills/${s.name}/SKILL.md`) });
      }
    }
    const agentsDir = path.join(KIT, c.name, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const f of entries(agentsDir).filter((d) => d.isFile())) {
        const file = path.join(agentsDir, f.name);
        const text = readText(file);
        out.push({ kind: 'agent', name: f.name.replace(/\.md$/, ''), category: c.name, rel: `${c.name}/agents/${f.name}`, file, dir: null, text, fm: parseFrontmatter(text, `${c.name}/agents/${f.name}`) });
      }
    }
  }
  return out;
}

// The catalog row of an item, from its frontmatter. notice: where its license notice is (a skill's bundled
// LICENSE.md, an agent's frontmatter comment).
function catalogRow(it) {
  const d = it.fm.data;
  const m = d.metadata || {};
  return {
    kind: it.kind,
    name: d.name,
    category: it.category,
    description: d.description,
    tags: list(m['sibersentez-tags']),
    stage: m['sibersentez-stage'],
    keywordsTr: list(m['sibersentez-keywords-tr']),
    offer: list(m['sibersentez-offer'] || ''),
    path: it.rel,
    notice: it.kind === 'skill' ? `${it.rel}/${NOTICE_FILE}` : 'frontmatter',
    version: m.version,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// License notices (docs/kit.md §7): generated from the copyright line of kit/LICENSE.md, so the owner changes one line
// ---------------------------------------------------------------------------------------------------------------

const COPYRIGHT_RE = /^Copyright \(c\) .+$/m;
const copyrightLine = () => COPYRIGHT_RE.exec(readText(path.join(KIT, 'LICENSE.md')))?.[0] || '';

// The LICENSE.md bundled with every skill (the same for all): the MIT text itself, since the license asks for its
// permission notice in every copy, and a skill travels into projects on its own
function skillNotice(copyright) {
  const mit = readText(path.join(KIT, 'LICENSE.md')).replace(/\r\n/g, '\n');
  const body = mit.slice(mit.indexOf('Permission is hereby granted')).trimEnd();
  return [
    '# License notice',
    '',
    "This skill is part of the SiberSentez Kit, SiberSentez's own set of skills and agents. It is licensed under the MIT",
    'License:',
    '',
    copyright,
    '',
    body,
    '',
  ].join('\n');
}

// The comment lines at the top of every agent's frontmatter (YAML comments: tools read past them, the model never
// sees them)
function agentNotice(copyright) {
  return ['SiberSentez Kit agent.', copyright, 'SPDX-License-Identifier: MIT (full text: LICENSE.md in the SiberSentez kit folder). Free to use, change and share; keep this notice. No warranty.'];
}

// Rewrites the notices from kit/LICENSE.md (KIT_WRITE_CATALOG=1)
function writeNotices() {
  const copyright = copyrightLine();
  if (!copyright) throw new Error('kit/LICENSE.md has no copyright line');
  for (const c of entries(KIT).filter((d) => d.isDirectory())) {
    const skillsDir = path.join(KIT, c.name, 'skills');
    if (fs.existsSync(skillsDir)) for (const s of entries(skillsDir).filter((d) => d.isDirectory())) fs.writeFileSync(path.join(skillsDir, s.name, NOTICE_FILE), skillNotice(copyright), 'utf8');
    const agentsDir = path.join(KIT, c.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const f of entries(agentsDir).filter((d) => d.isFile())) {
      const file = path.join(agentsDir, f.name);
      const lines = readText(file).split('\n');
      let i = 1;
      while (lines[i]?.startsWith('# ')) i++;
      fs.writeFileSync(file, [lines[0], ...agentNotice(copyright).map((l) => `# ${l}`), ...lines.slice(i)].join('\n'), 'utf8');
    }
  }
}

if (process.env.KIT_WRITE_CATALOG === '1') {
  writeNotices();
  const old = JSON.parse(readText(CATALOG_FILE));
  const items = readKit().map(catalogRow);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify({ ...old, count: items.length, items }, null, 2) + '\n', 'utf8');
}

const ITEMS = readKit();
const SKILLS = ITEMS.filter((it) => it.kind === 'skill');
const AGENTS = ITEMS.filter((it) => it.kind === 'agent');
const CATALOG = JSON.parse(readText(CATALOG_FILE));
const PROPOSED = new Map((CATALOG.proposedTags || []).map((t) => [t.id, t]));
const knownTag = (t) => TAG_BY_ID.has(t) || PROPOSED.has(t);

// Checks shared by skills and agents: description, license and the SiberSentez metadata
function checkCommon(it, where) {
  const d = it.fm.data;
  assert.equal(typeof d.description, 'string', `${where}: description`);
  assert.ok(d.description.length >= 1 && d.description.length <= 1024, `${where}: description is 1-1024 characters (${d.description.length})`);
  // The hub reader and the fit engine keep the first ENGINE_DESC_MAX characters: the whole description must reach them
  assert.ok(d.description.length <= ENGINE_DESC_MAX, `${where}: description fits in ${ENGINE_DESC_MAX} characters (${d.description.length})`);
  assert.ok(!/[<>]/.test(d.description), `${where}: no tags in the description`);
  assert.ok(/\bUse when\b/.test(d.description), `${where}: the description says when to use it`);
  assert.equal(d.license, it.kind === 'skill' ? LICENSE_LINE : AGENT_LICENSE_LINE, `${where}: license line`);
  assert.ok(d.metadata && typeof d.metadata === 'object', `${where}: metadata map`);
  assert.deepEqual(
    Object.keys(d.metadata)
      .filter((k) => !META_OPTIONAL.includes(k))
      .sort(),
    [...META_KEYS].sort(),
    `${where}: metadata keys`,
  );
  for (const [k, v] of Object.entries(d.metadata)) assert.equal(typeof v, 'string', `${where}: metadata ${k} is a string`);
  for (const o of list(d.metadata['sibersentez-offer'] || '')) assert.ok(KIT_OFFERS.includes(o), `${where}: offer ${o}`);
  assert.equal(d.metadata.author, 'SiberSentez', `${where}: author`);
  assert.match(d.metadata.version, SEMVER, `${where}: version`);
  assert.ok(STAGES.has(d.metadata['sibersentez-stage']), `${where}: stage ${d.metadata['sibersentez-stage']}`);
  const tags = list(d.metadata['sibersentez-tags']);
  assert.ok(tags.length, `${where}: at least one tag`);
  assert.equal(new Set(tags).size, tags.length, `${where}: tags are unique`);
  for (const t of tags) assert.ok(knownTag(t), `${where}: tag ${t} is in server/tags.mjs or in catalog.json proposedTags`);
  const kws = list(d.metadata['sibersentez-keywords-tr']);
  assert.ok(kws.length >= 3, `${where}: at least three Turkish keywords`);
  for (const k of kws) assert.match(k, KEYWORD, `${where}: keyword "${k}"`);
  assert.equal(new Set(kws.map(foldTr)).size, kws.length, `${where}: keywords are unique after folding`);
}

// ---------------------------------------------------------------------------------------------------------------
// Reference idea matcher (docs/kit.md §4): Turkish letters folded, whole words, '*' marks a stem, a phrase scores
// its word count
// ---------------------------------------------------------------------------------------------------------------

const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
function foldTr(s) {
  return String(s)
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşüâîû]/g, (c) => FOLD[c]);
}
const wordsOf = (s) => foldTr(s).split(/[^a-z0-9]+/).filter(Boolean);

function keywordScore(keywords, text) {
  const ws = wordsOf(text);
  let score = 0;
  for (const kw of keywords) {
    const stem = kw.endsWith('*');
    const parts = wordsOf(stem ? kw.slice(0, -1) : kw);
    const last = parts.length - 1;
    const hit = ws.some((_, i) => parts.every((p, k) => ws[i + k] !== undefined && (k === last && stem ? ws[i + k].startsWith(p) : ws[i + k] === p)));
    if (hit) score += parts.length;
  }
  return score;
}

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

test('kit: layout is <category>/skills/<name>/SKILL.md and <category>/agents/<name>.md, with README, LICENSE and catalog at the root', () => {
  const rootFiles = entries(KIT)
    .filter((d) => !d.isDirectory())
    .map((d) => d.name);
  assert.deepEqual(rootFiles, ['LICENSE.md', 'README.md', 'catalog.json']);
  const license = readText(path.join(KIT, 'LICENSE.md'));
  assert.ok(license.startsWith(LICENSE_TITLE) && COPYRIGHT_RE.test(license) && license.includes('Permission is hereby granted') && license.includes('WITHOUT WARRANTY OF ANY KIND'), 'kit/LICENSE.md holds the MIT License text with its copyright line');
  const app = readText(path.join(KIT, '..', 'LICENSE'));
  assert.ok(app.includes('GNU GENERAL PUBLIC LICENSE') && app.includes('Version 3, 29 June 2007'), 'the app itself is under the GNU GPL version 3 (LICENSE)');
  for (const c of entries(KIT).filter((d) => d.isDirectory())) {
    assert.match(c.name, CATEGORY_RE, `category ${c.name}`);
    const groups = entries(path.join(KIT, c.name)).map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`);
    assert.ok(groups.length && groups.every((g) => g === 'skills/' || g === 'agents/'), `${c.name} holds only skills/ and agents/: ${groups}`);
    const agentsDir = path.join(KIT, c.name, 'agents');
    if (fs.existsSync(agentsDir)) for (const f of entries(agentsDir)) assert.ok(f.isFile() && /^[a-z0-9-]+\.md$/.test(f.name), `agent file ${c.name}/agents/${f.name}`);
    const skillsDir = path.join(KIT, c.name, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const s of entries(skillsDir)) {
        assert.ok(s.isDirectory(), `skill folder ${c.name}/skills/${s.name}`);
        const files = entries(path.join(skillsDir, s.name)).map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`);
        assert.ok(files.includes('SKILL.md'), `${s.name} has SKILL.md`);
        assert.ok(files.includes(NOTICE_FILE), `${s.name} has its license notice (${NOTICE_FILE}), named by its license line`);
        // Extra files are reference documents linked from SKILL.md (one level deep)
        const body = readText(path.join(skillsDir, s.name, 'SKILL.md'));
        for (const f of files.filter((x) => x !== 'SKILL.md' && x !== NOTICE_FILE)) {
          assert.match(f, /^[a-z0-9-]+\.md$/, `${s.name}: extra file ${f} is a markdown reference`);
          assert.ok(body.includes(`(${f})`), `${s.name}: ${f} is linked from SKILL.md`);
        }
      }
    }
  }
  // No links, hidden files or other special entries anywhere in the kit
  const walk = (dir) => {
    for (const d of entries(dir)) {
      const p = path.join(dir, d.name);
      assert.ok(!d.name.startsWith('.'), `hidden entry ${p}`);
      assert.ok(!fs.lstatSync(p).isSymbolicLink(), `link ${p}`);
      if (d.isDirectory()) walk(p);
    }
  };
  walk(KIT);
  // docs/kit-v2.md §4: waves 1, 1.5 and 2 of kit v2 are in, plus the launch items of 0.5.0 (the counts move with each wave)
  assert.equal(SKILLS.length, 57);
  assert.equal(AGENTS.length, 16);
});

// ---------------------------------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------------------------------

test('kit: every SKILL.md frontmatter follows the Agent Skills specification and carries the SiberSentez metadata', () => {
  for (const it of SKILLS) {
    const where = it.rel;
    const d = it.fm.data;
    for (const k of Object.keys(d)) assert.ok(SKILL_KEYS.has(k), `${where}: key ${k} is not in the specification`);
    assert.equal(d.name, it.name, `${where}: name equals the folder name`);
    assert.ok(d.name.length >= 1 && d.name.length <= 64, `${where}: name length`);
    assert.match(d.name, SPEC_NAME, `${where}: name characters`);
    assert.ok(!/anthropic|claude/.test(d.name), `${where}: reserved word in the name`);
    assert.ok(validName(d.name), `${where}: the hub accepts the name`);
    if ('compatibility' in d) assert.ok(d.compatibility.length >= 1 && d.compatibility.length <= 500, `${where}: compatibility length`);
    checkCommon(it, where);
  }
});

test('kit: every agent file is a valid Claude Code subagent with the SiberSentez metadata', () => {
  for (const it of AGENTS) {
    const where = it.rel;
    const d = it.fm.data;
    for (const k of Object.keys(d)) assert.ok(AGENT_KEYS.has(k), `${where}: key ${k}`);
    assert.equal(d.name, it.name, `${where}: name equals the file name`);
    assert.match(d.name, SPEC_NAME, `${where}: name characters`);
    assert.ok(d.name.length <= 64 && validName(d.name), `${where}: the hub accepts the name`);
    if ('tools' in d) {
      const tools = list(d.tools);
      assert.ok(tools.length, `${where}: tools list`);
      assert.equal(new Set(tools).size, tools.length, `${where}: tools are unique`);
      for (const t of tools) assert.ok(AGENT_TOOLS.has(t), `${where}: tool ${t}`);
    }
    checkCommon(it, where);
  }
});

test("kit: the app's own frontmatter reader (server/util.mjs) reads the same name, description and tools", () => {
  for (const it of ITEMS) {
    const got = readFrontmatter(it.file);
    assert.equal(got.name, it.fm.data.name, `${it.rel}: name`);
    assert.equal(got.description, it.fm.data.description.replace(/\s+/g, ' ').trim(), `${it.rel}: description`);
    if (it.kind === 'agent') assert.equal(got.tools, it.fm.data.tools, `${it.rel}: tools`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------------------------

test('kit: bodies are short, speak the user language and ask before risky steps; reference files stay short', () => {
  for (const it of SKILLS) {
    const body = it.fm.body;
    const n = lineCount(body);
    assert.ok(n > 10 && n <= MAX_BODY_LINES, `${it.rel}: body has ${n} lines (limit ${MAX_BODY_LINES})`);
    assert.match(body, /^## Ground rules$/m, `${it.rel}: ground rules section`);
    assert.match(body, /Talk to the user in their language/, `${it.rel}: language rule`);
    assert.match(body, /Ask and wait for a yes before you delete, move or overwrite files, install anything/, `${it.rel}: ask-first rule`);
    assert.match(body, /Never switch off your tool's permission prompts or safety checks/, `${it.rel}: safety rule`);
    for (const m of body.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^[a-z]+:/.test(m[1])) continue;
      assert.ok(fs.existsSync(path.join(it.dir, m[1])), `${it.rel}: link ${m[1]} exists`);
    }
    for (const f of fs.readdirSync(it.dir).filter((x) => x !== 'SKILL.md')) {
      const r = lineCount(readText(path.join(it.dir, f)));
      assert.ok(r <= MAX_REFERENCE_LINES, `${it.rel}/${f}: ${r} lines (limit ${MAX_REFERENCE_LINES})`);
    }
  }
  for (const it of AGENTS) {
    const n = lineCount(it.fm.body);
    assert.ok(n > 10 && n <= MAX_BODY_LINES, `${it.rel}: body has ${n} lines`);
    assert.match(it.fm.body, /Write your result in the language the request was written in/, `${it.rel}: language rule`);
    assert.match(it.fm.body, /cannot ask the user questions/, `${it.rel}: works alone and returns questions`);
    assert.match(it.fm.body, /never install anything|Not allowed:[\s\S]{0,300}install/i, `${it.rel}: says it does not install`);
  }
});

test('kit: no file suggests a dangerous flag or switching off a safety setting', () => {
  const hits = [];
  const walk = (dir) => {
    for (const d of entries(dir)) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else
        readText(p)
          .split(/\r?\n/)
          .forEach((line, i) => {
            for (const re of DANGEROUS) if (re.test(line)) hits.push(`${path.relative(KIT, p)}:${i + 1}: ${re}`);
          });
    }
  };
  walk(KIT);
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------------------------

// docs/kit-v2.md §7 and docs/direction.md K9: short descriptions (a tool loads every installed item's description),
// and a README whose counts and names follow the catalog
const DESC_TARGET = 350;
test('kit: descriptions stay within 350 characters; the README names every item and the right counts', () => {
  for (const it of ITEMS) assert.ok(it.fm.data.description.length <= DESC_TARGET, `${it.rel}: description ${it.fm.data.description.length} > ${DESC_TARGET}`);
  const readme = readText(path.join(KIT, 'README.md'));
  const skills = ITEMS.filter((it) => it.kind === 'skill').length;
  const agents = ITEMS.filter((it) => it.kind === 'agent').length;
  assert.ok(readme.includes(`- ${skills} skills and ${agents} agents,`), `README says ${skills} skills and ${agents} agents`);
  for (const it of ITEMS) assert.ok(readme.includes(`\`${it.fm.data.name}\``), `README names ${it.fm.data.name}`);
});

test('kit: catalog.json matches the files one to one', () => {
  assert.equal(CATALOG.name, 'sibersentez-kit');
  assert.match(CATALOG.version, SEMVER);
  assert.equal(CATALOG.license, LICENSE_LINE);
  assert.equal(CATALOG.count, ITEMS.length, 'count');
  const expected = ITEMS.map(catalogRow);
  // Row by row first, so a failure names the item
  for (const row of expected) {
    const got = CATALOG.items.find((r) => r.kind === row.kind && r.name === row.name);
    assert.ok(got, `catalog row for ${row.kind} ${row.name}`);
    assert.deepEqual(got, row, `catalog row for ${row.kind} ${row.name} (KIT_WRITE_CATALOG=1 rewrites it)`);
  }
  assert.deepEqual(CATALOG.items, expected, 'same rows in the same order, nothing extra');
  for (const it of ITEMS) assert.ok(fs.existsSync(path.join(KIT, catalogRow(it).path)), `${it.rel}: path exists`);
  // Proposed tags: new tag ids for server/tags.mjs, each with its synonyms
  const ids = new Set();
  for (const t of CATALOG.proposedTags) {
    assert.match(t.id, /^[a-z][a-z0-9-]*$/, `proposed tag ${t.id}`);
    assert.ok(!ids.has(t.id), `proposed tag ${t.id} listed once`);
    ids.add(t.id);
    assert.ok(t.type === 'topic' || t.type === 'stack', `proposed tag ${t.id} type`);
    assert.ok(Array.isArray(t.words) && t.words.length && t.words.every((w) => typeof w === 'string' && w.trim() === w && w), `proposed tag ${t.id} words`);
  }
  // Every proposed tag is used by at least one item
  const used = new Set(CATALOG.items.flatMap((r) => r.tags));
  for (const id of ids) assert.ok(used.has(id), `proposed tag ${id} is used`);
});

// ---------------------------------------------------------------------------------------------------------------
// The hub library reader and the import scan
// ---------------------------------------------------------------------------------------------------------------

test('kit: the hub library reader (listLibrary, libraryItems) reads kit/ as a hub library', () => {
  const hub = path.join(ROOT, 'hub');
  fs.cpSync(KIT, path.join(hub, 'library'), { recursive: true });
  const listed = listLibrary(hub);
  assert.deepEqual(
    listed.map(({ kind, name, category, rel }) => ({ kind, name, category, rel })),
    ITEMS.map((it) => ({ kind: it.kind, name: it.fm.data.name, category: it.category, rel: `library/${it.rel}` })),
  );
  for (const it of listed) {
    const src = ITEMS.find((x) => x.kind === it.kind && x.fm.data.name === it.name);
    assert.equal(it.description, truncate(src.fm.data.description, ENGINE_DESC_MAX), `${it.name}: description as the roster shows it`);
    assert.ok(validName(it.name), `${it.name}: valid name`);
  }
  // catalog.json at library/ is read too: every row has a folder, so nothing is added
  const all = libraryItems(hub);
  assert.equal(all.length, ITEMS.length);
  assert.ok(all.every((it) => it.path), 'every item is installable (has a folder or file)');
});

test('kit: an import scan of kit/ (library-scan) finds every item with no problem', { skip: process.platform !== 'win32' && 'the scan accepts Windows paths only' }, () => {
  const hub = path.join(ROOT, 'empty-hub');
  const home = path.join(ROOT, 'home');
  fs.mkdirSync(path.join(hub, 'library'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const scan = scanSource(KIT, { hubDir: hub, homeDir: home });
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.truncated, false);
  assert.deepEqual(
    scan.items.map((i) => `${i.kind}:${i.name}`).sort(),
    ITEMS.map((it) => `${it.kind}:${it.fm.data.name}`).sort(),
  );
  for (const i of scan.items) {
    assert.deepEqual(i.problems, [], `${i.name}: problems`);
    assert.equal(i.status, 'new', `${i.name}: status`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The fit engine (server/tags.mjs, server/fit.mjs)
// ---------------------------------------------------------------------------------------------------------------

const engineTags = (it) => new Set(itemTags({ name: it.fm.data.name, description: truncate(it.fm.data.description, ENGINE_DESC_MAX), category: it.category }));
const metaTags = (it) => list(it.fm.data.metadata['sibersentez-tags']);
function profileOf(tags) {
  const all = withImplied(tags);
  return { stacks: new Set([...all].filter(isStack)), primary: primaryStacks(all), topics: topicsOf(all) };
}
const UNITY_PROJECT = profileOf(['unity']);
const NEXT_PROJECT = profileOf(['nextjs', 'react', 'typescript', 'web']);
const PYTHON_PROJECT = profileOf(['python']);

test('kit: the fit engine derives the same stack tags as the metadata; general items have none and are never excluded', () => {
  for (const it of ITEMS) {
    const eng = engineTags(it);
    const meta = metaTags(it);
    const engStacks = [...eng].filter(isStack).sort();
    const metaStacks = meta.filter((t) => TAG_BY_ID.has(t) && isStack(t));
    for (const t of metaStacks) assert.ok(eng.has(t), `${it.rel}: the description gives the stack tag ${t}`);
    const implied = withImplied(meta.filter((t) => TAG_BY_ID.has(t)));
    for (const t of engStacks) assert.ok(implied.has(t), `${it.rel}: the description gives the stack tag ${t}, which the metadata lacks`);
    if (it.category !== 'starters' || it.name === 'project-setup') {
      assert.deepEqual(engStacks, [], `${it.rel}: a general item names no stack`);
      for (const p of [UNITY_PROJECT, NEXT_PROJECT, PYTHON_PROJECT]) assert.equal(scoreItem(eng, p).excluded, false, `${it.rel}: never excluded`);
    } else assert.ok(engStacks.length, `${it.rel}: a starter names its stack`);
  }
});

test('kit: each stack starter is listed for its own stack and excluded from a foreign one', () => {
  const starters = SKILLS.filter((it) => it.category === 'starters' && it.name !== 'project-setup');
  assert.equal(starters.length, 11);
  for (const it of starters) {
    const eng = engineTags(it);
    const own = scoreItem(eng, profileOf(metaTags(it).filter((t) => TAG_BY_ID.has(t))));
    assert.equal(own.excluded, false, `${it.name}: fits its own stack`);
    // Listed (medium or high). Starters are meant for new projects, so they need not be selected automatically
    assert.ok(own.score >= MEDIUM_SCORE, `${it.name}: listed on its own stack (score ${own.score}, ${own.confidence})`);
    const foreign = eng.has('unity') ? NEXT_PROJECT : UNITY_PROJECT;
    assert.equal(scoreItem(eng, foreign).excluded, true, `${it.name}: excluded from a foreign stack`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Turkish keywords
// ---------------------------------------------------------------------------------------------------------------

const IDEAS = [
  ['Arkadaşlarımla oynayacağımız, Unity ile yapılmış 2D bir platform oyunu istiyorum', 'game-prototype-unity'],
  ['Kuaför salonum için müşterilerin randevu alabileceği bir web sitesi', 'web-app-starter'],
  // The first test drive: a to-do list app is a web app, not a request to break work into tasks
  ['Basit bir yapılacaklar listesi web uygulaması', 'web-app-starter'],
  ['Ürünlerimi satacağım bir online mağaza açmak istiyorum', 'web-app-starter'],
  ["Telegram'da her sabah hava durumunu gönderen bir bot yapmak istiyorum", 'python-bot-starter'],
  ['Discord sunucumuz için yeni gelenlere otomatik rol veren bir bot', 'python-bot-starter'],
  ['Telefonda çalışan bir alışveriş listesi uygulaması', 'mobile-app-starter'],
  ['Android ve iPhone için yemek tarifi uygulaması', 'mobile-app-starter'],
  ['Bilgisayarımda çalışan, sistem tepsisinde duran küçük bir not programı', 'desktop-app-starter'],
  ['Bir fikrim var ama nereden başlayacağımı bilmiyorum', 'idea-to-plan'],
  ['Oyunum açılırken çöküyor, hata veriyor', 'debug-helper'],
  // Kit v2, wave 1 (docs/kit-v2.md §4)
  ["Yanlışlıkla şifremi GitHub'a yükledim, ne yapmalıyım", 'secrets-cleanup'],
  ['Sitemi internete koymak ve yayına almak istiyorum', 'deploy-web'],
  // The follow-up a finished job offers (2026-10-02)
  ['Bu projeyi internete koy: önce bir önizleme bağlantısı ver, ben bakınca canlıya al.', 'deploy-web'],
  ['Siteyi tarayıcıda bir kullanıcı gibi dene: ana akışları tıklayıp dene, bulduğun hataları listele ve düzelt.', 'try-it-in-browser'],
  // The Building's job box examples (2026-10-02): the sentence plus a few words the person adds
  ['Bir sorun var, sorunu bul ve düzelt: sayfa açılmıyor', 'debug-helper'],
  ['Bu projede sıradaki adım ne olmalı? Öner, ben onaylayınca yap.', 'next-step'],
  ['Görünüşü güzelleştir: daha düzenli ve profesyonel görünsün.', 'ui-polish'],
  ['Proje derlenmiyor, build hatası veriyor', 'fix-build-errors'],
  ['Kodum çok dağınık oldu, yeniden düzenlemek istiyorum', 'refactor-safely'],
  ['Yarın kaldığım yerden devam edelim, devir notu bırak', 'handoff-notes'],
  ['Bu özelliği baştan sona bir yapay zekâ ekibiyle yaptır', 'orchestrate'],
  ['API anahtarımı nereye koymalıyım, .env dosyası nasıl olur', 'env-and-secrets'],
  ['Her push yaptığımda testler otomatik çalışsın', 'github-actions-setup'],
  ['Uygulamanın görüntüsü çirkin, daha şık ve modern olsun', 'ui-polish'],
  ['Hangi programlama dilini ve teknolojiyi seçmeliyim', 'tech-stack-chooser'],
  // Wave 1.5 (docs/direction.md K1)
  ['Şimdi ne yapmam gerekiyor, sıradaki adım ne', 'next-step'],
  ['Bitti demeden önce gerçekten çalıştığını kanıtla', 'verify-before-done'],
  ['Planımı yazmadan önce zayıf yerlerini sorgula', 'plan-challenge'],
  ['Projeye AGENTS.md talimat dosyası yaz', 'agent-rules'],
  ['İş bitti, dalı birleştirip pull request açalım', 'finish-branch'],
  ['Kaybolduk, bundan sonra ne yapacağız', 'next-step'],
  ['Sonraki adım ne olmalı', 'next-step'],
  ['Gerçekten çalışıyor mu, kanıt göster', 'verify-before-done'],
  ['Emin misin, gerçekten düzeldi mi', 'verify-before-done'],
  ['Planın en zayıf yerlerini bul, ön ölüm yapalım', 'plan-challenge'],
  ['Bu plandaki zayıf yerleri bul', 'plan-challenge'],
  ['CLAUDE.md dosyası oluştur, proje kuralları yazılsın', 'agent-rules'],
  ['Yapay zekâ kuralları için bir kural dosyası istiyorum', 'agent-rules'],
  ['Dalı kapatmak ve ana dala birleştirmek istiyorum', 'finish-branch'],
  ['Değişiklikler için pull request açmak istiyorum', 'finish-branch'],
  // Wave 2 (2026-10-01): one idea for each new skill
  ['Veritabanı tasarlamak, tabloları ve ilişkileri çizmek istiyorum', 'database-schema'],
  ['Kullanıcılar kayıt olup giriş yapabilsin, şifre sıfırlama da olsun', 'auth-flow'],
  ['Uygulamama yapay zekâ modeli bağlamak istiyorum', 'llm-app-basics'],
  ['Sitemi gerçek bir kullanıcı gibi tarayıcıda dene', 'try-it-in-browser'],
  ['Telefonda düzgün görünmüyor, klavye ile de kullanılabilsin', 'ui-check'],
  ['Godot ile oynanabilir bir prototip yapmak', 'game-prototype-godot'],
  ['CSV dosyamdaki satış verisini analiz edip grafik çizmek istiyorum', 'data-analysis-starter'],
  ['Betiğimi komut satırı aracına çevirmek istiyorum', 'cli-tool-starter'],
  ['Chrome için tarayıcı eklentisi geliştirmek', 'browser-extension-starter'],
  ['API belgesi yazmak, her uç nokta için örnek istek olsun', 'api-docs'],
  ['Projenin mimarisini ve veri akışını anlatan bir sayfa yaz', 'architecture-notes'],
  ['Uygulamam çok yavaş açılıyor, hızlandırmak istiyorum', 'performance-check'],
  ['Uygulamamı Docker konteynerine koymak istiyorum', 'docker-basics'],
  ['Eski paketleri güncellemek ve bağımlılıkları kontrol etmek istiyorum', 'dependency-update'],
  ['Bu uygulamayı kullanıcı gözüyle dene ve sorun listesi çıkar', 'qa-explorer'],
];

// Sentences that must NOT go to the named item: it is not ranked first (neighbours keep their own ground)
const NOT_IDEAS = [
  ['Bu fonksiyon için birim test yaz', 'verify-before-done'],
  ['Hata veriyor, çalışmıyor', 'verify-before-done'],
  ['Yapılacaklar için görev listesi çıkar', 'next-step'],
  ['Kodu yazdım, yeni oturum için devir notu bırak', 'next-step'],
  ['Bir fikrim var, projemin planını çıkar', 'plan-challenge'],
  ['Kapsam çok büyüdü, neyi keseyim', 'plan-challenge'],
  ['Projenin kullanım kılavuzu ve readme yaz', 'agent-rules'],
  ['API anahtarımı nereye koyayım', 'agent-rules'],
  ['Yeni bir sürüm çıkaracağım, değişiklik günlüğü yaz', 'finish-branch'],
  ['Değişiklikleri kaydet ve yeni dal aç', 'finish-branch'],
  ['Basit bir yapılacaklar listesi web uygulaması', 'task-breakdown'],
  // Wave 2: the neighbours keep their own ground
  ["Yanlışlıkla şifremi GitHub'a yükledim, ne yapmalıyım", 'auth-flow'],
  ['Hata veriyor, çalışmıyor', 'try-it-in-browser'],
  ['Sitemi internete koymak ve yayına almak istiyorum', 'docker-basics'],
  ["Telegram'da her sabah hava durumunu gönderen bir bot yapmak istiyorum", 'cli-tool-starter'],
  ['Yeni bir sürüm çıkaracağım, değişiklik günlüğü yaz', 'dependency-update'],
  ['Uygulamanın görüntüsü çirkin, daha şık ve modern olsun', 'ui-check'],
  ['Bu fonksiyon için birim test yaz', 'try-it-in-browser'],
  ['Projenin kullanım kılavuzu ve readme yaz', 'api-docs'],
  ['Hangi programlama dilini ve teknolojiyi seçmeliyim', 'game-prototype-godot'],
];

test('kit: Turkish idea sentences reach the right skill through sibersentez-keywords-tr', () => {
  for (const [idea, expected] of IDEAS) {
    const ranked = ITEMS.map((it) => ({ name: it.fm.data.name, score: keywordScore(list(it.fm.data.metadata['sibersentez-keywords-tr']), idea) })).sort((a, b) => b.score - a.score || byteOrder(a.name, b.name));
    assert.equal(ranked[0].name, expected, `"${idea}": ${JSON.stringify(ranked.slice(0, 3))}`);
    assert.ok(ranked[0].score > ranked[1].score, `"${idea}": a clear winner ${JSON.stringify(ranked.slice(0, 3))}`);
  }
});

test('kit: sentences that belong to a neighbour never rank the new skill first', () => {
  for (const [idea, notExpected] of NOT_IDEAS) {
    const ranked = ITEMS.map((it) => ({ name: it.fm.data.name, score: keywordScore(list(it.fm.data.metadata['sibersentez-keywords-tr']), idea) })).sort((a, b) => b.score - a.score || byteOrder(a.name, b.name));
    assert.notEqual(ranked[0].name, notExpected, `"${idea}": ${JSON.stringify(ranked.slice(0, 3))}`);
  }
});

test('kit: no two items of the same kind share a Turkish keyword word for word (a skill and its agent twin may)', () => {
  const owner = new Map();
  for (const it of ITEMS) {
    for (const kw of list(it.fm.data.metadata['sibersentez-keywords-tr'])) {
      const key = it.kind + ':' + wordsOf(kw).join(' ') + (kw.endsWith('*') ? '*' : '');
      assert.ok(!owner.has(key) || owner.get(key) === it.fm.data.name, `"${kw}" is in both ${owner.get(key)} and ${it.fm.data.name}`);
      owner.set(key, it.fm.data.name);
    }
  }
});

test('kit: the reference matcher folds Turkish letters, matches whole words and stems', () => {
  assert.equal(keywordScore(['masaüstü*'], 'MASAÜSTÜNDE çalışan'), 1);
  assert.equal(keywordScore(['masaüstü*'], 'masaustu uygulama'), 1);
  assert.equal(keywordScore(['oyun'], 'oyunlar'), 0);
  assert.equal(keywordScore(['oyun*'], 'oyunlar'), 1);
  assert.equal(keywordScore(['platform oyunu'], 'bir platform oyunu'), 2);
  assert.equal(keywordScore(['e ticaret'], 'e-ticaret sitesi'), 2);
  assert.equal(keywordScore(['ios'], 'IOS için'), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// The server's reader and matcher (server/kit.mjs) agree with the files and the reference
// ---------------------------------------------------------------------------------------------------------------

test("kit: the server's matcher (kitWords, keywordHits) scores every sample idea like the reference and names the words as typed", () => {
  const server = (keywords, idea) => keywordHits(keywords, kitWords(idea)).reduce((n, h) => n + h.count, 0);
  for (const [idea] of IDEAS) {
    for (const it of ITEMS) {
      const kws = list(it.fm.data.metadata['sibersentez-keywords-tr']);
      assert.equal(server(kws, idea), keywordScore(kws, idea), `${it.fm.data.name}: "${idea}"`);
    }
  }
  for (const [kws, text] of [[['masaüstü*'], 'MASAÜSTÜNDE çalışan'], [['e ticaret'], 'e-ticaret sitesi'], [['ios'], 'IOS için'], [['oyun'], 'oyunlar'], [['platform oyunu'], 'bir platform oyunu']]) assert.equal(server(kws, text), keywordScore(kws, text), `${kws} / ${text}`);
  assert.deepEqual(keywordHits(['telegram', 'bot*', 'her sabah'], kitWords("Telegram'da her sabah bir bot")), [
    { keyword: 'telegram', count: 1, raw: 'Telegram' },
    { keyword: 'bot*', count: 1, raw: 'bot' },
    { keyword: 'her sabah', count: 2, raw: 'her sabah' },
  ]);
});

test("kit: the server's reader (readKit) gives every item with the metadata of catalog.json; tags are all in the dictionary now", () => {
  const kit = serverReadKit(KIT);
  assert.equal(kit.version, CATALOG.version);
  assert.deepEqual(
    kit.items.map((it) => `${it.kind}:${it.name}`),
    CATALOG.items.map((r) => `${r.kind}:${r.name}`),
  );
  for (const it of kit.items) {
    const row = CATALOG.items.find((r) => r.kind === it.kind && r.name === it.name);
    assert.deepEqual([...it.tags].sort(), [...row.tags].sort(), `${it.name}: tags (every one known to server/tags.mjs)`);
    assert.equal(it.stage, row.stage, `${it.name}: stage`);
    assert.deepEqual([...it.keywords], row.keywordsTr, `${it.name}: keywords`);
    assert.deepEqual([...it.offer], row.offer, `${it.name}: offer`);
    assert.equal(it.version, row.version, `${it.name}: version`);
    assert.equal(it.kitVersion, CATALOG.version, `${it.name}: kit version`);
    assert.equal(it.origin, 'kit');
    assert.equal(it.rel, `kit/${row.path}`);
  }
  assert.deepEqual(CATALOG.proposedTags, [], 'the proposed tags of the first version are in server/tags.mjs');
  for (const r of CATALOG.items) for (const t of r.tags) assert.ok(TAG_BY_ID.has(t), `${r.name}: ${t}`);
  // Offered in an empty folder: the idea-to-plan interview and the project skeleton
  assert.deepEqual(
    CATALOG.items.filter((r) => r.offer.includes('empty-folder')).map((r) => r.name),
    ['idea-to-plan', 'project-setup'],
  );
  // No kit: an empty kit, never an error
  assert.deepEqual(serverReadKit(path.join(ROOT, 'no-such-kit')).items, []);
  assert.deepEqual(serverReadKit(null).items, []);
});

test('kit: every skill carries its license notice (LICENSE.md, the same text for all) and every agent the notice comment; both name the copyright line of kit/LICENSE.md', () => {
  const copyright = copyrightLine();
  assert.match(copyright, COPYRIGHT_RE, 'kit/LICENSE.md has a copyright line');
  for (const it of SKILLS) {
    assert.equal(readText(path.join(it.dir, NOTICE_FILE)), skillNotice(copyright), `${it.rel}/${NOTICE_FILE} (KIT_WRITE_CATALOG=1 rewrites it)`);
    const row = CATALOG.items.find((r) => r.kind === 'skill' && r.name === it.name);
    assert.ok(fs.existsSync(path.join(KIT, row.notice)), `${it.name}: the catalog names its notice`);
  }
  for (const it of AGENTS) {
    assert.deepEqual(it.fm.comments, agentNotice(copyright), `${it.rel}: notice comment (KIT_WRITE_CATALOG=1 rewrites it)`);
    // Tools read past the comment: the app's own reader sees the same name and description
    assert.equal(readFrontmatter(it.file).name, it.name);
  }
  // Every notice names the license and carries the copyright line; the skill notice holds the permission notice, the
  // agent notice points to it
  const text = skillNotice(copyright) + agentNotice(copyright).join(' ');
  for (const phrase of ['MIT', 'Copyright (c)', 'Permission is hereby granted', 'LICENSE.md in the SiberSentez kit folder', 'arranty']) assert.ok(text.includes(phrase), phrase);
});

// ---------------------------------------------------------------------------------------------------------------
// Wave 2 (2026-10-01): every software kind has a start, a build helper and a check
// ---------------------------------------------------------------------------------------------------------------

const WAVE2_SKILLS = {
  backend: ['database-schema', 'auth-flow'],
  'ai-apps': ['llm-app-basics'],
  quality: ['try-it-in-browser', 'performance-check', 'dependency-update'],
  design: ['ui-check'],
  starters: ['game-prototype-godot', 'data-analysis-starter', 'cli-tool-starter', 'browser-extension-starter'],
  docs: ['api-docs', 'architecture-notes'],
  release: ['docker-basics'],
};
const WAVE2_AGENTS = { security: ['security-auditor'], quality: ['qa-explorer'], backend: ['data-analyst'], game: ['game-builder'], release: ['devops-helper'], docs: ['doc-builder'] };
const WAVE2_ITEM_NAMES = new Set([...Object.values(WAVE2_SKILLS).flat(), ...Object.values(WAVE2_AGENTS).flat()]);
const STATUS_WORDS = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'];

test('kit wave 2: the new skills and agents are in their categories, and the catalog is 0.6.2 (job identity, jobs started outside the app)', () => {
  assert.equal(CATALOG.version, '0.6.2');
  for (const [category, names] of Object.entries(WAVE2_SKILLS)) {
    for (const name of names) {
      const it = SKILLS.find((x) => x.name === name);
      assert.ok(it, `skill ${name} exists`);
      assert.equal(it.category, category, `${name}: category`);
    }
  }
  for (const [category, names] of Object.entries(WAVE2_AGENTS)) {
    for (const name of names) {
      const it = AGENTS.find((x) => x.name === name);
      assert.ok(it, `agent ${name} exists`);
      assert.equal(it.category, category, `${name}: category`);
    }
  }
  // An item that names a kit item in backticks names one that exists (no dead hand-offs)
  const names = new Set(ITEMS.map((it) => it.name));
  for (const it of ITEMS) {
    for (const m of it.fm.body.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
      if (WAVE2_ITEM_NAMES.has(m[1])) assert.ok(names.has(m[1]), `${it.rel} mentions ${m[1]}`);
    }
  }
});

// Kit 0.5.0 (2026-10-05): what a real launch taught. The going-live skills sit in release, hand off to each other by
// name, and the launch checker is read-only and ends with the VERDICT line like the other auditors
const LAUNCH_SKILLS = ['launch-checklist', 'domain-email', 'move-to-new-host'];
test('kit 0.5.0: the launch skills and the launch-checker agent are in release, read-only where they check, and hand off to each other', () => {
  for (const name of LAUNCH_SKILLS) {
    const it = SKILLS.find((x) => x.name === name);
    assert.ok(it, `skill ${name} exists`);
    assert.equal(it.category, 'release', `${name}: category`);
    assert.equal(it.fm.data.metadata['sibersentez-stage'], 'ship', `${name}: stage`);
    assert.ok(fs.existsSync(path.join(it.dir, 'reference.md')), `${name}: has a reference`);
  }
  const checker = AGENTS.find((x) => x.name === 'launch-checker');
  assert.ok(checker, 'agent launch-checker exists');
  assert.equal(checker.category, 'release');
  assert.deepEqual(list(checker.fm.data.tools).sort(), ['Bash', 'Glob', 'Grep', 'Read'], 'launch-checker: read-only tools');
  assert.match(checker.fm.body, /VERDICT: \{"verdict":"(?:REVISE|APPROVE)"/);
  assert.match(checker.fm.body, /last line\*\* of your answer is `VERDICT:`/);
  assert.match(checker.fm.body, /You write no file/);
  assert.match(checker.fm.body, /POST/, 'launch-checker: never sends forms');
  // The domain-email skill never lets the AI make or hold a password
  const mail = SKILLS.find((x) => x.name === 'domain-email');
  assert.match(mail.fm.body, /Passwords are the user's/);
  // deploy-web sends to the new skills, and every backticked kit name in the new items exists
  const deploy = SKILLS.find((x) => x.name === 'deploy-web');
  for (const name of LAUNCH_SKILLS) assert.ok(deploy.fm.body.includes(`\`${name}\``), `deploy-web names ${name}`);
  const names = new Set(ITEMS.map((it) => it.name));
  for (const it of ITEMS.filter((x) => [...LAUNCH_SKILLS, 'launch-checker'].includes(x.name))) {
    for (const m of it.fm.body.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) if (/^(launch|domain|move|deploy|security|performance|try|env|docker)-/.test(m[1])) assert.ok(names.has(m[1]), `${it.rel} mentions ${m[1]}`);
  }
});

test('kit wave 2: the auditing and exploring agents are read-only and end with the VERDICT line; the building agents end with a status word', () => {
  for (const name of ['security-auditor', 'qa-explorer']) {
    const it = AGENTS.find((x) => x.name === name);
    assert.deepEqual(list(it.fm.data.tools).sort(), ['Bash', 'Glob', 'Grep', 'Read'], `${name}: read-only tools`);
    assert.match(it.fm.body, /VERDICT: \{"verdict":"(?:REVISE|APPROVE)"/, `${name}: a VERDICT example line`);
    assert.match(it.fm.body, /last line\*\* of your answer is (?:the )?`VERDICT:`/, `${name}: the verdict is the last line`);
    assert.match(it.fm.body, /You write no file/, `${name}: writes nothing`);
  }
  for (const name of ['data-analyst', 'game-builder', 'devops-helper', 'doc-builder']) {
    const it = AGENTS.find((x) => x.name === name);
    for (const w of STATUS_WORDS) assert.ok(it.fm.body.includes(`\`${w}\``), `${name}: names ${w}`);
    assert.match(it.fm.body, /never write outside the task's files list/i, `${name}: stays in its files`);
    assert.match(it.fm.body, /do not write that file\s+yourself/, `${name}: the conductor saves the report`);
    assert.match(it.fm.body, /git commands?\s+that\s+changes?\s+state/, `${name}: no git writes`);
  }
});

test('kit wave 2: Godot and Unity starters exclude each other; the Godot starter is listed for a Godot project', () => {
  const godot = ITEMS.find((it) => it.name === 'game-prototype-godot');
  const unity = ITEMS.find((it) => it.name === 'game-prototype-unity');
  const GODOT_PROJECT = profileOf(['godot']);
  assert.equal(scoreItem(engineTags(unity), GODOT_PROJECT).excluded, true, 'the Unity starter is out of a Godot project');
  assert.equal(scoreItem(engineTags(godot), UNITY_PROJECT).excluded, true, 'the Godot starter is out of a Unity project');
  for (const p of [NEXT_PROJECT, PYTHON_PROJECT]) assert.equal(scoreItem(engineTags(godot), p).excluded, true);
  const own = scoreItem(engineTags(godot), GODOT_PROJECT);
  assert.equal(own.excluded, false);
  assert.ok(own.score >= MEDIUM_SCORE);
});

test('kit wave 2: the new topic tags (cli, extension) are in the dictionary and named for people in both languages', async () => {
  for (const id of ['cli', 'extension']) assert.ok(TAG_BY_ID.has(id), `${id} is in server/tags.mjs`);
  const strings = (await import('../public/js/strings/kit.js')).default;
  for (const lang of ['en', 'tr']) for (const id of ['cli', 'extension']) assert.ok(strings[lang][`fitTag_${id}`], `${lang}: fitTag_${id}`);
  assert.ok(metaTags(ITEMS.find((it) => it.name === 'cli-tool-starter')).includes('cli'));
  assert.ok(metaTags(ITEMS.find((it) => it.name === 'browser-extension-starter')).includes('extension'));
});
