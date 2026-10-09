// One primary start on the first screen (docs/comprehensive-roadmap-tr-2026-10-07.md B4, package 2): with no project
// of the person's own, the "Got an idea?" card leads; the strip, the job row and the header's button step back.
// Run: node --test test/start-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { firstScreenParts } from '../public/js/firstScreen.js';
import { startCardHtml, hasOwnProject } from '../public/js/views/checklist.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('no project of their own: only the start card leads; with a project, the strip and the job row come back', () => {
  assert.deepEqual(firstScreenParts({ live: true, loaded: true, ownProject: false }), { strip: false, jobRow: false, headerQuiet: true, playQuiet: true });
  assert.deepEqual(firstScreenParts({ live: true, loaded: true, ownProject: true }), { strip: true, jobRow: true, headerQuiet: true, playQuiet: true }, 'with a project: Start (or the strip) leads; New project and Play are quiet (review B1)');
  // Folders found by other tools, none active lately: no card (they are the person's), nothing in the Building. The
  // strip's "create a project" is the one primary start; no job row (no project to give it to); the header is quiet
  assert.deepEqual(firstScreenParts({ live: true, loaded: true, ownProject: true, buildingProject: false }), { strip: true, jobRow: false, headerQuiet: true, playQuiet: true });
  // Not loaded yet: nothing is hidden on a guess
  assert.deepEqual(firstScreenParts({ live: true, loaded: false, ownProject: false }), { strip: true, jobRow: true, headerQuiet: true, playQuiet: true });
  // The example plays: its strip says it is an example, even with no project (its way back is there)
  assert.deepEqual(firstScreenParts({ live: false, loaded: true, ownProject: false }), { strip: true, jobRow: true, headerQuiet: true, playQuiet: false });
  // A broad folder is no project of their own (checklist.js, the same rule as the card)
  assert.equal(hasOwnProject([{ id: 'home', kind: 'adhoc', broad: true }]), false);
});

test('the start card: one primary New project, a quiet "Watch the example", the tour as a link; both languages', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const html = startCardHtml({ tools: { status: 'ready', tools: [{ installed: true }] } });
    assert.equal((html.match(/class="act-btn primary/g) || []).length, 1, `${lang}: one primary`);
    assert.ok(html.includes('data-cl="project"') && html.includes('data-cl="demo"') && html.includes('data-cl="tour"'));
    assert.ok(html.includes(STRINGS[lang].firstCardDemo));
    // The primary comes first for the keyboard
    assert.ok(html.indexOf('data-cl="project"') < html.indexOf('data-cl="demo"'));
  }
  setLanguage('en');
});

test('wiring: the Building hides its strip and job row, the header button turns quiet, the example plays from the card', () => {
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes("const parts = firstScreenParts({ live: mode === 'live', loaded: store.loaded, ownProject: hasOwnProject([...store.projects.values()]), buildingProject: mode !== 'live' || !!scene.project.id });"));
  assert.ok(ws.includes("if ($('next').hidden === parts.strip) $('next').hidden = !parts.strip;"));
  assert.ok(ws.includes('if (headRow.hidden === parts.jobRow) headRow.hidden = !parts.jobRow;'));
  assert.ok(ws.includes("$('play').classList.toggle('quiet', parts.playQuiet);"));
  // The building's guide waits until there is something to explain (it covered the one start before)
  assert.ok(ws.includes("if (guidePending && store.loaded && (mode !== 'live' || !!scene.project.id) && focusHere) {"));
  assert.ok(read('public/css/studio-pro.css').includes('.topbar .chip.new-proj.quiet{'), 'the theme does not override the quiet look');
  const main = read('public/js/main.js');
  assert.ok(main.includes("newProjectBtn.classList.toggle('quiet', firstScreenParts({ loaded: store.loaded, ownProject: hasOwnProject([...store.projects.values()]), buildingProject: projectsInOrder(store).length > 0 }).headerQuiet);"));
  assert.ok(main.includes('demo: () => workshop.playExample(),'));
  assert.ok(ws.includes("if (mode === 'demo' && playing) return;"), 'a second press does not pause the example');
  // The tour quiets the guide that waits too (it came back over the tour's first step)
  const quiet = ws.slice(ws.indexOf('    quietGuide() {'), ws.indexOf('    quietGuide() {') + 200);
  assert.ok(quiet.includes('guidePending = false;'), 'the tour clears the waiting guide');
  assert.ok(ws.includes('&& focusHere) {'), 'never takes the keyboard from a drawer or the palette');
  assert.ok(read('public/js/views/checklist.js').includes("else if (id === 'demo') actions.demo?.();"));
  assert.ok(read('public/css/start.css').includes('.new-proj.quiet {'));
});

test("main.js: a helper is defined before the code that runs at load uses it (a temporal dead zone broke the page once)", () => {
  const main = read('public/js/main.js');
  const def = main.indexOf('const leaveDrawer = ');
  assert.ok(def > 0 && def < main.indexOf('const guide = createGuide({') && def < main.indexOf('const palette = createPalette({'));
  assert.ok(main.indexOf('const drawer = createDrawer(') < def, 'and after the drawer it closes');
  // The guide's tour and tools close the drawer first, as the search's commands do (review round 2)
  for (const s of ['tour: leaveDrawer(() => tour.show())', 'tools: leaveDrawer(() => openToolsPanel())']) assert.ok(main.includes(s), s);
});

test('one primary action (review B1): the strip leads when the person is needed, else Start; never both', async () => {
  const { primaryIsNext, NEXT_PRIMARY } = await import('../public/js/firstScreen.js');
  for (const k of ['newProject', 'error', 'plan', 'result', 'waiting', 'stopped']) assert.equal(primaryIsNext(k), true, k);
  for (const k of ['give', 'working', 'running', 'demo', 'past']) assert.equal(primaryIsNext(k), false, k);
  assert.equal(primaryIsNext('waiting', false), false, 'no button: Start stays');
  assert.equal(NEXT_PRIMARY.size, 6);
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes("$('next-go').classList.toggle('primary', nextFirst);") && ws.includes("$('give-go').classList.toggle('quiet', nextFirst);"));
  const css = read('public/css/workshop.css');
  assert.ok(css.includes('.ws .ws-give button.quiet {') && css.includes('.ws-next button.primary {'));
});
