// "New project" from an idea (review U05, 2026-10-07): a name and an idea -> the shell makes the folder under
// Documents\SiberSentez (or under a folder the person picks) -> the drawer opens with the idea in its job box.
// Covered: the folder name rule (the shell's and the page's are the same), the request check, a free folder name, the
// shell's steps with fakes (no dialog, no real folder outside the temp folder), the preload, main.mjs's wiring, the
// page's flow and texts. No window or dialog is ever opened.
// Run: node --test test/idea-project.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  IDEA_PROJECT_IPC_CHANNEL,
  IDEA_PROJECTS_DIR,
  IDEA_TEXT_MAX,
  PROJECT_NAME_MAX,
  appOrigin,
  createIdeaProject,
  freeProjectFolder,
  ideaParentDialogOptions,
  ideaProjectRequest,
  projectFolderName,
  projectReply,
} from '../electron/helpers.mjs';
import { STRINGS as SHELL_STRINGS } from '../electron/strings.mjs';
import { createNewProjectFlow, newProjectOutcome, qaProjectBridge, projectBridge } from '../public/js/views/projects.js';
import { folderNameOf, ideaWhereText, ideaDialogHtml, NAME_MAX, IDEA_FIELD_MAX } from '../public/js/views/newIdea.js';
import { STRINGS, setLanguage, t } from '../public/js/i18n.js';
import { IDEA_MAX as SERVER_IDEA_MAX } from '../server/memory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-idea-project-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const textOf = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const bodyOf = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `end of function ${name}`);
  return src.slice(start, end);
};
const ORIGIN = appOrigin(47712);
const FROM_PAGE = { mainWindow: true, frame: { top: true, url: `${ORIGIN}/?lang=tr` }, origin: ORIGIN };
const inLanguages = (fn) => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    fn(lang, STRINGS[lang]);
  }
  setLanguage('en');
};

describe('the folder name of a project name', () => {
  const cases = [
    ['Tarif sitem', 'Tarif sitem'],
    ['  kafe   menüsü  ', 'kafe menüsü'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j'],
    ['ends with dots...', 'ends with dots'],
    ['tab\there\nnew', 'tab here new'],
    ['CON', ''],
    ['lpt1.txt', ''],
    ['console', 'console'],
    ['COM¹', ''],
    ['lpt³.md', ''],
    ['CONIN$', ''],
    ['conout$.txt', ''],
    ['abc', 'a b c'],
    ['...', ''],
    ['   ', ''],
    ['', ''],
    ['x'.repeat(80), 'x'.repeat(PROJECT_NAME_MAX)],
    ['🙂'.repeat(70), '🙂'.repeat(PROJECT_NAME_MAX)],
  ];
  test('characters Windows refuses become spaces; no trailing dot; no device name; at most PROJECT_NAME_MAX characters', () => {
    for (const [given, want] of cases) assert.equal(projectFolderName(given), want, JSON.stringify(given));
    assert.equal(projectFolderName(null), '');
    assert.equal(projectFolderName(42), '42');
  });
  test("the page's preview follows the very same rule; the same limits", () => {
    for (const [given] of cases) assert.equal(folderNameOf(given), projectFolderName(given), JSON.stringify(given));
    assert.equal(NAME_MAX, PROJECT_NAME_MAX);
    assert.equal(IDEA_FIELD_MAX, SERVER_IDEA_MAX, 'the window takes as much of the idea as the server keeps');
    assert.ok(IDEA_FIELD_MAX <= IDEA_TEXT_MAX);
  });
});

describe('shell: the request and the steps', () => {
  test('the sender first; then a string name that makes a folder name, a string idea, a boolean choose', () => {
    assert.deepEqual(ideaProjectRequest({ ...FROM_PAGE, name: ' Tarif / sitem ', idea: 'tarifler', choose: false }), { ok: true, name: 'Tarif sitem', idea: 'tarifler', choose: false });
    assert.equal(ideaProjectRequest({ ...FROM_PAGE, mainWindow: false, name: 'x', idea: '', choose: false }).reason, 'not-main-window');
    for (const bad of [{ name: 42 }, { name: 'x'.repeat(201) }, { name: 'x', idea: 1 }, { name: 'x', idea: 'y'.repeat(IDEA_TEXT_MAX + 1) }, { name: 'x', choose: 'yes' }]) {
      assert.deepEqual(ideaProjectRequest({ ...FROM_PAGE, idea: '', choose: false, ...bad }), { ok: false, reason: 'invalid' }, JSON.stringify(bad).slice(0, 60));
    }
    assert.deepEqual(ideaProjectRequest({ ...FROM_PAGE, name: 'NUL', idea: '', choose: false }), { ok: false, reason: 'bad-name' });
    assert.deepEqual(ideaProjectRequest({ ...FROM_PAGE, name: '???', idea: '', choose: false }), { ok: false, reason: 'bad-name' });
  });

  test('a free folder name: the name, then "(2)" ... "(99)", then none', () => {
    const base = 'C:\\Users\\x\\Documents\\SiberSentez';
    const taken = new Set([path.win32.join(base, 'Site'), path.win32.join(base, 'Site (2)')]);
    assert.equal(freeProjectFolder(base, 'Site', (p) => taken.has(p)), path.win32.join(base, 'Site (3)'));
    assert.equal(freeProjectFolder(base, 'Oyun', (p) => taken.has(p)), path.win32.join(base, 'Oyun'));
    assert.equal(freeProjectFolder(base, 'Site', () => true), null);
  });

  // Fake parts around a real temp folder: what was made, removed, checked, added, saved
  function parts(over = {}) {
    const log = { made: [], removed: [], checked: [], added: [], ideas: [], dialogs: [] };
    const p = {
      S: SHELL_STRINGS.tr,
      base: path.join(TMP, `docs${Math.random().toString(16).slice(2, 8)}`, IDEA_PROJECTS_DIR),
      name: 'Tarif sitem',
      idea: '',
      choose: false,
      showOpenDialog: async (o) => (log.dialogs.push(o), { canceled: true, filePaths: [] }),
      exists: (x) => fs.existsSync(x),
      mkdir: (x, recursive) => (log.made.push(recursive ? `${x} (r)` : x), fs.mkdirSync(x, { recursive })),
      removeEmpty: (x) => (log.removed.push(x), fs.rmdirSync(x)),
      check: (x) => (log.checked.push(x), { ok: true, path: x }),
      add: async (x) => (log.added.push(x), { ok: true, projectId: 'x-tarif', existed: false, reason: 'added' }),
      saveIdea: async (id, text) => log.ideas.push([id, text]),
      ...over,
    };
    return { p, log };
  }

  test('Documents\\SiberSentez\\<name>: made, checked, added, the idea kept; the page gets the id only', async () => {
    const { p, log } = parts({ idea: 'Tariflerimi tutan site' });
    const r = await createIdeaProject(p);
    const folder = path.join(p.base, 'Tarif sitem');
    assert.deepEqual(log.made, [`${p.base} (r)`, folder], 'the base folder recursively, the project folder never');
    assert.ok(fs.statSync(folder).isDirectory());
    assert.deepEqual(log.checked, [folder]);
    assert.deepEqual(log.added, [folder]);
    assert.deepEqual(log.ideas, [['x-tarif', 'Tariflerimi tutan site']]);
    assert.equal(log.dialogs.length, 0, 'no dialog for the default place');
    assert.equal(r.created, true);
    assert.deepEqual(projectReply(r), { ok: true, reason: 'added', projectId: 'x-tarif', existed: false });
    // The same name again: the next free folder; no idea, nothing saved
    const again = parts({ base: p.base });
    await createIdeaProject(again.p);
    assert.deepEqual(again.log.made, [path.join(p.base, 'Tarif sitem (2)')]);
    assert.deepEqual(again.log.ideas, []);
  });

  test('"Somewhere else…": the picker asks where (the shell language); cancel or a network folder makes nothing', async () => {
    const where = path.join(TMP, 'elsewhere');
    fs.mkdirSync(where, { recursive: true });
    const { p, log } = parts({ choose: true, showOpenDialog: async (o) => (log.dialogs.push(o), { canceled: false, filePaths: [where] }) });
    await createIdeaProject(p);
    assert.deepEqual(log.dialogs, [ideaParentDialogOptions(SHELL_STRINGS.tr)]);
    assert.equal(log.dialogs[0].title, SHELL_STRINGS.tr.newProjectWhereTitle);
    assert.deepEqual(log.made, [path.join(where, 'Tarif sitem')], 'the picked folder is there: only the project folder is made');
    const cancel = parts({ choose: true });
    assert.deepEqual(await createIdeaProject(cancel.p), { ok: false, reason: 'cancelled' });
    const net = parts({ choose: true, showOpenDialog: async () => ({ canceled: false, filePaths: ['\\\\server\\share'] }) });
    assert.deepEqual(await createIdeaProject(net.p), { ok: false, reason: 'not-local' });
    const thrown = parts({ choose: true, showOpenDialog: async () => Promise.reject(new Error('x')) });
    assert.deepEqual(await createIdeaProject(thrown.p), { ok: false, reason: 'error' });
    for (const x of [cancel, net, thrown]) assert.deepEqual(x.log.made, []);
  });

  test('a refused folder or a failing server: the empty folder just made is removed again, and the base folder this call made; nothing else is touched', async () => {
    const refused = parts({ check: () => ({ ok: false, reason: 'hub' }) });
    assert.deepEqual(await createIdeaProject(refused.p), { ok: false, reason: 'hub' });
    assert.deepEqual(refused.log.removed, [path.join(refused.p.base, 'Tarif sitem'), refused.p.base]);
    assert.equal(fs.existsSync(refused.p.base), false);
    // Refused by its path alone: nothing is made at all
    const planned = parts({ precheck: () => 'hub' });
    assert.deepEqual(await createIdeaProject(planned.p), { ok: false, reason: 'hub' });
    assert.deepEqual([planned.log.made, planned.log.checked, planned.log.added], [[], [], []]);
    // Inside a listed project (an older server answers with that project): refused, its idea untouched
    const inside = parts({ idea: 'x', add: async (x) => (inside.log.added.push(x), { ok: true, projectId: 'x-parent', existed: true, reason: 'existing' }) });
    assert.deepEqual(await createIdeaProject(inside.p), { ok: false, reason: 'inside-project' });
    assert.deepEqual(inside.log.ideas, [], 'the parent project keeps its idea');
    assert.equal(fs.existsSync(path.join(inside.p.base, 'Tarif sitem')), false);
    // A folder that appears between the look and the make is never taken over: the next free name
    const raced = parts();
    let once = true;
    raced.p.exists = (x) => fs.existsSync(x);
    const realMkdir = raced.p.mkdir;
    raced.p.mkdir = (x, recursive) => {
      if (!recursive && once) {
        once = false;
        fs.mkdirSync(x, { recursive: true });
        fs.writeFileSync(path.join(x, 'someone.txt'), 'theirs');
      }
      return realMkdir(x, recursive);
    };
    const r = await createIdeaProject(raced.p);
    assert.equal(r.ok, true);
    assert.deepEqual(raced.log.added, [path.join(raced.p.base, 'Tarif sitem (2)')]);
    assert.equal(fs.readFileSync(path.join(raced.p.base, 'Tarif sitem', 'someone.txt'), 'utf8'), 'theirs');
    // Every name says EEXIST while exists() says no (broken links): each name is tried once, then it stops
    const links = parts({ exists: () => false });
    let tries = 0;
    links.p.mkdir = (x, recursive) => {
      if (recursive) return fs.mkdirSync(x, { recursive: true });
      tries++;
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    };
    assert.deepEqual(await createIdeaProject(links.p), { ok: false, reason: 'exists' });
    assert.equal(tries, 99, 'each free name once, never a loop');
    // A folder that is not empty is never removed (rmdir only)
    const full = parts({ check: (x) => (fs.writeFileSync(path.join(x, 'keep.txt'), 'k'), { ok: false, reason: 'hub' }) });
    await createIdeaProject(full.p);
    assert.equal(fs.readFileSync(path.join(full.p.base, 'Tarif sitem', 'keep.txt'), 'utf8'), 'k');
    const down = parts({ add: async () => ({ ok: false, reason: 'no-server' }) });
    assert.deepEqual(await createIdeaProject(down.p), { ok: false, reason: 'no-server' });
    assert.equal(fs.existsSync(down.log.made[0]), false);
    const threw = parts({ add: async () => Promise.reject(new Error('x')) });
    assert.deepEqual(await createIdeaProject(threw.p), { ok: false, reason: 'error' });
    const noMkdir = parts({ mkdir: () => { throw new Error('denied'); } });
    assert.deepEqual(await createIdeaProject(noMkdir.p), { ok: false, reason: 'error' });
    assert.deepEqual(noMkdir.log.checked, []);
    // An idea that could not be kept does not undo the project
    const noIdea = parts({ idea: 'x', saveIdea: async () => Promise.reject(new Error('x')) });
    assert.equal((await createIdeaProject(noIdea.p)).ok, true);
  });

  test('the shell texts of the picker in both languages', () => {
    for (const lang of ['en', 'tr']) for (const k of ['newProjectWhereTitle', 'newProjectWhereButton']) assert.ok(SHELL_STRINGS[lang][k]?.trim(), `${lang}: ${k}`);
  });
});

describe('preload and main.mjs', () => {
  function loadPreload() {
    const code = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
    const exposed = {};
    const invokes = [];
    const ipcRenderer = { invoke: (...args) => (invokes.push(args), Promise.resolve({ ok: true, projectId: 'x-new', reason: 'added' })) };
    vm.runInNewContext(code, { require: (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (k, api) => (exposed[k] = api) }, ipcRenderer } : null) });
    return { api: exposed.sibersentezShell, invokes };
  }

  test('createIdeaProject passes a name, the idea and choose; anything else is refused before the shell', async () => {
    const p = loadPreload();
    await p.api.createIdeaProject('Tarif sitem', 'tarifler', false);
    await p.api.createIdeaProject('Oyun', '', true);
    assert.deepEqual(p.invokes, [
      [IDEA_PROJECT_IPC_CHANNEL, 'Tarif sitem', 'tarifler', false],
      [IDEA_PROJECT_IPC_CHANNEL, 'Oyun', '', true],
    ]);
    for (const bad of [[1, '', false], ['x'.repeat(201), '', false], ['x', null, false], ['x', 'y'.repeat(IDEA_TEXT_MAX + 1), false], ['x', '', 'true'], ['x', '']]) {
      assert.deepEqual({ ...(await p.api.createIdeaProject(...bad)) }, { ok: false, reason: 'invalid' });
    }
    assert.equal(p.invokes.length, 2);
    assert.ok(textOf('electron', 'preload.cjs').includes(`const IDEA_PROJECT_CHANNEL = '${IDEA_PROJECT_IPC_CHANNEL}';`), "the preload's channel is the shell's");
  });

  test('main.mjs: the sender is checked first, one folder at a time, under Documents\\SiberSentez; the log names no folder, name or idea', () => {
    const src = textOf('electron', 'main.mjs');
    assert.ok(src.includes('ipcMain.handle(IDEA_PROJECT_IPC_CHANNEL, onCreateIdeaProjectRequest);'));
    const h = bodyOf(src, 'onCreateIdeaProjectRequest');
    assert.ok(h.indexOf('ideaProjectRequest({ name, idea, choose, ...senderFacts(event) })') < h.indexOf('createIdeaProject({'));
    assert.ok(h.includes('if (state.pickingFolder) return'));
    assert.ok(h.includes('base: path.join(documents, IDEA_PROJECTS_DIR),'));
    assert.ok(h.includes('check: (folder) => checkProjectFolder(folder, projectFolderRules()),'));
    assert.ok(h.includes('precheck: (folder) => plannedFolderRefusal(folder, projectFolderRules()),'));
    assert.ok(h.includes("add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder, fresh: true }),"), 'a new project only');
    assert.ok(h.includes('mkdir: (p, recursive) => fs.mkdirSync(p, { recursive }),'));
    assert.ok(h.includes('removeEmpty: (p) => fs.rmdirSync(p),'), 'only an empty folder is removed (rmdir, never a recursive delete)');
    assert.ok(h.includes('const reply = projectReply(result);'));
    for (const line of h.split('\n').filter((l) => l.includes('log('))) assert.doesNotMatch(line, /\$\{[^}]*\b(name|idea|folder|path|req\.name|req\.idea)\b/, `nothing personal in the log: ${line.trim()}`);
  });
});

describe('page: the "New project" window and its flow', () => {
  test('the window: a name, where its folder goes, the idea, Create / Somewhere else / Cancel, the old way at the bottom', () => {
    inLanguages((lang, S) => {
      const html = ideaDialogHtml();
      for (const k of ['create', 'elsewhere', 'cancel', 'existing']) assert.ok(html.includes(`data-np="${k}"`), `${lang}: ${k}`);
      assert.ok(html.includes(`maxlength="${NAME_MAX}"`) && html.includes(`maxlength="${IDEA_FIELD_MAX}"`));
      assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'));
      assert.equal((html.match(/act-btn primary/g) || []).length, 1, 'one primary');
      assert.equal(ideaWhereText('Tarif / sitem'), `${S.npIdeaDocs} › SiberSentez › Tarif sitem`);
      assert.ok(ideaWhereText('').endsWith('› …'));
      for (const k of ['npErr_inside-project', 'npIdeaTitle', 'npIdeaIntro', 'npIdeaName', 'npIdeaWhere', 'npIdeaIdea', 'npIdeaKeys', 'npIdeaCreate', 'npIdeaElsewhere', 'npIdeaCancel', 'npIdeaExisting', 'npIdeaBadName', 'npCreated', 'npCreatedNext', 'npCreateFailTitle', 'npErr_bad-name', 'npErr_exists']) assert.ok(S[k]?.trim(), `${lang}: ${k}`);
    });
    assert.equal(STRINGS.tr.npIdeaExisting, 'Zaten bir proje klasörün var mı? Ekle');
    assert.equal(STRINGS.tr.npIdeaDocs, 'Belgeler');
  });

  test('the outcome of a made project: "Project created", the idea waits in the job box; a failure says it could not be created', () => {
    inLanguages((lang, S) => {
      const ok = newProjectOutcome({ ok: true, projectId: 'x-tarif' }, () => 'Tarif sitem', { made: true, withIdea: true });
      assert.deepEqual(ok, { projectId: 'x-tarif', toast: { tone: 'ok', title: S.npCreated.replace('{name}', 'Tarif sitem'), body: S.npCreatedNext } });
      assert.equal(newProjectOutcome({ ok: true, projectId: 'x-tarif' }, () => 'T', { made: true }).toast.body, S.npNextIdea, 'no idea: write it in the drawer');
      const bad = newProjectOutcome({ ok: false, reason: 'bad-name' }, undefined, { made: true });
      assert.deepEqual(bad.toast, { tone: 'err', title: S.npCreateFailTitle, body: S['npErr_bad-name'] });
      assert.equal(newProjectOutcome({ ok: false, reason: 'cancelled' }, undefined, { made: true }).toast, null);
    });
  });

  function flowWith({ answers = [], bridge = {} } = {}) {
    const calls = [];
    const opened = [];
    const toasts = [];
    const queue = [...answers];
    const flow = createNewProjectFlow({
      bridge: {
        pickProjectFolder: async () => (calls.push(['pick']), { ok: true, projectId: 'x-old', existed: true }),
        saveProjectIdea: async () => ({ ok: true }),
        createIdeaProject: async (...a) => (calls.push(['create', ...a]), { ok: true, projectId: 'x-new', existed: false }),
        ...bridge,
      },
      ask: async () => queue.shift(),
      toast: (o) => toasts.push(o),
      openProject: (id, idea) => opened.push([id, idea]),
      hasProject: () => true,
      nameOf: (id) => id,
    });
    return { flow, calls, opened, toasts };
  }

  test('Create: the shell makes it in the default place; the drawer gets the idea; "Somewhere else" asks where; the old way picks a folder', async () => {
    const a = flowWith({ answers: [{ action: 'create', name: 'Tarif sitem', idea: 'tarifler' }] });
    assert.equal(await a.flow.start(), 'opened');
    assert.deepEqual(a.calls, [['create', 'Tarif sitem', 'tarifler', false]]);
    assert.deepEqual(a.opened, [['x-new', 'tarifler']]);
    assert.equal(a.toasts.at(-1).title, t('npCreated', { name: 'x-new' }));
    const b = flowWith({ answers: [{ action: 'elsewhere', name: 'Oyun', idea: '' }] });
    await b.flow.start();
    assert.deepEqual(b.calls, [['create', 'Oyun', '', true]]);
    assert.deepEqual(b.opened, [['x-new', '']], 'no idea: the drawer opens at the idea box');
    const c = flowWith({ answers: [{ action: 'existing' }] });
    await c.flow.start();
    assert.deepEqual(c.calls, [['pick']]);
    assert.equal(c.toasts.at(-1).title, t('npExisting', { name: 'x-old' }));
  });

  test('a try that did not work brings the window back with what was typed and the reason in it; nothing is lost, nothing opened', async () => {
    const asked = [];
    const replies = [{ ok: false, reason: 'inside-project' }, { ok: false, reason: 'cancelled' }, { ok: true, projectId: 'x-new', existed: false }];
    const answers = [{ action: 'elsewhere', name: 'Blog', idea: 'yazılar' }, { action: 'elsewhere', name: 'Blog', idea: 'yazılar' }, { action: 'create', name: 'Blog', idea: 'yazılar' }];
    const opened = [];
    const toasts = [];
    const flow = createNewProjectFlow({
      bridge: { pickProjectFolder: async () => ({ ok: false }), saveProjectIdea: async () => ({ ok: true }), createIdeaProject: async () => replies.shift() },
      ask: async (prev) => (asked.push(prev), answers.shift()),
      toast: (o) => toasts.push(o),
      openProject: (id, idea) => opened.push([id, idea]),
      hasProject: () => true,
    });
    assert.equal(await flow.start(), 'opened');
    assert.deepEqual(asked, [null, { name: 'Blog', idea: 'yazılar', error: t('npErr_inside-project') }, { name: 'Blog', idea: 'yazılar', error: '' }], 'a cancelled "Somewhere else" says nothing, but keeps what was typed');
    assert.deepEqual(opened, [['x-new', 'yazılar']]);
    assert.equal(toasts.length, 1, 'only the success is a notice; the refusal was said in the window');
    // Leaving the window after a refusal: nothing more happens
    const quit = flowWith({ answers: [{ action: 'create', name: 'X', idea: '' }, { action: 'cancel' }], bridge: { createIdeaProject: async () => ({ ok: false, reason: 'busy' }) } });
    assert.equal(await quit.flow.start(), 'cancelled');
    assert.deepEqual(quit.opened, []);
  });

  test('Cancel or a closed window: nothing reaches the shell, nothing is said; an older shell without the new call opens the picker', async () => {
    for (const answer of [{ action: 'cancel' }, undefined, { action: 'busy' }, { action: 'weird' }]) {
      const x = flowWith({ answers: [answer] });
      assert.equal(await x.flow.start(), 'cancelled');
      assert.deepEqual(x.calls, []);
      assert.deepEqual(x.toasts, []);
    }
    const old = flowWith({ bridge: { createIdeaProject: undefined } });
    await old.flow.start();
    assert.deepEqual(old.calls, [['pick']], 'the old way');
    // The project bridge needs only the two old functions; the QA stand-in can make projects too
    assert.ok(projectBridge({ sibersentezShell: { pickProjectFolder() {}, saveProjectIdea() {} } }));
    assert.equal(typeof qaProjectBridge('pick').createIdeaProject, 'function');
  });

  test('main.js and the drawer: the window asks; a made project opens with its idea in the job box, Start focused, nothing started', () => {
    const main = textOf('public', 'js', 'main.js');
    assert.ok(main.includes('const ideaDialog = createIdeaDialog();'));
    assert.ok(main.includes('ask: (prev) => ideaDialog.ask(prev),'), 'what the last try had comes back');
    assert.ok(main.includes('if (idea) drawer.openWithJob(id, idea);'));
    const drawer = textOf('public', 'js', 'views', 'drawer.js');
    const fn = drawer.slice(drawer.indexOf('  function openWithJob('), drawer.indexOf('  return { open, close'));
    assert.ok(fn.includes('job.setText(projectId, text);') && fn.includes("'job:start' : 'job:text'"), 'Start, or the box while there is no Start');
    assert.doesNotMatch(fn, /startJob|runAction|giveJob/, 'it only fills the box');
    const dialog = textOf('public', 'js', 'views', 'newIdea.js');
    assert.ok(dialog.includes('e.stopPropagation();'), "keys typed in the window do not reach the page's shortcuts");
    assert.ok(textOf('public', 'css', 'start.css').includes('.np-wrap {'));
  });
});
