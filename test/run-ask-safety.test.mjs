// Exercise the dock's actual private askAi body with inert terminal/DOM adapters.
// No real shell is opened and no key reaches a real AI tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { aiDraftOk, aiDraftCheck, pickRunningTab, inputVisible } from '../public/js/dockState.js';
import { bindRunHint, createRunHint, setRunAsker } from '../public/js/runHint.js';
import { STRINGS, setLanguage, t } from '../public/js/i18n.js';

// The dock's own askAi with the helpers it uses (screenRows, copyDraft), from the rows the tool shows now to the end
function dockFixture(tabs, { clipboardFails = false } = {}) {
  const source = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  const start = source.indexOf('// The rows the tool shows now');
  const end = source.indexOf('// The AI tabs that still run', start);
  assert.ok(start >= 0 && end > start, 'actual dock function is available');
  const writes = [], selected = [], notices = [], copied = [];
  const ask = vm.runInNewContext(source.slice(start, end) + '\naskAi', {
    tabs, aiDraftOk, aiDraftCheck, pickRunningTab, t, collapsed: false, Promise,
    show() {}, fold() {}, select(id) { selected.push(id); },
    api: { write(id, text) { writes.push([id, text]); } },
    toast(value) { notices.push(value); },
    navigator: { clipboard: { writeText: async (text) => { if (clipboardFails) throw new Error('denied'); copied.push(text); } } },
  });
  return { ask, writes, selected, notices, copied };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
// A screen whose last rows hold the tool's input line (Claude Code's box)
const INPUT = '\n──────────\n> \n──────────\n  ? for shortcuts';
const ai = (projectId, plain = '') => ({ ai: true, projectId, plain, term: { focus() {} } });

test('actual dock: permissions block typing even after the help note was dismissed; the draft is copied for later', async () => {
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
        await settle();
        assert.deepEqual(f.copied, [STRINGS[lang].runAsk]);
        assert.equal(f.notices[0]?.body, STRINGS[lang].draftAsksCopied);
      }
    } finally { setLanguage('en'); }
  }
});

test('actual dock: only the newest live AI of this project receives the exact Unicode draft, without Enter', () => {
  const tabs = new Map([
    ['old', ai('p')], ['new', ai('p', 'How can I help?' + INPUT)],
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

// Independent review 2026-10-20, T04: a question the helper does not know (a one-key menu, another tool's layout) used
// to be typed into; now nothing is typed unless the tool's input line is seen
test('actual dock: no input line seen (an unknown menu, a redraw), no typing: the draft is copied and the toast says how to paste it', async () => {
  for (const screen of [
    'Update available! 2.2.0 -> 2.3.0\n  Update now?  y / n',
    'Working… (esc to interrupt)',
    'Some tool\n› 1. Yes, go on\n  2. No',
    '> earlier message\nPick one:\n❯ Allow once\n  Deny',
  ]) {
    const f = dockFixture(new Map([['t1', ai('p', screen)]]));
    const r = f.ask('p', STRINGS.tr.runAsk);
    assert.equal(f.writes.length, 0, screen);
    assert.equal(r.ok, true, 'the draft still reached the person');
    assert.equal(r.copied, true);
    await settle();
    assert.deepEqual(f.copied, [STRINGS.tr.runAsk], screen);
    assert.equal(f.notices[0]?.body, STRINGS.en.draftCopied);
  }
  // A clipboard that refuses: the toast holds the text itself
  const f = dockFixture(new Map([['t1', ai('p', 'Working…')]]), { clipboardFails: true });
  f.ask('p', 'Planı onaylıyorum');
  await settle();
  await settle();
  assert.ok(f.notices[0]?.body.includes('Planı onaylıyorum'));
});

test('input line: the prompt row of the box at the bottom, between rules or borders; never a menu or an earlier message', () => {
  assert.equal(inputVisible(['Claude Code', '', '╭────╮', '│ > Try "fix lint"  │', '╰────╯', '  ? for shortcuts']), true, 'a box');
  assert.equal(inputVisible(['⏺ Done.', '', '────────────────', '> ', '────────────────', '  ⏵⏵ accept edits on (shift+tab to cycle)']), true, 'Claude Code: rules above and below');
  assert.equal(inputVisible(['╭──────────╮', '│ > Type your message or @path/to/file │', '╰──────────╯', '~/site  no sandbox  gemini-2.5-pro']), true, 'Gemini CLI');
  assert.equal(inputVisible(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), false);
  assert.equal(inputVisible(['> my earlier message', 'Do it?', '❯ Yes', '  No']), false, 'a choice below the last prompt row');
  assert.equal(inputVisible(['Working… (esc to interrupt)']), false);
  assert.equal(inputVisible([]), false);
  // Review of the fix (2026-10-20): an earlier "> message" in the transcript, or a menu's pointer row, is no input line
  assert.equal(inputVisible(['> fix the login bug', '', '⏺ Done.', '', 'A new version is ready. Restart now? [y/N]']), false, 'a one-key question under a past message');
  assert.equal(inputVisible(['> fix the login bug', '⏺ Done.', 'Press a to always allow, y to allow once, n to deny']), false);
  assert.equal(inputVisible(['Settings', '❯ Auto-compact  true', '  Theme  dark']), false, 'a menu without numbers');
  assert.equal(inputVisible(['Resume a session', '❯ Fix the login bug  2 hours ago', '  Add a menu  1 day ago']), false);
  assert.equal(inputVisible(['╭────╮', '│ Select model │', '│  ❯ Sonnet (default) │', '╰────╯']), false, 'a pointer row in a box, no rule right above it');
  // A question in the status rows under the box
  assert.equal(inputVisible(['────', '> ', '────', 'Update now? [y/N]']), false);
  // Round 2: a menu's hint under a one-item box, a one-key prompt under quoted text between rules
  assert.equal(inputVisible(['╭────╮', '│ ❯ Opus │', '╰────╯', 'Enter to select · Esc to cancel']), false);
  assert.equal(inputVisible(['---', '> quoted', '---', 'Apply the patch  a: apply  s: skip']), false);
  // At most FOOTER_ROWS status rows under the box
  assert.equal(inputVisible(['────', '> ', '────', 's1', 's2', 's3', 's4']), true);
  assert.equal(inputVisible(['────', '> ', '────', 's1', 's2', 's3', 's4', 's5']), false);
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
