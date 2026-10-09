// "How to run it" (server/runhint.mjs, public/js/runHint.js): the folder's names and small manifests give plain steps;
// commands are built from fixed words; nothing is run; an empty, unknown or unreadable folder says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFacts, runPlans, projectRun } from '../server/runhint.mjs';
import { runSectionHtml, createRunHint } from '../public/js/runHint.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

function folder(files, dirs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-run-'));
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const plansOf = (files, dirs) => runPlans(runFacts(folder(files, dirs)));
const cmds = (plan) => plan.steps.map((s) => s.cmd || s.id);

test('Node.js: the lock file picks the package manager, install first when node_modules is missing, the start script, an address', () => {
  assert.deepEqual(cmds(plansOf({ 'package.json': JSON.stringify({ scripts: { build: 'x', dev: 'vite' } }) })[0]), ['npm install', 'npm run dev', 'address']);
  assert.deepEqual(cmds(plansOf({ 'package.json': JSON.stringify({ scripts: { start: 'node .' } }), 'pnpm-lock.yaml': '' }, ['node_modules'])[0]), ['pnpm start', 'address']);
  assert.deepEqual(cmds(plansOf({ 'package.json': JSON.stringify({ scripts: { start: 'electron .' }, devDependencies: { electron: '1' } }), 'yarn.lock': '' }, ['node_modules'])[0]), ['yarn start', 'window']);
  assert.deepEqual(cmds(plansOf({ 'package.json': '{}', 'index.js': '' }, ['node_modules'])[0]), ['node index.js']);
  assert.deepEqual(plansOf({ 'package.json': JSON.stringify({ scripts: { 'dev; rm -rf /': 'x' } }) }), [], 'an odd script name is never used');
});

test('Python: uv or requirements first, then Django, Streamlit or the main file', () => {
  assert.deepEqual(cmds(plansOf({ 'requirements.txt': 'flask\n', 'app.py': '' })[0]), ['python -m pip install -r requirements.txt', 'python app.py']);
  assert.deepEqual(cmds(plansOf({ 'requirements.txt': 'streamlit==1.40\n', 'app.py': '', 'helpers.py': '' })[0]), ['python -m pip install -r requirements.txt', 'streamlit run app.py', 'address']);
  assert.deepEqual(cmds(plansOf({ 'pyproject.toml': '[project]\n', 'uv.lock': '', 'manage.py': '' })[0]), ['uv sync', 'uv run python manage.py runserver', 'address']);
  assert.deepEqual(cmds(plansOf({ 'oyun.py': '' })[0]), ['python oyun.py'], 'one .py file is the program');
  assert.deepEqual(plansOf({ 'a.py': '', 'b.py': '' }), [], 'two files and no main: not guessed');
});

test('engines and others; a plain web page only when nothing else starts it; at most two plans', () => {
  assert.equal(plansOf({}, ['Assets', 'ProjectSettings'])[0].kind, 'unity');
  assert.equal(plansOf({ 'project.godot': '' })[0].kind, 'godot');
  assert.equal(plansOf({ 'Game.uproject': '' })[0].kind, 'unreal');
  assert.deepEqual(cmds(plansOf({ 'pubspec.yaml': '' })[0]), ['flutter pub get', 'flutter run']);
  assert.deepEqual(cmds(plansOf({ 'go.mod': '' })[0]), ['go run .']);
  assert.deepEqual(cmds(plansOf({ 'Cargo.toml': '' })[0]), ['cargo run']);
  assert.deepEqual(cmds(plansOf({ 'App.csproj': '' })[0]), ['dotnet run']);
  assert.deepEqual(plansOf({ 'index.html': '' }), [{ kind: 'static', steps: [{ id: 'open', file: 'index.html' }] }]);
  assert.equal(plansOf({ 'index.html': '', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })[0].kind, 'node');
  assert.equal(plansOf({ 'go.mod': '', 'Cargo.toml': '', 'App.csproj': '' }).length, 2);
});

test('the route: empty, unknown, unreadable (missing, broad, network), not a project', () => {
  const empty = folder({ 'PLAN.md': '#', '.gitignore': '' }, ['.sibersentez', '.git']);
  const unknown = folder({ 'notes.txt': 'x' });
  const projects = [
    { id: 'e', path: empty },
    { id: 'u', path: unknown },
    { id: 'b', path: unknown, broad: true },
    { id: 'n', path: '\\\\server\\share\\p' },
    { id: 'm', path: path.join(unknown, 'missing') },
  ];
  const catalog = { getProject: (id) => projects.find((p) => p.id === id) || null };
  const state = (id) => projectRun({ catalog, projectId: id }).body.state;
  assert.deepEqual(['e', 'u', 'b', 'n', 'm'].map(state), ['empty', 'unknown', 'unreadable', 'unreadable', 'unreadable']);
  assert.equal(projectRun({ catalog, projectId: 'x' }).status, 404);
});

test('the section: steps with copy buttons in both languages, a ready question when unknown, nothing for an unreadable folder', () => {
  const p = { id: 'a', path: 'C:\\p' };
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = runSectionHtml(p, { state: 'ok', plans: [{ kind: 'node', steps: [{ id: 'install', cmd: 'npm install' }, { id: 'script', cmd: 'npm run dev' }, { id: 'address' }] }] });
      assert.ok(h.includes(S.runTitle) && h.includes(S.runKind_node) && h.includes('<code translate="no">npm run dev</code>') && h.includes('data-run-copy') && h.includes(S.runFoot), lang);
      assert.equal((h.match(/data-run-copy/g) || []).length, 2);
      assert.ok(runSectionHtml(p, { state: 'unknown', plans: [] }).includes(S.runAsk), lang);
      assert.ok(runSectionHtml(p, { state: 'empty', plans: [] }).includes(S.runEmpty), lang);
      assert.ok(runSectionHtml(p, null).includes(S.runLoading), lang);
      assert.ok(runSectionHtml(p, { state: 'ok', plans: [{ kind: 'static', steps: [{ id: 'open', file: 'index.html' }] }] }).includes(S.run_open.replace('{file}', 'index.html')), lang);
      for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('run'))) assert.ok(S[k], `${lang} ${k}`);
    }
  } finally {
    setLanguage('en');
  }
  assert.equal(runSectionHtml(p, { state: 'unreadable', plans: [] }), '');
  assert.equal(runSectionHtml({ id: 'h', path: 'C:\\h', kind: 'hub' }, null), '');
  const odd = runSectionHtml(p, { state: 'ok', plans: [{ kind: 'node', steps: [{ id: 'script', cmd: 'npm run dev & calc' }, { id: 'evil' }] }] });
  assert.ok(!odd.includes('calc') && !odd.includes('evil'), 'only the server-shaped command and known steps are shown');
});

test('the cache: asked once, again after 20 s; a failure reads as unreadable', async () => {
  let calls = 0;
  let time = 0;
  const hint = createRunHint({ fetchJson: async () => (calls++, { state: 'empty', plans: [] }), now: () => time });
  hint.get('a');
  hint.get('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  assert.equal(hint.get('a').data.state, 'empty');
  time = 21000;
  hint.get('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2);
  const bad = createRunHint({ fetchJson: async () => Promise.reject(new Error('x')) });
  bad.get('b');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bad.get('b').data.state, 'unreadable');
});

test('"Type in terminal": only with the dock, beside each command (not the question for the AI); the dock types one line and never Enter', async () => {
  const p = { id: 'a', path: 'C:\p' };
  const data = { state: 'ok', plans: [{ kind: 'node', steps: [{ id: 'install', cmd: 'npm install' }, { id: 'address' }] }] };
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = runSectionHtml(p, data, { canType: true });
      assert.ok(h.includes('data-run-type') && h.includes(S.runType) && h.includes(S.runFootType) && !h.includes(S.runFoot), lang);
      assert.ok(!runSectionHtml(p, data).includes('data-run-type'), 'no dock: copy only');
      assert.ok(!runSectionHtml(p, { state: 'unknown', plans: [] }, { canType: true }).includes('data-run-type'), 'the question is for the AI, never typed into a shell');
    }
  } finally {
    setLanguage('en');
  }
  const fs = await import('node:fs');
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  const fn = dock.slice(dock.indexOf('function typeInto('), dock.indexOf('// A reloaded page'));
  assert.ok(fn.includes('/^[\\x20-\\x7e]{1,200}$/.test(text)') && fn.includes('api.write(id, text);'), 'one line of printable ASCII, written as it is');
  // Reused only at an empty prompt (not under a running program or an AI tool started there, not after a command not
  // yet run); two quick clicks wait for each other (review round 1)
  assert.ok(fn.includes('!(atPrompt(old) && quiet(old))') && fn.includes('typing.set(key, done)'));
  const AT = new RegExp(/const AT_PROMPT_RE = (\/.*\/);/.exec(dock)[1].slice(1, -1));
  for (const s of ['PS C:\\p> ', 'x\nPS C:\\Users\\a b\\p>', 'C:\\p>']) assert.ok(AT.test(s), s);
  for (const s of ['PS C:\\p> npm install', 'Flutter run key commands.\nr Hot reload.', '> Try "help"', '│ > ']) assert.ok(!AT.test(s), s);
  assert.ok(!/\\r|\\n|Enter/.test(fn.replace(/\/\/.*$/gm, '')), 'no carriage return is ever sent');
  assert.ok(fn.includes("return typeQueued(`p:${projectId}`, { projectId }, text);") && fn.includes("return typeQueued('setup', { setup: true }, text);") && fn.includes('await open(target)'), 'a plain terminal of its own (the project’s, or the setup one), never the tab an AI tool runs in');
});

test('the setup terminal: the tools panel types there; a command run there that ended checks the tools again', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const dock = read('public/js/terminalDock.js');
  assert.ok(dock.includes("if (key === 'setup' && tabs.get(id)) tabs.get(id).setup = true;"), 'only the setup terminal is watched');
  assert.ok(dock.includes('if (x.setup && x.ranCommand && atPrompt(x)) {'), 'back at an empty prompt after Enter');
  const main = read('public/js/main.js');
  assert.ok(main.includes('onSetupDone: () => loadTools({ refresh: true })'));
  assert.ok(main.includes('if (termDock.available) setSetupTyper((cmd) => termDock.typeSetup(cmd));'), 'only with the dock');
  const tools = read('public/js/views/tools.js');
  assert.ok(tools.includes('if (!setupTyper || !root) return;') && tools.includes('.then((r) => (r?.ok ? close() : say('), 'buttons only with the dock; the panel closes so the terminal is seen');
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].aiType && STRINGS[lang].aiTypeFailed, lang);
});

// 2026-10-02: the result is something to open. A plain web page gets one button (the explorer action with
// open: 'index.html'); the section stands under the job once it is built; the Building's result card links to it.
test('"Open in the browser": only on a plain web page\'s index.html step, only when the page can open it; the result links here', () => {
  const p = { id: 'a', path: 'C:\p' };
  const page = { state: 'ok', plans: [{ kind: 'static', steps: [{ id: 'open', file: 'index.html' }] }] };
  const h = runSectionHtml(p, page, { canOpen: true });
  assert.ok(h.includes('data-run-open') && h.includes(STRINGS.en.runOpenPage));
  assert.ok(!runSectionHtml(p, page).includes('data-run-open'), 'no opener: the step only says to double-click it');
  assert.ok(!h.includes(STRINGS.en.runFoot) && !h.includes(STRINGS.en.runFootType), 'no command, no note on pasting commands');
  assert.ok(!runSectionHtml(p, { state: 'ok', plans: [{ kind: 'static', steps: [{ id: 'open', file: 'other.html' }] }] }, { canOpen: true }).includes('data-run-open'), 'another file: never');
  assert.ok(!runSectionHtml(p, { state: 'ok', plans: [{ kind: 'node', steps: [{ id: 'install', cmd: 'npm install' }] }] }, { canOpen: true }).includes('data-run-open'));
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].runOpenPage && STRINGS[lang].wsResultRun, lang);
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.ok(read('public/js/main.js').includes("payload: { projectId, open: 'index.html' }"), 'the page asks for exactly that file');
  const drawer = read('public/js/views/drawer.js');
  assert.ok(drawer.includes("const built = ['check', 'finish', 'done'].includes(job.get(p.id).data?.step);") && drawer.includes("${built ? runHint.html(p, { quiet: resultFirst }) : ''}") && drawer.includes("${built ? '' : runHint.html(p)}"), 'one run section: under the job once built, else in the details');
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes("button('resultRun', () => dispatch('open-run', a))") && ws.includes("if (job.step === 'done' || job.step === 'finish') body.append(button('resultRun'"));
  assert.ok(read('public/js/main.js').includes("d.action === 'open-run' && d.projectId) open({ type: 'project', id: d.projectId, section: 'run' })"));
});
