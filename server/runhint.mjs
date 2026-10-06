// "How to run it" (docs/run-hint.md): after the AI built something, a beginner does not know how to start it. This
// reads the names in the project folder and a few small manifest files (the same ones server/suggest.mjs reads) and
// says, in steps, what to install first and which command starts it. Read-only: nothing is run, written or installed,
// and no action mode is needed. Every command is built from fixed words and names checked against a plain pattern
// (a script or file name from the project never reaches a command as it is).
import path from 'node:path';
import { isLocalPath } from './fsutil.mjs';
import { normPath } from './util.mjs';
import { isRealDir, hasStreamColon } from './library.mjs';
import { signalRoot, readSmall, names } from './suggest.mjs';

// Scripts that start something, most likely first
const START_SCRIPTS = ['dev', 'start', 'serve', 'preview'];
// A Python file that is probably the program, most likely first
const PY_MAIN = ['main.py', 'app.py', 'bot.py', 'run.py', 'server.py'];
const NODE_MAIN = ['index.js', 'server.js', 'app.js', 'main.js'];
// A letter, digit or _ first: a name starting with "-" would read as an option of python (review round 1)
const PY_FILE_RE = /^\w[\w.-]{0,59}\.py$/;
// Files an empty project may already hold (SiberSentez's first message, git, a plan, a readme)
const EMPTY_OK = new Set(['.sibersentez', '.orkestra', '.git', '.gitignore', '.claude', 'plan.md', 'readme.md', 'claude.md', 'agents.md', 'gemini.md', '.vscode', '.idea', 'license', 'license.md']);

function json(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// What the folder holds (plain facts; the only part that reads the disk). dir: the project folder.
export function runFacts(dir) {
  const entries = names(dir);
  const lower = new Map(entries.map((d) => [d.name.toLowerCase(), d]));
  const file = (n) => !!lower.get(n)?.isFile();
  const folder = (n) => !!lower.get(n) && isRealDir(path.join(dir, lower.get(n).name));
  const f = { empty: entries.every((d) => EMPTY_OK.has(d.name.toLowerCase())) };
  const pkg = file('package.json') ? json(readSmall(path.join(dir, 'package.json')) || '') : null;
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    f.node = {
      pm: file('pnpm-lock.yaml') ? 'pnpm' : file('yarn.lock') ? 'yarn' : file('bun.lockb') || file('bun.lock') ? 'bun' : 'npm',
      installed: folder('node_modules'),
      script: START_SCRIPTS.find((s) => typeof scripts[s] === 'string') || null,
      main: NODE_MAIN.find(file) || null,
      electron: 'electron' in deps,
    };
  }
  const req = file('requirements.txt') ? readSmall(path.join(dir, 'requirements.txt')) || '' : null;
  const pyFiles = entries.filter((d) => d.isFile() && PY_FILE_RE.test(d.name)).map((d) => d.name);
  if (req !== null || file('pyproject.toml') || pyFiles.length) {
    const deps = `${req || ''}\n${file('pyproject.toml') ? readSmall(path.join(dir, 'pyproject.toml')) || '' : ''}`.toLowerCase();
    f.python = {
      requirements: req !== null,
      uv: file('uv.lock'),
      django: file('manage.py'),
      streamlit: /(^|[\s"'])streamlit\b/m.test(deps),
      main: PY_MAIN.find(file) || (pyFiles.length === 1 ? pyFiles[0] : null),
    };
  }
  f.index = file('index.html');
  f.unity = folder('assets') && folder('projectsettings');
  f.godot = file('project.godot');
  f.unreal = entries.some((d) => d.isFile() && /\.uproject$/i.test(d.name));
  f.flutter = file('pubspec.yaml');
  f.go = file('go.mod');
  f.rust = file('cargo.toml');
  f.dotnet = entries.some((d) => d.isFile() && /\.(csproj|sln)$/i.test(d.name));
  return f;
}

// The plans (pure): [{ kind, steps: [{ id, cmd? , file? }] }], the most likely first, at most two. A step's id is a
// text of the page (run_<id>); cmd is shown with a copy button; file is a name from the folder, shown as text.
export function runPlans(f) {
  const out = [];
  const add = (kind, steps) => out.push({ kind, steps });
  if (f.unity) add('unity', [{ id: 'unity' }]);
  if (f.godot) add('godot', [{ id: 'godot' }]);
  if (f.unreal) add('unreal', [{ id: 'unreal' }]);
  if (f.node && (f.node.script || f.node.main)) {
    const { pm } = f.node;
    const steps = [];
    if (!f.node.installed) steps.push({ id: 'install', cmd: `${pm} install` });
    if (f.node.script) {
      const s = f.node.script;
      steps.push({ id: 'script', cmd: pm === 'npm' ? (s === 'start' ? 'npm start' : `npm run ${s}`) : `${pm} ${s === 'start' ? 'start' : s}` });
      steps.push({ id: f.node.electron ? 'window' : 'address' });
    } else steps.push({ id: 'node', cmd: `node ${f.node.main}` });
    add('node', steps);
  }
  if (f.python && (f.python.django || f.python.main)) {
    const steps = [];
    const run = f.python.django ? 'manage.py runserver' : null;
    if (f.python.uv) steps.push({ id: 'uvsync', cmd: 'uv sync' });
    else if (f.python.requirements) steps.push({ id: 'pip', cmd: 'python -m pip install -r requirements.txt' });
    const pre = f.python.uv ? 'uv run ' : '';
    if (run) steps.push({ id: 'script', cmd: `${pre}python ${run}` }, { id: 'address' });
    else if (f.python.streamlit) steps.push({ id: 'script', cmd: `${pre}streamlit run ${f.python.main}` }, { id: 'address' });
    else steps.push({ id: 'python', cmd: `${pre}python ${f.python.main}` });
    add('python', steps);
  }
  if (f.flutter) add('flutter', [{ id: 'flutterget', cmd: 'flutter pub get' }, { id: 'script', cmd: 'flutter run' }]);
  if (f.go) add('go', [{ id: 'script', cmd: 'go run .' }]);
  if (f.rust) add('rust', [{ id: 'script', cmd: 'cargo run' }]);
  if (f.dotnet) add('dotnet', [{ id: 'script', cmd: 'dotnet run' }]);
  // A plain web page: only when nothing above starts the project (a web app's index.html is served, not opened)
  if (f.index && !out.length) add('static', [{ id: 'open', file: 'index.html' }]);
  return out.slice(0, 2);
}

// GET /api/projects/<id>/run -> { status, body }. body: { project, state: 'ok' | 'empty' | 'unknown' | 'unreadable',
// plans }. unreadable: no folder that may be read (missing, broad, temporary, a network path).
export function projectRun({ catalog, projectId, facts = runFacts }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  const body = { project: p.id, state: 'unreadable', plans: [] };
  const isBroad = (dir) => typeof catalog.isBroad === 'function' && !!catalog.isBroad(normPath(dir));
  if (!p.path || p.broad || p.tmpOnly || !isLocalPath(p.path) || hasStreamColon(p.path) || isBroad(p.path)) return { status: 200, body };
  const dir = signalRoot(p.path, { broad: isBroad });
  if (!dir) return { status: 200, body };
  const f = facts(dir);
  body.plans = runPlans(f);
  body.state = body.plans.length ? 'ok' : f.empty ? 'empty' : 'unknown';
  return { status: 200, body };
}
