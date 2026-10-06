// The app shell (docs/shell.md): the menu and its five screens, Today's blocks and the Settings screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { settingsHtml } from '../public/js/views/settings.js';
import { todayRecentHtml, RECENT_COUNT } from '../public/js/views/today.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

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

test('the menu: Building, Projects, then Skills & agents and Feed under "Advanced" (Timeline shares the Feed), then AI tools, Guide, Settings at its foot; one screen per menu item', () => {
  const html = read('public', 'index.html');
  const nav = html.slice(html.indexOf('<nav class="side"'), html.indexOf('</nav>'));
  assert.deepEqual([...nav.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]), ['today', 'projects', 'roster', 'feed', 'settings']);
  assert.ok(nav.indexOf('data-i18n="navAdvanced"') > nav.indexOf('data-tab="projects"') && nav.indexOf('data-i18n="navAdvanced"') < nav.indexOf('data-tab="roster"'), 'the advanced label');
  assert.match(nav, /data-tab="feed" data-tab-also="timeline"/);
  assert.ok(nav.indexOf('id="toolsBtn"') < nav.indexOf('id="guideBtn"') && nav.indexOf('id="guideBtn"') < nav.indexOf('data-tab="settings"'));
  for (const k of ['today', 'projects', 'roster', 'feed', 'timeline', 'settings']) assert.match(html, new RegExp(`<section id="tab-${k}" class="panel[^"]*" role="tabpanel"`), k);
  // Today holds the building, who waits, the recent projects, the numbers and the usage strip; the rest left the page
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="tab-projects"'));
  for (const id of ['todayChecklist', 'workshopBody', 'todayRecent', 'usageStrip']) assert.ok(today.includes(`id="${id}"`), id);
  assert.ok(html.slice(html.indexOf('id="tab-feed"'), html.indexOf('id="tab-timeline"')).includes('id="kpis"'), 'the 24-hour numbers sit on the Feed screen');
  assert.doesNotMatch(html, /<nav class="tabs"/, 'the old tab row is gone');
  const main = read('public', 'js', 'main.js');
  assert.match(main, /const TAB_KEYS = \['today', 'projects', 'roster', 'feed', 'timeline', 'settings'\];/);
  assert.match(main, /const NAV_KEYS = \['today', 'projects', 'roster', 'feed', 'settings'\];/);
  assert.match(main, /if \(e\.key >= '1' && e\.key <= '5'\) showTab\(NAV_KEYS\[Number\(e\.key\) - 1\]\);/);
  assert.match(main, /let active = 'today';/);
  assert.ok(html.includes('<link rel="stylesheet" href="/css/shell.css">'));
});

test('Settings: actions, AI tools, usage and cost, general, help, in both languages; the mode button only in the desktop app', () => {
  inLanguages((lang, S) => {
    const h = settingsHtml({ mode: 'dry', lang: 'tr', cost: false, canSwitch: true });
    for (const k of ['setActions', 'navTools', 'setUsage', 'setGeneral', 'setHelp', 'setMode_dry', 'setToolsOpen', 'setGuideOpen']) assert.ok(h.includes(S[k].replace(/'/g, '&#39;').replace(/"/g, '&quot;')), `${lang} ${k}`);
    assert.ok(h.includes('data-set-act="actions"'));
    assert.ok(h.includes('data-set-cost') && !/data-set-cost[^>]*checked/.test(h));
    assert.ok(h.includes('Türkçe'));
    const web = settingsHtml({ mode: 'off', lang: 'en', cost: true, canSwitch: false });
    assert.ok(!web.includes('data-set-act="actions"') && web.includes(S.setActionsAppOnly));
    assert.match(web, /data-set-cost[^>]*checked/);
  });
});

test('language from Settings: settings.json keeps every other key; auto removes the key; anything else is refused; the page offers the choice only in the desktop app', async () => {
  const { writeHubLanguageSetting, readHubLanguageSetting, LANGUAGE_CHOICES } = await import('../electron/helpers.mjs');
  const os = await import('node:os');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-lang-'));
  fs.writeFileSync(path.join(hub, 'settings.json'), JSON.stringify({ actions: 'dry', other: 1 }));
  assert.deepEqual([...LANGUAGE_CHOICES], ['auto', 'en', 'tr']);
  assert.equal(writeHubLanguageSetting(hub, 'tr').ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hub, 'settings.json'), 'utf8')), { actions: 'dry', other: 1, language: 'tr' });
  assert.equal(readHubLanguageSetting(hub), 'tr');
  assert.equal(writeHubLanguageSetting(hub, 'auto').ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hub, 'settings.json'), 'utf8')), { actions: 'dry', other: 1 });
  for (const bad of ['de', 'TR', '', null, 'auto ']) assert.deepEqual(writeHubLanguageSetting(hub, bad), { ok: false, code: 'INVALID_LANGUAGE' }, String(bad));
  assert.ok(!fs.readdirSync(hub).some((f) => f.endsWith('.tmp')), 'no temporary file left');
  fs.rmSync(hub, { recursive: true, force: true });
  // The shell checks the sender before it writes, and loads the window again in the new language
  const main = read('electron', 'main.mjs');
  const fn = main.slice(main.indexOf('async function onSetLanguageRequest'), main.indexOf('// window.sibersentezShell.pickLibraryFolder()'));
  assert.ok(fn.indexOf('bridgeSender(senderFacts(event))') < fn.indexOf('writeHubLanguageSetting'));
  assert.ok(fn.includes('win.loadURL(pageUrl())'));
  assert.ok(main.includes('ipcMain.handle(LANGUAGE_IPC_CHANNEL, onSetLanguageRequest);'));
  // The page: a choice with the desktop bridge, words without it
  const withBridge = settingsHtml({ lang: 'tr', langChoice: 'tr', canLang: true });
  assert.match(withBridge, /<select data-set-lang[^>]*>.*<option value="tr" selected>Türkçe<\/option>/s);
  assert.ok(withBridge.includes('value="auto"') && withBridge.includes('value="en"'));
  assert.ok(!settingsHtml({ lang: 'tr', canLang: false }).includes('data-set-lang'));
});

test('Today: the three most urgent or recent projects (never an other folder), each opening its detail; empty says how to start', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const p = (id, lastActivity, extra = {}) => ({ id, name: id.toUpperCase(), kind: 'registered', lastActivity, ...extra });
  const byProject = new Map([['b', [{ projectId: 'b', live: { status: 'busy', updatedAt: now - 1000, since: now - 5000 } }]]]);
  const list = [p('b', now - 3600e3), p('a', now - 60e3), p('c', now - 7200e3), p('d', now - 9000e3), p('tmp', now, { place: 'temp' })];
  inLanguages((lang, S) => {
    const h = todayRecentHtml(list, byProject, now);
    assert.deepEqual([...h.matchAll(/data-today-open="([a-z]+)"/g)].map((m) => m[1]), ['b', 'a', 'c'], lang);
    assert.equal((h.match(/class="tr-card /g) || []).length, RECENT_COUNT);
    assert.ok(h.includes(S.todayAllProjects) && h.includes('data-today-all'));
    const empty = todayRecentHtml([], new Map(), now);
    assert.ok(empty.includes(S.todayRecentEmpty.replace(/'/g, '&#39;')) && !empty.includes('tr-card'));
    // A project there but no work yet: the job box, never "no project yet"
    const idle = todayRecentHtml([p('new', 0)], new Map(), now);
    assert.ok(idle.includes(S.todayRecentNoWork.replace(/'/g, '&#39;')) && !idle.includes(S.todayRecentEmpty.replace(/'/g, '&#39;')), lang);
  });
  assert.ok(!todayRecentHtml([p('<x>', now)], new Map(), now).includes('<x>'), 'names are escaped');
});
