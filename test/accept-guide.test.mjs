// @ts-check
// A beginner's acceptance guide (public/js/acceptGuide.js, docs/internal/acceptance-guide-plan.md): the plan's Done-when
// items to try, the person's own marks (kept with the job in the hub), a change draft that fits the AI tab, its place on the card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { itemKey, guideItems, legacyMarks, createMarks, changeDraft, acceptGuideHtml } from '../public/js/acceptGuide.js';
import { aiDraftOk, AI_DRAFT_MAX } from '../public/js/dockState.js';
import { jobResultHtml } from '../public/js/jobResult.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
setLanguage('en');
const S = STRINGS.en;
const J = 'J' + '0123456789abcdef'.repeat(2);
const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};
const team = (step = 'finish', doneWhen = ['The menu page opens', 'npm test passes']) => ({ step, plan: { title: 'Menu', jobId: J, doneWhen }, review: { verdict: 'APPROVE', blockers: 0, nits: 0 } });

test('items: the plan\'s Done-when list, keyed by their text; without one, a general item', () => {
  assert.equal(itemKey('a'), itemKey('a'));
  assert.notEqual(itemKey('a'), itemKey('b'));
  assert.match(itemKey('ğüşı 😀'), /^[0-9a-f]{8}$/);
  assert.deepEqual(guideItems(team()).map((x) => x.text), ['The menu page opens', 'npm test passes']);
  const general = guideItems(team('finish', []));
  assert.deepEqual([general.length, general[0].text, general[0].general], [1, S.agGeneral, true]);
});

// A world for createMarks: the sent bodies, the timers to run by hand, the answer of the action client
function marksWorld({ mode = 'live', answer = (_b) => ({ ok: true, result: { executed: true }, tried: { at: 9000 } }), storage = fakeStorage() } = {}) {
  const sent = [];
  const timers = [];
  const redraws = [];
  const marks = createMarks({ send: async (b) => (sent.push(b), answer(b)), mode: () => mode, onChange: (p) => redraws.push(p), storage, now: () => 1234, wait: (fn, ms) => (timers.push({ fn, ms }), timers.length) });
  const run = async () => {
    const list = timers.splice(0);
    for (const x of list) await x.fn();
  };
  return { marks, sent, timers, redraws, run, storage };
}

test('marks: kept with the job in the hub (actions On), the whole set a moment after the last click; this window only otherwise', async () => {
  const items = guideItems(team());
  const [a, b] = items;
  const w = marksWorld();
  // The record still asked: no mark is taken (a set made from nothing would overwrite the hub's)
  assert.deepEqual(w.marks.view('p', J, undefined, items), { marks: {}, state: 'loading', at: null });
  assert.equal(w.marks.mark('p', J, a.key, 'ok', items, undefined), false);
  assert.equal(w.timers.length, 0);
  assert.match(acceptGuideHtml(team(), {}, { state: 'loading' }), /aria-pressed="false" disabled/);
  assert.match(acceptGuideHtml(team(), {}, { state: 'loading' }), /Reading the marks kept with this job/);
  assert.match(acceptGuideHtml(team(), {}, { state: 'unread' }), /could not be read just now/);
  assert.match(acceptGuideHtml(team(), {}, { state: 'unread' }), /aria-pressed="false" disabled/);
  assert.equal(w.marks.mark('p', J, a.key, 'ok', items, null), true);
  assert.equal(w.marks.mark('p', J, b.key, 'no', items, null), true);
  assert.equal(w.marks.view('p', J, null, items).state, 'saving');
  await w.run();
  assert.equal(w.sent.length, 1, 'only the newest set went out');
  assert.deepEqual(w.sent[0], { action: 'accept-marks', projectId: 'p', jobId: J, marks: { [a.key]: 'ok', [b.key]: 'no' }, itemKeys: [a.key, b.key] });
  assert.deepEqual(w.marks.view('p', J, null, items), { marks: { [a.key]: 'ok', [b.key]: 'no' }, state: 'hub', at: 9000 });
  assert.deepEqual(w.redraws, ['p']);
  // Pressed again: cleared; a key not on the list is refused
  w.marks.mark('p', J, a.key, null, items, null);
  assert.equal(w.marks.mark('p', J, 'ffffffff', 'ok', items, null), false);
  await w.run();
  assert.deepEqual(w.sent[1].marks, { [b.key]: 'no' });
  // From the hub's record when this window holds none
  const fresh = marksWorld();
  assert.deepEqual(fresh.marks.view('p', J, { marks: { [a.key]: 'ok' }, items: [a.key], at: 77 }, items), { marks: { [a.key]: 'ok' }, state: 'hub', at: 77 });
  // Not On: kept in this browser, nothing sent
  const off = marksWorld({ mode: 'dry' });
  off.marks.mark('p', J, a.key, 'ok', items, null);
  assert.deepEqual([off.timers.length, off.marks.view('p', J, null, items).state], [0, 'window']);
  assert.deepEqual(legacyMarks('p', J, off.storage), { [a.key]: 'ok' }, 'a reload shows them again');
  assert.deepEqual(marksWorld({ mode: 'dry', storage: off.storage }).marks.view('p', J, undefined, items), { marks: { [a.key]: 'ok' }, state: 'window', at: null });
});

test('marks: sent again after the repeat guard; a refusal holds them in this window and says so', async () => {
  const items = guideItems(team());
  let n = 0;
  const w = marksWorld({ answer: () => (n++ === 0 ? { ok: false, status: 429, error: 'repeat' } : { ok: true, result: { executed: true }, tried: { at: 5 } }) });
  w.marks.mark('p', J, items[0].key, 'ok', items, null);
  await w.run();
  assert.deepEqual([w.sent.length, w.timers[0]?.ms], [1, 3200]);
  await w.run();
  assert.deepEqual([w.sent.length, w.marks.view('p', J, null, items).state], [2, 'hub']);
  const bad = marksWorld({ answer: () => ({ ok: false, status: 500, error: 'record-write-failed' }) });
  bad.marks.mark('p', J, items[0].key, 'ok', items, null);
  await bad.run();
  assert.deepEqual(bad.marks.view('p', J, null, items), { marks: { [items[0].key]: 'ok' }, state: 'failed', at: null });
  const thrown = marksWorld({ answer: () => { throw new Error('down'); } });
  thrown.marks.mark('p', J, items[0].key, 'ok', items, null);
  await thrown.run();
  assert.equal(thrown.marks.view('p', J, null, items).state, 'failed');
});

test('marks of an earlier version in this browser: moved into the hub once the record holds none, then removed here', async () => {
  const items = guideItems(team());
  const st = fakeStorage();
  st.setItem('sibersentez.accept', JSON.stringify({ [`p|${J}`]: { [items[0].key]: 'ok', '<b>': 'ok' }, 'p|J2': { [items[0].key]: 'no' } }));
  assert.deepEqual(legacyMarks('p', J, st), { [items[0].key]: 'ok' }, 'bad stored values are ignored');
  const w = marksWorld({ storage: st });
  // The record still asked: shown, not moved yet
  assert.deepEqual(w.marks.view('p', J, undefined, items), { marks: { [items[0].key]: 'ok' }, state: 'loading', at: null });
  assert.equal(w.timers.length, 0);
  assert.equal(w.marks.view('p', J, null, items).state, 'saving');
  await w.run();
  assert.deepEqual(w.sent[0].marks, { [items[0].key]: 'ok' });
  assert.deepEqual(JSON.parse(st.getItem('sibersentez.accept')), { 'p|J2': { [items[0].key]: 'no' } }, 'only this job entry left the browser');
  st.setItem('sibersentez.accept', '{broken');
  assert.deepEqual(legacyMarks('p', J, st), {});
});

test('the change draft: only "Not as asked" items, cut to fit the AI tab\'s draft check', () => {
  const items = guideItems(team('finish', ['first thing', 'second thing', 'third']));
  const marks = { [items[0].key]: 'no', [items[1].key]: 'ok', [items[2].key]: 'no' };
  assert.equal(changeDraft(items, marks), 'When I tried the result, these did not work as I asked: first thing; third. Please fix them.');
  assert.equal(changeDraft(items, {}), '');
  const long = guideItems(team('finish', Array.from({ length: 12 }, (_, i) => `item ${i} ${'😀x'.repeat(40)}`)));
  const all = Object.fromEntries(long.map((x) => [x.key, 'no']));
  const d = changeDraft(long, all);
  assert.ok(d.length <= AI_DRAFT_MAX && aiDraftOk(d), `${d.length}`);
  assert.match(d, /…\. Please fix them\.$/);
  const general = guideItems(team('finish', []));
  assert.equal(changeDraft(general, { [general[0].key]: 'no' }), S.agChangeGeneral);
});

test('the guide on the card: rows with pressed states, how many were tried, the change button; before Accept, and after the checks once accepted', () => {
  const items = guideItems(team());
  assert.equal(acceptGuideHtml({ step: 'build' }, {}), '', 'not before the result');
  const none = acceptGuideHtml(team(), {});
  assert.match(none, /Try it yourself/);
  assert.match(none, /0 of 2 tried\. Not tried yet: 2\. You can still accept\./);
  assert.equal((none.match(/aria-pressed="false"/g) || []).length, 4);
  assert.doesNotMatch(none, /data-ag-act="change"/);
  const marked = acceptGuideHtml(team(), { [items[0].key]: 'ok', [items[1].key]: 'no' });
  assert.match(marked, /data-ag="ok" data-ag-key="[0-9a-f]{8}" aria-pressed="true"/);
  assert.match(marked, /2 of 2 tried\./);
  assert.match(marked, /data-ag-act="change"/);
  assert.match(acceptGuideHtml(team(), { [items[0].key]: 'ok', [items[1].key]: 'ok' }), /All tried, and they worked as you saw them\./);
  assert.doesNotMatch(acceptGuideHtml(team('finish', ['<img src=x>']), {}), /<img/, 'the plan\'s words are text');
  assert.doesNotMatch(acceptGuideHtml(team('done'), {}), /You can still accept/, 'accepted: no nudge');
  // On the card: before the actions while the result waits; after the checks once accepted
  const g = acceptGuideHtml(team(), {});
  const finish = jobResultHtml({ team: team(), changes: { basis: 'no-record' }, guide: g });
  assert.ok(finish.indexOf('class="ag"') > 0 && finish.indexOf('class="ag"') < finish.indexOf('jr-acts'));
  const done = jobResultHtml({ team: team('done'), changes: { basis: 'no-record' }, guide: acceptGuideHtml(team('done'), {}) });
  assert.ok(done.indexOf('class="ag"') > done.indexOf('jr-checks'));
  setLanguage('tr');
  try {
    assert.match(acceptGuideHtml(team(), {}), /Kendin dene.*2 maddeden 0 tanesi denendi\. Henüz denenmeyen: 2\. Yine de kabul edebilirsin\..*İstediğim gibi değil/s);
  } finally {
    setLanguage('en');
  }
});

test('wiring: the drawer passes the guide with the marks kept with the job, a mark goes to the hub, the change goes as a draft', () => {
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('const acceptMarks = createMarks({ send: runAction, mode: () => actionsState().mode'));
  assert.ok(drawer.includes('const guide = acceptGuideHtml(d, marks.marks, { ...marks, state, triedFresh: answer?.triedFresh, listChanged });'));
  assert.ok(drawer.includes("const state = marks.state === 'loading' && failed ? 'unread' : marks.state;"));
  assert.ok(drawer.includes("if (ag && current?.type === 'project') return acceptMark(current.id, ag);"));
  assert.ok(drawer.includes('acceptMarks.mark(projectId, jobId, key, value, guideItems(d), triedOf(projectId, jobId).tried);'));
  assert.ok(drawer.includes("const r = askAiDraft(projectId, text);\n    if (r?.ok || r?.reason === 'asks') return;\n    fillJob(projectId, text);"), 'never Enter: a draft, else the job box');
});

test('where the marks are kept, in one line; files written after the last mark and a changed list are said', () => {
  const items = guideItems(team());
  const one = { [items[0].key]: 'ok' };
  assert.match(acceptGuideHtml(team(), {}, { state: 'none' }), /SiberSentez keeps your marks with this job/);
  assert.match(acceptGuideHtml(team(), one, { state: 'hub', at: Date.UTC(2026, 9, 16, 12) }), /Your marks are kept with this job in SiberSentez \(last mark /);
  assert.match(acceptGuideHtml(team(), one, { state: 'saving' }), /Keeping your marks…/);
  assert.match(acceptGuideHtml(team(), one, { state: 'window' }), /kept in this browser only/);
  assert.match(acceptGuideHtml(team(), one, { state: 'failed' }), /could not be kept/);
  const stale = acceptGuideHtml(team(), one, { state: 'hub', at: 1, triedFresh: 'changed', listChanged: true });
  assert.match(stale, /class="small ag-stale">Files were written after your last mark: try again what matters to you\. The plan’s list changed after your marks\.</);
  assert.doesNotMatch(acceptGuideHtml(team(), one, { state: 'window', triedFresh: 'changed' }), /ag-stale/, 'only of marks the hub keeps');
});

test('review notes: a plan without a Job-ID shows the list without buttons; each button group is named by its item', () => {
  const legacy = { step: 'finish', plan: { title: 'x', jobId: null, doneWhen: ['It opens'] } };
  const html = acceptGuideHtml(legacy, {});
  assert.match(html, /It opens/);
  assert.doesNotMatch(html, /data-ag=/, 'no button that would do nothing');
  assert.doesNotMatch(html, /tried|You can still accept/);
  const withId = acceptGuideHtml(team(), {});
  const key = guideItems(team())[0].key;
  assert.ok(withId.includes(`id="agt-${key}"`) && withId.includes(`aria-labelledby="agt-${key}"`));
  assert.doesNotMatch(withId, /role="group" aria-label="The menu page opens"/, 'the text is not read twice');
});

test('marks: a click while the record\'s last look failed builds on the marks the hub was last known to hold, never on nothing (review of 2026-10-16)', async () => {
  const items = guideItems(team());
  const [a, b] = items;
  const w = marksWorld();
  const hub = { marks: { [a.key]: 'ok' }, items: [a.key, b.key], at: 50 };
  assert.equal(w.marks.view('p', J, hub, items).state, 'hub');
  // The next look failed (the drawer passes undefined): the last known record stands in
  assert.deepEqual(w.marks.view('p', J, undefined, items), { marks: { [a.key]: 'ok' }, state: 'hub', at: 50 });
  assert.equal(w.marks.mark('p', J, b.key, 'no', items, undefined), true);
  await w.run();
  assert.deepEqual(w.sent[0].marks, { [a.key]: 'ok', [b.key]: 'no' }, 'the hub\'s mark kept');
});
