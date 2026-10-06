// Localized string tables: the base table and the feature tables (public/js/strings/*.js) merge into STRINGS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, BASE_STRINGS, FEATURE_TABLES, LANGUAGES } from '../public/js/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('every language has the same keys, in the base table and in each feature table', () => {
  const keys = (o) => Object.keys(o || {}).sort();
  for (const lang of LANGUAGES) assert.deepEqual(keys(BASE_STRINGS[lang]), keys(BASE_STRINGS.en), `base ${lang}`);
  for (const [name, table] of Object.entries(FEATURE_TABLES)) {
    for (const lang of LANGUAGES) assert.deepEqual(keys(table[lang]), keys(table.en), `${name} ${lang}`);
  }
  for (const lang of LANGUAGES) assert.deepEqual(keys(STRINGS[lang]), keys(STRINGS.en), `merged ${lang}`);
});

test('a feature table never repeats a key of the base table or of another feature table', () => {
  const seen = new Map(Object.keys(BASE_STRINGS.en).map((k) => [k, 'base']));
  for (const [name, table] of Object.entries(FEATURE_TABLES)) {
    for (const k of Object.keys(table.en || {})) {
      assert.ok(!seen.has(k), `${name}.${k} repeats ${seen.get(k)}`);
      seen.set(k, name);
    }
  }
});

test('no string is empty and every value is a string', () => {
  for (const lang of LANGUAGES) {
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      assert.equal(typeof v, 'string', `${lang}.${k}`);
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
    }
  }
});

// The shell table (public/js/strings/shell.js): the static texts of index.html and the texts of the server's error codes
test('index.html: every data-i18n key has a text in every language, and the page holds no Turkish letters', () => {
  const html = read('public', 'index.html');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) keys.add(pair.split(':')[1]);
  assert.ok(keys.size > 20);
  for (const lang of LANGUAGES) for (const k of keys) assert.ok(STRINGS[lang][k], `${lang}.${k}`);
  assert.doesNotMatch(html, /[çğıöşüÇĞİÖŞÜ]/);
});

test('error codes: every code the server sends has a text in every language', () => {
  const codes = new Set();
  for (const file of ['actions.mjs', 'app.mjs']) {
    const src = read('server', file);
    // reject(status, 'code'), { error: 'code' } and the checkDir messages
    for (const m of src.matchAll(/(?:reject\(\d+, |error: |checkDir\([^,]+, )'([a-z][a-z-]*)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.has('project-not-found') && codes.has('bad-token') && codes.has('broad-folder'));
  // The skill flow, the terminal and the start-with-AI flow have tables of their own (skErr_, termErr_, aiErr_)
  for (const code of codes) {
    for (const lang of LANGUAGES) {
      const S = STRINGS[lang];
      const found = ['err_', 'termErr_', 'skErr_', 'aiErr_'].some((p) => S[p + code]) || ['actions-off', 'unknown-action'].includes(code); // the page maps these two itself (actionsOffError, skErr_malformed)
      assert.ok(found, `${lang}: no text for the error code ${code}`);
    }
  }
});

test('fixed server texts show in the page language: live events from their meta, "Last task:" in descriptions', async () => {
  const { eventText, itemDescription, projectDescription } = await import('../public/js/format.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  const ev = (status, prev, text = '') => ({ kind: 'live', text, meta: { status, prev } });
  try {
    setLanguage('tr');
    assert.equal(eventText(ev('closed', 'busy', 'Session closed')), 'Oturum kapandı');
    assert.equal(eventText(ev('busy', null, 'Session open')), 'Oturum açık');
    assert.equal(eventText(ev('busy', 'idle', 'Working')), 'Çalışıyor');
    assert.equal(eventText(ev('waiting', 'busy', 'Waiting for you: dialog open')), 'Seni bekliyor: bir onay penceresi açık', "Claude Code's English words translated");
    assert.equal(eventText(ev('waiting', 'busy', 'Waiting for you: something new')), 'Seni bekliyor: something new', 'an unknown phrase stays as it is');
    assert.equal(eventText(ev('waiting', 'busy', 'Waiting for you')), 'Seni bekliyor');
    assert.equal(eventText(ev('idle', 'busy', 'Finished its turn, waiting')), 'Cevabını bitirdi, seni bekliyor');
    assert.equal(eventText({ kind: 'prompt', text: 'fix the bug' }), 'fix the bug', 'the person’s own words stay as they are');
    assert.equal(itemDescription('Last task: build the menu'), 'Son görev: build the menu');
    assert.equal(itemDescription('A skill'), 'A skill');
    // The project notes of server/catalog.mjs (kept in step with its PROJECT_NOTE and ADDED_NOTE)
    const catalogSrc = fs.readFileSync(new URL('../server/catalog.mjs', import.meta.url), 'utf8');
    for (const [name, tr] of [['PROJECT_NOTE', 'Yapay zekâ araçlarının kayıtlarında otomatik bulundu.'], ['ADDED_NOTE', 'SiberSentez’de yeni proje olarak eklendi.']]) {
      const m = new RegExp(`const ${name} = '([^']*)';`).exec(catalogSrc);
      assert.ok(m, name);
      assert.equal(projectDescription(m[1]), tr, name);
    }
    assert.equal(projectDescription('My own notes'), 'My own notes');
    setLanguage('en');
    assert.equal(eventText(ev('idle', 'busy')), 'Finished its turn, waiting');
  } finally {
    setLanguage('en');
  }
});

test('every SiberSentez kit item has a short summary in every language; other items keep their own description', async () => {
  const { kitSummary } = await import('../public/js/format.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  const kit = JSON.parse(fs.readFileSync(new URL('../kit/catalog.json', import.meta.url), 'utf8'));
  for (const lang of LANGUAGES) {
    for (const it of kit.items) {
      const v = STRINGS[lang][`kitSum_${it.kind}_${it.name}`];
      assert.ok(v && v.length <= 140, `${lang} ${it.kind}:${it.name} has a short summary`);
    }
  }
  try {
    setLanguage('tr');
    assert.equal(kitSummary('skill', 'idea-to-plan', 'Turns a rough idea…', true), STRINGS.tr['kitSum_skill_idea-to-plan']);
    assert.equal(kitSummary('skill', 'idea-to-plan', 'My own copy', false), 'My own copy', 'a copy outside the kit keeps its text');
    assert.equal(kitSummary('skill', 'not-in-kit', 'Other', true), 'Other');
  } finally {
    setLanguage('en');
  }
});

test('no word was broken by the Orkestra -> SiberSentez rename: the product name is never glued to the letters of another word', () => {
  // Seen 2026-10-01: "orkestrasyon" had become "sibersentezsyon" in a kit category's name
  const glued = /sibersentez[a-zçğıöşü]/i;
  for (const lang of LANGUAGES) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      if (typeof value === 'string') assert.ok(!glued.test(value), `${lang}.${key}: ${value}`);
    }
  }
});

test('why a session waits, in the page language: its plan, its question, or Claude Code\'s English words translated (no more "Soruyor: dialog open")', async () => {
  const { waitWhat, waitPhrase } = await import('../public/js/format.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  setLanguage('tr');
  try {
    assert.equal(waitWhat({ lastAction: { tool: 'ExitPlanMode' }, live: { status: 'waiting', waitingFor: 'dialog open' } }), 'planının onayı', 'the plan wins over the generic words');
    assert.equal(waitWhat({ lastAction: { tool: 'AskUserQuestion' }, live: { status: 'waiting', waitingFor: 'input needed' } }), 'sorusuna yanıt');
    assert.equal(waitWhat({ lastAction: { tool: 'Bash' }, live: { status: 'waiting', waitingFor: 'Dialog Open' } }), 'bir onay penceresi açık');
    assert.equal(waitWhat({ live: { status: 'waiting', waitingFor: 'input needed' } }), 'yanıtın');
    assert.equal(waitWhat({ live: { status: 'waiting', waitingFor: '' } }), '');
    assert.equal(waitPhrase('something new'), 'something new');
  } finally {
    setLanguage('en');
  }
  for (const f of ['public/js/notify.js', 'public/js/views/drawer.js', 'public/js/views/waiting.js', 'public/js/main.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(src.includes('waitWhat(s)') && !/what: s\.live\.waitingFor|\(\$\{s\.live\.waitingFor\}\)/.test(src), `${f} shows the reason through waitWhat`);
  }
});
