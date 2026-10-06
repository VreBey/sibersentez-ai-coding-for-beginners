// Hardening tests of the first security review round that fit no other test file: the page's QA hooks never send a
// live action, a timed-out process is ended with its whole tree, and the usage ledger's size limit and set-aside
// copies. Run: node --test test/hardening.test.mjs
// Hermetic: no program is started (spawn is always a fake), no network, files only under the system temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { killTree, taskkillPath, runQuiet } from '../server/tools.mjs';
import * as usage from '../server/usage.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-hardening-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PUBLIC_JS = path.join(import.meta.dirname, '..', 'public', 'js');
const js = (rel) => fs.readFileSync(path.join(PUBLIC_JS, ...rel.split('/')), 'utf8');

// ---------------- QA hooks (item 3): an address another site can open never sends a live action ----------------

test('QA hooks of the import section: ?qa=1&import= and ?qa=1&github=<link> scan and fetch only in Preview (a plan, no request); in live mode and Off they send nothing', async () => {
  const { qaImportHooks } = await import('../public/js/views/roster.js');
  assert.equal(typeof qaImportHooks, 'function', 'the QA hooks are decided by one pure function');
  const link = '?qa=1&tab=roster&github=https://github.com/acme/skills';
  // Live: a page elsewhere can open http://127.0.0.1:<port>/?qa=1&github=... (a document navigation is allowed)
  const live = qaImportHooks(link, 'live');
  assert.deepEqual([live.fetch, live.scan, live.url, live.tab], [false, false, 'https://github.com/acme/skills', 'github'], 'the link only fills the field');
  assert.equal(qaImportHooks('?qa=1&import=C:\\Users\\x\\Documents', 'live').scan, false, 'no scan of a folder either');
  assert.equal(qaImportHooks(link, 'off').fetch, false);
  // Preview: the server answers with the plan and reaches nothing
  assert.equal(qaImportHooks(link, 'dry').fetch, true);
  assert.equal(qaImportHooks('?qa=1&import=C:\\src', 'dry').scan, true);
  // The samples never go to the server, in any mode
  for (const mode of ['live', 'dry', 'off']) {
    const d = qaImportHooks('?qa=1&github=demo-done', mode);
    assert.deepEqual([d.sample, d.fetch, d.url], ['demo-done', false, null], mode);
  }
  // Without ?qa nothing happens at all
  assert.deepEqual(qaImportHooks('?github=https://github.com/a/b&import=C:\\x', 'dry'), { open: false, tab: null, source: null, url: null, sample: null, scan: false, fetch: false });
  // The view acts only on the plan: scan() and ghFetch() are started from the hooks through its flags only
  const src = js('views/roster.js');
  const from = src.indexOf('qaImportHooks(location.search');
  assert.ok(from > 0, 'the view reads the hooks through qaImportHooks');
  const block = src.slice(from, src.indexOf('// Categories offered for an import'));
  const gated = /if \(\w+\.scan\) scan\(\);|if \(\w+\.fetch\) ghFetch\(\);/g;
  assert.equal((block.match(gated) || []).length, 2, 'scan() and ghFetch() only behind the flags');
  assert.doesNotMatch(block.replace(gated, ''), /\bscan\(\)|ghFetch\(\)|runAction\(/, 'no other call sends an action');
});

test('QA hooks elsewhere: the context menu pick and the install flow run only in Preview; the tools panel and the new-project stand-in send no action', () => {
  const main = js('main.js');
  assert.match(main, /if \(pick && qaDry\(\)\)/);
  assert.match(main, /if \(!flow \|\| !qaDry\(\)\) return;/);
  assert.match(main, /const qaDry = \(\) => actionsState\(\)\.mode === 'dry';/);
  const tools = js('views/tools.js');
  const hook = tools.slice(tools.indexOf("q.has('qa') && q.get('aitools')"), tools.indexOf('// Tests: back to the first state'));
  assert.doesNotMatch(hook, /runAction\(/, 'the tools panel reads GET /api/tools only');
});

// ---------------- a process past its time limit (item 8): the whole tree is ended ----------------

// A fake spawn: every call is recorded; the tool never ends by itself (pid 4321), taskkill "runs"
function treeSpawn(calls, { failTaskkill = false } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (/taskkill\.exe$/i.test(cmd) && failTaskkill) throw Object.assign(new Error('no taskkill'), { code: 'ENOENT' });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.pid = /taskkill\.exe$/i.test(cmd) ? 99 : 4321;
    child.kill = () => (child.killed = true);
    return child;
  };
}

test('killTree: taskkill /T /F /PID <pid> by absolute path (%SystemRoot%\\System32), hidden, no shell; child.kill() elsewhere, without a pid, or when taskkill cannot start', () => {
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\taskkill.exe');
  assert.equal(taskkillPath({ systemroot: 'C:\\Windows' }), 'C:\\Windows\\System32\\taskkill.exe', 'any letter case');
  for (const bad of [{}, { SystemRoot: '%EVIL%' }, { SystemRoot: 'relative\\win' }, { SystemRoot: '\\\\server\\share' }]) assert.equal(taskkillPath(bad), 'C:\\Windows\\System32\\taskkill.exe', JSON.stringify(bad));
  const calls = [];
  const child = { pid: 4321, kill: () => (child.killed = true) };
  killTree(treeSpawn(calls), child, { env: { SystemRoot: 'C:\\Windows' }, platform: 'win32' });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].cmd, calls[0].args], ['C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4321']]);
  assert.deepEqual([calls[0].opts.windowsHide, calls[0].opts.shell, calls[0].opts.stdio], [true, false, 'ignore']);
  assert.equal(child.killed, undefined, 'the tree is ended by taskkill');
  // No taskkill: the process itself
  const c2 = { pid: 4321, kill: () => (c2.killed = true) };
  killTree(treeSpawn([], { failTaskkill: true }), c2, { platform: 'win32' });
  assert.equal(c2.killed, true);
  const c3 = { kill: () => (c3.killed = true) };
  const none = [];
  killTree(treeSpawn(none), c3, { platform: 'win32' });
  assert.deepEqual([c3.killed, none.length], [true, 0], 'no pid: nothing else is started');
  const c4 = { pid: 7, kill: () => (c4.killed = true) };
  killTree(treeSpawn(none), c4, { platform: 'linux' });
  assert.deepEqual([c4.killed, none.length], [true, 0]);
});

test('runQuiet: a version check past its time limit ends cmd.exe and the Node.js process it started (taskkill /T), not cmd.exe alone', async () => {
  const calls = [];
  const spawn = treeSpawn(calls);
  const env = { SystemRoot: 'C:\\Windows' };
  const r = await runQuiet(spawn, { cmd: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'gemini.cmd --version'], verbatim: true }, { cwd: 'C:\\t', env, timeoutMs: 20, capture: true, killTree: (c) => killTree(spawn, c, { env, platform: 'win32' }) });
  assert.equal(r.timedOut, true);
  assert.deepEqual(
    calls.map((c) => [c.cmd, c.args.join(' ')]),
    [
      ['C:\\Windows\\System32\\cmd.exe', '/d /c gemini.cmd --version'],
      ['C:\\Windows\\System32\\taskkill.exe', '/T /F /PID 4321'],
    ],
  );
  // The default of runQuiet on Windows is the same tree kill
  if (process.platform === 'win32') {
    const d = [];
    await runQuiet(treeSpawn(d), { cmd: 'C:\\x\\tool.exe', args: [], verbatim: false }, { cwd: 'C:\\x', env, timeoutMs: 20, capture: false });
    assert.deepEqual(d[1]?.args, ['/T', '/F', '/PID', '4321']);
  }
});

// ---------------- the usage ledger (item 13): a size limit, and set-aside copies that are never overwritten ----------------

test('usage ledger: a file over 8 MB is set aside unread and rebuilt; a broken file never replaces the copy set aside before (time-stamped names, at most 3 kept)', () => {
  const NOW = Date.UTC(2026, 8, 29, 12);
  const hub = path.join(ROOT, 'hub-ledger');
  const dir = path.join(hub, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  const file = usage.ledgerFile(hub);
  const logs = [];
  const open = () => new usage.UsageLedger({ hubDir: hub, now: () => NOW, log: (l) => logs.push(l), debounceMs: 0 });
  assert.equal(usage.LEDGER_MAX_BYTES, 8 * 1024 * 1024);
  // A valid ledger, only too large: never read (JSON.parse of a huge file would hold the start up)
  const h = usage.hourLabel(Math.floor((NOW - 3600000) / 3600000));
  const big = { version: 1, hours: { [h]: { p1: { m: [1, 0, 0, 0, 5, 1] } } }, days: {}, pad: 'x'.repeat(usage.LEDGER_MAX_BYTES) };
  fs.writeFileSync(file, JSON.stringify(big));
  const l = open();
  assert.equal(l.report('30d').totals.messages, 0, 'nothing was read from it');
  assert.match(logs.at(-1), /8 MB/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.statSync(`${file}.broken`).size > usage.LEDGER_MAX_BYTES, 'kept aside as it was');
  // Five broken files one after another: the newest is ledger.json.broken, two older ones keep a time-stamped name
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(file, `broken ${i}`);
    open();
  }
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith('ledger.json.broken')).sort();
  assert.equal(kept.length, 3, kept.join(', '));
  assert.ok(kept.includes('ledger.json.broken'));
  assert.equal(fs.readFileSync(`${file}.broken`, 'utf8'), 'broken 5');
  const older = kept.filter((n) => n !== 'ledger.json.broken');
  for (const n of older) assert.match(n, /^ledger\.json\.broken-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/, n);
  assert.deepEqual(older.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort(), ['broken 3', 'broken 4'], 'the most recent copies, none overwritten');
});
