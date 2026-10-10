// @ts-check
// A beginner's acceptance guide (public/js/acceptGuide.js, docs/internal/acceptance-guide-plan.md): the plan's Done-when
// items to try, the person's own marks in this browser, a change draft that fits the AI tab, its place on the card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { itemKey, guideItems, readMarks, writeMark, changeDraft, acceptGuideHtml, JOBS_KEPT } from '../public/js/acceptGuide.js';
import { aiDraftOk, AI_DRAFT_MAX } from '../public/js/dockState.js';
import { jobResultHtml } from '../public/js/jobResult.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
setLanguage('en');
const S = STRINGS.en;
const J = 'J' + '0123456789abcdef'.repeat(2);
const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
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

test('marks: per project and job in this browser; pressed again clears; old jobs leave; bad stored values are ignored', () => {
  const st = fakeStorage();
  const [a, b] = guideItems(team());
  assert.equal(writeMark('p', J, a.key, 'ok', st), true);
  assert.equal(writeMark('p', J, b.key, 'no', st), true);
  assert.deepEqual(readMarks('p', J, st), { [a.key]: 'ok', [b.key]: 'no' });
  assert.deepEqual(readMarks('q', J, st), {}, 'another project');
  writeMark('p', J, a.key, null, st);
  assert.deepEqual(readMarks('p', J, st), { [b.key]: 'no' });
  assert.equal(writeMark('p', J, 'not-a-key', 'ok', st), false);
  for (let i = 0; i < JOBS_KEPT + 5; i++) writeMark('p', `J${i}`, a.key, 'ok', st);
  assert.equal(Object.keys(JSON.parse(st.getItem('sibersentez.accept'))).length, JOBS_KEPT);
  assert.deepEqual(readMarks('p', J, st), {}, 'the oldest job left');
  st.setItem('sibersentez.accept', JSON.stringify({ [`p|${J}`]: { [a.key]: 'maybe', '<b>': 'ok' } }));
  assert.deepEqual(readMarks('p', J, st), {});
  st.setItem('sibersentez.accept', '{broken');
  assert.deepEqual(readMarks('p', J, st), {});
  assert.equal(writeMark('p', J, a.key, 'ok', { getItem: () => null, setItem: () => { throw new Error('full'); } }), false, 'never throws');
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

test('wiring: the drawer passes the guide with this browser\'s marks, a mark redraws, the change goes as a draft', () => {
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('const guide = acceptGuideHtml(d, readMarks(p.id, jobId));'));
  assert.ok(drawer.includes("if (ag && current?.type === 'project') return acceptMark(current.id, ag);"));
  assert.ok(drawer.includes('const r = askAiDraft(projectId, text);\n    if (r?.ok || r?.reason === \'asks\') return;\n    fillJob(projectId, text);'), 'never Enter: a draft, else the job box');
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
