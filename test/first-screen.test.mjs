// A simpler first screen (docs/direction.md §3.3): the one big start, the building by state, the advanced views behind
// one switch, fewer header items, the guide only when asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heroFoldedFor, reconnectDelay } from '../public/js/layout.js';
import { startCardHtml, hasOwnProject } from '../public/js/views/checklist.js';
import { settingsHtml } from '../public/js/views/settings.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';
import { esc } from '../public/js/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the layout helper of the old fold still answers; the Building screen is the workshop itself, the orchestra scene sits on the Feed (docs/simplify.md)', () => {
  assert.equal(heroFoldedFor({}), true);
  assert.equal(heroFoldedFor({ openSessions: 0 }), true);
  assert.equal(heroFoldedFor({ openSessions: 2 }), false);
  assert.equal(heroFoldedFor({ stored: 'small', openSessions: 3 }), true);
  assert.equal(heroFoldedFor({ stored: 'large', openSessions: 0 }), false);
  assert.equal(heroFoldedFor({ stored: 'garbage', openSessions: 1 }), false);
  const html = read('public', 'index.html');
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="tab-projects"'));
  assert.ok(today.includes('id="workshopBody"') && !today.includes('id="hero"'), 'the Building holds the workshop');
  const feed = html.slice(html.indexOf('id="tab-feed"'), html.indexOf('id="tab-timeline"'));
  assert.ok(feed.includes('<section class="hero adv-only" id="hero"'), 'the orchestra scene: an advanced view on the Feed');
  assert.ok(!read('public', 'js', 'main.js').includes('followHero'), 'no fold any more');
});

test('the one big start: while there is no project of their own, Today shows "Got an idea?" with one primary button and a link to the tour', () => {
  setLanguage('tr');
  const S = STRINGS.tr;
  const html = startCardHtml({ tools: { status: 'ready', tools: [{ installed: true }] } });
  assert.ok(html.includes(esc(S.firstCardTitle)) && html.includes(esc(S.firstCardBody)));
  assert.equal((html.match(/class="act-btn primary/g) || []).length, 1, 'one primary button');
  assert.match(html, /<section class="first-card" aria-labelledby="firstCardH">/, 'its own class and id: the Projects page has a start-card of its own');
  assert.doesNotMatch(html, /start-card|startCardH/);
  assert.match(html, /data-cl="project"[^>]*>.*Yeni proje oluştur/);
  assert.match(html, /data-cl="tour"/, 'the tour link opens the tour (review U12)');
  assert.doesNotMatch(html, /data-cl="tool"/, 'a tool was found: no tool button');
  assert.match(startCardHtml({ tools: { status: 'ready', tools: [] } }), /data-cl="tool"/, 'no tool yet: its button too');
  assert.doesNotMatch(startCardHtml({ tools: { status: 'loading', tools: [] } }), /data-cl="tool"/, 'still looking: no button yet');
  assert.equal(hasOwnProject([]), false);
  assert.equal(hasOwnProject([{ id: 'home', kind: 'adhoc', broad: true }, { id: 'tmp', kind: 'adhoc', place: 'temp' }]), false, 'a broad or temporary folder is not a project of their own');
  assert.equal(hasOwnProject([{ id: 'p', path: 'C:\\p' }]), true);
  for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('firstCard') || x.startsWith('setAdvanced'))) assert.ok(STRINGS.tr[k], `tr ${k}`);
  const cl = read('public', 'js', 'views', 'checklist.js');
  assert.ok(cl.includes('if (!hasOwnProject([...store.projects.values()])) {'), 'the start card comes before the list, hidden or not');
  setLanguage('en');
});

test('advanced views: one switch in Settings, off by default; off hides the Feed numbers, the timeline switch, the orchestra scene, the clock, the drawer tiles and the most used charts', () => {
  setLanguage('en');
  const off = settingsHtml({});
  assert.match(off, /data-set-advanced data-fk="set:advanced" aria-label="Advanced views">/, 'unchecked by default');
  assert.match(settingsHtml({ advanced: true }), /data-set-advanced data-fk="set:advanced" aria-label="Advanced views" checked>/);
  assert.match(off, /data-set-cost data-fk="set:cost" aria-label="[^"]*">/, 'dollars off by default');
  const html = read('public', 'index.html');
  assert.match(html, /class="kpis adv-only" id="kpis"/);
  assert.equal((html.match(/class="seg feed-switch adv-only"/g) || []).length, 2, 'the Feed and the Timeline switch');
  assert.match(html, /<time class="clock adv-only" id="clock">/);
  assert.match(html, /<section class="hero adv-only" id="hero"/, 'the orchestra scene');
  assert.ok(read('public', 'js', 'views', 'drawer.js').includes('<div class="dr-tiles adv-only"'));
  assert.ok(read('public', 'js', 'views', 'roster.js').includes('<div class="leaders adv-only" data-k="leaders">'));
  assert.ok(read('public', 'css', 'app.css').includes('body:not(.adv) .adv-only { display: none !important; }'));
  const main = read('public', 'js', 'main.js');
  assert.ok(main.includes("if (active === 'timeline') showTab('feed');"), 'turned off: back to the feed');
  // Fewer header items: no "0 open sessions" chip
  assert.ok(main.includes("${k.live || k.busy ? '' : ' none'}"));
  assert.ok(read('public', 'css', 'app.css').includes('.status-chips .chip.none { display: none; }'));
});

test('a closed live stream is opened again after a growing pause (a plain browser stayed frozen)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9, -1, 1.5].map(reconnectDelay), [1000, 2000, 5000, 10000, 30000, 30000, 1000, 1000]);
  const main = read('public', 'js', 'main.js');
  assert.ok(main.includes('if (es.readyState === 2) {') && main.includes('setTimeout(connect, reconnectDelay(streamRetries++));'));
  assert.ok(main.includes('streamRetries = 0;'), 'a hello starts the count again');
});

test('licence: the installer carries the licence text and the third-party notices; Settings says where they are and where the source is', async () => {
  const pkg = JSON.parse(read('package.json'));
  const extra = pkg.build.extraResources.map((x) => `${x.from}->${x.to}`);
  assert.ok(extra.includes('LICENSE->LICENSE.txt') && extra.includes('THIRD_PARTY_NOTICES.md->THIRD_PARTY_NOTICES.md'));
  const { noticesText } = await import('../build/make-notices.mjs');
  assert.equal(read('THIRD_PARTY_NOTICES.md').replace(/\r\n/g, '\n').trim(), noticesText().trim(), 'the notices are up to date (node build/make-notices.mjs)');
  for (const who of ['Christopher Jeffrey', 'Ryan Prichard', 'Microsoft Corporation', 'The xterm.js authors']) assert.ok(noticesText().includes(who), who);
  const { settingsHtml, SOURCE_URL } = await import('../public/js/views/settings.js');
  setLanguage('tr');
  const html = settingsHtml({});
  assert.ok(html.includes(esc(STRINGS.tr.setLicenseTitle)) && html.includes(SOURCE_URL));
  setLanguage('en');
});

test('settings: a support row links to GitHub Sponsors, opened in the browser (a link, never a page inside the app); the repository has its Sponsor button', async () => {
  const { settingsHtml, SPONSOR_URL } = await import('../public/js/views/settings.js');
  assert.equal(SPONSOR_URL, 'https://sibersentez.com/destek', "the product's address (it forwards to GitHub Sponsors); no personal account in the app");
  setLanguage('tr');
  const html = settingsHtml({});
  assert.ok(html.includes(esc(STRINGS.tr.setSupportTitle)), 'the row in Turkish');
  assert.ok(html.includes(`href="${SPONSOR_URL}" target="_blank" rel="noopener noreferrer"`), 'a new window: the shell opens it in the default browser');
  setLanguage('en');
  for (const lang of ['en', 'tr']) for (const k of ['setSupportTitle', 'setSupportText', 'setSupportOpen']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  const funding = fs.readFileSync(new URL('../.github/FUNDING.yml', import.meta.url), 'utf8');
  assert.match(funding, /^github: \[VreBey\]$/m);
  const { icon } = await import('../public/js/icons.js');
  assert.match(icon('heart'), /<path/);
});
