// The whole journey a beginner takes (roadmap F1, 2026-10-08), end to end through the real parts: a new project from
// an idea (electron/helpers.mjs createIdeaProject, the shell's message channel server/memory.mjs, server/catalog.mjs),
// a job started in SiberSentez's own terminal (the start-ai action over HTTP, server/actions.mjs), the job's steps as the
// kit's team writes its hand-off files (GET /api/projects/<id>/team), the result (job-changes and run), and going back
// to how the project was before the job (restore-preview, restore-apply). The AI tool is played by the test: it writes
// the files the tool would write. Nothing is started (every spawn throws), no window opens, and every file lives under
// a fresh folder in the system temp folder. Run: node --test test/journey.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initHub } from '../server/hub.mjs';
import { Catalog } from '../server/catalog.mjs';
import { ProjectMemory, createProjectChannel } from '../server/memory.mjs';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { readCurrentJob } from '../server/job-id.mjs';
import { POINT_ID_RE } from '../server/restore.mjs';
import { IDEA_PROJECTS_DIR, checkProjectFolder, createIdeaProject, plannedFolderRefusal } from '../electron/helpers.mjs';
import { getStrings } from '../electron/strings.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-journey-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const touch = (file, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

// Every file below a folder (relative, sorted), the app's notes folder apart
function tree(dir, { notes = false } = {}) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!notes && r === '.sibersentez') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('a beginner\'s journey: new project from an idea → a job in the app\'s terminal → plan approved → built → checked → result seen and accepted → back to before the job', async () => {
  // ---- the computer: a home with Documents, the hub, the program's folder, one AI tool installed
  const home = path.join(TMP, 'home');
  const claudeDir = path.join(home, '.claude');
  const hub = path.join(TMP, 'hub');
  const app = path.join(TMP, 'program');
  for (const d of [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), claudeDir, app]) fs.mkdirSync(d, { recursive: true });
  initHub(hub);
  const cmdExe = touch(path.join(TMP, 'system32', 'cmd.exe'));
  const toolFile = touch(path.join(TMP, 'tools', 'claude.exe'));
  const detector = {
    detect: async () => ({
      at: 5,
      tools: [{ id: 'claude', name: 'Claude Code', installed: true, chosen: { file: toolFile, ext: '.exe', extra: false }, installs: [{ file: toolFile, via: 'native', version: '2.1.284' }], via: 'native', version: '2.1.284', ready: 'yes', app: false }],
      node: { installed: true, version: '24.18.0' },
    }),
  };
  const spawned = [];
  const spawn = (cmd, args) => {
    spawned.push([cmd, args]);
    throw new Error('the journey starts nothing');
  };
  const catalog = new Catalog({ hubDir: hub, claudeDir, homeDir: home, adapters: [], env: {}, memory: new ProjectMemory({ hubDir: hub, debounceMs: 0 }) });
  catalog.load();
  let clock = Date.UTC(2026, 9, 8, 9, 0, 0);
  const ingest = { sessions: new Map(), scan: { done: true } };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const actions = createActions({ catalog, ingest, mode: 'live', hubDir: hub, port, workDir: app, cmdExe, powershellExe: cmdExe, spawn, homeDir: home, claudeDir, now: () => clock, log: () => {}, ai: { tools: detector, env: { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') } } });
  const channel = createProjectChannel({ catalog, appDir: app, terminalTarget: actions.terminalTarget, terminalState: actions.terminalState });
  const call = (() => {
    let id = 0;
    return (msg) => channel.handle({ sibersentez: 'shell-call', id: ++id, ...msg });
  })();
  server.on('request', createHandler({ ingest, catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, tools: detector }));
  const page = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token };
  const post = (body) => {
    clock += 5000; // past the repeat guard
    return request(port, { method: 'POST', path: '/api/action', body, headers: page });
  };
  const get = (p) => request(port, { path: p, headers: { 'Sec-Fetch-Site': 'same-origin' } });

  try {
    // ---- 1. New project: a name and an idea, the folder made under Documents\SiberSentez, remembered by the server
    const rules = { homeDir: home, broadDirs: ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d)), hubPath: hub, programDirs: [app] };
    const made = await createIdeaProject({
      S: getStrings('tr'),
      base: path.join(home, 'Documents', IDEA_PROJECTS_DIR),
      name: 'Kafe menüsü',
      idea: 'Menüsü ve iletişim bilgileri olan bir kafe sayfası',
      exists: (p) => fs.existsSync(p),
      mkdir: (p, recursive) => fs.mkdirSync(p, { recursive }),
      removeEmpty: (p) => fs.rmdirSync(p),
      precheck: (f) => plannedFolderRefusal(f, rules),
      check: (f) => checkProjectFolder(f, rules),
      add: (f) => call({ type: 'project-add', path: f, fresh: true }),
      saveIdea: (projectId, idea) => call({ type: 'project-idea', projectId, idea }),
    });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.created, true);
    const projectId = made.projectId;
    const project = catalog.getProject(projectId);
    const dir = project.path;
    assert.equal(path.basename(path.dirname(dir)), IDEA_PROJECTS_DIR, 'under Documents\\SiberSentez');
    assert.equal(project.idea, 'Menüsü ve iletişim bilgileri olan bir kafe sayfası', 'the idea is kept with the project');
    assert.deepEqual(tree(dir, { notes: true }), [], 'a new, empty folder');
    let team = await get(`/api/projects/${projectId}/team`);
    assert.equal(team.json.step, 'none', 'no job yet');

    // ---- 2. The job starts in the app's own terminal: a copy of the project first, the job's message, its marker
    const started = await post({ action: 'start-ai', projectId, tool: 'claude', job: 'Kafe için menü ve iletişim sayfası yap', inDock: true });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const { jobId, launchId } = started.json;
    assert.equal(started.json.terminal, 'dock');
    assert.match(launchId, /^L[0-9a-f]{24}$/);
    assert.ok(started.json.restorePoint?.id, 'the copy before the job');
    assert.equal(readCurrentJob(path.join(dir, '.sibersentez')).jobId, jobId);
    const message = fs.readFileSync(path.join(dir, started.json.firstMessage.file), 'utf8');
    assert.ok(message.includes(`Job-ID: ${jobId}`) && message.includes('Kafe için menü ve iletişim sayfası yap'), 'the job reaches the tool in its message');
    team = await get(`/api/projects/${projectId}/team`);
    assert.equal(team.json.step, 'plan', 'waiting for a plan');

    // The shell redeems the launch once and runs the launcher in the project folder; then reports the tab running
    const target = call({ type: 'terminal-target', launchId });
    assert.equal(target.ok, true, JSON.stringify(target));
    assert.equal(target.dir, dir);
    assert.equal(target.jobId, jobId);
    // Windows: the Command Prompt runs the launcher; Linux and macOS: sh (plan G1)
    assert.equal(target.program.file, process.platform === 'win32' ? cmdExe : '/bin/sh');
    assert.equal(call({ type: 'terminal-target', launchId }).ok, false, 'a launch is redeemed once');
    assert.equal(call({ type: 'terminal-state', sessions: [{ id: 't1', projectId, ai: true, tool: 'claude', jobId, running: true }] }).ok, true);

    // ---- 3. The tool plans; the person approves; it builds; the check approves; the person accepts the result
    const team_ = (name, text) => touch(path.join(dir, '.sibersentez', name), text);
    team_('PLAN.md', `# Plan: Kafe sayfası\nJob-ID: ${jobId}\nSize: small\nApproved: no\n`);
    team = await get(`/api/projects/${projectId}/team`);
    assert.deepEqual([team.json.step, team.json.plan.title, team.json.plan.approved], ['plan', 'Kafe sayfası', false], 'the plan waits for the person');
    team_('PLAN.md', `# Plan: Kafe sayfası\nJob-ID: ${jobId}\nSize: small\nApproved: yes\n`);
    team_('TASKS.md', `# Tasks\nJob-ID: ${jobId}\n## T1: Menü ve iletişim sayfası\n- owner: builder\n- status: doing\n`);
    team = await get(`/api/projects/${projectId}/team`);
    assert.deepEqual([team.json.step, team.json.current?.title, team.json.tool], ['build', 'Menü ve iletişim sayfası', 'claude']);
    touch(path.join(dir, 'index.html'), '<!doctype html><title>Kafe</title><h1>Menü</h1><p>Çay 20 TL</p><footer>İletişim</footer>\n');
    team_('TASKS.md', `# Tasks\nJob-ID: ${jobId}\n## T1: Menü ve iletişim sayfası\n- owner: builder\n- status: done\n`);
    team = await get(`/api/projects/${projectId}/team`);
    assert.equal(team.json.step, 'check', 'built, not yet checked');
    team_('REVIEW.md', `## Review: whole job\nJob-ID: ${jobId}\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n`);
    team = await get(`/api/projects/${projectId}/team`);
    assert.equal(team.json.step, 'finish', 'checked: the result waits for the person');

    // ---- 4. The result: what the job changed, and how to open it
    const changes = await get(`/api/projects/${projectId}/job-changes?job=${jobId}`);
    assert.equal(changes.status, 200);
    assert.equal(changes.json.basis, 'start');
    assert.deepEqual([changes.json.added, changes.json.changed, changes.json.deleted], [['index.html'], [], []], 'the new page, the app\'s notes apart');
    assert.ok(changes.json.notes > 0, 'the notes are counted on their own');
    const run = await get(`/api/projects/${projectId}/run`);
    assert.equal(run.status, 200);
    assert.ok(JSON.stringify(run.json.plans).includes('index.html'), `the page can be opened: ${run.text}`);
    team_('PLAN.md', `# Plan: Kafe sayfası\nJob-ID: ${jobId}\nSize: small\nApproved: yes\nResult: accepted\n`);
    team = await get(`/api/projects/${projectId}/team`);
    assert.equal(team.json.step, 'done');

    // ---- 5. Going back: refused while the tool still runs, then a preview and the return to before the job
    const restore = (await get(`/api/projects/${projectId}/restore`)).json;
    const point = restore.jobs.find((j) => j.jobId === jobId);
    assert.ok(point, 'the job\'s copy is listed with its job');
    const busy = await post({ action: 'restore-apply', projectId, pointId: point.id });
    assert.deepEqual([busy.status, busy.json.error], [409, 'ai-working']);
    assert.equal(call({ type: 'terminal-state', sessions: [{ id: 't1', projectId, ai: true, tool: 'claude', jobId, running: false }] }).ok, true, 'the tool ended, its shell stays');
    const preview = await post({ action: 'restore-preview', projectId, pointId: point.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.ok(preview.json.added.includes('index.html'), 'the preview says the page goes');
    assert.equal(preview.json.added[0], 'index.html', 'the project\'s own file first, the team\'s notes after');
    assert.equal(preview.json.notes.added, preview.json.added.filter((n) => n.startsWith('.sibersentez/')).length, 'the notes counted apart');
    assert.ok(preview.json.notes.added >= 4, 'the job message, its marker, the plan, the tasks, the review');
    assert.equal(preview.json.result.executed, false);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'a preview changes nothing');
    const back = await post({ action: 'restore-apply', projectId, pointId: point.id, planId: preview.json.planId });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal(back.json.result.executed, true);
    assert.match(String(back.json.before), POINT_ID_RE,'the present was kept first, so going back can be undone');
    assert.deepEqual(tree(dir), [], 'the project is as it was before the job');
    assert.deepEqual(spawned, [], 'nothing was started');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
