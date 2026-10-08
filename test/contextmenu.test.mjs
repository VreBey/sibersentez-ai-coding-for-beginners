// Tests for the context menu model (pure), the roster model (sources, filtering, hub state), UI text
// and the action client. No DOM needed. All fixtures are neutral examples; expected UI strings are the
// English labels (the page's default language); other languages are checked through the string tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { menuModel, fitMenu, nextIndex, resultToast, errorText, skillErrorText, latestSession, previewValid, suggestable, installTargets, itemInstallView, runMenuItem, MENU_ACTIONS } from '../public/js/contextmenu.js';
import { initActions, actionsState, runAction, actionBody, argvSummary, onActionsChange, _resetActionsForTest, ACTION_NAMES, ACTION_FIELDS } from '../public/js/actions.js';
import { SOURCE, SOURCE_ORDER, SOURCE_HINT, sourceLabel, sourcesOf, everywhere, matchesFilter, sourceCounts, sourceOptions, libraryState, accessText, normalizeSource, isSourceKey, isLibraryItem } from '../public/js/rosterModel.js';
import { SOURCE as FORMAT_SOURCE, sourceLabel as formatSourceLabel } from '../public/js/format.js';
import { STRINGS as PAGE_STRINGS, setLanguage } from '../public/js/i18n.js';
import { projectPickerHtml } from '../public/js/views/drawer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Runs fn in each page language (the new menu strings come from i18n.js); the default language is restored after
function inLanguages(fn) {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      fn(lang, PAGE_STRINGS[lang]);
    }
  } finally {
    setLanguage('en');
  }
}
// Banned names are built from pieces so a repo-wide name search does not flag this file
const re = (...parts) => new RegExp(parts.join(''), 'i');
const OLD_HUB = re('Y.NE', 'T.M'); // old hub name (Turkish capitals)
const OLD_HUB_ASCII = re('yone', 'tim');
const PERSON = re('Vre', 'Bey');
const OLD_CORE = re('[cç]ekir', 'dek'); // the old hub's privileged "core" category
const OLD_SCRIPTS = [re('kayit', '-ekle'), re('paket', '-kur'), re('otomasyon', '\\\\'), re('Kayda', ' ekle')];

const S_OLD = '11111111-2222-4333-8444-555555555551';
const S_LIVE = '11111111-2222-4333-8444-555555555552';
const S_ADHOC = '11111111-2222-4333-8444-555555555553';
const S_NOCWD = '11111111-2222-4333-8444-555555555554';
const S_EMPTY_OLD = '11111111-2222-4333-8444-555555555555';
const ALPHA_PATH = 'D:\\Work\\alpha app'; // contains a space on purpose (quoting rules)

// Sample data in the store's shape (Maps + roster array)
function data() {
  const projects = new Map(
    [
      { id: 'alpha', name: 'Alpha App', kind: 'registered', path: ALPHA_PATH, exists: true, broad: false, packages: ['ext-kit', 'web-ui', 'design'] },
      { id: 'beta', name: 'Beta', kind: 'registered', path: 'C:\\work\\beta', exists: true, broad: false, packages: ['ext-kit', 'ext-plugin'] },
      { id: 'scratch', name: 'scratch', kind: 'adhoc', path: 'C:\\Users\\example\\scratch', exists: true, broad: false, packages: [] },
      { id: 'home', name: 'example', kind: 'adhoc', path: 'C:\\Users\\example', exists: true, broad: true, packages: [] },
      { id: 'empty', name: 'Empty Project', kind: 'registered', path: 'C:\\work\\empty', exists: true, broad: false, packages: ['web-ui'] },
      { id: 'no-packages', name: 'No Packages', kind: 'registered', path: 'C:\\work\\no-packages', exists: true, broad: false, packages: [] },
      { id: 'missing', name: 'Missing', kind: 'registered', path: 'C:\\work\\missing', exists: false, broad: false, packages: ['web-ui'] },
      // Fixed hub project that older servers added (current servers do not): the menu must still work
      { id: 'legacy-hub', name: 'Legacy hub', kind: 'hub', path: 'C:\\Users\\example\\Hub', exists: true, broad: false, packages: [] },
    ].map((p) => [p.id, p]),
  );
  const sessions = new Map(
    [
      { id: S_OLD, projectId: 'alpha', title: 'Old task', lastAt: 1000, cwd: ALPHA_PATH, live: null },
      { id: S_LIVE, projectId: 'alpha', title: 'Add menu', lastAt: 2000, cwd: ALPHA_PATH, live: { status: 'busy', since: 2100 } },
      { id: S_ADHOC, projectId: 'scratch', title: 'Adhoc', lastAt: 1500, cwd: 'C:\\Users\\example\\scratch', live: null },
      { id: S_NOCWD, projectId: 'legacy-hub', title: 'No folder', lastAt: 1200, cwd: null, live: null },
      { id: S_EMPTY_OLD, projectId: 'no-packages', title: 'Closed last session', lastAt: 900, cwd: 'C:\\work\\no-packages', live: null },
    ].map((s) => [s.id, s]),
  );
  const agents = new Map([
    ['ag-1', { id: 'ag-1', type: 'Explore', label: 'Search', projectId: 'alpha', sessionId: S_LIVE, status: 'running' }],
    ['ag-2', { id: 'ag-2', type: 'Plan', label: 'Plan', projectId: 'scratch', sessionId: S_ADHOC, status: 'done' }],
    ['ag-3', { id: 'ag-3', type: 'Plan', label: 'Orphan', projectId: 'scratch', sessionId: 'unknown-session', status: 'done' }],
  ]);
  const roster = [
    { id: 'agent:frontend-dev', kind: 'agent', name: 'frontend-dev', source: 'library', category: 'web-ui', installedIn: ['alpha'] },
    { id: 'skill:a11y-audit', kind: 'skill', name: 'a11y-audit', source: 'library', category: 'web-ui', installedIn: [] },
    { id: 'skill:my-skill', kind: 'skill', name: 'my-skill', source: 'personal', sources: ['personal'], category: 'personal', installedIn: [] },
    { id: 'plugin:gh-tools', kind: 'plugin', name: 'gh-tools', source: 'plugin', sources: ['plugin'], category: 'marketplace', enabled: true, installedIn: [] },
    { id: 'skill:Bad Name', kind: 'skill', name: 'Bad Name', source: 'library', category: 'web-ui', installedIn: [] },
    { id: 'skill:ui-kit', kind: 'skill', name: 'ui-kit', source: 'library', category: 'design', installedIn: [] },
    { id: 'skill:local-skill', kind: 'skill', name: 'local-skill', source: 'project', category: 'project', installedIn: ['alpha'] },
  ];
  return { projects, sessions, agents, roster };
}

const TARGETS = [
  { type: 'project', id: 'alpha' },
  { type: 'project', id: 'scratch' },
  { type: 'project', id: 'home' },
  { type: 'project', id: 'empty' },
  { type: 'project', id: 'legacy-hub' },
  { type: 'session', id: S_LIVE },
  { type: 'session', id: S_OLD },
  { type: 'agent', id: 'ag-1' },
  { type: 'roster', id: 'agent:frontend-dev' },
  { type: 'roster', id: 'skill:my-skill' },
];

const ids = (m) => m.filter((x) => !x.header && !x.sep).map((x) => x.id);
const byId = (m, id) => m.find((x) => x.id === id);
const actionItems = (m) => m.filter((x) => x.action);
const flowItems = (m) => m.filter((x) => x.flow);

test('menu: actions off → no action item for any target; header note "Actions are off"; client-only items remain', () => {
  const d = data();
  for (const t of TARGETS) {
    const m = menuModel(t, d, 'off');
    assert.equal(actionItems(m).length, 0, `${t.type}:${t.id} produced an action while off`);
    assert.equal(flowItems(m).length, 0, `${t.type}:${t.id} produced a skill-flow item while off`);
    assert.equal(m[0].header, true);
    assert.equal(m[0].note, PAGE_STRINGS.en.shCmOffNote);
    assert.equal(m[0].badge, undefined);
    assert.ok(byId(m, 'open'), '"Open details" is always there');
  }
  assert.deepEqual(ids(menuModel({ type: 'project', id: 'alpha' }, d, 'off')), ['copy-path', 'hide', 'open']);
  assert.deepEqual(ids(menuModel({ type: 'session', id: S_LIVE }, d, 'off')), ['copy-id', 'open']);
  // An unknown mode counts as off
  assert.equal(actionItems(menuModel({ type: 'project', id: 'alpha' }, d, 'unknown')).length, 0);
  assert.equal(actionItems(menuModel({ type: 'project', id: 'alpha' }, d)).length, 0);
});

test('menu: project menu in contract order (terminal · continue · sep · folder · VS Code · sep · suggested skills · sep · copy · hide · details)', () => {
  const m = menuModel({ type: 'project', id: 'alpha' }, data(), 'live');
  assert.deepEqual(ids(m), ['terminal', 'fork', 'explorer', 'vscode', 'skills', 'copy-path', 'hide', 'open']);
  const seq = m.map((x) => (x.sep ? '|' : x.header ? 'H' : x.id)).join(' ');
  assert.equal(seq, 'H terminal fork | explorer vscode | skills | copy-path hide open');
  assert.equal(byId(m, 'new'), undefined, 'no "new Claude session" item: the terminal replaces it');
  assert.equal(byId(m, 'terminal').action, 'terminal');
  assert.deepEqual(byId(m, 'terminal').payload, { projectId: 'alpha' });
  assert.deepEqual(byId(m, 'explorer').payload, { projectId: 'alpha' });
  assert.equal(byId(m, 'vscode').action, 'vscode');
  assert.equal(byId(m, 'copy-path').copy, ALPHA_PATH);
  assert.deepEqual(byId(m, 'open').open, { type: 'project', id: 'alpha' });
});

test('menu: "Open terminal" on the project menu and "Open terminal here" on the session menu (both languages); the menu never sends "new"', () => {
  const d = data();
  inLanguages((lang, S) => {
    const p = byId(menuModel({ type: 'project', id: 'alpha' }, d, 'live'), 'terminal');
    assert.equal(p.label, S.termOpen, lang);
    assert.equal(p.hint, S.termOpenHint, lang);
    assert.equal(p.icon, 'terminal');
    assert.equal(p.name, 'Alpha App', 'the project name is for the result notice only');
    const s = byId(menuModel({ type: 'session', id: S_OLD }, d, 'dry'), 'terminal');
    assert.equal(s.label, S.termOpenHere, lang);
    assert.equal(s.hint, S.termOpenHereHint, lang);
    assert.equal(s.action, 'terminal');
    assert.deepEqual(s.payload, { sessionId: S_OLD });
    assert.equal(s.name, 'Alpha App');
    if (lang === 'tr') {
      assert.equal(p.label, 'Terminal aç');
      assert.equal(p.hint, 'Bu klasörde; istediğin yapay zekâ aracını başlat');
      assert.equal(s.label, 'Bu klasörde terminal aç');
    } else {
      assert.equal(p.label, 'Open terminal');
      assert.equal(s.label, 'Open a terminal in this folder');
    }
  });
  // Session menu order: continue the Claude Code session, then a plain terminal, then the folder
  assert.deepEqual(ids(menuModel({ type: 'session', id: S_OLD }, d, 'live')), ['resume', 'terminal', 'explorer', 'copy-id', 'open']);
  assert.deepEqual(ids(menuModel({ type: 'session', id: S_LIVE }, d, 'live')), ['fork', 'terminal', 'explorer', 'copy-id', 'open']);
  // A session without a project in the catalog: the folder name is the notice's name
  const d2 = data();
  d2.sessions.get(S_ADHOC).projectId = 'unknown-project';
  assert.equal(byId(menuModel({ type: 'session', id: S_ADHOC }, d2, 'live'), 'terminal').name, 'scratch');
  // No target, in no mode, offers "new" (a Claude Code session): the server keeps it for the skill trial only
  const all = [...TARGETS, { type: 'project', id: 'beta' }, { type: 'project', id: 'no-packages' }, { type: 'session', id: S_ADHOC }, { type: 'agent', id: 'ag-2' }];
  for (const mode of ['off', 'dry', 'live']) {
    for (const t of all) {
      const m = menuModel(t, d, mode);
      assert.ok(!m.some((x) => x.id === 'new' || x.action === 'new'), `${mode} ${t.type}:${t.id}`);
    }
  }
  // Actions off: no terminal item either
  assert.equal(byId(menuModel({ type: 'project', id: 'alpha' }, d, 'off'), 'terminal'), undefined);
  assert.equal(byId(menuModel({ type: 'session', id: S_OLD }, d, 'off'), 'terminal'), undefined);
});

test('menu: when the latest session is live, "continue" becomes fork (a copy of the Claude Code session); otherwise resume; labels name Claude Code', () => {
  inLanguages((lang, S) => {
    const d = data();
    let m = menuModel({ type: 'project', id: 'alpha' }, d, 'live');
    assert.equal(byId(m, 'resume'), undefined);
    const f = byId(m, 'fork');
    assert.equal(f.action, 'fork');
    assert.equal(f.label, S.termFork, lang);
    assert.equal(f.hint, 'Add menu', 'the project menu names the session');
    assert.deepEqual(f.payload, { sessionId: S_LIVE });
    // Once the live session closes, the same project offers resume on the latest session
    d.sessions.get(S_LIVE).live = null;
    m = menuModel({ type: 'project', id: 'alpha' }, d, 'live');
    assert.equal(byId(m, 'fork'), undefined);
    assert.equal(byId(m, 'resume').label, S.termResume, lang);
    assert.deepEqual(byId(m, 'resume').payload, { sessionId: S_LIVE });
    // The session menu follows the same rule
    const d2 = data();
    const sf = byId(menuModel({ type: 'session', id: S_LIVE }, d2, 'dry'), 'fork');
    assert.equal(sf.action, 'fork');
    assert.equal(sf.hint, S.termLiveHint, lang);
    assert.equal(byId(menuModel({ type: 'session', id: S_LIVE }, d2, 'dry'), 'resume'), undefined);
    assert.equal(byId(menuModel({ type: 'session', id: S_OLD }, d2, 'dry'), 'resume').label, S.termResume, lang);
    // Agent menu: parent session live → fork
    const am = menuModel({ type: 'agent', id: 'ag-1' }, d2, 'live');
    assert.equal(byId(am, 'fork').label, S.termForkParent, lang);
    assert.deepEqual(byId(am, 'fork').payload, { sessionId: S_LIVE });
    const am2 = menuModel({ type: 'agent', id: 'ag-2' }, d2, 'live');
    assert.equal(byId(am2, 'resume').label, S.termResumeParent, lang);
    // Agent whose parent session is unknown: no continue item, details only
    assert.deepEqual(ids(menuModel({ type: 'agent', id: 'ag-3' }, d2, 'live')), ['open']);
    if (lang === 'tr') {
      assert.equal(S.termResume, 'Claude Code oturumuna devam et');
      assert.equal(S.termFork, 'Claude Code oturumunun kopyasını aç');
    }
    for (const k of ['termResume', 'termResumeParent', 'termFork', 'termForkParent']) assert.match(S[k], /Claude Code/, `${lang} ${k}`);
  });
});

test('menu: a project without sessions hides "continue" but keeps "Open terminal"', () => {
  const m = menuModel({ type: 'project', id: 'empty' }, data(), 'live');
  assert.equal(byId(m, 'resume'), undefined);
  assert.equal(byId(m, 'fork'), undefined);
  assert.ok(byId(m, 'terminal'));
  assert.deepEqual(ids(m), ['terminal', 'explorer', 'vscode', 'skills', 'copy-path', 'hide', 'open']);
});

test('menu: a session with an unknown folder has no continue/folder items, only a note', () => {
  const m = menuModel({ type: 'session', id: S_NOCWD }, data(), 'live');
  assert.equal(actionItems(m).length, 0);
  assert.equal(m[0].note, PAGE_STRINGS.en.shCmSessionNoFolder);
  assert.deepEqual(ids(m), ['copy-id', 'open']);
  assert.equal(byId(m, 'copy-id').copy, S_NOCWD);
  // The old hub project's last session has no folder: no continue, but new session exists; no skills item
  const hm = menuModel({ type: 'project', id: 'legacy-hub' }, data(), 'live');
  assert.deepEqual(ids(hm), ['terminal', 'explorer', 'vscode', 'copy-path', 'hide', 'open']);
  assert.equal(hm[0].hint, 'C:\\Users\\example\\Hub');
});

test('menu: broad folders and missing folders get no action items', () => {
  for (const mode of ['dry', 'live']) {
    const m = menuModel({ type: 'project', id: 'home' }, data(), mode);
    assert.equal(actionItems(m).length, 0);
    assert.equal(flowItems(m).length, 0);
    assert.equal(m[0].note, PAGE_STRINGS.en.shCmBroad);
    assert.deepEqual(ids(m), ['copy-path', 'hide', 'open']);
    const k = menuModel({ type: 'project', id: 'missing' }, data(), mode);
    assert.equal(actionItems(k).length, 0);
    assert.equal(flowItems(k).length, 0);
    assert.match(k[0].note, /Folder not found/);
  }
});

test('menu: "Suggested skills…" on every project that has the drawer\'s suggested-skills section (registered or found in tool records); it opens that section and sends nothing', () => {
  const d = data();
  inLanguages((lang, S) => {
    for (const mode of ['dry', 'live']) {
      const s = byId(menuModel({ type: 'project', id: 'alpha' }, d, mode), 'skills');
      assert.equal(s.label, S.skMenuSuggest, `${lang} ${mode}`);
      assert.equal(s.hint, S.skMenuSuggestHint);
      assert.deepEqual(s.flow, { type: 'project', id: 'alpha' });
      assert.equal(s.action, undefined, 'no server action: the drawer section runs the flow');
      assert.equal(s.payload, undefined);
      assert.notEqual(s.disabled, true);
    }
  });
  inLanguages((lang) => {
    if (lang === 'tr') assert.equal(byId(menuModel({ type: 'project', id: 'alpha' }, d, 'live'), 'skills').label, 'Uygun skill’ler…');
  });
  // A folder found in the tool records gets it too (suggestions come from its files; the server installs there)
  const a = menuModel({ type: 'project', id: 'scratch' }, d, 'live');
  assert.deepEqual(byId(a, 'skills').flow, { type: 'project', id: 'scratch' });
  assert.ok(byId(a, 'resume') && byId(a, 'terminal'), 'the other actions stay');
  // Exactly where the drawer shows the section (suggestable): never on a broad, missing, hub or temp-only project
  const all = [...d.projects.values(), { id: 'tmp-only', name: 'tmp', kind: 'adhoc', path: null, tmpOnly: true, exists: false }];
  for (const p of all) {
    const m = menuModel({ type: 'project', id: p.id }, { ...d, projects: [...all] }, 'live');
    assert.equal(!!byId(m, 'skills'), suggestable(p), p.id);
  }
  assert.deepEqual(all.filter(suggestable).map((p) => p.id), ['alpha', 'beta', 'scratch', 'empty', 'no-packages']);
});

test('menu: dry mode shows the "preview mode" badge in the header; live mode has no badge', () => {
  const d = data();
  for (const t of TARGETS) {
    const m = menuModel(t, d, 'dry');
    assert.equal(m[0].badge, PAGE_STRINGS.en.shCmDryBadge, `${t.type}:${t.id}`);
    assert.notEqual(m[0].note, PAGE_STRINGS.en.shCmOffNote);
    assert.equal(menuModel(t, d, 'live')[0].badge, undefined);
  }
  // dry and live produce the same items (the only difference is the badge: the server runs nothing)
  assert.deepEqual(ids(menuModel(TARGETS[0], d, 'dry')), ids(menuModel(TARGETS[0], d, 'live')));
});

test('menu: "Install into a project…" on library skills and agents while actions are on; it opens the install section and sends nothing', () => {
  const d = data();
  inLanguages((lang, S) => {
    const m = menuModel({ type: 'roster', id: 'agent:frontend-dev' }, d, 'dry');
    const it = byId(m, 'install-item');
    assert.equal(it.label, S.skMenuInstall, lang);
    assert.deepEqual(it.flow, { type: 'roster', id: 'agent:frontend-dev' });
    assert.equal(it.action, undefined, 'no server action: the drawer section runs the flow');
    assert.equal(it.payload, undefined);
    assert.equal(it.hint, S.skMenuInstallHintIn.replace('{count}', '1'));
    assert.deepEqual(ids(m), ['install-item', 'open']);
    assert.equal(byId(menuModel({ type: 'roster', id: 'skill:a11y-audit' }, d, 'live'), 'install-item').hint, S.skMenuInstallHintLib);
    if (lang === 'tr') {
      assert.equal(it.label, 'Projeye kur…');
      assert.equal(it.hint, '1 projede kurulu');
    }
  });
  const m = menuModel({ type: 'roster', id: 'agent:frontend-dev' }, d, 'live');
  assert.equal(m[0].label, 'frontend-dev');
  assert.equal(m[0].hint, 'Agent · web-ui');
  // Personal, plugin and names the server would reject: no install item (the drawer shows no install section either)
  for (const id of ['skill:my-skill', 'plugin:gh-tools', 'skill:Bad Name', 'skill:local-skill']) assert.deepEqual(ids(menuModel({ type: 'roster', id }, d, 'live')), ['open'], id);
  // A plugin is labelled "Eklenti" in the header
  assert.equal(menuModel({ type: 'roster', id: 'plugin:gh-tools' }, d, 'live')[0].hint, 'Plugin · marketplace');
});

test('skill-flow menu items only while actions are on; the menu sends only launch actions, the page knows every server action', () => {
  const d = data();
  assert.deepEqual([...MENU_ACTIONS], ['resume', 'fork', 'terminal', 'explorer', 'vscode', 'start-ai']);
  // 'new' (a Claude Code session) is a server action the page knows but the menu never sends
  assert.deepEqual([...ACTION_NAMES], ['resume', 'fork', 'new', 'terminal', 'explorer', 'vscode', 'library-scan', 'library-import', 'library-adopt', 'skills-preview', 'skills-install', 'skills-remove', 'skills-trial', 'skills-apply', 'restore-preview', 'restore-apply', 'start-ai', 'github-fetch', 'github-import', 'github-discard', 'github-check-update']);
  assert.deepEqual(Object.keys(ACTION_FIELDS), [...ACTION_NAMES]);
  const all = [...TARGETS, { type: 'project', id: 'beta' }, { type: 'project', id: 'no-packages' }, { type: 'roster', id: 'skill:a11y-audit' }];
  const seen = { off: 0, dry: 0, live: 0 };
  for (const mode of ['off', 'dry', 'live']) {
    for (const t of all) {
      const m = menuModel(t, d, mode);
      for (const it of flowItems(m)) {
        seen[mode]++;
        assert.ok(['skills', 'install-item'].includes(it.id), it.id);
        assert.equal(it.action, undefined, `${mode} ${t.type}:${t.id}`);
      }
      for (const it of actionItems(m)) assert.ok(MENU_ACTIONS.includes(it.action), `${mode} ${t.type}:${t.id} ${it.action}`);
    }
  }
  assert.equal(seen.off, 0, 'none while off (the header tip says how to switch actions on)');
  assert.ok(seen.dry > 0 && seen.dry === seen.live, 'the same items in preview and live mode');
  // Off: the tip line of the header stays
  inLanguages((lang, S) => assert.equal(menuModel({ type: 'project', id: 'alpha' }, d, 'off')[0].tip, S.actionsOffMenuTip, lang));
});

test('menu: action items carry only an allowed action name and ids (no path, command or free text)', () => {
  const d = data();
  const allowed = new Set(['projectId', 'sessionId', 'packages']);
  for (const t of TARGETS) {
    for (const it of actionItems(menuModel(t, d, 'live'))) {
      assert.ok(MENU_ACTIONS.includes(it.action), it.action);
      for (const k of Object.keys(it.payload || {})) assert.ok(allowed.has(k), `${it.id}: ${k}`);
      assert.ok(!JSON.stringify(it.payload).includes('\\\\'), 'no path in the payload');
      assert.deepEqual(actionBody({ action: it.action, ...it.payload }), { action: it.action, ...it.payload }, 'the sender keeps every field of a menu item');
    }
  }
});

test('menu: separators never lead, trail or repeat; ids are unique; unknown targets are safe', () => {
  const d = data();
  for (const mode of ['off', 'dry', 'live']) {
    for (const t of TARGETS) {
      const m = menuModel(t, d, mode);
      const body = m.filter((x) => !x.header);
      assert.ok(body.length > 0);
      assert.ok(!body[0].sep && !body[body.length - 1].sep, `${mode} ${t.type}:${t.id}`);
      for (let i = 1; i < body.length; i++) assert.ok(!(body[i].sep && body[i - 1].sep));
      const all = m.map((x) => x.id);
      assert.equal(new Set(all).size, all.length);
    }
  }
  assert.deepEqual(ids(menuModel({ type: 'project', id: 'unknown' }, d, 'live')), ['open']);
  assert.deepEqual(ids(menuModel({ type: 'session', id: 'unknown' }, d, 'live')), ['copy-id', 'open']);
  assert.equal(menuModel({ type: 'podium', id: 'podium' }, d, 'live').length, 1);
  assert.equal(menuModel(null, null, 'live')[0].header, true);
  // The input is not mutated
  const before = JSON.stringify([...d.sessions.values()]);
  menuModel({ type: 'project', id: 'alpha' }, d, 'live');
  assert.equal(JSON.stringify([...d.sessions.values()]), before);
  // Plain object/array shaped data works too
  const plain = { projects: Object.fromEntries(d.projects), sessions: [...d.sessions.values()], agents: {}, roster: d.roster };
  assert.deepEqual(ids(menuModel({ type: 'project', id: 'alpha' }, plain, 'live')), ids(menuModel({ type: 'project', id: 'alpha' }, d, 'live')));
  assert.equal(latestSession(d, 'alpha').id, S_LIVE);
  assert.equal(latestSession(d, 'empty'), null);
  // A newer session of another tool does not hide the Claude Code session the menu continues (review 2026-10-07)
  const mixed = { sessions: [{ id: 'c1', tool: 'claude', projectId: 'm', lastAt: 1000 }, { id: 'x1', tool: 'codex', projectId: 'm', lastAt: 5000 }] };
  assert.equal(latestSession(mixed, 'm').id, 'x1');
  assert.equal(latestSession(mixed, 'm', 'claude').id, 'c1');
  assert.equal(latestSession(mixed, 'm', 'gemini'), null);
});

test('install validity: a dry preview is invalid once the mode turns live; a changed selection closes it; same mode and selection keeps it open', () => {
  const dry = { preview: { ok: true, key: 'web-ui,design', mode: 'dry' } };
  // Same mode and same selection → open (in dry mode "Kur" is simulated too)
  assert.equal(previewValid(dry, 'web-ui,design', 'dry'), true);
  // The server restarted in live mode without a page reload → a dry preview does not unlock a real install
  assert.equal(previewValid(dry, 'web-ui,design', 'live'), false);
  // Selection changed → preview again
  assert.equal(previewValid(dry, 'web-ui', 'dry'), false);
  assert.equal(previewValid(dry, 'design,web-ui', 'dry'), false);
  // A real preview in live mode → open in the same mode, closed once the mode changes
  const live = { preview: { ok: true, key: 'alpha', mode: 'live' } };
  assert.equal(previewValid(live, 'alpha', 'live'), true);
  assert.equal(previewValid(live, 'alpha', 'off'), false);
  assert.equal(previewValid(live, 'alpha', 'dry'), false);
  // Failed preview, preview without a recorded mode, empty selection, no preview → closed
  assert.equal(previewValid({ preview: { ok: false, key: 'a', mode: 'dry' } }, 'a', 'dry'), false);
  assert.equal(previewValid({ preview: { ok: true, key: 'a' } }, 'a', 'dry'), false);
  assert.equal(previewValid({ preview: { ok: true, key: '', mode: 'dry' } }, '', 'dry'), false);
  assert.equal(previewValid({ preview: null }, 'a', 'dry'), false);
  assert.equal(previewValid(null, 'a', 'dry'), false);
  assert.equal(previewValid({ preview: { ok: 'yes', key: 'a', mode: 'dry' } }, 'a', 'dry'), false, 'ok must be exactly true');
});

test('install section: no project is chosen for the user; Preview and Install stay disabled until one is picked; registered projects come first', () => {
  const d = data();
  const r = d.roster.find((x) => x.id === 'agent:frontend-dev'); // installed in alpha
  // The list: suggestable projects, registered ones first (each group by name), then folders from tool records;
  // "aardvark" (found in a tool record) comes first by name but still after every registered project
  const projects = new Map([...d.projects, ['aardvark', { id: 'aardvark', name: 'aardvark', kind: 'adhoc', path: 'D:\\Work\\aardvark', exists: true, broad: false }]]);
  const list = installTargets(projects);
  assert.deepEqual(list.map((p) => p.id), ['alpha', 'beta', 'empty', 'no-packages', 'aardvark', 'scratch']);
  inLanguages((lang, S) => {
    // First opening: nothing chosen, even though projects without the item exist
    const st = { proj: null, targets: new Set(['claude']), busy: '', preview: null };
    let v = itemInstallView(r, list, st, 'dry');
    assert.equal(v.proj, null, lang);
    assert.equal(v.project, null);
    assert.equal(v.previewDisabled, true);
    assert.equal(v.installEnabled, false);
    assert.equal(v.removeEnabled, false);
    assert.equal(v.why, S.skWhyPickProject);
    // A leftover preview cannot open Install while no project is chosen
    st.preview = { ok: true, key: v.key, mode: 'dry' };
    assert.equal(itemInstallView(r, list, st, 'dry').installEnabled, false);
    // The picker: a placeholder is the selected option, no project is; registered projects in the first group
    const html = projectPickerHtml(list, v);
    assert.match(html, new RegExp(`<option value="" disabled selected>${S.skPickProject}</option>`));
    assert.equal((html.match(/ selected/g) || []).length, 1, 'only the placeholder is selected');
    const reg = html.indexOf(`<optgroup label="${S.skGroupRegistered}">`);
    const found = html.indexOf(`<optgroup label="${S.skGroupFound}">`);
    assert.ok(reg > 0 && found > reg, 'registered projects first');
    for (const id of ['alpha', 'beta', 'empty', 'no-packages']) assert.ok(html.indexOf(`value="${id}"`) > reg && html.indexOf(`value="${id}"`) < found, id);
    assert.ok(html.indexOf('value="aardvark"') > found && html.indexOf('value="scratch"') > html.indexOf('value="aardvark"'));
    // The user picks a project: Preview opens; Install only after a preview in the same mode for that project
    st.proj = 'empty';
    st.preview = null;
    v = itemInstallView(r, list, st, 'dry');
    assert.equal(v.proj, 'empty');
    assert.equal(v.previewDisabled, false);
    assert.equal(v.installEnabled, false);
    st.preview = { ok: true, key: v.key, mode: 'dry' };
    assert.equal(itemInstallView(r, list, st, 'dry').installEnabled, true);
    assert.equal(itemInstallView(r, list, st, 'live').installEnabled, false, 'a dry preview does not open Install in live mode');
    const picked = projectPickerHtml(list, v);
    assert.match(picked, /<option value="empty" selected>/);
    assert.match(picked, /<option value="" disabled>/, 'the placeholder is no longer selected');
    // Another project: the preview no longer holds; a project not in the list is not replaced by another one
    st.proj = 'alpha';
    v = itemInstallView(r, list, st, 'dry');
    assert.equal(v.installEnabled, false, 'closed when the project changes');
    assert.equal(v.here, true);
    st.proj = 'unknown';
    assert.equal(itemInstallView(r, list, st, 'dry').proj, null, 'a target not in the list is not corrected to another project');
    // No project at all: the reason says so
    assert.equal(itemInstallView(r, [], {}, 'dry').why, S.skNoProjects);
  });
});

test('menu: the item name is the label only (hint separate); every visible item has a label', () => {
  const d = data();
  for (const mode of ['off', 'dry', 'live']) {
    for (const t of TARGETS) {
      for (const it of menuModel(t, d, mode)) {
        if (it.sep) continue;
        assert.equal(typeof it.label, 'string');
        assert.ok(it.label.length > 0, `${mode} ${t.type}:${t.id} ${it.id}`);
      }
    }
  }
});

test('placement: the menu fits on screen (flips at the right/bottom edge, clamps and scrolls on small screens)', () => {
  assert.deepEqual(fitMenu(100, 100, 260, 300, 1920, 1080), { left: 100, top: 100, maxHeight: null });
  // Right edge: to the left of the pointer
  assert.equal(fitMenu(1800, 100, 260, 300, 1920, 1080).left, 1540);
  // Bottom edge: above the pointer
  assert.equal(fitMenu(100, 1000, 260, 300, 1920, 1080).top, 700);
  // Near the top-left corner and overflowing once flipped: clamped to the edge
  const p = fitMenu(50, 50, 260, 300, 280, 320);
  assert.ok(p.left >= 8 && p.left + 260 <= 280 - 8 + 1e-9 || p.left === 8);
  assert.ok(p.top >= 8);
  // Menu taller than the screen: 8 px from the top, at most vh-16 high
  assert.deepEqual(fitMenu(10, 10, 200, 900, 800, 600), { left: 10, top: 8, maxHeight: 584 });
});

test('keyboard: ↑/↓ wrap around, Home/End go to the ends, other keys stay put', () => {
  assert.equal(nextIndex(5, 0, 'ArrowDown'), 1);
  assert.equal(nextIndex(5, 4, 'ArrowDown'), 0);
  assert.equal(nextIndex(5, 0, 'ArrowUp'), 4);
  assert.equal(nextIndex(5, -1, 'ArrowDown'), 0);
  assert.equal(nextIndex(5, -1, 'ArrowUp'), 4);
  assert.equal(nextIndex(5, 2, 'Home'), 0);
  assert.equal(nextIndex(5, 2, 'End'), 4);
  assert.equal(nextIndex(5, 2, 'x'), 2);
  assert.equal(nextIndex(0, 0, 'ArrowDown'), -1);
});

test('toast: dry mode shows a command summary (at most 120 chars); errors say what to do next', () => {
  const argv = ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ALPHA_PATH, '--title', 'Alpha App', 'claude', '--resume', S_OLD, '--plugin-dir', 'C:\\Users\\example\\SiberSentez\\library\\web-ui'];
  const t = resultToast("Claude'a devam et", { ok: true, mode: 'dry', action: 'resume', argv });
  assert.equal(t.tone, 'dry');
  assert.match(t.title, /Preview mode/);
  assert.ok(t.code.length <= 120);
  // A long command keeps the program name plus a meaningful tail: which session and package would be used
  assert.ok(t.code.startsWith('wt.exe … '), t.code);
  assert.ok(t.code.includes(`--resume ${S_OLD}`), t.code);
  assert.ok(t.code.endsWith('…\\library\\web-ui'), t.code);
  // A short command stays as is (the path is not shortened)
  assert.equal(argvSummary(['explorer.exe', `"${ALPHA_PATH}"`]), `explorer.exe "${ALPHA_PATH}"`);
  const pk = argvSummary(['pwsh.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\example\\tools\\install-packages.ps1', '-Project', 'alpha', '-Package', 'web-ui,design,backend,mobile,testing,security,marketing', '-DryRun']);
  assert.ok(pk.length <= 120 && pk.includes('-Project alpha -Package web-ui') && pk.endsWith('-DryRun'), pk);
  assert.equal(argvSummary(['a', 'b c']), 'a "b c"');
  assert.equal(argvSummary([]), '');
  assert.equal(resultToast('Open folder', { ok: true, mode: 'live', action: 'explorer' }).tone, 'ok');
  inLanguages((lang, S) => {
    // "Open in browser" (the run hint's page): the page opens, not the folder (seen when using the app, 2026-10-08)
    assert.equal(resultToast('x', { ok: true, mode: 'live', action: 'explorer' }, { action: 'explorer', payload: { projectId: 'p', open: 'index.html' } }).title, S.shDone_openPage, lang);
    assert.equal(resultToast('x', { ok: true, mode: 'live', action: 'explorer' }, { action: 'explorer', payload: { projectId: 'p' } }).title, S.shDone_explorer, lang);
  });
  inLanguages((lang, S) => {
    const e = resultToast(S.termResume, { ok: false, error: 'session-live', hint: 'fork', status: 409 });
    assert.equal(e.tone, 'err');
    // The notice names the menu item to choose instead, by its current label
    assert.ok(e.body.includes(S.termFork), `${lang}: ${e.body}`);
    if (lang === 'tr') assert.equal(e.body, 'Oturum şu an açık. Menüden “Claude Code oturumunun kopyasını aç” seçeneğini seç.');
  });
  assert.match(errorText({ ok: false, status: 429, error: 'repeat' }), /few seconds/);
  assert.match(errorText({ ok: false, status: 0, error: 'actions-off' }), /SIBERSENTEZ_ACTIONS/);
  assert.equal(errorText({ ok: false, status: 400, error: 'bad-package-name' }), PAGE_STRINGS.en['err_bad-package-name']);
  // A code nobody knows gets the general text with the code in it
  assert.equal(errorText({ ok: false, status: 400, error: 'no-such-code' }), PAGE_STRINGS.en.shErrUnknown.replace('{code}', 'no-such-code'));
  // The sender's own error codes (actions.js) read as text in the page language, in both text functions
  inLanguages((lang, S) => {
    for (const fn of [errorText, skillErrorText]) {
      assert.equal(fn({ ok: false, status: 0, error: 'actions-off' }), S.actionsOffError, lang);
      assert.equal(fn({ ok: false, status: 0, error: 'network' }), S.skErr_network, lang);
      assert.equal(fn({ ok: false, status: 0, error: 'unknown-action' }), S.skErr_malformed, lang);
      assert.equal(fn({ ok: false, status: 502, error: 'bad-response' }), S.skErr_unknown.replace('{code}', '502'), lang);
    }
  });
});

test('toast: "Open terminal" says which terminal opened, what to do next, and why it failed (both languages)', async () => {
  const wtArgv = ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', ALPHA_PATH, '--title', 'Alpha App'];
  const psArgv = ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'start', '', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoExit'];
  const item = byId(menuModel({ type: 'project', id: 'alpha' }, data(), 'live'), 'terminal');
  inLanguages((lang, S) => {
    // Windows Terminal opened: "Terminal açıldı · <project>" and the next step (type the AI tool's name)
    let n = resultToast(S.termOpen, { ok: true, mode: 'live', action: 'terminal', argv: wtArgv, terminal: 'wt' }, item);
    assert.equal(n.tone, 'ok', lang);
    assert.equal(n.title, S.termToastOpened.replace('{name}', 'Alpha App'));
    assert.equal(n.body, S.termToastNext);
    // Fallback: the notice says Windows Terminal was not found (or could not start) and PowerShell opens instead
    n = resultToast(S.termOpen, { ok: true, mode: 'live', action: 'terminal', argv: psArgv, terminal: 'powershell', fallbackReason: 'terminal-missing' }, item);
    assert.equal(n.tone, 'ok');
    assert.equal(n.body, S['termToastFallback_terminal-missing']);
    n = resultToast(S.termOpen, { ok: true, mode: 'live', action: 'terminal', argv: psArgv, terminal: 'powershell', fallbackReason: 'terminal-failed' }, item);
    assert.equal(n.body, S['termToastFallback_terminal-failed']);
    // Dry: nothing started, the command shown
    n = resultToast(S.termOpen, { ok: true, mode: 'dry', action: 'terminal', argv: wtArgv, fallbackArgv: psArgv }, item);
    assert.equal(n.tone, 'dry');
    assert.equal(n.title, S.termDryTitle.replace('{label}', S.termOpen));
    assert.equal(n.body, S.termDryBody);
    assert.equal(n.code, `wt.exe -w sibersentez new-tab -d "${ALPHA_PATH}" --title "Alpha App"`);
    // Errors: a failed reply does not name its action, the menu item does; codes read as text
    for (const code of ['no-terminal', 'app-folder-missing', 'launch-failed', 'folder-missing']) {
      n = resultToast(S.termOpen, { ok: false, mode: 'live', error: code, status: 500 }, item);
      assert.equal(n.tone, 'err');
      assert.equal(n.title, S.termFailTitle.replace('{name}', 'Alpha App'), `${lang} ${code}`);
      assert.equal(n.body, S[`termErr_${code}`], `${lang} ${code}`);
      assert.equal(errorText({ ok: false, error: code, status: 500 }), S[`termErr_${code}`]);
    }
    // Validation errors (shared with the other launch actions) read from the error-code table
    n = resultToast(S.termOpen, { ok: false, error: 'broad-folder', status: 409 }, item);
    assert.equal(n.body, S['err_broad-folder'], lang);
    if (lang === 'tr') {
      assert.equal(resultToast(S.termOpen, { ok: true, mode: 'live', action: 'terminal', terminal: 'wt' }, item).title, 'Terminal açıldı · Alpha App');
      assert.equal(resultToast(S.termOpen, { ok: true, mode: 'live', action: 'terminal', terminal: 'powershell', fallbackReason: 'terminal-missing' }, item).body, 'Windows Terminal bulunamadı; terminal PowerShell ile açılıyor.');
    }
  });
  // The PowerShell command shows start's empty title as "" (argvSummary)
  assert.equal(argvSummary(psArgv), 'C:\\Windows\\System32\\cmd.exe /d /c start "" C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoExit');
  // runMenuItem hands the item to the notice: a failed terminal request is still told as a terminal failure
  _resetActionsForTest();
  const f = fakeFetch((url) => (url === '/api/actions' ? { status: 200, body: { mode: 'live', token: TOKEN } } : { status: 501, body: { ok: false, mode: 'live', action: 'terminal', error: 'no-terminal' } }));
  await initActions({ fetch: f });
  const toasts = [];
  const r = await runMenuItem(item, { toast: (x) => toasts.push(x) });
  assert.equal(r.status, 501);
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { action: 'terminal', projectId: 'alpha' }, 'the name never goes to the server');
  assert.equal(toasts[0].tone, 'err');
  assert.equal(toasts[0].body, PAGE_STRINGS.en['termErr_no-terminal']);
  _resetActionsForTest();
});

// ---------- roster model: source labels, filtering, hub state ----------

// Sample roster in the server's shape (contract §4: source + sources[], English source keys)
function roster() {
  return [
    { id: 'skill:lib-skill', kind: 'skill', name: 'lib-skill', source: 'library', sources: ['library'], category: 'web-ui', description: 'Library skill', installedIn: [] },
    { id: 'skill:shared', kind: 'skill', name: 'shared', source: 'personal', sources: ['personal', 'project'], category: 'personal', description: 'Both personal and in a project', installedIn: ['p1'], usage: { count: 3, lastAt: 5 } },
    { id: 'skill:synced', kind: 'skill', name: 'synced', source: 'claudeai', sources: ['claudeai'], category: 'claudeai', description: 'claude.ai', installedIn: [] },
    { id: 'agent:proj-agent', kind: 'agent', name: 'proj-agent', source: 'project', sources: ['project'], category: 'project', description: 'Agent owned by a project', installedIn: ['p1', 'p2'] },
    { id: 'skill:gh:review', kind: 'skill', name: 'gh:review', source: 'plugin', sources: ['plugin'], category: 'gh', plugin: 'gh@market', enabled: false, description: 'Plugin skill', installedIn: [] },
    { id: 'agent:gh:bot', kind: 'agent', name: 'gh:bot', source: 'plugin', sources: ['plugin'], category: 'gh', plugin: 'gh@market', enabled: true, description: 'Agent of an enabled plugin', installedIn: [] },
    { id: 'plugin:gh@market', kind: 'plugin', name: 'gh@market', source: 'plugin', sources: ['plugin'], enabled: true, installedIn: [] },
    { id: 'agent:explore', kind: 'agent', name: 'Explore', source: 'builtin', sources: ['builtin'], category: 'builtin', installedIn: [] },
    { id: 'agent:mystery', kind: 'agent', name: 'mystery', source: 'other', category: 'other', installedIn: [], usage: { count: 1, lastAt: 1 } },
  ];
}

test('source labels: the six contract sources with their UI labels in one table; unknown names show as "Other"; format.js re-exports the same table', () => {
  setLanguage('tr'); // the Turkish texts are asserted below; English is checked at the end
  assert.deepEqual(SOURCE_ORDER, ['library', 'personal', 'claudeai', 'project', 'plugin', 'builtin', 'other']);
  assert.deepEqual(
    SOURCE_ORDER.filter((k) => k !== 'other').map((k) => SOURCE[k]),
    ['Kütüphane', 'Kişisel', 'claude.ai', 'Proje', 'Eklenti', 'Claude Code yerleşik'],
  );
  assert.deepEqual(Object.keys(SOURCE).sort(), [...SOURCE_ORDER].sort());
  for (const k of SOURCE_ORDER) assert.ok(SOURCE_HINT[k], `hint for ${k}`);
  // Hub-specific or unknown source names never show under their own name
  for (const old of ['core', 'anthropic', 'unknown', '', undefined, null, 42]) assert.equal(sourceLabel(old), 'Diğer', String(old));
  assert.equal(sourceLabel('plugin'), 'Eklenti');
  assert.equal(FORMAT_SOURCE, SOURCE);
  assert.equal(formatSourceLabel('personal'), 'Kişisel');
  setLanguage('en');
  assert.equal(sourceLabel('plugin'), 'Plugin');
  assert.equal(sourceLabel('nothing'), 'Other');
  assert.equal(SOURCE.builtin, 'Claude Code built-in');
  setLanguage('tr');
  // No label or hint carries the old hub name or its core concept
  const labels = JSON.stringify([SOURCE, SOURCE_HINT]);
  assert.ok(!OLD_HUB.test(labels) && !OLD_CORE.test(labels), labels);
  setLanguage('en');
});

test('source keys: transitional Turkish keys from pre-release servers map to the English keys', () => {
  const legacy = { kutuphane: 'library', kisisel: 'personal', proje: 'project', eklenti: 'plugin', yerlesik: 'builtin', diger: 'other' };
  for (const [tr, en] of Object.entries(legacy)) {
    assert.equal(normalizeSource(tr), en, tr);
    assert.equal(sourceLabel(tr), SOURCE[en], tr);
    assert.ok(isSourceKey(tr) && isSourceKey(en), tr);
  }
  assert.equal(normalizeSource('claudeai'), 'claudeai');
  assert.equal(isSourceKey('web-ui'), false);
  assert.equal(isSourceKey('toString'), false, 'prototype names are not source keys');
  // A library item is recognised under both spellings (menu and package logic rely on it)
  assert.equal(isLibraryItem({ source: 'library' }), true);
  assert.equal(isLibraryItem({ source: 'kutuphane' }), true);
  assert.equal(isLibraryItem({ source: 'personal' }), false);
  assert.equal(isLibraryItem(null), false);
});

test('sourcesOf: primary source first, then sources[]; deduplicated; unknown becomes "other"; tolerates missing fields', () => {
  const r = roster();
  assert.deepEqual(sourcesOf(r[1]), ['personal', 'project']);
  assert.deepEqual(sourcesOf({ source: 'project', sources: ['personal', 'project', '', null] }), ['project', 'personal']);
  assert.deepEqual(sourcesOf({ source: 'proje', sources: ['project'] }), ['project'], 'old and new spelling of one source count once');
  assert.deepEqual(sourcesOf({ source: 'core' }), ['other'], 'an unknown source name does not crash, it becomes "other"');
  assert.deepEqual(sourcesOf({}), ['other']);
  assert.deepEqual(sourcesOf(null), []);
});

test('filter by source: an item appears under EVERY source it has; combines with kind, category, search and used filters', () => {
  const r = roster();
  const names = (f) => r.filter((i) => matchesFilter(i, f)).map((i) => i.name);
  assert.equal(names({ source: 'all' }).length, r.length);
  assert.deepEqual(names({ source: 'library' }), ['lib-skill']);
  assert.deepEqual(names({ source: 'personal' }), ['shared']);
  assert.deepEqual(names({ source: 'project' }), ['shared', 'proj-agent'], 'the second source in sources[] is filterable too');
  assert.deepEqual(names({ source: 'claudeai' }), ['synced']);
  assert.deepEqual(names({ source: 'plugin' }), ['gh:review', 'gh:bot', 'gh@market']);
  assert.deepEqual(names({ source: 'builtin' }), ['Explore']);
  assert.deepEqual(names({ source: 'other' }), ['mystery']);
  assert.deepEqual(names({ source: 'plugin', kind: 'agent' }), ['gh:bot']);
  assert.deepEqual(names({ source: 'plugin', kind: 'plugin' }), ['gh@market']);
  assert.deepEqual(names({ source: 'project', used: true }), ['shared']);
  assert.deepEqual(names({ q: 'market' }), ['gh:review', 'gh:bot', 'gh@market'], 'the plugin id is searchable');
  assert.deepEqual(names({ q: 'owned by a project' }), ['proj-agent']);
  assert.deepEqual(names({ category: 'gh', source: 'plugin', kind: 'skill' }), ['gh:review']);
  const c = sourceCounts(r);
  assert.deepEqual(c, { all: 9, library: 1, personal: 1, claudeai: 1, project: 2, plugin: 3, builtin: 1, other: 1 });
  // Filter options: the six sources always (even at 0), "other" only when it has items
  assert.deepEqual(sourceOptions(c).map((o) => o.key), SOURCE_ORDER);
  const noOther = sourceCounts(r.filter((i) => i.source !== 'other'));
  assert.deepEqual(sourceOptions(noOther).map((o) => o.key), SOURCE_ORDER.filter((k) => k !== 'other'));
  assert.deepEqual(sourceOptions(sourceCounts([])).map((o) => [o.key, o.count]), SOURCE_ORDER.filter((k) => k !== 'other').map((k) => [k, 0]));
});

test('available everywhere and access text: personal/claude.ai/built-in and enabled-plugin items everywhere; library items wait', () => {
  const r = roster();
  const by = (n) => r.find((i) => i.name === n);
  assert.equal(everywhere(by('shared')), true);
  assert.equal(everywhere(by('synced')), true);
  assert.equal(everywhere(by('Explore')), true);
  assert.equal(everywhere(by('gh:bot')), true, 'agent of an enabled plugin');
  assert.equal(everywhere(by('gh:review')), false, 'skill of a disabled plugin');
  assert.equal(everywhere(by('lib-skill')), false);
  assert.equal(everywhere(by('proj-agent')), false);
  assert.equal(everywhere({ source: 'project', global: true }), true, 'server marked it global');
  setLanguage('tr'); // the Turkish texts are asserted below; English is checked at the end
  assert.match(accessText(by('lib-skill')), /Kütüphanede bekliyor/);
  assert.match(accessText(by('proj-agent')), /2 projede/);
  assert.match(accessText(by('shared')), /^Her projede hazır/);
  assert.match(accessText(by('gh:review')), /kapalı/);
  assert.match(accessText(by('gh:bot')), /açık/);
  assert.match(accessText(by('gh@market')), /^Eklenti açık/);
  assert.match(accessText({ kind: 'plugin', enabled: false }), /kapalı/);
  assert.match(accessText(by('mystery')), /loglarda/);
  for (const i of r) {
    const text = accessText(i);
    assert.ok(!OLD_SCRIPTS.some((x) => x.test(text)) && !OLD_HUB.test(text), i.name);
  }
  setLanguage('en');
  assert.match(accessText(by('lib-skill')), /^Waiting in the library/);
  assert.match(accessText(by('proj-agent')), /the 2 projects/);
  assert.match(accessText(by('shared')), /^Ready in every project/);
});

test('hub state (libraryState): no field → unknown; null → no hub; library 0 → empty with the <hub>/library path; >0 → ready', () => {
  assert.equal(libraryState(undefined).state, 'unknown');
  assert.deepEqual(libraryState(null), { state: 'none', path: null, libraryPath: null, library: 0, projects: 0 });
  assert.equal(libraryState({}).state, 'none', 'a hub without a path counts as missing');
  assert.equal(libraryState({ path: '' }).state, 'none');
  const e = libraryState({ path: 'C:\\Users\\example\\SiberSentez', projects: 0, library: 0 });
  assert.deepEqual(e, { state: 'empty', path: 'C:\\Users\\example\\SiberSentez', libraryPath: 'C:\\Users\\example\\SiberSentez\\library', library: 0, projects: 0 });
  assert.equal(libraryState({ path: 'C:\\Hub\\', library: 0 }).libraryPath, 'C:\\Hub\\library', 'no doubled separator');
  assert.equal(libraryState({ path: '/home/example/SiberSentez', library: 0 }).libraryPath, '/home/example/SiberSentez/library');
  assert.equal(libraryState({ path: 'C:\\Hub', library: 0, libraryPath: 'D:\\Lib' }).libraryPath, 'D:\\Lib', 'the server library path wins');
  const ready = libraryState({ path: 'D:\\M', projects: 4, library: 12 });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.library, 12);
  assert.equal(ready.projects, 4);
  assert.equal(libraryState({ path: 'D:\\M', library: 'broken' }).state, 'empty', 'a broken count counts as empty');
});

// ---------- UI text: nothing left over from the personal setup (names, paths, commands) ----------
function publicFiles(dir = path.join(ROOT, 'public')) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...publicFiles(p));
    else if (/\.(js|html|css|svg|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('UI text: public/ has no personal name, old hub name, "Kayda ekle" or package-install commands', () => {
  const files = publicFiles();
  assert.ok(files.length > 10);
  const banned = [PERSON, OLD_HUB, OLD_HUB_ASCII, OLD_CORE, ...OLD_SCRIPTS, /C:\\\\Users\\\\/i, /C:\\Users\\/i];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const rx of banned) assert.ok(!rx.test(text), `${path.relative(ROOT, f)}: ${rx}`);
  }
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<title>SiberSentez<\/title>/);
  assert.match(html, /id="hubFoot"/, 'footer shows where the hub folder is');
});

// ---------- action client (injected fetch) ----------
const TOKEN = 'a'.repeat(64);
const TOKEN2 = 'b'.repeat(64);
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = routes(url, opts, calls);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? Promise.reject(new Error('no json')) : r.body) };
  };
  fn.calls = calls;
  return fn;
}

// 'actions-off' below is the server's error code for "actions are off" (the client checks it)
test('action client: /api/actions 404 → off, runAction never touches the network', async () => {
  _resetActionsForTest();
  const f = fakeFetch(() => ({ status: 404, body: { error: 'actions-off' } }));
  const st = await initActions({ fetch: f });
  assert.deepEqual(st, { mode: 'off', token: null });
  const r = await runAction({ action: 'resume', sessionId: S_OLD });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1, 'only the GET');
  // A network error or a malformed answer also counts as off
  await initActions({ fetch: async () => Promise.reject(new Error('no network')) });
  assert.equal(actionsState().mode, 'off');
  await initActions({ fetch: fakeFetch(() => ({ status: 200, body: { mode: 'dry', token: 'short' } })) });
  assert.equal(actionsState().mode, 'off', 'invalid token → off');
  await initActions({ fetch: fakeFetch(() => ({ status: 200, body: { mode: 'everything', token: TOKEN } })) });
  assert.equal(actionsState().mode, 'off', 'unknown mode → off');
});

test('action client: dry mode; POST sends only id fields, as JSON, with the token header', async () => {
  _resetActionsForTest();
  let seen = null;
  const f = fakeFetch((url, opts) => {
    if (url === '/api/actions') return { status: 200, body: { mode: 'dry', token: TOKEN, actions: [...ACTION_NAMES] } };
    seen = opts;
    return { status: 200, body: { ok: true, mode: 'dry', action: 'resume', argv: ['wt.exe'] } };
  });
  const changes = [];
  onActionsChange((s) => changes.push(s.mode));
  assert.equal((await initActions({ fetch: f })).mode, 'dry');
  assert.deepEqual(changes, ['dry']);
  const r = await runAction({ action: 'resume', sessionId: S_OLD, path: 'C:\\bad', cmd: 'calc', packages: [] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.equal(seen.headers['X-SiberSentez-Token'], TOKEN);
  assert.deepEqual(JSON.parse(seen.body), { action: 'resume', sessionId: S_OLD }, 'path/command fields are never sent');
});

test('action client: 403 → token refreshed and retried once; 404 "actions-off" → mode turns off', async () => {
  _resetActionsForTest();
  let token = TOKEN;
  let posts = 0;
  const f = fakeFetch((url, opts) => {
    if (url === '/api/actions') return { status: 200, body: { mode: 'live', token } };
    posts++;
    if (opts.headers['X-SiberSentez-Token'] !== TOKEN2) return { status: 403, body: { ok: false, error: 'token' } };
    return { status: 200, body: { ok: true, mode: 'live', action: 'explorer' } };
  });
  await initActions({ fetch: f });
  token = TOKEN2; // the server restarted
  const r = await runAction({ action: 'explorer', projectId: 'alpha' });
  assert.equal(r.ok, true);
  assert.equal(posts, 2);
  // An unchanged token is not retried
  posts = 0;
  const g = fakeFetch((url) => (url === '/api/actions' ? { status: 200, body: { mode: 'live', token: TOKEN } } : (posts++, { status: 403, body: { ok: false, error: 'origin' } })));
  _resetActionsForTest();
  await initActions({ fetch: g });
  const r2 = await runAction({ action: 'explorer', projectId: 'alpha' });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);
  assert.equal(posts, 1);
  // "Project not found" (404) keeps the mode; "actions-off" (404) turns it off
  const h = fakeFetch((url, opts) => {
    if (url === '/api/actions') return { status: 200, body: { mode: 'dry', token: TOKEN } };
    return JSON.parse(opts.body).projectId === 'unknown' ? { status: 404, body: { ok: false, error: 'project-not-found' } } : { status: 404, body: { error: 'actions-off' } };
  });
  _resetActionsForTest();
  await initActions({ fetch: h });
  assert.equal((await runAction({ action: 'new', projectId: 'unknown' })).ok, false);
  assert.equal(actionsState().mode, 'dry');
  await runAction({ action: 'new', projectId: 'alpha' });
  assert.equal(actionsState().mode, 'off');
});

test('action client: if the mode changed after a 403 (dry → live) the request is NOT resent; same mode with a new token is retried', async () => {
  // Scenario: the page is in dry mode with token A; the user confirms "Evet, kur"; meanwhile the server
  // restarted in live mode (token B). The first POST gets 403; the client re-reads the mode. Because the
  // mode changed, the install must not be sent to the live server again.
  // Every action goes through the same sender (runAction): launch actions and every skill-flow action alike
  for (const action of ACTION_NAMES) {
    _resetActionsForTest();
    let server = { mode: 'dry', token: TOKEN };
    let posts = 0;
    const f = fakeFetch((url, opts) => {
      if (url === '/api/actions') return { status: 200, body: { mode: server.mode, token: server.token } };
      posts++;
      if (opts.headers['X-SiberSentez-Token'] !== server.token) return { status: 403, body: { ok: false, error: 'token' } };
      return { status: 200, body: { ok: true, mode: server.mode, action } };
    });
    await initActions({ fetch: f });
    assert.equal(actionsState().mode, 'dry');
    server = { mode: 'live', token: TOKEN2 }; // the server restarted in live mode
    const r = await runAction({ action, projectId: 'alpha', sessionId: S_OLD, packages: ['web-ui'], source: 'D:\\skills', items: [{ kind: 'skill', name: 'a' }], targets: ['claude'] });
    assert.equal(posts, 1, `${action}: no second send to the live server`);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.modeChanged, true);
    assert.equal(r.error, 'mode-changed');
    assert.equal(actionsState().mode, 'live', 'the client learns the new mode (the UI redraws)');
    assert.equal(errorText(r), PAGE_STRINGS.en.shErrModeChanged);
    inLanguages((lang, S) => assert.equal(skillErrorText(r), S['skErr_mode-changed'], lang));
  }
  // Same mode (dry → dry), only the token changed: retried once and succeeds
  _resetActionsForTest();
  let server = { mode: 'dry', token: TOKEN };
  let posts = 0;
  const g = fakeFetch((url, opts) => {
    if (url === '/api/actions') return { status: 200, body: { mode: server.mode, token: server.token } };
    posts++;
    if (opts.headers['X-SiberSentez-Token'] !== server.token) return { status: 403, body: { ok: false, error: 'token' } };
    return { status: 200, body: { ok: true, mode: server.mode, action: 'skills-install' } };
  });
  await initActions({ fetch: g });
  server = { mode: 'dry', token: TOKEN2 };
  const r2 = await runAction({ action: 'skills-install', projectId: 'alpha', items: [{ kind: 'skill', name: 'a' }] });
  assert.equal(posts, 2);
  assert.equal(r2.ok, true);
  // Mode turned off (dry → off): not sent
  _resetActionsForTest();
  server = { mode: 'dry', token: TOKEN };
  posts = 0;
  const h = fakeFetch((url, opts) => {
    if (url === '/api/actions') return server.mode === 'off' ? { status: 404, body: { error: 'actions-off' } } : { status: 200, body: { mode: server.mode, token: server.token } };
    posts++;
    return { status: 403, body: { ok: false, error: 'token' } };
  });
  await initActions({ fetch: h });
  server = { mode: 'off', token: null };
  const r3 = await runAction({ action: 'new', projectId: 'alpha' });
  assert.equal(posts, 1);
  assert.equal(r3.ok, false);
  assert.equal(actionsState().mode, 'off');
  _resetActionsForTest();
});

test('action client: the same request is not sent twice before it answers; a non-JSON answer is an error', async () => {
  _resetActionsForTest();
  let release;
  const gate = new Promise((r) => (release = r));
  let posts = 0;
  const f = async (url) => {
    if (url === '/api/actions') return { ok: true, status: 200, json: async () => ({ mode: 'dry', token: TOKEN }) };
    posts++;
    await gate;
    return { ok: false, status: 500, json: async () => Promise.reject(new Error('html')) };
  };
  await initActions({ fetch: f });
  const a = runAction({ action: 'new', projectId: 'alpha' });
  const b = await runAction({ action: 'new', projectId: 'alpha' });
  assert.equal(b.busy, true);
  release();
  const ra = await a;
  assert.equal(ra.ok, false);
  assert.equal(ra.status, 500);
  assert.equal(ra.error, 'bad-response');
  assert.match(errorText(ra), /500/);
  assert.equal(posts, 1);
  _resetActionsForTest();
});

test('action client: two different skill requests are not mixed up as "the same request" (the whole body is the key)', async () => {
  _resetActionsForTest();
  let release;
  const gate = new Promise((r) => (release = r));
  const bodies = [];
  const f = async (url, opts) => {
    if (url === '/api/actions') return { ok: true, status: 200, json: async () => ({ mode: 'dry', token: TOKEN }) };
    bodies.push(JSON.parse(opts.body));
    await gate;
    return { ok: true, status: 200, json: async () => ({ ok: true, mode: 'dry' }) };
  };
  await initActions({ fetch: f });
  const a = runAction({ action: 'skills-preview', projectId: 'alpha', items: [{ kind: 'skill', name: 'a' }] });
  const b = runAction({ action: 'skills-preview', projectId: 'alpha', items: [{ kind: 'skill', name: 'b' }] });
  const again = await runAction({ action: 'skills-preview', projectId: 'alpha', items: [{ kind: 'skill', name: 'a' }] });
  assert.equal(again.busy, true, 'the very same request waits for its answer');
  assert.equal(again.error, 'in-flight');
  release();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true, 'another selection of the same project is its own request');
  assert.deepEqual(bodies.map((x) => x.items[0].name), ['a', 'b']);
  _resetActionsForTest();
});

test('action client: one sender; each action carries only its own fields (ACTION_FIELDS), in their shape', async () => {
  // Everything a caller might pass, including fields of other actions and things that must never go out
  const everything = {
    projectId: 'cc',
    sessionId: S_OLD,
    source: 'D:\\skills',
    packages: ['web-ui', 7],
    item: 'ui-kit',
    items: [{ kind: 'skill', name: 'a', path: 'C:\\bad', category: 'web', replace: true, extra: 1 }],
    targets: ['claude', 'agents'],
    plan: true,
    keys: ['skill:a', 7],
    tool: 'claude',
    withIdea: true,
    path: 'C:\\Windows',
    command: 'calc.exe',
    url: 'https://github.com/o/r',
    fetchId: 'o-r@abcdef0',
    pointId: 'R20260930120000abcd',
    planId: '0123456789abcdef',
  };
  const want = {
    resume: { sessionId: S_OLD, projectId: 'cc', packages: ['web-ui', '7'] },
    fork: { sessionId: S_OLD, projectId: 'cc', packages: ['web-ui', '7'] },
    new: { projectId: 'cc', packages: ['web-ui', '7'] },
    terminal: { projectId: 'cc', sessionId: S_OLD },
    explorer: { projectId: 'cc', sessionId: S_OLD },
    vscode: { projectId: 'cc', sessionId: S_OLD },
    'library-scan': { source: 'D:\\skills' },
    'library-import': { source: 'D:\\skills', items: [{ path: 'C:\\bad', category: 'web', replace: true }] },
    'library-adopt': { items: [{ kind: 'skill', name: 'a' }] },
    'skills-preview': { projectId: 'cc', items: [{ kind: 'skill', name: 'a' }], targets: ['claude', 'agents'] },
    'skills-install': { projectId: 'cc', items: [{ kind: 'skill', name: 'a' }], targets: ['claude', 'agents'] },
    'skills-remove': { projectId: 'cc', items: [{ kind: 'skill', name: 'a' }], targets: ['claude', 'agents'], plan: true },
    'skills-trial': { projectId: 'cc', items: [{ kind: 'skill', name: 'a' }] },
    'skills-apply': { projectId: 'cc', keys: ['skill:a', '7'], targets: ['claude', 'agents'] },
    'restore-preview': { projectId: 'cc', pointId: 'R20260930120000abcd' },
    'restore-apply': { projectId: 'cc', pointId: 'R20260930120000abcd', planId: '0123456789abcdef' },
    'start-ai': { projectId: 'cc', sessionId: S_OLD, tool: 'claude', withIdea: true },
    'github-fetch': { url: 'https://github.com/o/r' },
    'github-import': { fetchId: 'o-r@abcdef0', items: [{ path: 'C:\\bad', category: 'web', replace: true }] },
    'github-discard': { fetchId: 'o-r@abcdef0' },
    'github-check-update': { items: [{ kind: 'skill', name: 'a' }] },
  };
  assert.deepEqual(Object.keys(want), [...ACTION_NAMES]);
  // skills-apply: an empty key list goes out as it is (the server refuses it); it never becomes the automatic selection
  assert.deepEqual(actionBody({ action: 'skills-apply', projectId: 'cc', keys: [] }), { action: 'skills-apply', projectId: 'cc', keys: [] });
  assert.deepEqual(actionBody({ action: 'skills-apply', projectId: 'cc' }), { action: 'skills-apply', projectId: 'cc' });
  for (const action of ACTION_NAMES) assert.deepEqual(actionBody({ action, ...everything }), { action, ...want[action] }, action);
  // plan goes out only as true; empty values are left out (the server names the missing field)
  assert.deepEqual(actionBody({ action: 'skills-remove', projectId: 'cc', items: [], plan: 'yes' }), { action: 'skills-remove', projectId: 'cc', items: [] });
  assert.deepEqual(actionBody({ action: 'library-scan', source: '' }), { action: 'library-scan' });
  assert.deepEqual(actionBody({ action: 'resume', sessionId: S_OLD, packages: [] }), { action: 'resume', sessionId: S_OLD });
  // An unknown action is never sent
  for (const action of ['rm', '__proto__', 'constructor', 'toString', '', undefined, 42]) assert.equal(actionBody({ action, projectId: 'cc' }), null, String(action));
  _resetActionsForTest();
  const f = fakeFetch((url) => (url === '/api/actions' ? { status: 200, body: { mode: 'dry', token: TOKEN } } : { status: 200, body: { ok: true } }));
  await initActions({ fetch: f });
  const u = await runAction({ action: 'rm', projectId: 'cc' });
  assert.equal(u.error, 'unknown-action');
  assert.equal(f.calls.length, 1, 'nothing posted for an unknown action');
  // The body a skill action posts is exactly actionBody's
  await runAction({ action: 'skills-install', ...everything });
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { action: 'skills-install', ...want['skills-install'] });
  // Off: never sent, whatever the action
  _resetActionsForTest();
  for (const action of ACTION_NAMES) assert.equal((await runAction({ action, ...everything })).error, 'actions-off', action);
  // The context menu module has no sender of its own and no longer exports the old names
  const cm = await import('../public/js/contextmenu.js');
  for (const name of ['runSkillAction', 'skillBody', 'itemFlowView']) assert.equal(name in cm, false, `contextmenu.js still exports ${name}`);
  // actions.js is the only page module that posts an action; the drawer and the roster tab import runAction from it
  const js = (f) => fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
  const posts = /['"`]\/api\/action['"`]|X-SiberSentez-Token/;
  assert.match(js('actions.js'), posts);
  for (const f of ['contextmenu.js', 'main.js', 'views/drawer.js', 'views/roster.js']) {
    assert.doesNotMatch(js(f), posts, f);
    assert.doesNotMatch(js(f), /\brunSkillAction\b|\bskillBody\b|\bitemFlowView\b/, `${f} still names an old function`);
  }
  for (const f of ['views/drawer.js', 'views/roster.js']) assert.match(js(f), /import \{[^}]*\brunAction\b[^}]*\} from '\.\.\/actions\.js'/, f);
});

test('menu: a skill-flow item opens its drawer section through openSkills and never touches the network', async () => {
  _resetActionsForTest();
  const f = fakeFetch((url) => (url === '/api/actions' ? { status: 200, body: { mode: 'dry', token: TOKEN } } : { status: 200, body: { ok: true } }));
  await initActions({ fetch: f });
  const d = data();
  const opened = [];
  const ctx = { openSkills: (t) => opened.push(t), openDrawer: () => assert.fail('not the plain details drawer'), toast: () => {} };
  await runMenuItem(byId(menuModel({ type: 'project', id: 'alpha' }, d, 'dry'), 'skills'), ctx);
  await runMenuItem(byId(menuModel({ type: 'roster', id: 'skill:a11y-audit' }, d, 'dry'), 'install-item'), ctx);
  assert.deepEqual(opened, [
    { type: 'project', id: 'alpha' },
    { type: 'roster', id: 'skill:a11y-audit' },
  ]);
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ['/api/actions'],
    'only the mode was read; nothing was posted',
  );
  _resetActionsForTest();
});

test("another tool's session continues with that tool (start-ai resume), never with Claude's; a session of a tool that cannot continue hides nothing", () => {
  setLanguage('en');
  const d = data();
  const CODEX_ID = '01a11627-5555-4aaa-8aaa-619e30c69d4a';
  const OTHER_ID = '01a11627-6666-4aaa-8aaa-619e30c69d4a';
  d.sessions.set(CODEX_ID, { id: CODEX_ID, tool: 'codex', projectId: 'beta', title: 'Codex task', lastAt: 3000, cwd: 'C:\work\beta', live: null });
  const m = menuModel({ type: 'session', id: CODEX_ID }, d, 'live');
  const resume = m.find((x) => x.id === 'resume');
  assert.ok(resume, 'offered');
  assert.equal(resume.action, 'start-ai');
  assert.deepEqual(resume.payload, { sessionId: CODEX_ID, tool: 'codex', resume: true });
  assert.ok(resume.label.includes('Codex'));
  assert.ok(!m.some((x) => x.id === 'fork' || x.id === 'resume-outside'), "Windows Terminal's continue and the copy are Claude's own");
  // The project's newest session is of a tool whose sessions are not read: the Codex one is still offered
  d.sessions.set(OTHER_ID, { id: OTHER_ID, tool: 'opencode', projectId: 'beta', title: 'Other', lastAt: 9000, cwd: 'C:\work\beta', live: null });
  assert.equal(latestSession(d, 'beta', (tool) => ['claude', 'codex', 'gemini', 'qwen'].includes(tool)).id, CODEX_ID);
  const pm = menuModel({ type: 'project', id: 'beta' }, d, 'live');
  assert.ok(pm.some((x) => x.action === 'start-ai' && x.payload?.resume && x.payload.tool === 'codex' && x.payload.sessionId === CODEX_ID), 'the project menu continues it');
});
