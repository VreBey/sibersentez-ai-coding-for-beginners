// Interface fixes of 2026-10-02 (a walk through every screen with the owner's real data): Settings looks for the AI
// tools itself, the catalog's standing notes are not repeated under the kind line, the waiting chip is calm with
// nobody waiting and warm again when someone waits, the side menu's shortcut keys show only on hover or focus, and the
// Building's three numbers stay out of the way until something happens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settingsHtml } from '../public/js/views/settings.js';
import { shownDescription } from '../public/js/format.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
setLanguage('en');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('Settings: while the tools are looked for it says so (not "none found"); it asks for them itself', () => {
  assert.ok(settingsHtml({ tools: [], toolsLooking: true }).includes(STRINGS.en.aiLoading));
  assert.ok(settingsHtml({ tools: [], toolsLooking: false }).includes(STRINGS.en.setToolNone));
  assert.ok(settingsHtml({ tools: [{ id: 'claude', name: 'Claude Code' }], tool: 'claude' }).includes('<option value="claude" selected>Claude Code</option>'));
  const src = read('public/js/views/settings.js');
  assert.ok(src.includes('needTools();') && src.includes("toolsLooking: st.status === 'idle' || st.status === 'loading'"));
});

test('a project\'s description: the two standing notes are not repeated; anything else is shown', () => {
  assert.equal(shownDescription('Not in the registry; found in AI tool records.'), '');
  assert.equal(shownDescription('Added in SiberSentez as a new project.'), '');
  assert.equal(shownDescription('Restoranım için sipariş sitesi'), 'Restoranım için sipariş sitesi');
  assert.equal(shownDescription('Only seen in temporary (scratchpad) folders; the real folder is not known yet.'), STRINGS.en.evProjectScratch);
  assert.ok(read('public/js/views/drawer.js').includes('shownDescription(p.description) ?') && read('public/js/views/projects.js').includes('shownDescription(p.description) ?'));
});

test('the waiting chip, the side menu keys and the Building\'s numbers', () => {
  const polish = read('public/css/polish.css');
  assert.match(polish, /\.wait-chip\.wait-chip \{[^}]*color: var\(--muted\);/s, 'calm with nobody waiting');
  assert.match(polish, /\.wait-chip\.wait-chip\.on \{[^}]*rgba\(var\(--orange-rgb\)/s, 'warm when someone waits');
  assert.match(polish, /\.side kbd \{ opacity: 0;/);
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes('data-ws="stats"') && ws.includes("$('stats').hidden = mode !== 'demo' && !active && !scene.waiting.length && !done;"));
});

// The review of 2026-10-02 (reviewer, APPROVE with advisories)
test('review: no double start while actions turn on; an open question goes with the drawer; done steps say done; the warm chip keeps its hover', () => {
  const drawer = read('public/js/views/drawer.js');
  const on = drawer.slice(drawer.indexOf("if (act === 'start-on') {"), drawer.indexOf("if (act === 'team') {"));
  assert.ok(on.includes('if (jobBusy.has(p.id)) return;') && on.includes('jobBusy.add(p.id);') && on.includes('jobBusy.delete(p.id);'));
  assert.ok(drawer.includes('startAsk.clear();'), 'cleared on close');
  assert.ok(read('public/js/views/checklist.js').includes("<span class=\"sr-only\">${esc(t('clDoneSr'))}</span></span>`)"));
  assert.match(read('public/css/polish.css'), /\.wait-chip\.wait-chip\.on:hover \{/);
});

test('a project card leaves out the empty chart and its three zeros when nothing happened; any activity shows them', async () => {
  const { quiet24 } = await import('../public/js/views/projects.js');
  const zero = { stats24: { tools: 0, tokens: 0, agents: 0 }, hourly: new Array(48).fill(0) };
  assert.equal(quiet24(zero), true);
  assert.equal(quiet24({ ...zero, stats24: { tools: 3, tokens: 0, agents: 0 } }), false);
  assert.equal(quiet24({ ...zero, hourly: [...new Array(47).fill(0), 2] }), false, 'yesterday still on the chart');
  assert.equal(quiet24({}), true);
  assert.ok(read('public/js/views/projects.js').includes("${quiet24(p) ? '' : `<div class=\"pstats\">"));
});

test('the command palette: Turkish letters folded ("is ver" finds "İş ver"), a word start beats a match inside a word, the two main moves first', async () => {
  const { lower, wordStart } = await import('../public/js/palette.js');
  setLanguage('tr');
  assert.equal(lower('İş ver · Kütüphane · Görüşü'), 'is ver · kutuphane · gorusu');
  setLanguage('en');
  assert.equal(wordStart('is ver', 'is'), true);
  assert.equal(wordStart('finish-branch', 'is'), false, 'inside a word');
  assert.equal(wordStart('data-analysis-starter', 'star'), true, 'a dash starts a word');
  const main = read('public/js/main.js');
  const cmds = main.slice(main.indexOf('commands: ['), main.indexOf('],', main.indexOf('commands: [')));
  assert.ok(cmds.indexOf("id: 'give-job'") < cmds.indexOf("id: 'guide'") && cmds.includes("id: 'new-project'"));
  assert.ok(read('public/js/palette.js').includes("icon: 'spark', boost: 3, run: c.run"));
});
