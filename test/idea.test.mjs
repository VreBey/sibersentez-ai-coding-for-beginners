// Project idea tests (docs/start-flow.md): the idea's tags (English and Turkish, suffixed forms), the idea as the
// server reads it (length, control and invisible characters), the scoring with an idea (weight, reasons, the conflict
// rule), the fit cache per idea, GET /api/projects/<id>/fit?idea=, skills-apply with the keys an idea chose, and the
// idea box of the drawer (pure helpers only).
// Run: node --test test/idea.test.mjs
// Hermetic: a fake hub and fake projects under the system temp folder; no real process is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { initHub } from '../server/hub.mjs';
import { TAGS, TAG_BY_ID, ideaTags, ideaKeywords, keywordIn, tagsInText, IDEA_WORD_MAX, IDEA_KEYWORDS_MAX, IDEA_STOPWORDS } from '../server/tags.mjs';
import { SCORE, LIBRARY_SIG_MS, IDEA_MAX, IDEA_WORDS_CAP, MAX_IDEA_FITS, normalizeIdea, withIdea, itemWords, scoreItem, createFit, planApplyImports, projectProfile } from '../server/fit.mjs';
import { IDEA_KINDS, STACK_CHOICES, stackChoiceFor, ideaWith, cleanIdea, ideaBoxHtml, ideaKeptAnswer, ideaStaysLocal, ideaStateHtml, ideaWordOf, fitReasonText, fitReasonsText, fitSectionHtml, fitView, fitRequestBody, ensureFitSelection, IDEA_MAX as UI_IDEA_MAX } from '../public/js/views/drawer.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { esc } from '../public/js/format.js';

// ---------------- fake world ----------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-idea-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });

const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const libSkill = (hub, cat, name, desc) => write(path.join(hub, 'library', cat, 'skills', name, 'SKILL.md'), fm(name, desc));
const libAgent = (hub, cat, name, desc) => write(path.join(hub, 'library', cat, 'agents', `${name}.md`), fm(name, desc));
const unityAt = (dir) => {
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  write(path.join(dir, 'Assets', 'Scripts', 'Player.cs'), 'class Player {}');
};

let worldN = 0;
function world() {
  const base = path.join(ROOT, `w${++worldN}`);
  const hub = path.join(base, 'hub');
  initHub(hub);
  const projects = [];
  const catalog = { hubDir: hub, homeDir: HOME, claudeDir: CLAUDE, roster: new Map(), version: 1, getProject: (id) => projects.find((p) => p.id === id) || null, allProjects: () => projects };
  const project = (id, make = null) => {
    const dir = path.join(base, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    if (make) make(dir);
    projects.push({ id, name: id, kind: 'adhoc', path: dir, exists: true, via: ['claude-code'], packages: [] });
    return dir;
  };
  return { base, hub, projects, catalog, project };
}

// A library with skills for several kinds of projects, and an empty project folder 'fresh'
function libraryWorld() {
  const w = world();
  libSkill(w.hub, 'game', 'unity-2d', 'Unity 2D games: tilemaps, sprites and player movement');
  libSkill(w.hub, 'game', 'unity-ui', 'Unity UI Toolkit screens');
  libAgent(w.hub, 'game', 'unity-specialist', 'Unity engine specialist for gameplay code');
  libSkill(w.hub, 'mobile', 'react-native-expert', 'React Native and Expo apps');
  libSkill(w.hub, 'web', 'nextjs-shop', 'Next.js online store: product pages, cart and Stripe payments');
  libSkill(w.hub, 'web', 'nextjs-seo', 'Next.js SEO for websites');
  libSkill(w.hub, 'general', 'telegram-bot', 'Telegram bots in Python with python-telegram-bot');
  libSkill(w.hub, 'data', 'pandas-analysis', 'Data analysis in Python with pandas');
  libSkill(w.hub, 'docs', 'writing', 'Technical writing');
  libSkill(w.hub, 'general', 'stripe-checkout', 'Stripe checkout and payments');
  libSkill(w.hub, 'design', 'web-accessibility', 'Accessibility for websites');
  w.project('fresh');
  return w;
}
const byKey = (body, key) => body.candidates.find((c) => c.key === key);
const selectedKeys = (body) => body.candidates.filter((c) => c.selected).map((c) => c.key);

function snapshotTree(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${e.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// ---------------- the idea's tags ----------------
const named = (text) => ideaTags(text).filter((x) => !x.via).map((x) => x.id);
const all = (text) => ideaTags(text).map((x) => x.id);

test('idea tags: Turkish ideas with suffixed forms give the right tags; the tool is a stack tag, the kind of thing a topic', () => {
  assert.deepEqual(named('Unity ile oyun yapmak istiyorum'), ['unity', 'gamedev']);
  assert.deepEqual(all('Unity ile oyun yapmak istiyorum'), ['unity', 'csharp', 'gamedev'], 'Unity implies C#');
  assert.deepEqual(named('Unity ile 2D platform oyunu'), ['unity', 'gamedev']);
  assert.deepEqual(named('Next.js ile online mağaza'), ['nextjs', 'ecommerce']);
  assert.deepEqual(all('Next.js ile online mağaza'), ['nextjs', 'web', 'ecommerce'], 'a store implies web; the phrase names only the store');
  assert.deepEqual(named('Python ile Telegram botu'), ['python', 'bot']);
  assert.deepEqual(named('Discord botları'), ['bot']);
  assert.deepEqual(named('e-ticaret sitesi'), ['web', 'ecommerce']);
  assert.deepEqual(named('Mağazası olan bir site'), ['web', 'ecommerce']);
  assert.deepEqual(named('Kişisel blog sitesi'), ['web', 'content']);
  assert.deepEqual(named('portfolyo sitesi'), ['web']);
  assert.deepEqual(named('React Native ile mobil uygulama'), ['react-native', 'mobile']);
  assert.deepEqual(named('Electron ile masaüstü uygulaması'), ['electron', 'desktop']);
  assert.deepEqual(named('Python ile veri analizi'), ['python', 'data']);
  assert.deepEqual(named('yapay zekâ destekli sohbet botu'), ['ai', 'bot']);
  assert.deepEqual(named('Yapay zekalı asistan'), ['ai']);
  assert.deepEqual(named('Şirket sunumu hazırlamak'), ['slides']);
  assert.deepEqual(named('web scraping ile fiyat takibi otomasyonu'), ['automation', 'scraping']);
  assert.deepEqual(named('E-ticaret için REST API'), ['web', 'ecommerce', 'backend']);
  assert.deepEqual(named('çok oyunculu oyun sunucusu'), ['multiplayer'], 'the longer phrases take their words (not also oyun*)');
  // Letter case: people type names in lower case; capitals and the dotted capital I fold
  assert.deepEqual(named('unity ile oyun'), ['unity', 'gamedev']);
  assert.deepEqual(named('NEXT.JS İLE MAĞAZASI'), ['nextjs', 'ecommerce']);
  assert.deepEqual(named('flask ile api'), ['flask', 'backend'], 'a proper noun counts in lower case in an idea');
  assert.deepEqual([...tagsInText('flask ile api', { strictCase: true })], ['backend'], 'but not in a description');
  // English ideas
  assert.deepEqual(named('A 2D platformer in Unity'), ['unity', 'gamedev']);
  assert.deepEqual(named('An online store with Next.js'), ['nextjs', 'ecommerce']);
  assert.deepEqual(named('A Telegram bot in Python'), ['python', 'bot']);
  assert.deepEqual(named('landing page and a newsletter'), ['web', 'content']);
  // Nothing known: no tags; words that only look alike do not count
  assert.deepEqual(ideaTags('bir şey yapmak istiyorum'), []);
  assert.deepEqual(ideaTags('bottom sheet in a community app'), [], 'bot and unity are whole words');
});

test('idea tags: named tags carry the words that named them (as typed, bounded); implied tags name the tag behind them', () => {
  const list = ideaTags('Unity ile 2D platform oyunu');
  assert.deepEqual(list, [
    { id: 'unity', type: 'stack', word: 'Unity' },
    { id: 'csharp', type: 'stack', via: 'unity' },
    { id: 'gamedev', type: 'topic', word: 'oyunu' },
  ]);
  assert.deepEqual(ideaTags('Expo ile uygulama').map((x) => `${x.id}<${x.via || x.word}`), ['react-native<expo', 'expo<Expo', 'mobile<expo']);
  const long = ideaTags(`${'a'.repeat(200)} oyun`);
  assert.equal(long[0].word, 'oyun');
  const phrase = ideaTags('headless cms');
  assert.ok(phrase.every((x) => !x.word || x.word.length <= IDEA_WORD_MAX));
  for (const x of ideaTags('Next.js ile online mağaza, Python ile Telegram botu, Unity oyunu')) assert.ok(TAG_BY_ID.has(x.id), x.id);
});

test('idea tags: the new topics are topics, never stacks (the conflict rule stays about tools)', () => {
  for (const id of ['ecommerce', 'bot', 'backend', 'content', 'slides', 'automation', 'scraping']) {
    assert.equal(TAG_BY_ID.get(id)?.type, 'topic', id);
  }
  assert.ok(TAGS.length > 60);
});

// ---------------- the idea as the server reads it ----------------
test('normalizeIdea: at most 300 characters, controls become spaces, invisible and direction marks go, spaces collapse; anything else is empty', () => {
  assert.equal(IDEA_MAX, 300);
  assert.equal(normalizeIdea('  Unity   ile\toyun\n'), 'Unity ile oyun');
  assert.equal(normalizeIdea('a'.repeat(5000)).length, 300);
  assert.equal(Array.from(normalizeIdea('ğ'.repeat(400))).length, 300, 'counted in characters');
  assert.equal(normalizeIdea('oyun\u0000\u0007\u001b[31m\u007f\u009bx'), 'oyun [31m x');
  assert.equal(normalizeIdea('Uni​ty ‮oyun‬ ﻿'), 'Unity oyun');
  assert.equal(normalizeIdea('⁦Next.js⁩ mağaza'), 'Next.js mağaza');
  assert.equal(normalizeIdea('mağaza'.normalize('NFD')), 'mağaza'.normalize('NFC'), 'composed');
  assert.equal(normalizeIdea('ğ'.normalize('NFD')), 'ğ');
  assert.equal(normalizeIdea('x\ud800y'), 'x�y', 'a lone surrogate is replaced');
  for (const bad of [null, undefined, 42, {}, ['oyun'], '', '   ', '\u0000\u0001']) assert.equal(normalizeIdea(bad), '', String(bad));
  // HTML stays text: it never becomes a tag, and the fit never echoes the idea itself
  assert.deepEqual(ideaTags(normalizeIdea('<script>alert(1)</script> oyun')).map((x) => x.id), ['gamedev']);
});

// ---------------- scoring with an idea ----------------
test('scoring with an idea: a topic the idea names weighs like a stack; an implied one like a topic; a tag only the idea gives has the reason idea:<named tag>', () => {
  const empty = projectProfile({ id: 'none', kind: 'adhoc' });
  const p = withIdea(empty, ideaTags('Unity ile 2D platform oyunu'));
  assert.deepEqual([...p.stacks].sort(), ['csharp', 'unity']);
  assert.deepEqual([...p.primary], ['unity']);
  assert.deepEqual([...p.topics], ['gamedev']);
  assert.equal(SCORE.idea, SCORE.stack);
  const unity = scoreItem(['unity', 'csharp', 'gamedev'], p);
  assert.deepEqual(unity, { excluded: false, stacks: ['unity'], score: SCORE.stack + SCORE.idea, confidence: 'high', reasons: ['idea:unity', 'idea:gamedev'] });
  // The idea only says Unity: game development is implied, so it weighs as a topic (5 + 2 = medium)
  const only = scoreItem(['unity', 'csharp', 'gamedev'], withIdea(empty, ideaTags('Unity ile uygulama')));
  assert.equal(only.score, SCORE.stack + SCORE.topic);
  assert.equal(only.confidence, 'medium');
  assert.deepEqual(only.reasons, ['idea:unity'], 'one reason per named tag');
  // A topic-only item never reaches high (a shared tool is needed)
  assert.equal(scoreItem(['gamedev'], p).confidence, 'medium');
  // The conflict rule follows the idea: a React Native skill is left out of a Unity idea
  assert.equal(scoreItem(['react-native', 'mobile'], p).excluded, true);
  assert.equal(scoreItem(['godot', 'gdscript', 'gamedev'], p).excluded, true);
  // No idea: the profile is the same object; an empty folder excludes every item with a tool
  assert.equal(withIdea(empty, []), empty);
  assert.equal(scoreItem(['unity'], empty).excluded, true);
  // Files and idea together: a tag the folder shows keeps its own reason
  const w = world();
  w.project('u', unityAt);
  const fromFiles = withIdea(projectProfile(w.projects[0]), ideaTags('Unity oyunu'));
  assert.deepEqual(scoreItem(['unity', 'csharp', 'gamedev'], fromFiles).reasons, ['stack:unity', 'topic:gamedev']);
  assert.equal(scoreItem(['unity', 'csharp', 'gamedev'], fromFiles).score, SCORE.stack + SCORE.idea, 'the idea still weighs the topic it names');
});

test('idea words: the words no tag took (no stop words, no bare numbers, once, at most 8) order skills that fit anyway, +1 each, at most +3, with the reason idea-word:<word>', () => {
  assert.deepEqual(ideaKeywords('Unity ile 2D platform oyunu yapmak istiyorum').map((k) => k.raw), ['2D', 'platform']);
  assert.deepEqual(ideaKeywords('A 2D platformer in Unity with pixel art').map((k) => k.w), ['2d', 'pixel', 'art']);
  assert.deepEqual(ideaKeywords('bir uygulama projesi için 3 tane 42 app'), [], 'stop words and bare numbers');
  assert.deepEqual(ideaKeywords('pixel Pixel PIXEL').map((k) => k.raw), ['pixel'], 'once, the first spelling');
  assert.equal(ideaKeywords('aa bb cc dd ee ff gg hh ii jj kk').length, IDEA_KEYWORDS_MAX);
  assert.ok(IDEA_STOPWORDS.has('istiyorum') && IDEA_STOPWORDS.has('with'));
  // Turkish suffixes: a word of five letters or more matches its suffixed forms either way
  assert.ok(keywordIn('platformu', new Set(['platform'])));
  assert.ok(keywordIn('envanter', new Set(['envanteri'])));
  assert.ok(!keywordIn('2d', new Set(['2dx'])), 'short words match whole');
  assert.ok(!keywordIn('art', new Set(['artist'])));
  // Scoring: only an item that fits already gets the words; at most three count
  const empty = projectProfile({ id: 'none', kind: 'adhoc' });
  const p = withIdea(empty, ideaTags('Unity ile 2D pixel art platform tilemap oyunu'), ideaKeywords('Unity ile 2D pixel art platform tilemap oyunu'));
  const words = itemWords({ name: 'unity-2d-pixel', description: 'Unity 2D pixel art platform games with tilemaps' });
  const s = scoreItem(['unity', 'csharp', 'gamedev'], p, { words });
  assert.equal(s.score, SCORE.stack + SCORE.idea + IDEA_WORDS_CAP * SCORE.ideaWord, 'four words match, three count');
  assert.deepEqual(s.reasons, ['idea:unity', 'idea-word:2D']);
  assert.equal(scoreItem(['docs'], p, { words: itemWords({ name: 'pixel-docs', description: '2D pixel art platform notes' }) }).score, 0, 'the words alone never make an item fit');
  // Words without any known tag still order a project whose folder has the tool
  const w = world();
  w.project('u', unityAt);
  const folder = withIdea(projectProfile(w.projects[0]), ideaTags('2D platform'), ideaKeywords('2D platform'));
  assert.equal(scoreItem(['unity', 'csharp', 'gamedev'], folder, { words }).score, scoreItem(['unity', 'csharp', 'gamedev'], projectProfile(w.projects[0])).score + 2 * SCORE.ideaWord);
  // The page reads the reason plainly
  setLanguage('tr');
  try {
    assert.equal(fitReasonText('idea-word:2D', (x) => x, []), 'fikrinde “2D” geçiyor');
  } finally {
    setLanguage('en');
  }
});

// ---------------- the fit with an idea ----------------
test('empty folder + idea: without an idea nothing with a tool is proposed; with "Unity ile 2D platform oyunu" the Unity skills are strong and selected, the others left out', () => {
  const w = libraryWorld();
  const fit = createFit({ catalog: w.catalog });
  const plain = fit.get('fresh').body;
  assert.deepEqual(plain.project.tags, []);
  assert.ok(!('idea' in plain.project));
  assert.deepEqual(selectedKeys(plain), [], 'an empty folder selects nothing');
  assert.ok(!plain.candidates.some((c) => c.name.startsWith('unity')), 'every item with a tool is left out');
  const body = fit.get('fresh', { idea: 'Unity ile 2D platform oyunu' }).body;
  assert.deepEqual(body.project.tags, [], 'the folder tags stay the folder\'s');
  assert.deepEqual(body.project.idea.tags.map((x) => x.id), ['unity', 'csharp', 'gamedev']);
  assert.deepEqual(selectedKeys(body), ['skill:unity-2d', 'skill:unity-ui', 'agent:unity-specialist']);
  for (const k of ['skill:unity-2d', 'skill:unity-ui', 'agent:unity-specialist']) assert.equal(byKey(body, k).confidence, 'high', k);
  assert.deepEqual(byKey(body, 'skill:unity-ui').reasons, ['idea:unity', 'idea:gamedev']);
  // "2D" is no tag, but the 2D skill has it: it comes first and says why
  assert.equal(byKey(body, 'skill:unity-2d').score, byKey(body, 'skill:unity-ui').score + SCORE.ideaWord);
  assert.deepEqual(byKey(body, 'skill:unity-2d').reasons, ['idea:unity', 'idea-word:2D']);
  assert.equal(body.candidates[0].key, 'skill:unity-2d');
  const names = body.candidates.map((c) => c.name);
  for (const n of ['react-native-expert', 'nextjs-shop', 'nextjs-seo', 'telegram-bot', 'pandas-analysis']) assert.ok(!names.includes(n), n);
  assert.ok(body.excluded.sample.some((x) => x.name === 'react-native-expert' && x.stacks.includes('react-native')), 'the conflict rule, with the idea');
  assert.ok(names.includes('writing'), 'items without a tool stay (weak)');
  assert.deepEqual(body.selection, { skills: 2, agents: 1 });
});

test('empty folder + idea: other ideas pick their own skills (Next.js store, Python Telegram bot, Python data analysis)', () => {
  const w = libraryWorld();
  const fit = createFit({ catalog: w.catalog });
  const shop = fit.get('fresh', { idea: 'Next.js ile online mağaza' }).body;
  assert.deepEqual(selectedKeys(shop), ['skill:nextjs-shop'], 'the store skill; SEO for websites only may help');
  assert.equal(byKey(shop, 'skill:nextjs-shop').score, SCORE.stack + SCORE.idea + SCORE.topic, 'Next.js, the store it names, web it implies');
  assert.equal(byKey(shop, 'skill:nextjs-seo').confidence, 'medium');
  assert.deepEqual(byKey(shop, 'skill:nextjs-shop').reasons, ['idea:nextjs', 'idea:ecommerce']);
  const bot = fit.get('fresh', { idea: 'Python ile Telegram botu' }).body;
  assert.deepEqual(selectedKeys(bot), ['skill:telegram-bot']);
  assert.equal(byKey(bot, 'skill:pandas-analysis').confidence, 'medium', 'Python alone: possible, not selected');
  const data = fit.get('fresh', { idea: 'Python ile veri analizi' }).body;
  assert.deepEqual(selectedKeys(data), ['skill:pandas-analysis']);
  // A topic-only idea: possible fits, none selected (the tip asks for the tool); the store skill comes before a skill
  // that is only about the web (a store implies web, it does not name it)
  const store = fit.get('fresh', { idea: 'online mağaza' }).body;
  assert.deepEqual(selectedKeys(store), []);
  assert.ok(!store.project.idea.tags.some((x) => x.type === 'stack'));
  assert.equal(store.candidates[0].key, 'skill:stripe-checkout');
  assert.equal(byKey(store, 'skill:stripe-checkout').confidence, 'medium');
  assert.deepEqual(byKey(store, 'skill:stripe-checkout').reasons, ['idea:ecommerce']);
  assert.equal(byKey(store, 'skill:web-accessibility').confidence, 'low');
});

test('fit cache: the idea is part of the key; the same idea comes from the cache; a new idea scores the kept pool; at most 16 ideas are kept; a change drops them', async () => {
  const w = libraryWorld();
  let clock = 1000;
  const fit = createFit({ catalog: w.catalog, now: () => clock });
  const count = () => ({ ...fit.stats });
  const a = fit.get('fresh', { idea: 'Unity oyunu' }).body;
  let s = count();
  assert.equal(s.computed, 1, 'one pool');
  assert.equal(s.scored, 1);
  const b = fit.get('fresh', { idea: 'Next.js mağaza' }).body;
  assert.notDeepEqual(selectedKeys(a), selectedKeys(b), 'two ideas, two fits');
  assert.equal(fit.stats.computed, 1, 'the pool is not read again for another idea');
  assert.equal(fit.stats.scored, 2);
  // The same idea (spaces and controls aside) comes from the cache
  s = count();
  assert.deepEqual(fit.get('fresh', { idea: '  Unity\toyunu ' }).body, a);
  assert.equal(fit.stats.scored, s.scored);
  assert.equal(fit.stats.cached, s.cached + 1);
  // No idea: the plain fit, cached with the pool
  assert.ok(!('idea' in fit.get('fresh').body.project));
  assert.equal(fit.stats.computed, 1);
  // The cache is bounded
  assert.equal(MAX_IDEA_FITS, 16);
  for (let i = 0; i < 40; i++) fit.get('fresh', { idea: `Unity oyunu ${i}` });
  assert.equal(fit.ideaCacheSize(), MAX_IDEA_FITS);
  // The oldest went first: 'Unity oyunu' is scored again
  s = count();
  fit.get('fresh', { idea: 'Unity oyunu' });
  assert.equal(fit.stats.scored, s.scored + 1);
  // A change in the library: the pool is built again and the idea fits of the old pool no longer answer
  libSkill(w.hub, 'game', 'unity-audio', 'Unity audio mixers for games');
  clock += LIBRARY_SIG_MS; // the library's signature is read again after a while
  const after = fit.get('fresh', { idea: 'Unity oyunu' }).body;
  assert.equal(fit.stats.computed, 2);
  assert.ok(byKey(after, 'skill:unity-audio'));
  fit.invalidate('fresh');
  assert.equal(fit.ideaCacheSize(), 0, 'invalidate drops the idea fits of the project');
});

test('skills-apply plans the keys an idea chose: the pool of the fit without an idea has them all (excluded ones too); the automatic selection without keys has none', () => {
  const w = libraryWorld();
  const fit = createFit({ catalog: w.catalog });
  const keys = selectedKeys(fit.get('fresh', { idea: 'Unity ile 2D platform oyunu' }).body);
  assert.equal(keys.length, 3);
  // skills-apply reads the fit without an idea (server/actions.mjs): every key must still be found there
  const plain = fit.fitOf('fresh').fit;
  for (const k of keys) assert.ok(plain._byKey.has(k), k);
  const part = planApplyImports({ fit: plain, keys, hubDir: w.hub });
  assert.deepEqual(part.entries, [], 'nothing skipped');
  assert.deepEqual(part.installItems, [{ kind: 'skill', name: 'unity-2d' }, { kind: 'skill', name: 'unity-ui' }, { kind: 'agent', name: 'unity-specialist' }]);
  const auto = planApplyImports({ fit: plain, keys: null, hubDir: w.hub });
  assert.deepEqual(auto.installItems, [], 'the automatic selection of an empty folder is empty');
});

// ---------------- HTTP ----------------
function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
}
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`no answer: ${method} ${p}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function startServer(w, mode) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const workDir = path.join(w.base, 'app');
  fs.mkdirSync(workDir, { recursive: true });
  const fit = createFit({ catalog: w.catalog });
  const logs = [];
  const actions = createActions({ catalog: w.catalog, ingest: { sessions: new Map() }, mode, port, hubDir: w.hub, workDir, homeDir: HOME, claudeDir: CLAUDE, spawn: fakeSpawn([]), now: () => Date.UTC(2026, 8, 29), log: (l) => logs.push(l), fit });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, fit }));
  const headers = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token || '' };
  return {
    fit,
    logs,
    getFit: (id, idea) => request(port, { path: `/api/projects/${id}/fit${idea === undefined ? '' : `?idea=${encodeURIComponent(idea)}`}`, headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    getRaw: (p) => request(port, { path: p, headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    post: (body) => request(port, { method: 'POST', path: '/api/action', body, headers }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// Console output while fn runs (the idea must never reach a log line)
async function capture(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

test('GET /api/projects/<id>/fit?idea=: tags of the idea, a long or harmful idea cut and cleaned, never echoed, never logged, nothing written', async () => {
  const w = libraryWorld();
  const env = await startServer(w, 'dry');
  const before = snapshotTree(w.base);
  const secret = 'Unity ile oyun GIZLI-IDEA-7f3a';
  try {
    const lines = await capture(async () => {
      const r = await env.getFit('fresh', secret);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.project.idea.tags.map((x) => x.id), ['unity', 'csharp', 'gamedev']);
      assert.ok(!r.raw.includes('GIZLI-IDEA-7f3a'), 'the idea text is not sent back');
      // Long: only the first 300 characters are read (the tool named after them does not count)
      const long = await env.getFit('fresh', `${'x '.repeat(200)}Unity`);
      assert.equal(long.status, 200);
      assert.deepEqual(long.json.project.idea.tags, []);
      // Controls, direction marks, HTML, a broken percent sign, repeated parameters
      const odd = await env.getFit('fresh', '‮Unity\u0000\u0007 <img src=x onerror=alert(1)> oyun');
      assert.deepEqual(odd.json.project.idea.tags.map((x) => x.id), ['unity', 'csharp', 'gamedev']);
      assert.ok(!odd.raw.includes('<img'), 'nothing of the idea but its tags comes back');
      assert.equal((await env.getRaw('/api/projects/fresh/fit?idea=%E0%A4%A')).status, 200, 'a malformed escape is read as text');
      const twice = await env.getRaw(`/api/projects/fresh/fit?idea=${encodeURIComponent('Next.js mağaza')}&idea=Unity`);
      assert.deepEqual(twice.json.project.idea.tags.filter((x) => !x.via).map((x) => x.id), ['nextjs', 'ecommerce'], 'the first idea parameter');
      // Empty and blank ideas are no idea
      assert.ok(!('idea' in (await env.getFit('fresh', '   ')).json.project));
      assert.equal((await env.getFit('nope', 'Unity')).status, 404);
    });
    assert.ok(!lines.some((l) => /GIZLI|onerror|Unity/.test(l)), lines.join('\n'));
    assert.ok(!env.logs.some((l) => /GIZLI|Unity/.test(l)));
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')), 'nothing written');
});

test('skills-apply with the keys an idea chose: preview plans them (nothing written), live installs them into the empty folder', async () => {
  for (const mode of ['dry', 'live']) {
    const w = libraryWorld();
    const env = await startServer(w, mode);
    const fresh = w.projects.find((p) => p.id === 'fresh').path;
    try {
      const f = await env.getFit('fresh', 'Unity ile 2D platform oyunu');
      const keys = f.json.candidates.filter((c) => c.selected).map((c) => c.key);
      assert.deepEqual(keys, ['skill:unity-2d', 'skill:unity-ui', 'agent:unity-specialist']);
      const r = await env.post({ action: 'skills-apply', projectId: 'fresh', keys });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.selection, 'keys');
      const ops = r.json.plan.map((e) => `${e.op}:${e.kind}:${e.name}`);
      assert.deepEqual(ops, ['copy:skill:unity-2d', 'copy:skill:unity-ui', 'copy:agent:unity-specialist'], mode);
      if (mode === 'dry') {
        assert.equal(r.json.applied, false);
        assert.equal(r.json.reason, 'preview-mode');
        assert.ok(!fs.existsSync(path.join(fresh, '.claude')), 'preview wrote nothing');
      } else {
        assert.equal(r.json.applied, true);
        assert.ok(fs.existsSync(path.join(fresh, '.claude', 'skills', 'unity-2d', 'SKILL.md')));
        assert.ok(fs.existsSync(path.join(fresh, '.claude', 'agents', 'unity-specialist.md')));
        // The fit of the idea follows: installed, nothing left to select
        const again = await env.getFit('fresh', 'Unity ile 2D platform oyunu');
        assert.deepEqual(again.json.candidates.filter((c) => c.selected), []);
        assert.ok(again.json.candidates.filter((c) => keys.includes(c.key)).every((c) => c.installed));
      }
      // Without keys, the automatic selection of the folder alone (empty) is applied: never the idea's
      const auto = await env.post({ action: 'skills-apply', projectId: 'fresh' });
      assert.deepEqual(auto.json.plan, []);
    } finally {
      await env.close();
    }
  }
});

// ---------------- the drawer's idea box (pure helpers) ----------------
function inLanguages(fn) {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      fn(lang, STRINGS[lang]);
    }
  } finally {
    setLanguage('en');
  }
}
const P = { id: 'fresh', name: 'Fresh', via: ['claude-code'] };
const fitWithIdea = (text, candidates = []) => ({ project: { id: 'fresh', tags: [], idea: { tags: ideaTags(text) }, entries: 0, truncated: false }, candidates, active: [], excluded: { count: 0, sample: [] }, selection: { skills: 0, agents: 0 } });
const cand = (key, extra = {}) => ({ key, kind: key.split(':')[0], name: key.split(':')[1], description: '', sources: ['library'], installable: true, installed: false, confidence: 'high', score: 10, reasons: ['idea:unity', 'idea:gamedev'], tags: ['unity'], selected: true, ...extra });

test('idea box: the question, the box with the typed text (escaped), the button, the hint; examples only while the box is empty; every example gives a topic and one also names a tool', () => {
  inLanguages((lang, S) => {
    const empty = ideaBoxHtml({ idea: '' });
    assert.ok(empty.includes(`<label class="idea-l" for="fitIdea">${S.startIdeaLabel}</label>`), lang);
    assert.match(empty, /<input type="text" id="fitIdea" class="idea-in" data-idea data-fk="fit:idea" value="" maxlength="300"/);
    assert.match(empty, /data-fit-act="find" data-fk="fit:find">/);
    // Examples in plain words first: a newcomer need not know the tools; one example shows that a tool can be named
    let withTool = 0;
    for (const i of [1, 2, 3]) {
      const ex = S[`startExample${i}`];
      assert.ok(empty.includes(`data-idea-example="${ex}"`), `${lang} example ${i}`);
      const tags = ideaTags(ex);
      assert.ok(tags.some((x) => x.type === 'topic' && !x.via), `${lang} "${ex}" names a topic`);
      if (tags.some((x) => x.type === 'stack' && !x.via)) withTool++;
    }
    assert.ok(withTool >= 1, `${lang}: one example names a tool`);
    const typed = ideaBoxHtml({ idea: '"><img src=x onerror=alert(1)>' });
    assert.doesNotMatch(typed, /<img/);
    assert.match(typed, /value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.doesNotMatch(typed, /data-fit-act="example"/, 'no examples once something is typed');
  });
  assert.equal(UI_IDEA_MAX, IDEA_MAX, 'the page sends at most what the server reads');
  assert.doesNotMatch(ideaBoxHtml({ idea: 'x' }), /idea-local/, 'no local-only note unless the app said so');
  assert.equal(cleanIdea(` a\u0000b  ${'c'.repeat(400)}`).length, 300);
  assert.equal(cleanIdea(null), '');
});

test('keeping the idea with the project: kept; not-in-memory stops the tries for that project in this page session and shows one plain note under the box; other failures stay quiet', () => {
  const st = { idea: 'Unity ile oyun' };
  assert.equal(ideaKeptAnswer('p-kept', st, 'Unity ile oyun', { ok: true, projectId: 'p-kept', reason: 'saved' }), 'kept');
  assert.deepEqual([st.hubSent, st.hubIdea, st.ideaLocalOnly], ['Unity ile oyun', 'Unity ile oyun', undefined]);
  assert.equal(ideaStaysLocal('p-kept'), false);
  const other = {};
  for (const r of [null, undefined, { ok: false, reason: 'no-server' }, { ok: false, reason: 'timeout' }, { ok: false, reason: 'error' }]) {
    assert.equal(ideaKeptAnswer('p-quiet', other, 'x', r), 'failed', JSON.stringify(r));
  }
  assert.equal(ideaStaysLocal('p-quiet'), false, 'a passing failure is tried again with the next change');
  assert.equal(other.ideaLocalOnly, undefined);
  const local = { idea: 'Telegram botu' };
  assert.equal(ideaKeptAnswer('p-local', local, 'Telegram botu', { ok: false, reason: 'not-in-memory' }), 'local-only');
  assert.equal(ideaStaysLocal('p-local'), true);
  assert.equal(local.ideaLocalOnly, true);
  assert.equal(local.hubSent, undefined, 'nothing was kept');
  assert.equal(ideaStaysLocal('p-other'), false, 'only that project');
  inLanguages((lang, S) => {
    const html = ideaBoxHtml(local);
    assert.equal(html.split(esc(S.startIdeaLocalOnly)).length - 1, 1, `${lang}: the note once`);
    assert.match(html, /<\/div><p class="small muted idea-local" id="fitIdeaLocal">/, `${lang}: right under the box`);
    assert.match(html, /aria-describedby="fitIdeaHint fitIdeaLocal fitIdeaState"/);
  });
  assert.equal(STRINGS.tr.startIdeaLocalOnly, 'Bu fikir yalnız bu bilgisayarda saklanıyor.');
  // The drawer asks keepIdea no more for such a project (before the wait and when it ends)
  const src = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  const start = src.indexOf('  function keepIdeaLater(pid, st) {');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.ok(body.includes("if (typeof keepIdea !== 'function' || ideaStaysLocal(pid)) return;"));
  assert.ok(body.includes('if (st.hubSent === text || ideaStaysLocal(pid)) return;'));
  assert.ok(body.includes("if (ideaKeptAnswer(pid, st, text, r) === 'local-only') rerenderFlow(`fit:${pid}`);"));
});

test('idea state: searching, "press Enter" while the box differs from the list, "From your idea" chips, the tip without a tool, nothing known, a failure', () => {
  inLanguages((lang, S) => {
    assert.ok(ideaStateHtml({ idea: 'Unity oyunu', loading: true, loadingIdea: 'Unity oyunu' }).includes(esc(S.startIdeaSearching)), lang);
    const data = fitWithIdea('Unity ile 2D platform oyunu');
    const found = ideaStateHtml({ idea: 'Unity ile 2D platform oyunu', dataIdea: 'Unity ile 2D platform oyunu', data });
    assert.ok(found.includes(esc(S.startIdeaFound)), lang);
    assert.match(found, /<li class="fit-tag stack idea"[^>]*>Unity<\/li><li class="fit-tag topic idea"[^>]*>/);
    assert.ok(found.includes(`>${S.fitTag_gamedev}</li>`), `${lang}: the named topic by its name`);
    assert.ok(!found.includes('>C#<'), 'implied tags are not listed as the idea\'s');
    assert.ok(!found.includes(esc(S.startIdeaNoStack)), 'a tool is named: no tip');
    // Typed but not asked for yet
    assert.ok(ideaStateHtml({ idea: 'Unity ile 3D', dataIdea: 'Unity ile 2D platform oyunu', data }).includes(esc(S.startIdeaPending)), lang);
    // Only a topic: the tip asks for the tool
    const shop = fitWithIdea('online mağaza');
    assert.ok(ideaStateHtml({ idea: 'online mağaza', dataIdea: 'online mağaza', data: shop }).includes(esc(S.startIdeaNoStack)), lang);
    // Nothing known
    const none = fitWithIdea('bir şey');
    assert.ok(ideaStateHtml({ idea: 'bir şey', dataIdea: 'bir şey', data: none }).includes(esc(S.startIdeaNone)), lang);
    // Failed: the older list stays and says so
    assert.ok(ideaStateHtml({ idea: 'Unity', dataIdea: '', data, error: true, errorIdea: 'Unity' }).includes(esc(S.startIdeaFailed)), lang);
    // No idea at all: nothing
    assert.equal(ideaStateHtml({ idea: '', dataIdea: '', data: { ...data, project: { tags: [] } } }), '');
  });
});

test('a vague idea is asked about, never a dead end: kinds when nothing is known, then the tool with the recommended one first', () => {
  inLanguages((lang, S) => {
    // Nothing known: the kind question with a chip per kind and "not sure yet"; no warning
    const none = fitWithIdea('uygulama geliştirme');
    const vague = ideaStateHtml({ idea: 'uygulama geliştirme', dataIdea: 'uygulama geliştirme', data: none });
    assert.ok(vague.includes(esc(S.startIdeaNone)), lang);
    assert.doesNotMatch(vague, /idea-warn/);
    for (const k of IDEA_KINDS) assert.ok(vague.includes(`data-idea-add="${esc(S[`startKindAdd_${k}`])}"`), `${lang} kind ${k}`);
    assert.match(vague, /data-fit-act="unsure"/);
    // Every kind's words name a topic that has a tool choice (so the next step asks for the tool)
    for (const k of IDEA_KINDS) {
      const tags = ideaTags(S[`startKindAdd_${k}`]);
      assert.ok(tags.length && stackChoiceFor(tags), `${lang} "${S[`startKindAdd_${k}`]}" leads to a tool choice`);
      assert.ok(!tags.some((x) => x.type === 'stack'), `${lang} a kind names no tool by itself`);
    }
    // "Not sure yet": the note instead of the question, the kinds stay
    const unsure = ideaStateHtml({ idea: 'uygulama geliştirme', dataIdea: 'uygulama geliştirme', ideaUnsure: 'uygulama geliştirme', data: none });
    assert.ok(unsure.includes(esc(S.startUnsureNote)) && !unsure.includes('data-fit-act="unsure"'), lang);
    assert.match(unsure, /data-fit-act="refine"/);
    // A topic without a tool: the tool question, the recommended tool first, and why
    const game = ideaStateHtml({ idea: 'oyun', dataIdea: 'oyun', data: fitWithIdea('oyun') });
    assert.ok(game.includes(esc(S.startIdeaNoStack)) && game.includes(esc(S.startStackWhy_game)), lang);
    assert.ok(game.indexOf(esc(S.startStackRec.replace('{name}', 'Unity'))) < game.indexOf('>Godot<'), `${lang} recommended first`);
    assert.match(game, /class="idea-chip rec"/);
    // Every tool's words name that tool, and together with the kind the idea is complete
    for (const c of STACK_CHOICES) {
      for (const name of c.stacks) {
        const tags = ideaTags(ideaWith(c.topics[0] === 'gamedev' ? 'oyun' : 'x', S.startStackAdd.replace('{name}', name)));
        assert.ok(tags.some((x) => x.type === 'stack' && !x.via), `${lang} "${name}" is a known tool`);
      }
    }
  });
  assert.equal(ideaWith('  oyun ', 'Unity ile'), 'oyun Unity ile');
  assert.ok(ideaWith('x'.repeat(400), 'Unity ile').length <= UI_IDEA_MAX, 'within what the server reads');
  assert.equal(stackChoiceFor([{ id: 'ecommerce' }]).stacks[0], 'Next.js');
  assert.equal(stackChoiceFor([{ id: 'testing' }]), null);
  // A plain web idea (a to-do list) starts with files that need no install; a shop or a server keeps Next.js first
  assert.deepEqual(stackChoiceFor([{ id: 'web' }]).stacks, ['HTML + JavaScript', 'Next.js']);
  assert.equal(stackChoiceFor([{ id: 'web' }]).why, 'webSimple');
  assert.equal(stackChoiceFor([{ id: 'web' }, { id: 'ecommerce' }]).stacks[0], 'Next.js');
  assert.equal(stackChoiceFor([{ id: 'backend' }, { id: 'web' }]).stacks[0], 'Next.js');
});

test('weak fits: an item that shares nothing (score 0) is not listed, not counted in "show more" and not selectable; with only such items there are no install buttons', () => {
  const zero = cand('skill:unrelated', { confidence: 'low', score: 0, reasons: [], selected: false });
  const weak = cand('skill:weak', { confidence: 'low', score: 2, reasons: ['topic:web'], selected: false });
  const data = fitWithIdea('online mağaza', [weak, zero]);
  const st = { data, sel: new Set(['skill:unrelated']), targets: new Set(['claude']), busy: '', showLow: true, idea: 'online mağaza', dataIdea: 'online mağaza' };
  const v = fitView(data, st, 'live');
  assert.deepEqual(v.low.map((c) => c.key), ['skill:weak']);
  assert.deepEqual(v.keys, [], 'a hidden item never goes into a request');
  const only = fitWithIdea('', [zero]);
  const sv = fitView(only, { data: only, sel: null, targets: new Set(['claude']) }, 'live');
  assert.equal(sv.selectable, false);
  assert.equal(sv.low.length, 0);
  const html = fitSectionHtml(P, { data: only, sel: null, targets: new Set(['claude']), busy: '', confirm: '', out: null, showLow: false, folds: {}, idea: '', dataIdea: '' }, 'live', (x) => x);
  assert.doesNotMatch(html, /data-fit-act="apply"|data-fit-act="more"/);
});

test('reasons from the idea read plainly: a tool by its name, a topic by the words typed; the section starts with the idea box and selects what the idea chose', () => {
  const data = fitWithIdea('Unity ile 2D platform oyunu', [cand('skill:unity-2d'), cand('agent:unity-specialist'), cand('skill:writing', { confidence: 'medium', score: 2, reasons: [], selected: false })]);
  const idea = data.project.idea.tags;
  assert.equal(ideaWordOf('unity', idea), 'Unity');
  assert.equal(ideaWordOf('gamedev', idea), 'oyunu');
  assert.equal(ideaWordOf('csharp', idea), 'C#', 'an implied tag by its name');
  assert.equal(ideaWordOf('web', idea), 'web', 'a tag the idea lacks by its name');
  setLanguage('tr');
  try {
    assert.equal(fitReasonText('idea:unity', (x) => x, idea), 'fikrinde “Unity” geçiyor');
    assert.equal(fitReasonsText(['idea:unity', 'idea:gamedev'], (x) => x, idea), 'fikrinde “Unity” geçiyor · fikrinde “oyunu” geçiyor');
    const st = { data, sel: null, targets: new Set(['claude']), busy: '', confirm: '', out: null, showLow: false, folds: {}, idea: 'Unity ile 2D platform oyunu', ideaWanted: 'Unity ile 2D platform oyunu', dataIdea: 'Unity ile 2D platform oyunu' };
    const html = fitSectionHtml(P, st, 'dry', (x) => x);
    assert.ok(html.indexOf('class="idea"') > html.indexOf('id="fitH"') && html.indexOf('class="idea"') < html.indexOf('class="fit-tags"'), 'the idea box comes before the folder tags');
    assert.ok(html.includes(esc(STRINGS.tr.startFolderEmpty)), 'an empty folder says the idea decides');
    assert.match(html, /<span class="fit-why">fikrinde “Unity” geçiyor · fikrinde “oyunu” geçiyor<\/span>/);
    // The request carries the keys on screen: the ones the idea chose
    ensureFitSelection(st);
    assert.deepEqual(fitRequestBody('fresh', 'apply', fitView(data, st, 'live')), { action: 'skills-apply', projectId: 'fresh', keys: ['skill:unity-2d', 'agent:unity-specialist'], targets: ['claude'] });
  } finally {
    setLanguage('en');
  }
  assert.equal(fitReasonText('idea:gamedev', (x) => x, idea), 'your idea mentions “oyunu”');
  assert.equal(fitReasonText('idea:', (x) => x, idea), STRINGS.en.fitReason_other, 'a code without a tag reads as the general line, never raw');
});
