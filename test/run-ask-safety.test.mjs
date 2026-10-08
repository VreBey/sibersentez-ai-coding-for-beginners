// Exercise the dock's actual private askAi body with inert terminal/DOM adapters.
// No real shell is opened and no key reaches a real AI tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { aiDraftOk, aiDraftCheck, pickRunningTab } from '../public/js/dockState.js';
import { bindRunHint, createRunHint, setRunAsker } from '../public/js/runHint.js';
import { STRINGS, setLanguage, t } from '../public/js/i18n.js';

function dockFixture(tabs) {
  const source = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  const start = source.indexOf('function askAi(');
  const end = source.indexOf('// The AI tabs that still run', start);
  assert.ok(start >= 0 && end > start, 'actual dock function is available');
  const writes = [], selected = [], notices = [];
  const ask = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
    tabs, aiDraftOk, aiDraftCheck, pickRunningTab, t, collapsed: false,
    show() {}, fold() {}, select(id) { selected.push(id); },
    api: { write(id, text) { writes.push([id, text]); } },
    toast(value) { notices.push(value); },
  });
  return { ask, writes, selected, notices };
}
const ai = (projectId, plain = '') => ({ ai: true, projectId, plain, term: { focus() {} } });

test('actual dock: permissions block typing even after the help note was dismissed', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    try {
      for (const screen of [
        'Would you like to run the following command?\n$ npm start\n(y) Yes (a) Always',
        'Do you trust the files in this folder?',
        'Would you like to make the following edits?',
        'Ready to code?\nNo, keep planning',
        'Select login method',
      ]) {
        const x = { ...ai('p', screen), help: null, answered: 'dismissed' };
        const f = dockFixture(new Map([['t1', x]]));
        const result = f.ask('p', STRINGS[lang].runAsk);
        assert.equal(f.writes.length, 0, 'AI permission screens must receive no draft');
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'asks');
        assert.deepEqual(f.selected, ['t1']);
        assert.equal(f.notices[0]?.body, STRINGS[lang].runAskFirst);
        assert.ok(STRINGS[lang].runAskFirst);
      }
    } finally { setLanguage('en'); }
  }
});

test('actual dock: only the newest live AI of this project receives the exact Unicode draft, without Enter', () => {
  const tabs = new Map([
    ['old', ai('p')], ['new', ai('p', 'How can I help?')],
    ['other', ai('other')], ['shell', { ...ai('p'), ai: false }],
    ['done', { ...ai('p'), toolEnded: true }], ['closed', { ...ai('p'), ended: true }],
  ]);
  const f = dockFixture(tabs);
  assert.equal(f.ask('p', STRINGS.tr.runAsk).ok, true);
  assert.deepEqual(f.writes, [['new', STRINGS.tr.runAsk]]);
  assert.equal(f.ask('absent', STRINGS.en.runAsk).reason, 'no-ai');
  assert.equal(f.ask('p', 'hello\r').reason, 'bad-text');
  assert.equal(f.writes.length, 1);
});

test('a pending AI question stays in its terminal instead of filling a new job', () => {
  const jobs = [];
  let click;
  setRunAsker(() => ({ ok: false, reason: 'asks' }), () => true);
  try {
    bindRunHint({ addEventListener(type, fn) { if (type === 'click') click = fn; } }, {
      projectOf: () => 'p', asJob(...args) { jobs.push(args); },
    });
    const button = { hasAttribute: a => a === 'data-run-ask', closest: () => button };
    click({ target: button });
    assert.deepEqual(jobs, [], 'a pending question must not become a second job');
  } finally { setRunAsker(null, null); }
});

test('the real run-hint controller uses the project AI availability when drawing the button', async () => {
  let running = true;
  const checked = [];
  setRunAsker(() => ({ ok: true }), id => { checked.push(id); return running; });
  try {
    let ready;
    const received = new Promise(resolve => { ready = resolve; });
    const hint = createRunHint({ fetchJson: async () => ({ state: 'unknown', plans: [] }), onData: ready });
    const p = { id: 'p', path: 'C:/demo' };
    hint.get(p.id);
    await received;
    assert.match(hint.html(p), /data-run-ask/);
    running = false;
    const stopped = hint.html(p);
    assert.doesNotMatch(stopped, /data-run-ask/);
    assert.match(stopped, /data-run-job/);
    assert.deepEqual(checked, ['p', 'p']);
  } finally { setRunAsker(null, null); }
});
