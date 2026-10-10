// Behaviour tests for the Electron shell rules (electron/helpers.mjs, logger.mjs, strings.mjs), which main.mjs
// only wires to Electron events; plus wiring and packaging checks (main.mjs text, package.json, installer.nsh).
// Ports come from the OS (ephemeral); 4545 is never touched. Temporary files go to the system temp folder.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_PERMISSIONS,
  HUB_DIR_NAME,
  HUB_SETTINGS_FILE,
  INSTANCE_HEADER,
  LOGIN_ITEM_NAME,
  PORT_RANGE_END,
  PORT_RANGE_START,
  SUPERVISOR_DEFAULTS,
  appOrigin,
  RESTART_RECHECK_MS,
  buildServerEnv,
  canonicalPath,
  checkLocalDir,
  classifyNavigation,
  decideNavigation,
  describeUrl,
  findFreePort,
  foldersOverlap,
  initialSupervisor,
  isAppUrl,
  isExternalUrl,
  isInside,
  isPortFree,
  pathsOverlap,
  permissionAllowed,
  pickLanguage,
  probeServer,
  readHubLanguageSetting,
  readQaOptions,
  redactHome,
  requestAllowed,
  resolveHubPath,
  restartDelay,
  restartDue,
  samePath,
  superviseStep,
  waitForServer,
  windowOptions,
} from '../electron/helpers.mjs';
import { createLogger } from '../electron/logger.mjs';
import { STRINGS, formatString, getStrings } from '../electron/strings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-electron-test-'));
const WIN = { skip: process.platform !== 'win32' && 'Windows paths' };
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
// A run of n ports that are free now, outside Windows' automatic range (49152 and up): the other test files that
// listen on port 0 get neighbouring automatic ports, so a range next to one of them was sometimes taken meanwhile
// (an EADDRINUSE red run, seen 2026-10-08)
async function freeRange(n) {
  for (let tries = 0; tries < 40; tries++) {
    const start = 20000 + Math.floor(Math.random() * 9000);
    const held = [];
    try {
      for (let p = start; p < start + n; p++) {
        const s = net.createServer();
        await listen(s, p);
        held.push(s);
      }
      return start;
    } catch {
      /* one of them is in use: another range */
    } finally {
      await Promise.all(held.map(close));
    }
  }
  throw new Error('no free range');
}

// ------------------------------------------------------------------ ports
describe('free port lookup', () => {
  test('the shell has its own port range, away from 4545', () => {
    assert.equal(PORT_RANGE_START, 47700);
    assert.equal(PORT_RANGE_END, 47799);
    assert.ok(!(4545 >= PORT_RANGE_START && 4545 <= PORT_RANGE_END));
  });

  test('skips a busy port and returns the next free one', async () => {
    const busy = net.createServer();
    const port = await listen(busy);
    try {
      assert.equal(await isPortFree(port), false, 'a listening port must not count as free');
      // The system's random port can sit near the top (Windows hands out 49152-65535): the range stops at 65535, and
      // below the busy port when there is no room above it (a red run under load, 2026-10-09)
      const above = port <= 65535 - 19;
      const range = above ? { start: port, end: port + 19 } : { start: port - 19, end: port };
      const found = await findFreePort(range);
      assert.ok(found !== port && found >= range.start && found <= range.end);
    } finally {
      await close(busy);
    }
  });

  test('tries the preferred port first, falls back to the range when it is busy', async () => {
    const start = await freeRange(6);
    assert.equal(await findFreePort({ start, end: start + 5, preferred: start + 3 }), start + 3);
    const busy = net.createServer();
    await listen(busy, start + 3);
    try {
      // Another program may hold a port of the range meanwhile (a rare red run in a clean clone, 2026-10-05): any
      // free port of the range but the busy one
      const got = await findFreePort({ start, end: start + 5, preferred: start + 3 });
      assert.ok(got >= start && got <= start + 5 && got !== start + 3, String(got));
    } finally {
      await close(busy);
    }
    assert.equal(await findFreePort({ start, end: start + 5, preferred: 4545 }), start, 'a preferred port outside the range is ignored');
  });

  test('throws when the whole range is busy; rejects an invalid range', async () => {
    const busy = net.createServer();
    const port = await listen(busy);
    try {
      await assert.rejects(findFreePort({ start: port, end: port }), /no free port found/);
    } finally {
      await close(busy);
    }
    for (const r of [{ start: 0, end: 10 }, { start: 10, end: 5 }, { start: 1.5, end: 9 }, { start: 65000, end: 65536 }, { start: '4545', end: 4600 }]) {
      await assert.rejects(findFreePort(r), RangeError, JSON.stringify(r));
    }
  });
});

// ------------------------------------------------------------------ paths
describe('path comparison', () => {
  test('same path, containment and overlap (Windows: case-insensitive, trailing separator ignored)', WIN, () => {
    assert.equal(samePath('C:\\Apps\\SiberSentez', 'c:\\apps\\sibersentez\\'), true);
    assert.equal(isInside('C:\\Apps\\SiberSentez\\hub', 'C:\\Apps\\SiberSentez'), true);
    assert.equal(isInside('C:\\Apps\\SiberSentez', 'C:\\Apps\\SiberSentez'), false);
    assert.equal(isInside('C:\\Apps\\SiberSentez2', 'C:\\Apps\\SiberSentez'), false, 'a shared name prefix is not containment');
    assert.equal(pathsOverlap('C:\\Apps\\SiberSentez\\hub', 'C:\\Apps\\SiberSentez'), true);
    assert.equal(pathsOverlap('C:\\Users\\a', 'C:\\Users\\a\\AppData\\Local\\Programs\\SiberSentez'), true);
    assert.equal(pathsOverlap('C:\\Users\\a\\SiberSentez', 'C:\\Users\\a\\AppData\\Local\\Programs\\SiberSentez'), false);
    assert.equal(pathsOverlap('C:\\Apps\\SiberSentez2', 'C:\\Apps\\SiberSentez'), false);
  });
});

describe('real-path overlap (hub vs. program folder)', () => {
  const base = path.join(TMP, 'real');
  const app = path.join(base, 'Program Folder Long Name');
  const link = path.join(base, 'junction-to-app');
  fs.mkdirSync(app, { recursive: true });
  fs.symlinkSync(app, link, 'junction'); // junctions need no admin rights on Windows

  test('a junction into the program folder cannot sidestep the check (hub not created yet)', WIN, () => {
    const hub = path.join(link, 'hub');
    assert.equal(pathsOverlap(hub, app), false, 'as written the paths look unrelated');
    assert.equal(canonicalPath(hub).toLowerCase(), path.join(app, 'hub').toLowerCase());
    assert.equal(foldersOverlap(hub, app), true);
    assert.equal(foldersOverlap(link, app), true);
    assert.equal(foldersOverlap(path.join(base, 'elsewhere', 'hub'), app), false);
  });

  test('an 8.3 short name cannot sidestep the check (when the volume has short names)', WIN, (t) => {
    let short = '';
    try {
      // verbatim: cmd.exe must get the quotes as written, not Node's escaped form
      short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${app}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
    } catch {
      short = '';
    }
    if (!short || samePath(short, app)) return t.skip('8.3 short names are disabled on this volume');
    assert.equal(pathsOverlap(path.join(short, 'hub'), app), false, 'as written the short name looks unrelated');
    assert.equal(foldersOverlap(path.join(short, 'hub'), app), true);
  });

  test('missing paths and failing realpath never throw; the lexical check still applies', () => {
    const missing = path.join(TMP, 'does', 'not', 'exist', 'hub');
    assert.equal(canonicalPath(missing).toLowerCase(), path.join(fs.realpathSync.native(TMP), 'does', 'not', 'exist', 'hub').toLowerCase());
    const failing = () => {
      throw new Error('EACCES');
    };
    assert.equal(canonicalPath(missing, failing), path.resolve(missing));
    assert.equal(foldersOverlap(path.join(app, 'x'), app, failing), true);
    assert.equal(foldersOverlap(missing, app, failing), false);
    if (process.platform === 'win32') assert.equal(canonicalPath('Q:\\surely\\missing\\drive'), 'Q:\\surely\\missing\\drive');
  });
});

describe('local folder validation (SIBERSENTEZ_HUB, SIBERSENTEZ_DATA_DIR, QA screenshot folder)', () => {
  const home = path.join(TMP, 'home');

  test('a local absolute folder is accepted and normalised', WIN, () => {
    const dir = path.join(TMP, 'hub', '..', 'hub2');
    assert.deepEqual(checkLocalDir(`  ${dir}  `, { homeDir: home }), { ok: true, path: path.join(TMP, 'hub2') });
    assert.equal(checkLocalDir(path.join(home, 'SiberSentez'), { homeDir: home }).ok, true, 'inside the home folder is fine');
  });

  test('network, device, relative, drive-root, home and invalid paths are rejected', WIN, () => {
    const cases = {
      '\\\\server\\share\\hub': 'network or device path',
      '//server/share/hub': 'network or device path',
      '\\\\?\\C:\\hub': 'network or device path',
      '\\\\.\\PhysicalDrive0': 'network or device path',
      'relative\\hub': 'not an absolute local path',
      'C:hub': 'not an absolute local path',
      '\\hub': 'not an absolute local path',
      'C:\\': 'drive root',
      'D:/': 'drive root',
      'C:\\hub\\a:b': 'invalid characters',
      'C:\\hub\\a|b': 'invalid characters',
      '': 'empty',
      '   ': 'empty',
    };
    for (const [raw, reason] of Object.entries(cases)) assert.deepEqual(checkLocalDir(raw, { homeDir: home }), { ok: false, reason }, raw);
    assert.equal(checkLocalDir(home, { homeDir: home }).reason, 'home folder or one of its parents');
    assert.equal(checkLocalDir(home.toUpperCase(), { homeDir: home }).reason, 'home folder or one of its parents');
    assert.equal(checkLocalDir(TMP, { homeDir: home }).reason, 'home folder or one of its parents');
    for (const v of [null, undefined, 42, {}]) assert.equal(checkLocalDir(v).ok, false);
  });
});

// ------------------------------------------------------------------ hub path
describe('hub path resolution', () => {
  const home = path.join(TMP, 'home');

  test('a valid SIBERSENTEZ_HUB is used', WIN, () => {
    const hub = path.join(TMP, 'other-hub');
    assert.deepEqual(resolveHubPath({ SIBERSENTEZ_HUB: hub }, home), { path: hub, source: 'env', rejected: null });
    assert.equal(resolveHubPath({ SIBERSENTEZ_HUB: `  ${hub}  ` }, undefined).path, hub, 'no home needed when the variable is valid');
  });

  test('missing SIBERSENTEZ_HUB falls back to <home>\\SiberSentez', () => {
    const expected = { path: path.join(home, HUB_DIR_NAME), source: 'default', rejected: null };
    assert.equal(HUB_DIR_NAME, 'SiberSentez');
    for (const env of [{}, { SIBERSENTEZ_HUB: '' }, { SIBERSENTEZ_HUB: '   ' }, { SIBERSENTEZ_HUB: 42 }, undefined, null]) {
      assert.deepEqual(resolveHubPath(env, home), expected, JSON.stringify(env));
    }
  });

  test('an invalid SIBERSENTEZ_HUB is rejected with a reason and the default is used', WIN, () => {
    assert.deepEqual(resolveHubPath({ SIBERSENTEZ_HUB: '\\\\nas\\share\\hub' }, home), { path: path.join(home, 'SiberSentez'), source: 'default', rejected: 'network or device path' });
    assert.equal(resolveHubPath({ SIBERSENTEZ_HUB: 'relative-hub' }, home).rejected, 'not an absolute local path');
    assert.equal(resolveHubPath({ SIBERSENTEZ_HUB: home }, home).rejected, 'home folder or one of its parents');
  });

  test('throws when the default is needed but the home folder is unknown', () => {
    assert.throws(() => resolveHubPath({}, ''), /home folder/);
    assert.throws(() => resolveHubPath({ SIBERSENTEZ_HUB: 'relative' }, undefined), /home folder/);
  });
});

// ------------------------------------------------------------------ navigation
describe('own-origin rule', () => {
  const origin = appOrigin(47712);

  test('origin format and own addresses', () => {
    assert.equal(origin, 'http://127.0.0.1:47712');
    for (const u of [`${origin}/`, origin, `${origin}/api/snapshot?x=1`, `${origin}/#/roster`, `${origin}/css/app.css`]) {
      assert.equal(isAppUrl(u, origin), true, u);
    }
  });

  test('other ports, hosts, schemes, credentials and look-alikes are not own', () => {
    const bad = [
      'http://127.0.0.1:4545/',
      'http://127.0.0.1:47713/',
      'http://localhost:47712/',
      'https://127.0.0.1:47712/',
      'http://127.0.0.1:47712@evil.example/',
      'http://127.0.0.1:477120/',
      'http://user:pw@127.0.0.1:47712/',
      'http://[::1]:47712/',
      'file:///C:/Windows/win.ini',
      'data:text/html,<b>x</b>',
      'javascript:alert(1)',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      '',
      `${origin}/${'a'.repeat(5000)}`,
    ];
    for (const u of bad) assert.equal(isAppUrl(u, origin), false, u);
    for (const u of [null, undefined, 42, {}]) assert.equal(isAppUrl(u, origin), false, String(u));
  });

  test('with an invalid origin (server not ready) nothing is own; "null" origins never match', () => {
    assert.equal(isAppUrl(`${origin}/`, null), false);
    assert.equal(isAppUrl('data:text/html,x', 'null'), false);
    assert.equal(isAppUrl('file:///C:/x', 'null'), false);
    assert.equal(classifyNavigation('data:text/html,x', 'null'), 'deny');
  });
});

describe('navigation decisions (what main.mjs does on each event)', () => {
  const origin = appOrigin(47712);
  const own = `${origin}/api/x`;
  const ext = 'https://nodejs.org/en';
  const stay = { cancel: false, openExternal: false };
  const block = { cancel: true, openExternal: false };
  const browser = { cancel: true, openExternal: true };

  test('main-frame navigation: own stays, external http(s) goes to the browser, other schemes are blocked', () => {
    assert.deepEqual(decideNavigation('navigate', own, origin), stay);
    assert.deepEqual(decideNavigation('navigate', ext, origin), browser);
    assert.deepEqual(decideNavigation('navigate', 'http://127.0.0.1:4545/', origin), browser);
    for (const u of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ms-settings:display', 'data:text/html,x', 'not a url']) {
      assert.deepEqual(decideNavigation('navigate', u, origin), block, u);
    }
  });

  test('redirects and subframes stay inside our origin and never open the browser', () => {
    for (const kind of ['redirect', 'frame']) {
      assert.deepEqual(decideNavigation(kind, own, origin), stay, kind);
      assert.deepEqual(decideNavigation(kind, ext, origin), block, kind);
      assert.deepEqual(decideNavigation(kind, 'file:///C:/x', origin), block, kind);
    }
  });

  test('window.open never creates a window; only external http(s) goes to the browser', () => {
    assert.deepEqual(decideNavigation('window-open', own, origin), block);
    assert.deepEqual(decideNavigation('window-open', ext, origin), browser);
    assert.deepEqual(decideNavigation('window-open', 'javascript:alert(1)', origin), block);
  });

  test('before the server is ready nothing stays in the window; unknown kinds are blocked', () => {
    for (const kind of ['navigate', 'redirect', 'frame', 'window-open']) assert.equal(decideNavigation(kind, own, null).cancel, true, kind);
    assert.deepEqual(decideNavigation('redirect', own, null), block);
    assert.deepEqual(decideNavigation('frame', own, null), block);
    assert.deepEqual(decideNavigation('something-new', own, origin), block);
    assert.deepEqual(decideNavigation('something-new', ext, origin), block);
  });

  test('network filter: only our origin (ws/wss treated like http/https)', () => {
    assert.equal(requestAllowed(`${origin}/api/stream`, origin), true);
    assert.equal(requestAllowed(`ws://127.0.0.1:47712/socket`, origin), true);
    for (const u of ['wss://127.0.0.1:47712/', 'http://127.0.0.1:4545/api/snapshot', 'https://example.com/x', 'ws://evil.example/', null]) {
      assert.equal(requestAllowed(u, origin), false, String(u));
    }
    assert.equal(requestAllowed(`${origin}/`, null), false);
  });
});

describe('external link rule: http and https only', () => {
  test('http and https links may go to the default browser', () => {
    for (const u of ['https://nodejs.org/', 'http://example.com/a?b=c', 'https://example.com:8443/x#y']) assert.equal(isExternalUrl(u), true, u);
  });

  test('other schemes, credentials and malformed addresses are rejected', () => {
    const bad = [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@example.com',
      'ms-settings:display',
      'search-ms:query=x',
      'vbscript:msgbox(1)',
      'ftp://example.com/x',
      'chrome://settings',
      'smb://server/share',
      '\\\\server\\share\\x.exe',
      'https://user:pw@example.com/',
      'http://',
      'nodejs.org',
      '',
      null,
      undefined,
      `https://example.com/${'a'.repeat(5000)}`,
    ];
    for (const u of bad) assert.equal(isExternalUrl(u), false, String(u));
  });

  test('log summary of a URL is scheme and host only', () => {
    assert.equal(describeUrl('https://example.com/secret/path?token=123'), 'https://example.com');
    assert.equal(describeUrl('javascript:alert(1)'), 'javascript:');
    assert.equal(describeUrl('not a url'), '(invalid url)');
  });
});

// ------------------------------------------------------------------ permissions
describe('permission rule', () => {
  const origin = appOrigin(47712);

  test('our origin may show notifications and write to the clipboard (request and check forms)', () => {
    assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), ['clipboard-sanitized-write', 'notifications']);
    for (const p of ['notifications', 'clipboard-sanitized-write']) {
      assert.equal(permissionAllowed(p, `${origin}/`, origin), true, p);
      assert.equal(permissionAllowed(p, origin, origin), true, p);
    }
  });

  test('reading the clipboard and every other permission is denied; other origins get nothing', () => {
    for (const p of ['clipboard-read', 'media', 'geolocation', 'openExternal', 'fullscreen', 'pointerLock', 'hid', 'serial', 'usb', 'display-capture', 'midiSysex']) {
      assert.equal(permissionAllowed(p, `${origin}/`, origin), false, p);
    }
    for (const p of ['notifications', 'clipboard-sanitized-write']) {
      assert.equal(permissionAllowed(p, 'https://evil.example/', origin), false, p);
      assert.equal(permissionAllowed(p, 'http://127.0.0.1:4545/', origin), false, p);
      assert.equal(permissionAllowed(p, `${origin}/`, null), false, p);
    }
  });
});

// ------------------------------------------------------------------ server environment
describe('server environment', () => {
  const base = {
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\someone',
    SIBERSENTEZ_ACTIONS: 'live',
    sibersentez_actions: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require x.js',
    SIBERSENTEZ_QA_SHOT: 'a.png',
    SIBERSENTEZ_QA_QUIT_MS: '10',
    SIBERSENTEZ_QA_DELAY_MS: '10',
    SIBERSENTEZ_DATA_DIR: 'C:\\d',
    SiberSentez_Port: '4545',
    SIBERSENTEZ_HUB: 'C:\\old-hub',
    SIBERSENTEZ_INSTANCE: 'forged',
    SIBERSENTEZ_DAYS: '7',
  };

  test('actions, Node/Electron switches and shell-only settings never reach the server', () => {
    const env = buildServerEnv(base, { port: 47712, hubPath: 'C:\\hub', instance: 'abc' });
    for (const k of Object.keys(env)) {
      assert.ok(!['SIBERSENTEZ_ACTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SIBERSENTEZ_QA_SHOT', 'SIBERSENTEZ_QA_QUIT_MS', 'SIBERSENTEZ_QA_DELAY_MS', 'SIBERSENTEZ_DATA_DIR'].includes(k.toUpperCase()), k);
    }
    assert.equal(env.PATH, 'C:\\Windows');
    assert.equal(env.SIBERSENTEZ_DAYS, '7');
  });

  test('port, hub and instance are set exactly once (case-insensitive), input untouched', () => {
    const env = buildServerEnv(base, { port: 47712, hubPath: 'C:\\hub', instance: 'abc' });
    assert.equal(env.SIBERSENTEZ_PORT, '47712');
    assert.equal(env.SIBERSENTEZ_HUB, 'C:\\hub');
    assert.equal(env.SIBERSENTEZ_INSTANCE, 'abc');
    assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'SIBERSENTEZ_PORT').length, 1);
    assert.equal(base.SIBERSENTEZ_ACTIONS, 'live', 'the input object is not modified');
    assert.equal('SIBERSENTEZ_HUB' in buildServerEnv(base, { port: 1, hubPath: null, instance: 'x' }), false);
  });
});

// ------------------------------------------------------------------ readiness probe
describe('server readiness probe', () => {
  // Same access rules as the real server; it always answers with its instance id
  function fakeServer(instance, { status = 200, strict = true } = {}) {
    let port = 0;
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, site: req.headers['sec-fetch-site'], url: req.url, method: req.method });
      const headers = instance ? { [INSTANCE_HEADER]: instance } : {};
      if (strict && req.headers.host !== `127.0.0.1:${port}`) return res.writeHead(421, headers).end();
      if (strict && req.headers['sec-fetch-site'] !== 'same-origin') return res.writeHead(403, headers).end();
      res.writeHead(status, headers).end('ok');
    });
    return { srv, seen, start: async () => (port = await listen(srv)) };
  }

  test('ready only with the Host / Sec-Fetch-Site headers and our instance id', async () => {
    const f = fakeServer('inst-1');
    const port = await f.start();
    try {
      assert.equal(await probeServer(port, { instance: 'inst-1' }), 'ready');
      assert.deepEqual(f.seen[0], { host: `127.0.0.1:${port}`, site: 'same-origin', url: '/', method: 'GET' });
      assert.equal(await waitForServer(port, { instance: 'inst-1', timeoutMs: 2000, intervalMs: 50 }), 'ready');
    } finally {
      await close(f.srv);
    }
  });

  test('another server (wrong or missing instance id) is foreign and is reported at once', async () => {
    for (const other of ['someone-else', null]) {
      const f = fakeServer(other, { strict: false });
      const port = await f.start();
      try {
        assert.equal(await probeServer(port, { instance: 'inst-1' }), 'foreign');
        const t0 = Date.now();
        assert.equal(await waitForServer(port, { instance: 'inst-1', timeoutMs: 5000, intervalMs: 50 }), 'foreign');
        assert.ok(Date.now() - t0 < 2000);
      } finally {
        await close(f.srv);
      }
    }
  });

  test('our instance but not 200 yet, or a closed port, is down; waiting ends in timeout or stopped', async () => {
    const f = fakeServer('inst-1', { status: 503 });
    const port = await f.start();
    try {
      assert.equal(await probeServer(port, { instance: 'inst-1' }), 'down');
      assert.equal(await waitForServer(port, { instance: 'inst-1', timeoutMs: 300, intervalMs: 50 }), 'timeout');
    } finally {
      await close(f.srv);
    }
    assert.equal(await probeServer(port, { instance: 'inst-1' }), 'down');
    assert.equal(await waitForServer(port, { instance: 'inst-1', timeoutMs: 5000, shouldStop: () => true }), 'stopped');
    assert.throws(() => probeServer(port, {}), TypeError);
  });
});

// ------------------------------------------------------------------ supervisor
describe('restart supervisor', () => {
  const T0 = 1_760_000_000_000; // realistic Date.now() values (0 would read as "never ready")
  const run = (events) => {
    let s = initialSupervisor();
    const actions = [];
    for (const e of events) {
      const r = superviseStep(s, e);
      s = r.state;
      if (e.type === 'failed') actions.push(r.action.type === 'restart' ? r.action.delayMs : r.action.type);
    }
    return actions;
  };

  test('backoff starts at 1 s, doubles, caps at 30 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => restartDelay(n)), [1000, 2000, 4000, 8000, 16000]);
    assert.equal(restartDelay(5), 30000);
    assert.equal(restartDelay(100), 30000);
    for (const n of [-3, NaN, undefined, null, 'x']) assert.equal(restartDelay(n), 1000, String(n));
  });

  test('a server that never becomes ready backs off and gives up after maxFailures', () => {
    assert.equal(SUPERVISOR_DEFAULTS.maxFailures, 5);
    const fails = Array.from({ length: 6 }, (_, i) => ({ type: 'failed', at: T0 + i * 1000 }));
    assert.deepEqual(run(fails), [1000, 2000, 4000, 8000, 16000, 'give-up']);
  });

  test('long run, then a crash loop at startup: the stability credit is used once, backoff grows, then gives up', () => {
    // The audit's bug: readyAt was never cleared, so every later failure looked "stable" and restarted
    // after 1 s forever. Now the long run earns one fresh start and the startup crash loop backs off.
    const events = [{ type: 'ready', at: T0 }, { type: 'failed', at: T0 + 120000 }];
    for (let i = 1; i <= 5; i++) events.push({ type: 'failed', at: T0 + 120000 + i * 1000 });
    assert.deepEqual(run(events), [1000, 2000, 4000, 8000, 16000, 'give-up']);
    const after = superviseStep({ failures: 0, readyAt: T0 }, { type: 'failed', at: T0 + 120000 }).state;
    assert.equal(after.readyAt, 0, 'a failure clears readyAt');
  });

  test('short-lived runs keep counting; a stable run resets the counter', () => {
    const loop = [];
    for (let i = 0; i < 6; i++) loop.push({ type: 'ready', at: T0 + i * 10000 }, { type: 'failed', at: T0 + i * 10000 + 5000 });
    assert.deepEqual(run(loop), [1000, 2000, 4000, 8000, 16000, 'give-up']);
    const recovered = [
      { type: 'failed', at: T0 },
      { type: 'failed', at: T0 + 1000 },
      { type: 'failed', at: T0 + 3000 },
      { type: 'ready', at: T0 + 10000 },
      { type: 'failed', at: T0 + 10000 + SUPERVISOR_DEFAULTS.stableMs },
    ];
    assert.deepEqual(run(recovered), [1000, 2000, 4000, 1000]);
    assert.throws(() => superviseStep(initialSupervisor(), { type: 'bogus' }), /unknown supervisor event/);
  });

  test('a due restart waits for a running launch instead of being dropped', () => {
    assert.deepEqual(restartDue({ launching: true }), { type: 'wait', delayMs: RESTART_RECHECK_MS });
    assert.deepEqual(restartDue({}), { type: 'launch' });
    assert.equal(restartDue({ quitting: true, launching: true }).type, 'drop');
    assert.equal(restartDue({ serverAlive: true }).type, 'drop');
    assert.ok(RESTART_RECHECK_MS > 0 && RESTART_RECHECK_MS <= 1000);
  });

  test('simulation: the timer fires during a slow launch that then fails; exactly one restart follows', () => {
    // Timeline of main.mjs: timer due at t=1000 while a launch runs until t=1600 and fails without a server
    const sim = { launching: true, serverAlive: false, quitting: false };
    let t = 1000;
    const launches = [];
    for (let step = 0; step < 20 && launches.length === 0; step++) {
      if (t >= 1600) sim.launching = false;
      const d = restartDue(sim);
      if (d.type === 'launch') launches.push(t);
      else if (d.type === 'wait') t += d.delayMs;
      else break;
    }
    assert.deepEqual(launches, [1000 + Math.ceil(600 / RESTART_RECHECK_MS) * RESTART_RECHECK_MS]);
  });
});

// ------------------------------------------------------------------ QA options
describe('QA options', () => {
  const shot = path.join(TMP, 'qa', 'window.png');

  test('development honours the QA variables', () => {
    const q = readQaOptions({ env: { SIBERSENTEZ_QA_SHOT: shot, SIBERSENTEZ_QA_DELAY_MS: '1500' }, argv: [], isPackaged: false });
    assert.deepEqual(q, { enabled: true, ignored: false, rejected: null, shot, quitMs: 0, delayMs: 1500 });
  });

  test('a packaged build ignores them without --qa and honours them with it', () => {
    const env = { SIBERSENTEZ_QA_SHOT: shot, SIBERSENTEZ_QA_QUIT_MS: '9000' };
    const off = readQaOptions({ env, argv: ['SiberSentez.exe'], isPackaged: true });
    assert.equal(off.enabled, false);
    assert.equal(off.ignored, true);
    assert.equal(off.shot, null);
    assert.equal(off.quitMs, 0);
    const on = readQaOptions({ env, argv: ['SiberSentez.exe', '--qa'], isPackaged: true });
    assert.equal(on.enabled, true);
    assert.equal(on.shot, shot);
    assert.equal(on.quitMs, 9000);
    assert.equal(on.delayMs, 5000);
  });

  test('no QA variables means QA off; bad screenshot paths are rejected', WIN, () => {
    assert.deepEqual(readQaOptions({ env: {}, argv: ['--qa'], isPackaged: true }), { enabled: false, ignored: false, rejected: null, shot: null, quitMs: 0, delayMs: 5000 });
    const unc = readQaOptions({ env: { SIBERSENTEZ_QA_SHOT: '\\\\server\\share\\x.png' } });
    assert.equal(unc.enabled, false);
    assert.match(unc.rejected, /network or device path/);
    assert.equal(readQaOptions({ env: { SIBERSENTEZ_QA_SHOT: path.join(TMP, 'x.exe') } }).rejected, 'screenshot must be a .png file');
    const quitOnly = readQaOptions({ env: { SIBERSENTEZ_QA_SHOT: 'rel.png', SIBERSENTEZ_QA_QUIT_MS: '100' } });
    assert.equal(quitOnly.enabled, true);
    assert.equal(quitOnly.shot, null);
    assert.equal(readQaOptions({ env: { SIBERSENTEZ_QA_QUIT_MS: 'abc' } }).enabled, false);
  });
});

// ------------------------------------------------------------------ UI language and strings
describe('UI language', () => {
  test('auto (or missing/unsupported setting) follows the OS locale: tr* → tr, others → en', () => {
    for (const locale of ['tr', 'tr-TR', 'TR_tr']) assert.equal(pickLanguage({ setting: 'auto', locale }), 'tr', locale);
    for (const locale of ['en-US', 'de', 'fr-FR', 'trk', '', undefined]) assert.equal(pickLanguage({ setting: 'auto', locale }), 'en', String(locale));
    for (const setting of [undefined, null, '', 'auto', 'AUTO', 'de', 42]) {
      assert.equal(pickLanguage({ setting, locale: 'tr-TR' }), 'tr', String(setting));
      assert.equal(pickLanguage({ setting, locale: 'en-GB' }), 'en', String(setting));
    }
    assert.equal(pickLanguage(), 'en');
  });

  test('an explicit supported setting wins over the locale', () => {
    assert.equal(pickLanguage({ setting: 'en', locale: 'tr-TR' }), 'en');
    assert.equal(pickLanguage({ setting: 'tr', locale: 'en-US' }), 'tr');
    assert.equal(pickLanguage({ setting: ' TR-tr ', locale: 'en-US' }), 'tr');
  });

  test('language setting is read from <hub>\\settings.json; any problem means null', () => {
    assert.equal(HUB_SETTINGS_FILE, 'settings.json');
    const hub = path.join(TMP, 'lang-hub');
    fs.mkdirSync(hub, { recursive: true });
    const file = path.join(hub, 'settings.json');
    assert.equal(readHubLanguageSetting(hub), null, 'missing file');
    fs.writeFileSync(file, JSON.stringify({ version: 1, language: 'tr' }));
    assert.equal(readHubLanguageSetting(hub), 'tr');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"language":"en"}')]));
    assert.equal(readHubLanguageSetting(hub), 'en', 'byte order mark is tolerated');
    fs.writeFileSync(file, '{ broken');
    assert.equal(readHubLanguageSetting(hub), null, 'invalid JSON');
    fs.writeFileSync(file, JSON.stringify({ language: 7 }));
    assert.equal(readHubLanguageSetting(hub), null, 'non-string value');
    assert.equal(readHubLanguageSetting(null), null);
  });
});

describe('user-visible strings', () => {
  test('every language has exactly the same keys, all non-empty, with the same placeholders', () => {
    const langs = Object.keys(STRINGS);
    assert.deepEqual(langs.sort(), ['en', 'tr']);
    const keys = Object.keys(STRINGS.en).sort();
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const lang of langs) {
      assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, `keys of ${lang}`);
      for (const k of keys) {
        assert.equal(typeof STRINGS[lang][k], 'string', `${lang}.${k}`);
        assert.ok(STRINGS[lang][k].trim(), `${lang}.${k} is empty`);
        assert.deepEqual(placeholders(STRINGS[lang][k]), placeholders(STRINGS.en[k]), `placeholders of ${lang}.${k}`);
      }
    }
  });

  test('Turkish and English texts are really different; unknown languages fall back to English', () => {
    assert.equal(getStrings('tr').trayQuit, 'Çık');
    assert.equal(getStrings('en').trayQuit, 'Quit');
    assert.equal(getStrings('tr').trayOpenHub, 'Merkez klasörünü aç');
    assert.equal(getStrings('de'), STRINGS.en);
    assert.equal(getStrings(undefined), STRINGS.en);
  });

  test('placeholders are filled; unknown ones are left intact', () => {
    assert.equal(formatString('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
    assert.equal(formatString(STRINGS.en.errorStartup, { message: 'boom' }), 'Startup failed: boom');
  });
});

// ------------------------------------------------------------------ logging
describe('logging', () => {
  test('home folder is hidden (case and slash style do not matter)', () => {
    const home = 'C:\\Users\\Ali.Veli+1';
    assert.equal(redactHome('C:\\Users\\Ali.Veli+1\\SiberSentez', home), '~\\SiberSentez');
    assert.equal(redactHome('c:\\users\\ali.veli+1\\x', home), '~\\x');
    assert.equal(redactHome('C:/Users/Ali.Veli+1/x', home), '~/x');
    assert.equal(redactHome('C:\\Users\\AliXVeli+1\\x', home), 'C:\\Users\\AliXVeli+1\\x');
    // JSON.stringify doubles backslashes: the QA summary line must be hidden as well
    assert.equal(redactHome(JSON.stringify({ hub: 'C:\\Users\\Ali.Veli+1\\SiberSentez' }), home), '{"hub":"~\\\\SiberSentez"}');
    assert.equal(redactHome('untouched', ''), 'untouched');
  });

  test('lines are timestamped with the home folder hidden; the log rotates at the size cap', () => {
    const dir = path.join(TMP, 'logs');
    const home = path.join(TMP, 'user');
    const logger = createLogger({ dir, name: 'main', maxBytes: 400, homeDir: home });
    logger.write(`hub: ${path.join(home, 'SiberSentez')}`);
    const first = fs.readFileSync(logger.file, 'utf8');
    assert.match(first, /^\d{4}-\d\d-\d\dT[\d:.]+Z hub: ~[\\/]SiberSentez\n$/);
    assert.ok(!first.includes(home));
    for (let i = 0; i < 60; i++) logger.write(`line ${i} ${'x'.repeat(30)}`);
    assert.ok(fs.statSync(logger.file).size <= 400, 'the active log must stay under the cap');
    assert.ok(fs.existsSync(logger.rotated), 'the older log must become .1.log');
    assert.ok(fs.statSync(logger.rotated).size <= 400);
    assert.match(fs.readFileSync(logger.file, 'utf8'), /line 59 /);
  });

  test('an unwritable log never crashes the app', () => {
    const blocker = path.join(TMP, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const logger = createLogger({ dir: blocker, name: 'main' });
    assert.doesNotThrow(() => logger.write('trial'));
  });
});

// ------------------------------------------------------------------ main.mjs wiring (text checks)
describe('main.mjs wiring', () => {
  // The shell's main module and its QA run (electron/qa-run.mjs, moved out of it: module-split-plan M1)
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'electron', 'qa-run.mjs'), 'utf8');

  test('sandboxed window, no Node; one preload whose three functions reach one IPC handler each; DevTools only in development', () => {
    // The window's options are the tested windowOptions (test/electron.test.mjs, "the hidden QA run"); main.mjs passes
    // the preload, the icon and DevTools only for development
    assert.ok(src.includes('win = new BrowserWindow(windowOptions({ qaHidden: QA_SHELL.hidden, preload: PRELOAD_PATH, icon: ICON_PATH, devTools: !app.isPackaged }));'));
    assert.equal((src.match(/new BrowserWindow\(/g) || []).length, 1, 'one window');
    for (const qaHidden of [false, true]) {
      const w = windowOptions({ qaHidden, preload: 'p.cjs', icon: 'i.png', devTools: false }).webPreferences;
      for (const [k, v] of Object.entries({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, devTools: false, preload: 'p.cjs' })) {
        assert.equal(w[k], v, `${k} (qaHidden ${qaHidden})`);
      }
    }
    assert.equal(windowOptions({ preload: 'p.cjs', devTools: true }).webPreferences.devTools, true);
    assert.equal(windowOptions({ preload: 'p.cjs', devTools: 'yes' }).webPreferences.devTools, false, 'only exactly true');
    // The in-app actions switch (docs/actions-toggle.md §3b) and the new project (docs/start-flow.md): electron/preload.cjs
    // on the main window only, and the shell listens on exactly three channels; test/actions-in-app.test.mjs and
    // test/new-project.test.mjs check what the preload exposes and who may call
    assert.equal((src.match(/preload\s*:/g) || []).length, 1, 'one preload, on the main window');
    assert.ok(src.includes('preload: PRELOAD_PATH,'));
    assert.ok(src.includes("const PRELOAD_PATH = path.join(here, 'preload.cjs');"));
    assert.equal((src.match(/\bipcMain\.\w+\(/g) || []).join(), 'ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.on(,ipcMain.on(', 'twelve bridge handlers (the theme’s, two for the page’s errors and the log folder, test/page-errors.test.mjs; two for the support bundle, test/support-bundle.test.mjs) and five for the terminal (test/terminal.test.mjs), nothing else');
    assert.ok(src.includes('ipcMain.handle(LIBRARY_PICK_IPC_CHANNEL, onPickLibraryFolderRequest);'));
    const lib = src.slice(src.indexOf('async function onPickLibraryFolderRequest'), src.indexOf('// window.sibersentezShell.saveProjectIdea'));
    assert.ok(lib.indexOf('bridgeSender(senderFacts(event))') < lib.indexOf('showOpenDialog'), 'the library picker checks the sender first');
    assert.doesNotMatch(lib, /log\([^)]*path/, 'the log never names the folder');
    assert.ok(src.includes('ipcMain.handle(ACTIONS_IPC_CHANNEL, onPanelActionsRequest);'));
    assert.ok(src.includes('ipcMain.handle(PROJECT_PICK_IPC_CHANNEL, onPickProjectFolderRequest);'));
    assert.ok(src.includes('ipcMain.handle(PROJECT_IDEA_IPC_CHANNEL, onSaveProjectIdeaRequest);'));
    assert.ok(src.includes('ipcMain.handle(ATTENTION_IPC_CHANNEL, onAttention);'));
    assert.ok(src.includes('ipcMain.handle(IDEA_PROJECT_IPC_CHANNEL, onCreateIdeaProjectRequest);'));
    assert.doesNotMatch(src, /contextBridge|ipcRenderer/);
    assert.equal((src.match(/webContents\.send\(/g) || []).length, 1, 'the shell sends into the page only the terminals’ output (test/terminal.test.mjs)');
    assert.doesNotMatch(src, /nodeIntegration: true|contextIsolation: false|sandbox: false|webSecurity: false/);
  });

  test('every navigation event, the window-open handler and the network filter go through the tested decisions', () => {
    for (const needle of [
      "applyNavigation('navigate', url",
      "applyNavigation('redirect', url",
      "applyNavigation('frame', details.url",
      "applyNavigation('window-open', url",
      "return { action: 'deny' }",
      'decideNavigation(kind, url, state.origin)',
      'requestAllowed(details.url, state.origin)',
      'permissionAllowed(permission,',
    ]) {
      assert.ok(src.includes(needle), `missing: ${needle}`);
    }
  });

  test('server env, supervisor, instance check, port range, QA gate and screenshot flag are wired', () => {
    for (const needle of [
      'buildServerEnv(process.env',
      "superviseStep(state.supervisor, { type: 'failed'",
      "superviseStep(state.supervisor, { type: 'ready'",
      'instance: state.instance',
      "result === 'ready'",
      'findFreePort({ preferred: state.port })',
      'readQaOptions({ env: process.env, argv: process.argv, isPackaged: app.isPackaged })',
      "{ flag: 'wx' }",
      'foldersOverlap(hubPath, appDir)',
      'setTimeout(onRestartDue, next.delayMs)',
      'checkLocalDir(process.env.SIBERSENTEZ_DATA_DIR',
      'requestSingleInstanceLock()',
      'name: LOGIN_ITEM_NAME',
    ]) {
      assert.ok(src.includes(needle), `missing: ${needle}`);
    }
    assert.doesNotMatch(src, /4545/, 'the shell never uses 4545');
    assert.doesNotMatch(src, /shell:\s*true/);
    assert.doesNotMatch(src, /setLoginItemSettings\(\{ openAtLogin: true/, 'start at login must never turn itself on');
  });

  test('menu and tray labels come from strings.mjs; shell code carries no Turkish text', () => {
    assert.doesNotMatch(src, /label:\s*['"`]/, 'hard-coded label');
    assert.doesNotMatch(src, /displayBalloon\(\{[^}]*(title|content):\s*['"`]/, 'hard-coded balloon text');
    assert.doesNotMatch(src, /showErrorBox\(\s*['"`]/, 'hard-coded dialog text');
    assert.doesNotMatch(src, /setToolTip\(\s*['"`]/, 'hard-coded tooltip');
    // Every file of the shell (helpers.mjs is split into modules since plan D8); strings.mjs holds the Turkish texts
    const shellFiles = fs.readdirSync(path.join(ROOT, 'electron')).filter((f) => /\.(mjs|cjs)$/.test(f) && f !== 'strings.mjs');
    assert.ok(shellFiles.length >= 11 && shellFiles.includes('actions-mode.mjs'));
    for (const f of shellFiles) {
      const text = fs.readFileSync(path.join(ROOT, 'electron', f), 'utf8');
      assert.doesNotMatch(text, /[çğıöşüÇĞİÖŞÜ]/, `Turkish characters in electron/${f}`);
    }
  });
});

// ------------------------------------------------------------------ packaging and installer
describe('packaging and installer', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  const macro = (name) => new RegExp(`!macro ${name}\\r?\\n([\\s\\S]*?)!macroend`).exec(nsh)?.[1] ?? '';

  test('only server, public, electron and package.json go into the package (and node-pty for Windows x64)', () => {
    assert.deepEqual(pkg.build.files.slice(0, 4), ['server/**', 'public/**', 'electron/**', 'package.json']);
    assert.ok(pkg.build.files.slice(4).every((x) => x.startsWith('!node_modules/node-pty/')), 'the rest only trims node-pty');
    // The embedded terminal's pseudo console (docs/embedded-terminal.md): its prebuilt N-API binaries outside the
    // archive, never rebuilt (no compiler needed)
    assert.deepEqual(pkg.build.asarUnpack, ['node_modules/node-pty/**']);
    assert.equal(pkg.build.npmRebuild, false);
    // What is put in (the "!" patterns only take out)
    const text = JSON.stringify(pkg.build.files.filter((x) => !x.startsWith('!')));
    for (const bad of ['test', 'docs', 'qa', '.claude', 'build/']) assert.ok(!text.includes(bad), `must not be packaged: ${bad}`);
    // Each platform keeps only its own node-pty binary (plan G2, G3): Windows x64 its prebuilt one as before, Linux the
    // one built from source (no prebuilt binary for it), macOS its own
    // A platform's own list must name what goes in again: with only "!" patterns electron-builder packs the whole
    // project folder (0.18.0's build, 2026-10-09: qa, site, test, docs and .claude went in, a 243 MB installer)
    const root = pkg.build.files;
    assert.deepEqual(pkg.build.win.files, [...root, '!node_modules/node-pty/prebuilds/{darwin-*,linux-*,win32-arm64}/**']);
    assert.deepEqual(pkg.build.linux.files, [...root, '!node_modules/node-pty/prebuilds/**']);
    assert.deepEqual(pkg.build.mac.files, [...root, '!node_modules/node-pty/prebuilds/{win32-*,linux-*}/**']);
    for (const k of ['win', 'linux', 'mac']) {
      const text = JSON.stringify(pkg.build[k].files.filter((x) => !x.startsWith('!')));
      for (const bad of ['test', 'docs', 'qa', 'site', '.claude', 'build/', 'tools', '**/*']) assert.ok(!text.includes(bad), `${k} must not pack: ${bad}`);
    }
    assert.deepEqual(pkg.build.linux.target, [{ target: 'AppImage', arch: ['x64'] }]);
    // Linux desktops tie a running window to its .desktop entry by Electron's app_id, which comes from desktopName
    // (electron-builder warned without it, 2026-10-09): the entry's file name and StartupWMClass follow it
    assert.equal(pkg.desktopName, 'sibersentez.desktop');
    assert.equal(pkg.build.linux.syncDesktopName, true);
    assert.equal(pkg.build.mac.identity, null, 'macOS: experimental and unsigned');
  });

  test('one pinned dependency (node-pty); dev dependencies pinned: electron, electron-builder, xterm (vendored), happy-dom (the DOM tests only, plan D1), typescript (the type check only, plan D7)', () => {
    assert.deepEqual(pkg.dependencies, { 'node-pty': '1.1.0' });
    assert.deepEqual(pkg.devDependencies, { '@xterm/addon-fit': '0.11.0', '@xterm/xterm': '6.0.0', electron: '44.7.0', 'electron-builder': '26.15.3', 'happy-dom': '20.14.5', typescript: '7.0.2' });
  });

  test('per-user NSIS installer: fixed install folder, no elevation, English and Turkish, keeps user data', () => {
    assert.equal(pkg.main, 'electron/main.mjs');
    assert.match(pkg.description, /^[\x20-\x7e]+$/, 'description is plain English');
    assert.equal(pkg.build.artifactName, 'SiberSentez-Setup-${version}.${ext}');
    assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
    const n = pkg.build.nsis;
    assert.equal(n.oneClick, false);
    assert.equal(n.perMachine, false);
    assert.equal(n.allowToChangeInstallationDirectory, false, 'the user must not be able to install into the hub folder');
    assert.equal(n.allowElevation, false);
    assert.equal(n.packElevateHelper, false, 'elevate.exe is not shipped');
    assert.equal(n.include, 'build/installer.nsh');
    assert.equal(n.deleteAppDataOnUninstall, false);
    assert.equal(n.shortcutName, 'SiberSentez');
    assert.equal(n.multiLanguageInstaller, true);
    assert.deepEqual(n.installerLanguages, ['en_US', 'tr_TR']);
  });

  test('installer.nsh is UTF-8 without a byte order mark (makensis reads it as UTF8)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'));
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(Buffer.from(raw.toString('utf8'), 'utf8').equals(raw), true, 'valid UTF-8');
  });

  test('installer.nsh: current user only, /allusers has no effect, /D is refused', () => {
    assert.match(macro('customInstallMode'), /StrCpy \$isForceCurrentInstall "1"/);
    assert.doesNotMatch(macro('customInstallMode'), /isForceMachineInstall "1"/);
    // ${isForAllUsers} redefined to be always false: the only jump goes to the false label
    assert.match(nsh, /!macroundef _isForAllUsers\r?\n!macro _isForAllUsers _a _b _t _f/);
    assert.match(macro('_isForAllUsers _a _b _t _f'), /^\s*StrCmp "current-user-only" "" `\$\{_t\}` `\$\{_f\}`\s*$/);
    assert.doesNotMatch(macro('_isForAllUsers _a _b _t _f'), /StdUtils|allusers"/);
    const init = macro('customInit');
    assert.match(init, /StrCpy \$hasPerMachineInstallation "0"/);
    assert.match(init, /StrCpy \$hasPerUserInstallation "1"/);
    assert.match(init, /!insertmacro setInstallModePerUser/);
    assert.doesNotMatch(init, /setInstallModePerAllUsers|UAC_RunElevated/);
    assert.match(init, /!insertmacro GetDParameter \$R0\r?\n\s*\$\{If\} \$R0 != ""\r?\n\s*MessageBox [^\n]*\/SD IDOK\r?\n\s*SetErrorLevel 2\r?\n\s*Quit/);
    // the folder the template picked, InstallLocation and UninstallString must pass the uninstaller's check, or the installer stops
    assert.match(init, /!insertmacro sibersentezRecheckInstallDir\s*$/);
    const recheck = macro('sibersentezRecheckInstallDir');
    // the same values from the same keys that electron-builder's uninstallOldVersion reads before it runs the old uninstaller
    assert.match(recheck, /^\s*SetShellVarContext current\r?\n\s*Push \$R8\r?\n\s*Push \$R9\r?\n\s*ReadRegStr \$R8 HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation\r?\n\s*ReadRegStr \$R9 HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString\r?\n/);
    assert.match(recheck, /!ifdef UNINSTALL_REGISTRY_KEY_2\r?\n\s*\$\{If\} \$R9 == ""\r?\n\s*ReadRegStr \$R9 HKCU "\$\{UNINSTALL_REGISTRY_KEY_2\}" UninstallString\r?\n/);
    assert.match(recheck, /!insertmacro sibersentezCheckInstallDirs \$INSTDIR \$R8 \$R9 \$LOCALAPPDATA \$PROFILE\r?\n\s*Pop \$R9\r?\n\s*Pop \$R8\r?\n/);
    assert.match(recheck, /!insertmacro sibersentezRefuse sibersentezMsgInstallDir\r?\n\s*\$\{EndIf\}\r?\n\s*StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{APP_FILENAME\}"\s*$/);
    const installUtil = fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installUtil.nsh'), 'utf8');
    for (const layout of [
      /readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString/,
      /readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY_2\}" UninstallString/,
      /readReg \$installationDir "\$rootKey" "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation\r?\n\s*\$\{if\} \$installationDir == ""\r?\n\s*\$\{andIf\} \$uninstallerFileName != ""\r?\n\s*# [^\n]*\r?\n\s*Push \$uninstallerFileName\r?\n\s*Call GetFileParent/,
    ]) {
      assert.match(installUtil, layout, 'template layout this check relies on');
    }
    assert.match(macro('sibersentezRefuse MESSAGE'), /^\s*MessageBox [^\n]*\/SD IDOK\r?\n\s*SetErrorLevel 2\r?\n\s*Quit\s*$/);
  });

  test('installer.nsh: the all-users mode is replaced, before multiUser.nsh defines it, by the current-user mode', () => {
    // electron-builder defines the symbol for every assisted installer; multiUser.nsh only defines its own
    // setInstallModePerAllUsers (the one that relaunches the uninstaller through UAC) while it is defined
    assert.match(nsh, /!ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED\r?\n\s*!undef INSTALL_MODE_PER_ALL_USERS_REQUIRED\r?\n\s*Var perMachineInstallationFolder\r?\n\s*!macro setInstallModePerAllUsers\r?\n/);
    assert.match(macro('setInstallModePerAllUsers'), /^\s*!insertmacro setInstallModePerUser\s*$/);
    const multiUser = fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'), 'utf8');
    assert.match(multiUser, /!ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED\r?\n\s*Var perMachineInstallationFolder\r?\n\s*!macro setInstallModePerAllUsers/, 'template layout this override relies on');
  });

  test('installer.nsh: the uninstaller takes its folder from the installer registry value and pins it before every step', () => {
    const pin = macro('sibersentezPinProgramDir');
    assert.match(pin, /^\s*SetShellVarContext current\r?\n\s*ReadRegStr \$sibersentezDir HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation\r?\n\s*!insertmacro sibersentezPinDir \$sibersentezDir \$LOCALAPPDATA \$PROFILE\s*$/);
    const pinDir = macro('sibersentezPinDir CANDIDATE LOCAL_APP_DATA PROFILE_DIR');
    assert.match(pinDir, /^\s*!insertmacro sibersentezCheckProgramDir "\$\{CANDIDATE\}" "\$\{LOCAL_APP_DATA\}" "\$\{PROFILE_DIR\}"\r?\n/);
    assert.match(pinDir, /\$\{AndIfNot\} \$\{FileExists\} "\$sibersentezDir\\\$\{UNINSTALL_FILENAME\}"/, 'the folder must hold the uninstaller');
    assert.match(pinDir, /GetFileAttributesW\(w s\) i \.s'\r?\n\s*Pop \$sibersentezTmp\r?\n\s*IntOp \$sibersentezTmp \$sibersentezTmp & 1024\r?\n/, 'a folder that is a link is refused');
    assert.match(pinDir, /!insertmacro sibersentezRefuse sibersentezMsgNotUninstalled\r?\n\s*\$\{EndIf\}\r?\n\s*StrCpy \$INSTDIR "\$\{LOCAL_APP_DATA\}\\Programs\\\$\{APP_FILENAME\}"\s*$/);
    for (const untrusted of [/\$EXEDIR/, /\$EXEPATH/, /_\?=/, /GetDParameter/, /GetParameters/]) assert.doesNotMatch(pin + pinDir, untrusted);
    const check = macro('sibersentezCheckProgramDir CANDIDATE LOCAL_APP_DATA PROFILE_DIR');
    assert.ok(check.includes(`$sibersentezDir == "\${PROFILE_DIR}\\${HUB_DIR_NAME}"`), 'the hub folder name matches the app');
    assert.match(check, /\$sibersentezDir != "\$\{LOCAL_APP_DATA\}\\Programs\\\$\{APP_FILENAME\}"/);
    assert.match(macro('customUnInit'), /!insertmacro sibersentezPinProgramDir\s*$/, 'un.onInit ends with the pin');
    assert.match(macro('customUnInstall'), /^\s*!insertmacro sibersentezPinProgramDir\r?\n/, 'the uninstall section pins before it removes anything');
    assert.match(macro('customRemoveFiles'), /^\s*!insertmacro sibersentezPinProgramDir\r?\n\s*!insertmacro sibersentezRemoveProgramDir\s*$/, 'and once more right before the program folder');
    // electron-builder's CHECK_APP_RUNNING inserts customCheckAppRunning: the pin (or, in the installer, the check) comes first
    assert.match(macro('customCheckAppRunning'), /^\s*!ifdef BUILD_UNINSTALLER\r?\n\s*!insertmacro sibersentezPinProgramDir\r?\n\s*!else\r?\n\s*!insertmacro sibersentezRecheckInstallDir\r?\n\s*!endif\r?\n\s*!insertmacro sibersentezCloseApp \$LOCALAPPDATA\s*$/);
  });

  test('installer.nsh: nothing is removed with RMDir /r; a real uninstall removes the login item and the updater copy, nothing else', () => {
    assert.doesNotMatch(nsh, /^\s*RMDir\s+\/r/im, 'NSIS 3.0.4 RMDir /r enters junctions');
    const un = macro('customUnInstall').replace(/^\s*!insertmacro sibersentezPinProgramDir\r?\n/, '');
    assert.match(un, /^\s*\$\{ifNot\} \$\{isUpdated\}\r?\n/, 'everything is inside the "not an update" branch');
    assert.match(un, /\$\{endIf\}\s*$/);
    for (const key of ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run']) {
      assert.ok(un.includes(`DeleteRegValue HKCU "${key}" "${LOGIN_ITEM_NAME}"`), `missing DeleteRegValue for ${key}`);
    }
    // electron-builder's updater cache folder is "<package name>-updater" under the current user's local app data
    const updater = `$LOCALAPPDATA\\${pkg.name}-updater`;
    assert.match(un, new RegExp(`\\$\\{if\\} "\\$LOCALAPPDATA" != ""\\r?\\n\\s*!insertmacro sibersentezRemoveFolder "${updater.replace(/[$\\]/g, '\\$&')}"`), 'the updater copy is removed, never from an empty base path');
    // Every removal in the file: the link-safe emptying function, the folder helper, the update's staging folder (RMDir
    // without /r: only when empty) and the program folder itself
    const removals = [...nsh.matchAll(/^\s*(RMDir|Delete)\b.*$/gim)].map((m) => m[0].replace(/\s*;.*$/, '').trim());
    assert.deepEqual(removals, ['RMDir $R4', 'Delete $R4', 'RMDir $R4', 'Delete $R4', 'RMDir "${DIR}"', 'RMDir "${DIR}"', 'RMDir $1', 'RMDir $1', 'Delete "$INSTDIR\\${UNINSTALL_FILENAME}"', 'RMDir $INSTDIR']);
    // The only move: each entry as a whole and as itself, inside the pinned program folder
    assert.deepEqual([...nsh.matchAll(/^\s*(Rename|CopyFiles)\b.*$/gim)].map((m) => m[0].trim()), ['Rename $R4 "$R1\\$R3"']);
  });

  test('installer.nsh: every message box shows a LangString with an English and a Turkish text', () => {
    const boxes = [...nsh.matchAll(/^\s*MessageBox\b[^\n]*$/gm)].map((m) => m[0].trim());
    assert.ok(boxes.length >= 5, 'message boxes found');
    for (const box of boxes) assert.match(box, /\/SD ID\w+\b/, `answered by itself in a silent run: ${box}`);
    for (const box of boxes) {
      const text = /"([^"]*)"/.exec(box)?.[1] ?? '';
      assert.match(text, /^\$\(/, `starts with a LangString: ${box}`);
      assert.doesNotMatch(text.replace(/\$\([^)]*\)|\$\\[rn]|\$\w+|[\s()]/g, ''), /[^\s]/, `literal text in: ${box}`);
    }
    const strings = [...nsh.matchAll(/^LangString (\w+) (\d+) "(.*)"$/gm)].map(([, name, lang, text]) => ({ name, lang, text }));
    const names = [...new Set(strings.map((s) => s.name))];
    assert.deepEqual(names.sort(), ['sibersentezMsgInstallDir', 'sibersentezMsgNoCustomDir', 'sibersentezMsgNotUninstalled', 'sibersentezMsgOldVersionKept']);
    for (const name of names) {
      const en = strings.find((s) => s.name === name && s.lang === '1033');
      const tr = strings.find((s) => s.name === name && s.lang === '1055');
      assert.ok(en && tr, `${name}: English (1033) and Turkish (1055)`);
      assert.notEqual(en.text, tr.text, name);
    }
    const used = [...nsh.matchAll(/\$\((sibersentez\w+)\)|sibersentezRefuse (sibersentez\w+)/g)].map((m) => m[1] || m[2]);
    assert.deepEqual([...new Set(used)].sort(), names.sort(), 'every message is used and every used one is defined');
    // the two installer languages these ids stand for
    assert.deepEqual(pkg.build.nsis.installerLanguages, ['en_US', 'tr_TR']);
  });

  test('Electron fuses: the packaged exe cannot act as a Node interpreter or a debug door', () => {
    assert.deepEqual(pkg.build.electronFuses, {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  // The script runs every *.test.mjs file in test/ by a pattern Node expands itself (docs/direction.md §3.5: a hand
  // list forgot new files); only test files live there, so nothing else runs
  test('the test script runs every *.test.mjs file in test/', () => {
    assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
    const all = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.mjs'));
    assert.ok(all.length > 40 && all.every((f) => f.endsWith('.test.mjs')), 'no helper module that the pattern would skip or run');
  });
});

// ------------------------------------------------------------------ installer and uninstaller as makensis builds them
// build/installer.nsh only matters inside electron-builder's NSIS template. These tests rebuild the script the way
// electron-builder does (its own header generator and message files, the defines it derives from package.json,
// its makensis with -WX) and read makensis' -V4 listing: every instruction of the compiled program, in order, with
// all macros expanded. The compiled installer and uninstaller are never run. The only program that is run is the
// small check harness below, which compares strings and writes one result file.
const requireCjs = createRequire(import.meta.url);
const NSIS_TEMPLATES = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const NSIS_GUID = 'sibersentez-test-guid';

// electron-builder's makensis and plugins (downloaded by the first "npm run dist")
function findNsisToolchain() {
  if (process.platform !== 'win32') return null;
  const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const children = (dir) => {
    try {
      return fs.readdirSync(dir).map((d) => path.join(dir, d));
    } catch {
      return [];
    }
  };
  const dir = [...children(path.join(cache, 'nsis-3.0.4.1')), path.join(cache, 'nsis', 'nsis-3.0.4.1')].find((d) => fs.existsSync(path.join(d, 'Bin', 'makensis.exe')));
  const plugins = [...children(path.join(cache, 'nsis-resources-3.4.1')), path.join(cache, 'nsis', 'nsis-resources-3.4.1')]
    .map((d) => path.join(d, 'plugins', 'x86-unicode'))
    .find((d) => fs.existsSync(path.join(d, 'UAC.dll')));
  return dir && plugins ? { makensis: path.join(dir, 'Bin', 'makensis.exe'), dir, plugins } : null;
}
const NSIS = findNsisToolchain();
const NEEDS_NSIS = { skip: !NSIS && 'electron-builder NSIS toolchain not in its cache (run "npm run dist" once)' };

function makensis(args, input) {
  try {
    return execFileSync(NSIS.makensis, ['-INPUTCHARSET', 'UTF8', '-OUTPUTCHARSET', 'UTF8', ...args], {
      input,
      cwd: NSIS_TEMPLATES,
      env: { ...process.env, NSISDIR: NSIS.dir },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      timeout: 180000,
    }).split(/\r?\n/);
  } catch (err) {
    const tail = String(err.stdout || '').split(/\r?\n/).filter((l) => /^(warning \d+|error)|error in |: error/i.test(l)).slice(-15).join('\n');
    throw new Error(`makensis failed:\n${tail || err.message}`);
  }
}

// Same steps and order as NsisTarget.computeCommonInstallerScriptHeader + installer.nsi
async function electronBuilderScript(pkg, tag) {
  const out = path.join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis');
  const { NsisScriptGenerator } = requireCjs(path.join(out, 'nsisScriptGenerator.js'));
  const { LangConfigurator, createAddLangsMacro, addCustomMessageFileInclude } = requireCjs(path.join(out, 'nsisLang.js'));
  const langs = new LangConfigurator(pkg.build.nsis);
  const g = new NsisScriptGenerator();
  g.include(path.join(NSIS_TEMPLATES, 'include', 'StdUtils.nsh'));
  g.addIncludeDir(path.join(NSIS_TEMPLATES, 'include'));
  g.flags(['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser']);
  createAddLangsMacro(g, langs);
  g.addPluginDir('x86-unicode', NSIS.plugins);
  let n = 0;
  const packager = { getTempFile: async (name) => path.join(TMP, `nsis-${tag}-${++n}-${name}`) };
  await addCustomMessageFileInclude('messages.yml', packager, g, langs);
  await addCustomMessageFileInclude('assistedMessages.yml', packager, g, langs);
  g.addIncludeDir(path.join(ROOT, 'build'));
  g.include(path.join(ROOT, 'build', 'installer.nsh'));
  return g.build() + fs.readFileSync(path.join(NSIS_TEMPLATES, 'installer.nsi'), 'utf8');
}

// The defines NsisTarget passes for this package.json (assisted, per-user installer); fake payload files
function electronBuilderDefines(pkg) {
  const payload = path.join(TMP, 'nsis-app-64.7z');
  const uninstaller = path.join(TMP, 'nsis-uninstaller.exe');
  fs.writeFileSync(payload, 'not a real archive');
  fs.writeFileSync(uninstaller, 'not a real uninstaller');
  const icon = path.join(ROOT, 'build', 'icon.ico');
  const bitmap = '${NSISDIR}\\Contrib\\Graphics\\Wizard\\nsis3-metro.bmp';
  return {
    APP_ID: pkg.build.appId,
    APP_GUID: NSIS_GUID,
    UNINSTALL_APP_KEY: NSIS_GUID,
    PRODUCT_NAME: pkg.productName,
    PRODUCT_FILENAME: pkg.productName,
    APP_FILENAME: pkg.productName,
    VERSION: pkg.version,
    APP_DESCRIPTION: pkg.description,
    APP_PACKAGE_NAME: pkg.name,
    MUI_ICON: icon,
    MUI_UNICON: icon,
    APP_64: payload,
    APP_64_NAME: path.basename(payload),
    APP_64_HASH: 'A'.repeat(128),
    APP_64_UNPACKED_SIZE: '1',
    COMPANY_NAME: pkg.author,
    APP_INSTALLER_STORE_FILE: `${pkg.name}-updater\\installer.exe`,
    COMPRESSION_METHOD: '7z',
    INSTALL_MODE_PER_ALL_USERS_REQUIRED: null, // oneClick: false
    SHORTCUT_NAME: pkg.build.nsis.shortcutName,
    UNINSTALL_DISPLAY_NAME: `${pkg.productName} ${pkg.version}`,
    MUI_WELCOMEFINISHPAGE_BITMAP: bitmap,
    MUI_UNWELCOMEFINISHPAGE_BITMAP: bitmap,
    COMPRESS: 'auto',
    UNINSTALLER_OUT_FILE: uninstaller,
  };
}

function compileListing(script, defines, outFile) {
  const args = ['-WX', '-V4'];
  for (const [k, v] of Object.entries(defines)) args.push(v == null ? `-D${k}` : `-D${k}=${v}`);
  args.push(`-XOutFile "${outFile}"`, '-XUnicode true', '-XSetCompressor zlib', '-');
  const lines = makensis(args, script);
  assert.ok(fs.existsSync(outFile), 'makensis produced no output file');
  return lines;
}

// Lines from `first` up to and including the next `last`
function listingBlock(lines, first, last) {
  const start = lines.indexOf(first);
  assert.notEqual(start, -1, `missing in the listing: ${first}`);
  const end = lines.indexOf(last, start);
  assert.notEqual(end, -1, `missing in the listing: ${last} (after ${first})`);
  return lines.slice(start, end + 1);
}
// Every expansion of a macro: [start, end] line indexes
function macroSpans(lines, name) {
  const spans = [];
  lines.forEach((l, i) => {
    if (l === `!insertmacro: ${name}`) spans.push([i, lines.indexOf(`!insertmacro: end of ${name}`, i)]);
  });
  return spans;
}
const ELEVATION = /^(!insertmacro: UAC_RunElevated|Plugin command: _ 0)$/; // UAC::_ 0 = relaunch elevated

describe('installer and uninstaller as makensis compiles them', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const PIN = `StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${pkg.productName}" () ()`;
  const REG = `ReadRegStr $sibersentezDir HKCU\\Software\\${NSIS_GUID}\\InstallLocation`;
  let uninstaller = [];
  let installer = [];
  let buildError = null;

  before(async () => {
    if (!NSIS) return;
    try {
      const defines = electronBuilderDefines(pkg);
      uninstaller = compileListing(await electronBuilderScript(pkg, 'un'), { ...defines, BUILD_UNINSTALLER: null }, path.join(TMP, 'nsis-uninstaller-writer.exe'));
      installer = compileListing(await electronBuilderScript(pkg, 'in'), defines, path.join(TMP, 'nsis-installer.exe'));
    } catch (err) {
      buildError = err; // reported by the first test instead of cancelling all of them
    }
  });

  test('both builds compile with -WX, as in "npm run dist"', NEEDS_NSIS, () => {
    if (buildError) throw buildError;
    for (const lines of [uninstaller, installer]) {
      assert.ok(lines.some((l) => /^Processing script file: "<stdin>"/.test(l)));
      assert.ok(lines.some((l) => /^Total size:/.test(l)), 'compilation finished');
      assert.deepEqual(lines.filter((l) => /^warning \d+:|^\d+ warnings?:/.test(l)), [], 'no warnings (-WX would have failed anyway)');
    }
    assert.ok(uninstaller.includes('Command line defined: "BUILD_UNINSTALLER"'));
  });

  test('uninstaller: un.onInit runs customUnInit after initMultiUser, and its last act is pinning $INSTDIR', NEEDS_NSIS, () => {
    const onInit = listingBlock(uninstaller, 'Function: "un.onInit"', 'FunctionEnd');
    const initEnd = onInit.indexOf('!insertmacro: end of initMultiUser');
    const hook = onInit.indexOf('!insertmacro: customUnInit');
    assert.ok(initEnd > 0 && hook === initEnd + 1, 'customUnInit comes right after initMultiUser');
    // initMultiUser can set $INSTDIR from /D= (GetDParameter); the pin overwrites it and nothing comes after
    assert.ok(onInit.slice(0, hook).some((l) => l === 'StrCpy $INSTDIR "$R0" () ()'), 'template writes /D= into $INSTDIR first');
    assert.deepEqual(onInit.slice(-5), [PIN, '!insertmacro: end of sibersentezPinDir', '!insertmacro: end of sibersentezPinProgramDir', '!insertmacro: end of customUnInit', 'FunctionEnd']);
    const hookLines = onInit.slice(hook);
    assert.ok(hookLines.includes(REG), 'folder read from HKCU InstallLocation');
    assert.deepEqual(hookLines.filter((l) => l.startsWith('StrCpy $INSTDIR')), [PIN], 'the only $INSTDIR written by the hook is the checked folder');
    const refuse = hookLines.indexOf('SetErrorLevel: 2');
    assert.ok(refuse > hookLines.indexOf(REG) && hookLines[refuse + 1] === 'Quit' && refuse < hookLines.indexOf(PIN), 'a refused folder quits before the pin');
    for (const l of hookLines) assert.doesNotMatch(l, /\$EXEDIR|\$EXEPATH|_\?=|GetDParameter|GetAllParameters/, 'no untrusted source');
  });

  test('uninstaller: /allusers cannot elevate; un.onInit holds no UAC relaunch and no all-users mode', NEEDS_NSIS, () => {
    const onInit = listingBlock(uninstaller, 'Function: "un.onInit"', 'FunctionEnd');
    assert.deepEqual(onInit.filter((l) => ELEVATION.test(l)), []);
    assert.ok(!onInit.includes('StrCpy $installMode "all" () ()'));
    const spans = macroSpans(uninstaller, 'setInstallModePerAllUsers');
    assert.ok(spans.some(([a]) => a > uninstaller.indexOf('Function: "un.onInit"')), 'initMultiUser still has the /allusers branch');
    for (const [a, b] of spans) {
      const body = uninstaller.slice(a, b + 1);
      assert.ok(body.includes('!insertmacro: setInstallModePerUser'), 'replaced by the current-user mode');
      assert.deepEqual(body.filter((l) => ELEVATION.test(l) || l === 'StrCpy $installMode "all" () ()'), []);
    }
  });

  test('uninstaller: the uninstall section pins the folder again before anything is removed', NEEDS_NSIS, () => {
    // the install-mode page runs between un.onInit and the section and reads /D= once more
    const pageStart = uninstaller.findIndex((l) => /^Function: "un\.MultiUser\.InstallModePre_/i.test(l));
    assert.ok(pageStart > 0);
    assert.ok(uninstaller.slice(pageStart, uninstaller.indexOf('FunctionEnd', pageStart)).includes('!insertmacro: GetDParameter'), 'why the section pins again');
    const section = listingBlock(uninstaller, 'Section: "un.Uninstall"', 'SectionEnd');
    const custom = section.indexOf('!insertmacro: customUnInstall');
    assert.equal(section[custom + 1], '!insertmacro: sibersentezPinProgramDir', 'the pin is the first thing customUnInstall does');
    const pin = section.indexOf(PIN);
    const firstRemoval = section.findIndex((l) => /^(RMDir|Delete|DeleteRegValue|DeleteRegKey)\b/.test(l));
    assert.ok(pin > custom && pin < firstRemoval, 'pinned before the first removal');
    assert.ok(section.slice(custom, pin).includes(REG));
    // customRemoveFiles replaces the template's RMDir /r $INSTDIR (and its rename-everything update path): pinned once
    // more, then (update) moved out whole into a new staging folder, restored on failure, the staging folder emptied, or
    // (real uninstall) emptied in place, by functions that never enter a link; then the uninstaller file, then the folder
    const remove = section.indexOf('!insertmacro: customRemoveFiles');
    assert.equal(section[remove + 1], '!insertmacro: sibersentezPinProgramDir');
    const pin2 = section.indexOf(PIN, remove);
    const staging = section.indexOf('StrCpy $1 "$INSTDIR\\~sibersentez-old-$0" () ()', pin2);
    const create = section.indexOf('Plugin command: Call kernel32::CreateDirectoryW(w r1, p 0) i .r0', staging);
    // (customUnInstall, before, also empties the updater folder through the same function)
    const callsAfterPin = (fn) => section.map((l, i) => [l, i]).filter(([l, i]) => i > pin2 && l === `Call "${fn}"`).map(([, i]) => i);
    const moves = callsAfterPin('un.sibersentezMoveEntries');
    const empties = callsAfterPin('un.sibersentezEmptyFolder');
    assert.ok(staging > pin2 && create === staging + 1, 'a new staging folder inside the pinned folder');
    assert.equal(moves.length, 2, 'move out, and back on failure');
    assert.deepEqual(section.slice(moves[0] - 2, moves[0]), ['Push: $1', 'Push: $INSTDIR'], 'out: from the program folder into the staging folder');
    assert.deepEqual(section.slice(moves[1] - 2, moves[1]), ['Push: $INSTDIR', 'Push: $1'], 'back: from the staging folder into the program folder');
    const restoreEnd = section.indexOf('Abort: ""', moves[1]);
    assert.deepEqual(section.slice(moves[1] + 1, restoreEnd + 1), ['Pop: $0', 'RMDir: "$1"', 'SetErrorLevel: 2', 'Abort: ""'], 'nothing is deleted after a failed move');
    assert.ok(section.slice(create, moves[0]).includes('Abort: ""'), 'no staging folder, no removal');
    assert.equal(empties.length, 2);
    assert.ok(empties[0] > restoreEnd && section[empties[0] - 1] === 'Push: $1', 'the staging folder is emptied only once everything is out');
    assert.equal(section[empties[1] - 1], 'Push: $INSTDIR', 'a real uninstall empties the folder in place');
    const rmUninstaller = section.indexOf(`Delete: "$INSTDIR\\Uninstall ${pkg.productName}.exe"`, empties[1]);
    const rmInstdir = section.indexOf('RMDir: "$INSTDIR"', rmUninstaller);
    assert.ok(pin2 > remove && rmUninstaller > empties[1] && rmInstdir > rmUninstaller, 'pin, empty, uninstaller, folder');
    assert.deepEqual(section.slice(pin2 + 1, rmInstdir).filter((l) => l.startsWith('StrCpy $INSTDIR')), [], 'nothing changes $INSTDIR between the pin and its removal');
    assert.deepEqual(section.filter((l) => /^RMDir: \/r "\$(INSTDIR|LOCALAPPDATA|1)/.test(l)), [], 'no RMDir /r on the program, staging or updater folder');
    assert.ok(!section.includes('Call "un.atomicRMDir"'), "the template's rename loop (it enters junctions too) is not used");
    // The move function renames each entry as it is: no recursion, no removal, no copy
    const mover = listingBlock(uninstaller, 'Function: "un.sibersentezMoveEntries"', 'FunctionEnd');
    assert.deepEqual(mover.filter((l) => /^(RMDir|Delete|Call|CopyFiles|Plugin command)\b/.test(l)), []);
    assert.deepEqual(mover.filter((l) => l.startsWith('Rename:')), ['Rename: $R4->$R1\\$R3']);
    // The emptying function looks at each entry's own attributes before it removes it, and never recurses into a link
    const fn = listingBlock(uninstaller, 'Function: "un.sibersentezEmptyFolder"', 'FunctionEnd');
    const attrs = fn.indexOf('Plugin command: Call kernel32::GetFileAttributesW(w R4) i .R3');
    assert.ok(attrs > 0 && attrs < fn.findIndex((l) => /^(RMDir|Delete|Call)\b/.test(l)));
    assert.equal(fn.filter((l) => l === 'Call "un.sibersentezEmptyFolder"').length, 1, 'one recursive call, for real folders only');
    assert.deepEqual(fn.filter((l) => /^RMDir: \/r/.test(l)), []);
  });

  test('uninstaller: no process is looked for or closed before the folder is pinned, and none outside it', NEEDS_NSIS, () => {
    // Every command the uninstaller program can start
    const EXEC = /^Plugin command: Exec|^Exec(Wait|Shell)?:/;
    const start = uninstaller.indexOf('Function: "un.checkAppRunning"');
    const fn = listingBlock(uninstaller, 'Function: "un.checkAppRunning"', 'FunctionEnd');
    const execs = uninstaller.map((l, i) => [l, i]).filter(([l]) => EXEC.test(l));
    assert.ok(execs.length >= 6, 'PowerShell checks found');
    for (const [l, i] of execs) assert.ok(i > start && i < start + fn.length, `only in un.checkAppRunning: ${l}`);
    // In the function: registry value, check (refusal quits), pin, and only then the first command
    const reg = fn.indexOf(REG);
    const pin = fn.indexOf(PIN);
    const refuse = fn.indexOf('SetErrorLevel: 2');
    const firstExec = fn.findIndex((l) => EXEC.test(l));
    assert.ok(reg > 0 && refuse > reg && fn[refuse + 1] === 'Quit' && pin > refuse && firstExec > pin, 'read, check, pin, then commands');
    assert.deepEqual(fn.slice(pin + 1).filter((l) => l.startsWith('StrCpy $INSTDIR')), [], 'nothing changes $INSTDIR after the pin');
    // The folder reaches PowerShell through an environment variable with a trailing backslash, never in the command text
    const envDir = fn.indexOf('StrCpy $0 "$INSTDIR\\" () ()');
    assert.ok(envDir > pin && envDir < firstExec);
    assert.equal(fn[envDir + 1], 'Plugin command: Call kernel32::SetEnvironmentVariableW(w "SIBERSENTEZ_PROGRAM_DIR", w r0) i');
    for (const [l] of execs) assert.doesNotMatch(l, /\$INSTDIR|\$installationDir|_\?=|taskkill|tasklist|IMAGENAME/i, l);
    // Every PowerShell, including the availability check, runs without the user's profile and cannot prompt
    for (const [l] of execs) assert.match(l, /^Plugin command: Exec "\$PowerShellPath" -NoProfile -NonInteractive -Command "/, l);
    assert.deepEqual(macroSpans(uninstaller, 'IS_POWERSHELL_AVAILABLE'), [], "electron-builder's availability check (no -NoProfile) is not used");
    const stops = execs.filter(([l]) => /Stop-Process/.test(l)).map(([l]) => l);
    assert.equal(stops.length, 2, 'close, then force-close');
    for (const l of stops) {
      assert.match(l, /\$\$d = \$\$env:SIBERSENTEZ_PROGRAM_DIR;.*-not \$\$d\.EndsWith\('\\'\)\) \{ exit 2 \}/, 'no folder, no search');
      assert.match(l, /\$\$_\.ProcessId -ne \$\$s -and \$\$_\.ExecutablePath\.StartsWith\(\$\$d, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
    }
    assert.deepEqual(macroSpans(uninstaller, '_CHECK_APP_RUNNING'), [], "electron-builder's own check is not used");
    // The template calls the function from un.onInit before initMultiUser (silent) and from the section (not silent)
    const onInit = listingBlock(uninstaller, 'Function: "un.onInit"', 'FunctionEnd');
    assert.ok(onInit.indexOf('Call "un.checkAppRunning"') < onInit.indexOf('!insertmacro: initMultiUser'), 'why the function pins by itself');
    assert.ok(listingBlock(uninstaller, 'Section: "un.Uninstall"', 'SectionEnd').includes('Call "un.checkAppRunning"'));
  });

  test('installer: before closing the app or running the old uninstaller, the install section checks the folder, InstallLocation and UninstallString again', NEEDS_NSIS, () => {
    const EXEC = /^Plugin command: Exec|^Exec(Wait|Shell)?:/;
    const section = listingBlock(installer, 'Section: "install" ->(INSTALL_SECTION_ID)', 'SectionEnd');
    const hook = section.indexOf('!insertmacro: customCheckAppRunning');
    assert.equal(section[hook + 1], '!insertmacro: sibersentezRecheckInstallDir');
    const reg = section.indexOf(`ReadRegStr $R8 HKCU\\Software\\${NSIS_GUID}\\InstallLocation`, hook);
    const regUninstall = section.indexOf(`ReadRegStr $R9 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_GUID}\\UninstallString`, hook);
    const checkUninstall = section.indexOf('!insertmacro: sibersentezCheckUninstallString', hook);
    const refuse = section.indexOf('SetErrorLevel: 2', hook);
    const pin = section.indexOf(PIN, hook);
    assert.ok(reg > hook && regUninstall > reg && checkUninstall > regUninstall && refuse > checkUninstall && section[refuse + 1] === 'Quit' && pin > refuse, 'both values read and checked, refusal quits, then the folder is set');
    // uninstallOldVersion reads the uninstall entry from the same key (the current user's, as SHELL_CONTEXT is here)
    const old = listingBlock(installer, 'Function: "uninstallOldVersion"', 'FunctionEnd');
    assert.ok(old.includes(`ReadRegStr $uninstallString SHELL_CONTEXT\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_GUID}\\UninstallString`));
    assert.ok(old.includes(`ReadRegStr $installationDir SHELL_CONTEXT\\Software\\${NSIS_GUID}\\InstallLocation`));
    // Right after the old uninstaller: our check answers by itself in a silent run and stops before any new file
    const result = listingBlock(installer, 'Function: "handleUninstallResult"', 'FunctionEnd');
    for (const hookName of ['customUnInstallCheck', 'customUnInstallCheckCurrentUser']) {
      const at = result.indexOf(`!insertmacro: ${hookName}`);
      assert.ok(at > 0, hookName);
      assert.equal(result[result.indexOf(`!insertmacro: end of ${hookName}`, at) + 1], 'Return', `${hookName} replaces the template's own message`);
    }
    const stop = result.indexOf('SetErrorLevel: 2');
    assert.ok(stop > 0 && result[stop + 1] === 'Quit');
    const execs = section.map((l, i) => [l, i]).filter(([l]) => EXEC.test(l));
    assert.ok(execs.length >= 6);
    for (const [l, i] of execs) {
      assert.ok(i > pin, `after the check: ${l}`);
      assert.doesNotMatch(l, /\$INSTDIR|taskkill|tasklist/i, l);
      if (/PowerShell/i.test(l)) assert.match(l, /^Plugin command: Exec "\$PowerShellPath" -NoProfile -NonInteractive -Command "/, l);
    }
    assert.deepEqual(macroSpans(installer, 'IS_POWERSHELL_AVAILABLE'), []);
    // uninstallOldVersion reads InstallLocation once more and passes it as _?=: that value was checked just before
    assert.ok(section.indexOf('Call "uninstallOldVersion"') > pin);
    assert.ok(installer.some((l) => /^ExecWait: .*_\?=\$installationDir/.test(l)), 'template layout this relies on');
  });

  test('every message box of our macros in the compiled programs shows a LangString defined in both languages', NEEDS_NSIS, () => {
    for (const lines of [installer, uninstaller]) {
      const ours = ['customInit', 'sibersentezRefuse', 'sibersentezCloseApp', 'customUnInstallCheck'].flatMap((m) => macroSpans(lines, m)).flatMap(([a, b]) => lines.slice(a, b + 1));
      const boxes = ours.filter((l) => l.startsWith('MessageBox:'));
      assert.ok(boxes.length >= 3);
      for (const box of boxes) {
        const id = /^MessageBox: \d+: "\$\((\w+)\)/.exec(box)?.[1];
        assert.ok(id, `a LangString: ${box}`);
        for (const lang of ['1033', '1055']) assert.ok(lines.some((l) => l.startsWith(`LangString: "${id}" ${lang} "`)), `${id} ${lang}`);
      }
    }
  });

  test('installer: .onInit refuses /D= and a folder the uninstaller would refuse, and never elevates', NEEDS_NSIS, () => {
    const onInit = listingBlock(installer, 'Function: ".onInit"', 'FunctionEnd');
    const hook = onInit.indexOf('!insertmacro: customInit');
    assert.equal(onInit[hook - 1], '!insertmacro: end of initMultiUser');
    const hookLines = onInit.slice(hook);
    const check = hookLines.indexOf('!insertmacro: sibersentezCheckProgramDir');
    assert.ok(check > 0 && hookLines.indexOf('!insertmacro: GetDParameter') < check);
    assert.equal(hookLines.filter((l) => l === 'SetErrorLevel: 2').length, 2, 'two refusals: /D= and the folder check');
    assert.deepEqual(onInit.filter((l) => ELEVATION.test(l) || l === 'StrCpy $installMode "all" () ()'), []);
    assert.deepEqual(onInit.slice(-2), ['!insertmacro: end of customInit', 'FunctionEnd']);
  });
});

// ------------------------------------------------------------------ small NSIS programs around installer.nsh
// Each harness is a silent NSIS program that includes build/installer.nsh with the symbols electron-builder would
// define, both installer languages and stand-ins for electron-builder's messages, and runs a few of its macros on
// folders under TMP. The harnesses never read or write the registry: they call the pin with a made-up
// InstallLocation value instead of sibersentezPinProgramDir, and a guard in the harness itself stops before any process
// is looked for or any file removed when $INSTDIR is not under TMP.
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HARNESS_APP_EXE = `sibersentez-harness-app-${process.pid}.exe`; // the app's exe name in the harnesses: never a real program's
const nsisQ = (s) => `"${String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"')}"`;

function harnessScript({ out, updated = false, top = [], body }) {
  return [
    'Unicode true',
    'Name "sibersentez-harness"',
    `OutFile ${nsisQ(out)}`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    '!include LogicLib.nsh',
    `!define PRODUCT_NAME ${nsisQ(PKG.productName)}`,
    `!define APP_FILENAME ${nsisQ(PKG.productName)}`,
    `!define UNINSTALL_FILENAME ${nsisQ(`Uninstall ${PKG.productName}.exe`)}`,
    `!define APP_EXECUTABLE_FILENAME ${nsisQ(HARNESS_APP_EXE)}`,
    // stand-ins for the command-line tests electron-builder defines before installer.nsh
    '!macro _isUpdated _a _b _t _f',
    `  StrCmp "${updated ? 1 : 0}" "1" \`\${_t}\` \`\${_f}\``,
    '!macroend',
    '!define isUpdated `"" isUpdated ""`',
    '!macro _isForAllUsers _a _b _t _f',
    '!macroend',
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\Turkish.nlf"',
    ...['appRunning', 'appCannotBeClosed', 'appClosing'].flatMap((k) => [`LangString ${k} 1033 "${k}"`, `LangString ${k} 1055 "${k}"`]),
    `!include ${nsisQ(path.join(ROOT, 'build', 'installer.nsh'))}`,
    ...top,
    'Section',
    ...body,
    'SectionEnd',
  ].join('\n');
}

// Stops the harness (exit code 7) unless VALUE starts with BASE
function harnessGuard(value, base) {
  return [`  StrLen $8 ${nsisQ(base)}`, `  StrCpy $9 ${value} $8`, `  \${If} $9 != ${nsisQ(base)}`, '    SetErrorLevel 7', '    Quit', '  ${EndIf}'];
}

// Writes RESULT once the harness got to its end
const harnessDone = (result) => [`  FileOpen $9 ${nsisQ(result)} w`, '  FileWrite $9 "done"', '  FileClose $9'];

// Resolves the harness' exit code (null when it had to be stopped at the timeout, by its own handle)
function runHarness(exe, { timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(exe, [], { windowsHide: true, timeout, env: env && { ...process.env, ...env } }, () => resolve(child.exitCode));
  });
}

// Every file and folder under dir, relative, links marked
function listTree(dir) {
  const out = [];
  const walk = (p, rel) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(p, e.name);
      if (fs.lstatSync(full).isSymbolicLink()) out.push(`${r} (link)`);
      else if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

const pathExists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('program folder check, run by NSIS itself', () => {
  const LAD = 'C:\\Users\\Test User\\AppData\\Local';
  const HOME = 'C:\\Users\\Test User';
  const OK = '';
  // name: [candidate, %LOCALAPPDATA%, %USERPROFILE%, expected reason]
  const cases = {
    exact: [`${LAD}\\Programs\\SiberSentez`, LAD, HOME, OK],
    'trailing backslashes': [`${LAD}\\Programs\\SiberSentez\\\\`, LAD, HOME, OK],
    'other letter case': [`${LAD.toUpperCase()}\\programs\\SIBERSENTEZ\\`, LAD, HOME, OK],
    empty: ['', LAD, HOME, 'empty'],
    'only backslashes': ['\\\\', LAD, HOME, 'empty'],
    'drive root': ['C:\\', LAD, HOME, 'drive root'],
    'bare drive': ['D:', LAD, HOME, 'drive root'],
    home: [HOME, LAD, HOME, 'home folder'],
    'home, other case': [`${HOME.toLowerCase()}\\`, LAD, HOME, 'home folder'],
    hub: [`${HOME}\\SiberSentez`, LAD, HOME, 'hub folder'],
    'hub, other case': [`${HOME.toUpperCase()}\\SIBERSENTEZ\\`, LAD, HOME, 'hub folder'],
    'shared prefix': [`${LAD}\\Programs\\SiberSentez2`, LAD, HOME, 'not the program folder'],
    parent: [`${LAD}\\Programs`, LAD, HOME, 'not the program folder'],
    child: [`${LAD}\\Programs\\SiberSentez\\resources`, LAD, HOME, 'not the program folder'],
    'dot-dot': [`${LAD}\\Programs\\SiberSentez\\..\\SiberSentez`, LAD, HOME, 'not the program folder'],
    'forward slashes': [`${LAD.replaceAll('\\', '/')}/Programs/SiberSentez`, LAD, HOME, 'not the program folder'],
    'network share': ['\\\\server\\share\\SiberSentez', LAD, HOME, 'not the program folder'],
    'other drive': ['D:\\SiberSentez', LAD, HOME, 'not the program folder'],
    'local app data unknown': [`${LAD}\\Programs\\SiberSentez`, '', HOME, 'user folders unknown'],
    'profile unknown': [`${LAD}\\Programs\\SiberSentez`, LAD, '', 'user folders unknown'],
  };
  test('only %LOCALAPPDATA%\\Programs\\SiberSentez passes; empty, root, home, hub and every other spelling are refused', NEEDS_NSIS, () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'dircheck-'));
    const exe = path.join(dir, 'sibersentez-dircheck.exe');
    const result = path.join(dir, 'result.txt');
    const ids = Object.keys(cases);
    const script = harnessScript({
      out: exe,
      body: [
        `  FileOpen $9 ${nsisQ(result)} w`,
        ...ids.flatMap((id, i) => {
          const [candidate, lad, home] = cases[id];
          return [`  !insertmacro sibersentezCheckProgramDir ${nsisQ(candidate)} ${nsisQ(lad)} ${nsisQ(home)}`, `  FileWrite $9 "${i}=$sibersentezReason$\\r$\\n"`];
        }),
        '  FileClose $9',
      ],
    });
    const listing = makensis(['-WX', '-V4', '-'], script);
    // the harness only compares strings and writes its result file: no removal, registry, exec or plugin call
    const program = listingBlock(listing, 'Section: ""', 'SectionEnd');
    assert.deepEqual(program.filter((l) => /^(RMDir|Delete|Rename|CopyFiles|WriteReg|DeleteReg|Exec|Plugin command|Call)\b/.test(l)), []);
    execFileSync(exe, [], { windowsHide: true, timeout: 60000 });
    const got = Object.fromEntries(
      fs
        .readFileSync(result, 'latin1')
        .trim()
        .split(/\r?\n/)
        .map((l) => {
          const [i, reason] = l.split('=');
          return [ids[Number(i)], reason];
        }),
    );
    assert.deepEqual(got, Object.fromEntries(ids.map((id) => [id, cases[id][3]])));
  });

  // electron-builder's uninstallOldVersion runs (a copy of) the file quoted at the start of UninstallString with _?= set
  // to InstallLocation or, when InstallLocation is empty, to that file's folder. After our check, the harness derives
  // both the way the template does, with the template's own GetInQuotes and GetFileParent.
  const INSTALL_UTIL = fs.readFileSync(path.join(NSIS_TEMPLATES, 'include', 'installUtil.nsh'), 'utf8');
  const templateFunction = (name) => {
    const m = new RegExp(`^Function ${name}\\r?\\n[\\s\\S]*?^FunctionEnd`, 'm').exec(INSTALL_UTIL);
    assert.ok(m, `template function ${name}`);
    return m[0];
  };
  const PROGRAM = `${LAD}\\Programs\\SiberSentez`;
  const UNINSTALLER = `${PROGRAM}\\Uninstall ${PKG.productName}.exe`;
  // name: [InstallLocation, UninstallString, accepted]
  const entries = {
    'first install: no record at all': ['', '', true],
    'update: both name the program folder': [PROGRAM, `"${UNINSTALLER}" /currentuser`, true],
    'InstallLocation empty, the uninstall entry names the program folder': ['', `"${UNINSTALLER}" /currentuser`, true],
    'other letter case': [PROGRAM.toUpperCase(), `"${UNINSTALLER.toLowerCase()}" /currentuser`, true],
    'InstallLocation empty, the uninstall entry lies in the home folder': ['', `"${HOME}\\Uninstall ${PKG.productName}.exe" /currentuser`, false],
    'InstallLocation empty, the uninstall entry lies in the hub': ['', `"${HOME}\\SiberSentez\\Uninstall ${PKG.productName}.exe"`, false],
    'InstallLocation empty, the uninstall entry lies at a drive root': ['', `"C:\\Uninstall ${PKG.productName}.exe"`, false],
    'uninstall entry in a sibling folder with the same prefix': ['', `"${LAD}\\Programs\\SiberSentez2\\Uninstall ${PKG.productName}.exe"`, false],
    'uninstall entry in a subfolder': ['', `"${PROGRAM}\\sub\\Uninstall ${PKG.productName}.exe"`, false],
    'uninstall entry climbs out with ..': ['', `"${PROGRAM}\\..\\..\\Uninstall ${PKG.productName}.exe"`, false],
    'uninstall entry names another program in the folder': [PROGRAM, `"${PROGRAM}\\${PKG.productName}.exe"`, false],
    'uninstall entry without quotes': ['', `${UNINSTALLER} /currentuser`, false],
    'text before the quotes': ['', `x"${HOME}\\Uninstall ${PKG.productName}.exe"`, false],
    'InstallLocation elsewhere, the uninstall entry fine': [HOME, `"${UNINSTALLER}"`, false],
  };
  test('the uninstall entry: whatever the template takes for the old uninstaller and its _?= is the program folder, or the installer stops', NEEDS_NSIS, () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'entrycheck-'));
    const exe = path.join(dir, 'sibersentez-entrycheck.exe');
    const result = path.join(dir, 'result.txt');
    const ids = Object.keys(entries);
    const script = harnessScript({
      out: exe,
      top: [templateFunction('GetInQuotes'), templateFunction('GetFileParent')],
      body: [
        `  FileOpen $9 ${nsisQ(result)} w`,
        ...ids.flatMap((id, i) => {
          const [location, uninstallString] = entries[id];
          return [
            `  !insertmacro sibersentezCheckInstallDirs ${nsisQ(PROGRAM)} ${nsisQ(location)} ${nsisQ(uninstallString)} ${nsisQ(LAD)} ${nsisQ(HOME)}`,
            '  ${If} $sibersentezReason == ""',
            // uninstallOldVersion: $1 = GetInQuotes(UninstallString); $2 = InstallLocation, else GetFileParent($1)
            `    Push ${nsisQ(uninstallString)}`,
            '    Call GetInQuotes',
            '    Pop $1',
            `    StrCpy $2 ${nsisQ(location)}`,
            '    ${If} $2 == ""',
            '    ${AndIf} $1 != ""',
            '      Push $1',
            '      Call GetFileParent',
            '      Pop $2',
            '    ${EndIf}',
            `    FileWrite $9 "${i}|accepted|$1|$2$\\r$\\n"`,
            '  ${Else}',
            `    FileWrite $9 "${i}|refused|$sibersentezReason|$\\r$\\n"`,
            '  ${EndIf}',
          ];
        }),
        '  FileClose $9',
      ],
    });
    const listing = makensis(['-WX', '-V4', '-'], script);
    const program = listingBlock(listing, 'Section: ""', 'SectionEnd');
    assert.deepEqual(program.filter((l) => /^(RMDir|Delete|Rename|CopyFiles|ReadReg|WriteReg|DeleteReg|Exec|Plugin command)\b/.test(l)), [], 'string checks only');
    execFileSync(exe, [], { windowsHide: true, timeout: 60000 });
    const got = Object.fromEntries(
      fs
        .readFileSync(result, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => {
          // accepted: the file the template runs and its _?=; refused: the reason
          const [i, verdict, first, second] = l.split('|');
          return [ids[Number(i)], verdict === 'accepted' ? { verdict, runs: first, instDir: second } : { verdict, reason: first }];
        }),
    );
    assert.deepEqual(
      Object.fromEntries(ids.map((id) => [id, got[id].verdict])),
      Object.fromEntries(ids.map((id) => [id, entries[id][2] ? 'accepted' : 'refused'])),
    );
    for (const id of ids.filter((k) => entries[k][2])) {
      const { runs, instDir } = got[id];
      if (!entries[id][1]) {
        assert.deepEqual({ runs, instDir }, { runs: '', instDir: '' }, `${id}: nothing runs`);
        continue;
      }
      assert.equal(runs.toLowerCase(), UNINSTALLER.toLowerCase(), `${id}: the old uninstaller is the program folder's own`);
      assert.equal(instDir.toLowerCase(), PROGRAM.toLowerCase(), `${id}: _?= is the program folder`);
    }
    for (const id of ids.filter((k) => !entries[k][2])) assert.ok(got[id].reason, `${id}: a reason is given`);
  });
});

// A stand-in for the running app: a silent NSIS program that only sleeps. Copies of it run from the program folder
// and from folders around it. Only processes this file started are stopped at the end, by pid (child.kill).
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleeperExe = null;
function ensureSleeper() {
  if (sleeperExe) return sleeperExe;
  const file = path.join(TMP, 'sleeper', 'sleeper.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  makensis(['-WX', '-V2', '-'], ['Unicode true', 'Name "sibersentez-sleeper"', `OutFile ${nsisQ(file)}`, 'RequestExecutionLevel user', 'SilentInstall silent', 'Section', '  Sleep 300000', 'SectionEnd'].join('\n'));
  return (sleeperExe = file);
}
function startSleeper(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(ensureSleeper(), file);
  const child = spawn(file, [], { windowsHide: true, stdio: 'ignore' });
  child.exited = new Promise((resolve) => child.once('exit', resolve));
  return child;
}
const isRunning = (child) => child.exitCode === null && child.signalCode === null;
async function stopSleepers(children) {
  for (const c of children) if (isRunning(c)) c.kill();
  await Promise.all(children.map((c) => c.exited));
}

// A stand-in for a program that keeps a file open (an editor, a virus scanner): a silent NSIS program that opens the
// file named in SIBERSENTEZ_TEST_LOCK without FILE_SHARE_DELETE, so Windows refuses to delete or rename the file and the
// folders around it, writes SIBERSENTEZ_TEST_LOCK_READY once it holds the file, then sleeps. Stopped by pid like the sleepers.
let lockerExe = null;
function ensureLocker() {
  if (lockerExe) return lockerExe;
  const file = path.join(TMP, 'locker', 'locker.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['Unicode true', 'Name "sibersentez-locker"', `OutFile ${nsisQ(file)}`, 'RequestExecutionLevel user', 'SilentInstall silent', '!include LogicLib.nsh', 'Section'];
  lines.push('  ReadEnvStr $0 SIBERSENTEZ_TEST_LOCK', '  ReadEnvStr $2 SIBERSENTEZ_TEST_LOCK_READY', '  ClearErrors', '  FileOpen $1 $0 r', '  ${If} ${Errors}', '    SetErrorLevel 3', '    Quit', '  ${EndIf}');
  lines.push('  FileOpen $3 $2 w', '  FileClose $3', '  Sleep 300000', 'SectionEnd');
  makensis(['-WX', '-V2', '-'], lines.join('\n'));
  return (lockerExe = file);
}
let lockCount = 0;
async function lockFile(file) {
  const ready = path.join(TMP, 'locker', `ready-${++lockCount}`);
  const child = spawn(ensureLocker(), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, SIBERSENTEZ_TEST_LOCK: file, SIBERSENTEZ_TEST_LOCK_READY: ready } });
  child.exited = new Promise((resolve) => child.once('exit', resolve));
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await delay(25);
  if (!fs.existsSync(ready)) {
    await stopSleepers([child]);
    throw new Error(`could not hold ${file} open`);
  }
  return child;
}

// A stand-in for Windows PowerShell: records each command line it is started with (SIBERSENTEZ_TEST_PS_LOG) and answers
// like a PowerShell that works and finds no process of the app (exit code 1 for the Win32_Process search, 0 otherwise)
function fakePowerShell(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['Unicode true', 'Name "sibersentez-fake-powershell"', `OutFile ${nsisQ(file)}`, 'RequestExecutionLevel user', 'SilentInstall silent', '!include LogicLib.nsh', '!include StrFunc.nsh', '${StrStr}', 'Section'];
  lines.push('  ReadEnvStr $0 SIBERSENTEZ_TEST_PS_LOG', '  FileOpen $1 $0 a', '  FileSeek $1 0 END', '  FileWrite $1 "$CMDLINE$\\r$\\n"', '  FileClose $1');
  lines.push('  ${StrStr} $2 $CMDLINE "Win32_Process"', '  ${If} $2 != ""', '    SetErrorLevel 1', '  ${EndIf}', 'SectionEnd');
  makensis(['-WX', '-V2', '-'], lines.join('\n'));
  return file;
}

describe('closing the running app, run by NSIS itself', () => {
  // name: InstallLocation value and what /D= or _?= had put into $INSTDIR (both from the case's folders), the user
  // folder's name, where the harness runs from, whether PowerShell exists, and the expected exit code and closed copies
  const cases = {
    'InstallLocation names the program folder; /D= had given the home folder': { value: (p) => p.program, preset: (p) => p.home, status: 0, closed: ['program'] },
    'InstallLocation is the home folder (what /S /D=C:\\Users\\<name> leads to)': { value: (p) => p.home, preset: (p) => p.home, status: 2, closed: [] },
    'InstallLocation is a sibling folder with the same prefix': { value: (p) => p.sibling, preset: (p) => p.program, status: 2, closed: [] },
    'InstallLocation tries to break out of a PowerShell string': { value: (p) => `${p.program}'; Get-Process | Stop-Process; '`, preset: (p) => p.home, status: 2, closed: [] },
    'no InstallLocation value': { value: () => '', preset: (p) => p.home, status: 2, closed: [] },
    "a quote in the user's own profile path": { user: "O'Brien", value: (p) => p.program, preset: (p) => p.home, status: 0, closed: ['program'] },
    'the uninstaller runs in place from the program folder (_?=) and does not close itself': { inPlace: true, value: (p) => p.program, preset: (p) => p.program, status: 0, closed: ['program'] },
    'without PowerShell nothing is closed by name; the user is asked (silent: Cancel)': { powershell: false, value: (p) => p.program, preset: (p) => p.home, status: 2, closed: [] },
  };

  test('only processes whose exe lies inside the pinned program folder are closed; a folder from outside closes nothing', NEEDS_NSIS, async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'close-'));
    const runs = Object.entries(cases).map(([name, c], i) => {
      const base = path.join(dir, `c${i}`);
      const home = path.join(base, c.user || 'user');
      const lad = path.join(home, 'AppData', 'Local');
      const places = {
        program: path.join(lad, 'Programs', PKG.productName),
        sibling: path.join(lad, 'Programs', `${PKG.productName}2`),
        home,
        hub: path.join(home, HUB_DIR_NAME),
      };
      const uninstallerFile = path.join(places.program, `Uninstall ${PKG.productName}.exe`);
      fs.mkdirSync(places.program, { recursive: true });
      const exe = c.inPlace ? uninstallerFile : path.join(base, 'harness.exe');
      if (!c.inPlace) fs.writeFileSync(uninstallerFile, 'stand-in');
      const powershell = c.powershell === false ? nsisQ(path.join(base, 'no-powershell.exe')) : '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"';
      makensis(
        ['-WX', '-V2', '-'],
        harnessScript({
          out: exe,
          top: [`!addincludedir ${nsisQ(path.join(NSIS_TEMPLATES, 'include'))}`, '!include allowOnlyOneInstallerInstance.nsh', 'Var PowerShellPath'],
          body: [
            `  StrCpy $INSTDIR ${nsisQ(c.preset(places))}`,
            `  !insertmacro sibersentezPinDir ${nsisQ(c.value(places))} ${nsisQ(lad)} ${nsisQ(home)}`,
            ...harnessGuard('$INSTDIR', base),
            `  StrCpy $PowerShellPath ${powershell}`,
            `  !insertmacro sibersentezCloseApp ${nsisQ(lad)}`,
            ...harnessDone(`${exe}.done`),
          ],
        }),
      );
      return { name, c, places, exe };
    });
    const sleepers = runs.map((r) => Object.fromEntries(Object.entries(r.places).map(([k, d]) => [k, startSleeper(path.join(d, HARNESS_APP_EXE))])));
    const all = sleepers.flatMap((s) => Object.values(s));
    try {
      await delay(500);
      const statuses = await Promise.all(runs.map((r) => runHarness(r.exe)));
      await Promise.all(runs.flatMap((r, i) => r.c.closed.map((k) => Promise.race([sleepers[i][k].exited, delay(5000)]))));
      await delay(300);
      const got = Object.fromEntries(runs.map((r, i) => [r.name, { status: statuses[i], done: fs.existsSync(`${r.exe}.done`), closed: Object.keys(r.places).filter((k) => !isRunning(sleepers[i][k])) }]));
      const want = Object.fromEntries(runs.map((r) => [r.name, { status: r.c.status, done: r.c.status === 0, closed: r.c.closed }]));
      assert.deepEqual(got, want);
    } finally {
      await stopSleepers(all);
    }
  });

  test("every PowerShell the close step starts, the availability check included, runs without the user's profile and cannot prompt", NEEDS_NSIS, async () => {
    // A profile script that waits for input would hang a silent install or uninstall: the stand-in records each start
    const base = fs.mkdtempSync(path.join(TMP, 'close-powershell-'));
    const home = path.join(base, 'user');
    const lad = path.join(home, 'AppData', 'Local');
    const program = path.join(lad, 'Programs', PKG.productName);
    fs.mkdirSync(program, { recursive: true });
    fs.writeFileSync(path.join(program, `Uninstall ${PKG.productName}.exe`), 'stand-in');
    const fake = fakePowerShell(path.join(base, 'fake-powershell.exe'));
    const log = path.join(base, 'powershell-starts.txt');
    const exe = path.join(base, 'harness.exe');
    makensis(
      ['-WX', '-V2', '-'],
      harnessScript({
        out: exe,
        top: [`!addincludedir ${nsisQ(path.join(NSIS_TEMPLATES, 'include'))}`, '!include allowOnlyOneInstallerInstance.nsh', 'Var PowerShellPath'],
        body: [
          `  !insertmacro sibersentezPinDir ${nsisQ(program)} ${nsisQ(lad)} ${nsisQ(home)}`,
          ...harnessGuard('$INSTDIR', base),
          `  StrCpy $PowerShellPath ${nsisQ(fake)}`,
          `  !insertmacro sibersentezCloseApp ${nsisQ(lad)}`,
          ...harnessDone(`${exe}.done`),
        ],
      }),
    );
    assert.equal(await runHarness(exe, { env: { SIBERSENTEZ_TEST_PS_LOG: log } }), 0);
    assert.ok(fs.existsSync(`${exe}.done`));
    const starts = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    // the two availability checks, then the search that finds nothing to close
    assert.equal(starts.length, 3, starts.join('\n'));
    assert.match(starts[0], /Get-Command Get-CimInstance/);
    assert.match(starts[1], /Get-ExecutionPolicy/);
    assert.match(starts[2], /Win32_Process/);
    for (const line of starts) assert.ok(line.startsWith(`"${fake}" -NoProfile -NonInteractive -Command "`), line);
  });
});

describe('removing folders without following links, run by NSIS itself', () => {
  function world(name) {
    const base = fs.mkdtempSync(path.join(TMP, `remove-${name}-`));
    const home = path.join(base, 'user');
    const lad = path.join(home, 'AppData', 'Local');
    return { base, home, lad, program: path.join(lad, 'Programs', PKG.productName), uninstaller: `Uninstall ${PKG.productName}.exe` };
  }
  const put = (file, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // A folder outside the program folder with files that must survive
  const victim = (dir) => {
    put(path.join(dir, 'keep.txt'));
    put(path.join(dir, 'inner', 'keep2.txt'));
    return dir;
  };
  const VICTIM_TREE = ['inner/', 'inner/keep2.txt', 'keep.txt'];
  const pinAndRemove = (w) => [
    `  StrCpy $INSTDIR ${nsisQ(w.home)}`,
    `  !insertmacro sibersentezPinDir ${nsisQ(w.program)} ${nsisQ(w.lad)} ${nsisQ(w.home)}`,
    ...harnessGuard('$INSTDIR', w.base),
    '  !insertmacro sibersentezRemoveProgramDir',
  ];
  // functions: the harness defines only the ones its body calls (-WX refuses an unused function)
  function build(w, { updated = false, body, functions = ['sibersentezEmptyFolderFunction', 'sibersentezMoveEntriesFunction'] }) {
    const exe = path.join(w.base, 'harness.exe');
    makensis(['-WX', '-V2', '-'], harnessScript({ out: exe, updated, top: functions.map((f) => `!insertmacro ${f}`), body: [...body, ...harnessDone(`${exe}.done`)] }));
    return exe;
  }
  // A program folder with a real subtree and two junctions (top level and nested) into folders outside it
  function installed(w) {
    put(path.join(w.program, 'a.txt'), 'a');
    put(path.join(w.program, 'resources', 'b.txt'), 'b');
    put(path.join(w.program, 'resources', 'deeper', 'c.txt'), 'c');
    put(path.join(w.program, w.uninstaller));
    const top = victim(path.join(w.base, 'victim-top'));
    const nested = victim(path.join(w.base, 'victim-nested'));
    fs.symlinkSync(top, path.join(w.program, 'link-top'), 'junction'); // junctions need no admin rights
    fs.symlinkSync(nested, path.join(w.program, 'resources', 'link-nested'), 'junction');
    return { top, nested };
  }
  const STAGING = /^~sibersentez-old-\d+$/;

  test('the program folder is removed, but no junction inside it is entered (top level or nested), in an update as in a real uninstall', NEEDS_NSIS, async () => {
    for (const updated of [false, true]) {
      const w = world(updated ? 'inside-update' : 'inside');
      const { top, nested } = installed(w);
      const exe = build(w, { updated, body: pinAndRemove(w) });
      assert.equal(await runHarness(exe), 0, updated ? 'update' : 'real uninstall');
      assert.equal(pathExists(w.program), false, 'the program folder is gone, staging folder included');
      assert.deepEqual(listTree(top), VICTIM_TREE, 'the target of the top-level junction is untouched');
      assert.deepEqual(listTree(nested), VICTIM_TREE, 'the target of the nested junction is untouched');
      assert.deepEqual(fs.readdirSync(path.dirname(w.program)), [], 'nothing is left next to the program folder');
    }
  });

  test('a program folder that is itself a junction is refused: exit code 2, the link and its target stay', NEEDS_NSIS, async () => {
    const w = world('linked');
    const target = victim(path.join(w.base, 'victim'));
    put(path.join(target, w.uninstaller));
    fs.mkdirSync(path.dirname(w.program), { recursive: true });
    fs.symlinkSync(target, w.program, 'junction');
    const exe = build(w, { body: pinAndRemove(w) });
    assert.equal(await runHarness(exe), 2);
    assert.equal(fs.existsSync(`${exe}.done`), false);
    assert.ok(fs.lstatSync(w.program).isSymbolicLink(), 'the link stays');
    assert.deepEqual(listTree(target), [...VICTIM_TREE, w.uninstaller].sort());
  });

  test('the updater folder: a link loses only the link, a real folder is removed without entering its links, a missing one is fine', NEEDS_NSIS, async () => {
    const w = world('updater');
    put(path.join(w.program, w.uninstaller));
    const linked = path.join(w.lad, 'sibersentez-updater-linked');
    const real = path.join(w.lad, 'sibersentez-updater-real');
    const linkedTarget = victim(path.join(w.base, 'victim-linked'));
    const nestedTarget = victim(path.join(w.base, 'victim-nested'));
    fs.symlinkSync(linkedTarget, linked, 'junction');
    put(path.join(real, 'installer.exe'));
    fs.symlinkSync(nestedTarget, path.join(real, 'nested'), 'junction');
    const exe = build(w, {
      functions: ['sibersentezEmptyFolderFunction'],
      body: [
        `  !insertmacro sibersentezPinDir ${nsisQ(w.program)} ${nsisQ(w.lad)} ${nsisQ(w.home)}`,
        ...harnessGuard('$INSTDIR', w.base),
        ...[linked, real, path.join(w.lad, 'sibersentez-updater-missing')].map((d) => `  !insertmacro sibersentezRemoveFolder ${nsisQ(d)}`),
      ],
    });
    assert.equal(await runHarness(exe), 0);
    assert.equal(pathExists(linked), false, 'the link is removed');
    assert.equal(pathExists(real), false, 'the real folder is removed');
    assert.deepEqual(listTree(linkedTarget), VICTIM_TREE);
    assert.deepEqual(listTree(nestedTarget), VICTIM_TREE);
  });

  // Two ways a file is in use: a program that runs from the folder and holds its own exe open (the NSIS sleeper), and a
  // file another program keeps open deeper down. Windows refuses to rename either, and the folders that hold them.
  const BUSY = {
    'a program running from the folder': { file: (w) => path.join(w.program, HARNESS_APP_EXE), start: (file) => startSleeper(file), left: [HARNESS_APP_EXE] },
    'a file kept open in a subfolder': {
      file: (w) => path.join(w.program, 'resources', 'in-use.dat'),
      start: (file) => {
        put(file, 'held');
        return lockFile(file);
      },
      left: ['resources/', 'resources/in-use.dat'],
    },
  };

  test('update with a file in use: nothing is deleted; every entry moved so far goes back, links as links; exit code 2 and the uninstaller stays for the retry', NEEDS_NSIS, async () => {
    for (const [name, busy] of Object.entries(BUSY)) {
      const w = world('busy-update');
      const { top, nested } = installed(w);
      const child = await busy.start(busy.file(w));
      try {
        await delay(300);
        const before = listTree(w.program);
        const bytes = fs.readFileSync(path.join(w.program, 'a.txt'), 'utf8');
        const exe = build(w, { updated: true, body: pinAndRemove(w) });
        assert.equal(await runHarness(exe), 2, name);
        assert.equal(fs.existsSync(`${exe}.done`), false, `${name}: stopped`);
        assert.deepEqual(listTree(w.program), before, `${name}: the folder is exactly as it was, no staging folder left`);
        assert.equal(fs.readFileSync(path.join(w.program, 'a.txt'), 'utf8'), bytes);
        assert.ok(fs.lstatSync(path.join(w.program, 'link-top')).isSymbolicLink(), `${name}: the junction is back as a junction`);
        assert.deepEqual(listTree(top), VICTIM_TREE);
        assert.deepEqual(listTree(nested), VICTIM_TREE);
      } finally {
        await stopSleepers([child]);
      }
    }
  });

  test('real uninstall with a file in use: everything else is removed and the uninstall goes on', NEEDS_NSIS, async () => {
    for (const [name, busy] of Object.entries(BUSY)) {
      const w = world('busy-real');
      const { top, nested } = installed(w);
      const child = await busy.start(busy.file(w));
      try {
        await delay(300);
        const exe = build(w, { body: pinAndRemove(w) });
        assert.equal(await runHarness(exe), 0, name);
        assert.deepEqual(listTree(w.program), busy.left, `${name}: only the file in use is left`);
        assert.deepEqual(listTree(top), VICTIM_TREE);
        assert.deepEqual(listTree(nested), VICTIM_TREE);
      } finally {
        await stopSleepers([child]);
      }
    }
  });

  test('update while an ordinary program still runs from the folder (its exe can be moved, not deleted): the update goes on, only that exe is left, in the staging folder', NEEDS_NSIS, async () => {
    const w = world('moved-running');
    const { top, nested } = installed(w);
    // A copy of a small Windows program that does not hold its own file open: ping of the loopback address as a timer
    const exeInUse = path.join(w.program, 'resources', `running-${process.pid}.exe`);
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), exeInUse);
    const child = spawn(exeInUse, ['-n', '120', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    child.exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await delay(500);
      assert.ok(isRunning(child));
      const exe = build(w, { updated: true, body: pinAndRemove(w) });
      assert.equal(await runHarness(exe), 0);
      assert.ok(fs.existsSync(`${exe}.done`));
      const left = listTree(w.program);
      assert.equal(left.length, 3, left.join(', '));
      const [staging] = left[0].split('/');
      assert.match(staging, STAGING);
      assert.deepEqual(left, [`${staging}/`, `${staging}/resources/`, `${staging}/resources/${path.basename(exeInUse)}`]);
      assert.deepEqual(listTree(top), VICTIM_TREE);
      assert.deepEqual(listTree(nested), VICTIM_TREE);
    } finally {
      await stopSleepers([child]);
    }
  });
});

describe('after the old uninstaller, run by NSIS itself', () => {
  // $R0 is the old uninstaller's exit code, the error flag says it could not be started (electron-builder's uninstallOldVersion)
  const cases = {
    'it finished (exit code 0): the install goes on': { r0: 0, errors: false, status: 0 },
    'it stopped (exit code 2, a file in use): the installer stops with exit code 2, silently': { r0: 2, errors: false, status: 2 },
    'it could not be started: noted, and the install goes on as with the template': { r0: 5, errors: true, status: 0 },
  };
  test('a silent install never waits on a message box: a failed old uninstaller stops it with exit code 2', NEEDS_NSIS, async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unresult-'));
    const runs = Object.entries(cases).map(([name, c], i) => {
      const exe = path.join(dir, `c${i}.exe`);
      // (the first lines only set installer.nsh's variables: -WX refuses a variable that is never set)
      const body = ['  StrCpy $sibersentezDir ""', '  StrCpy $sibersentezReason ""', '  StrCpy $sibersentezTmp ""', `  StrCpy $R0 "${c.r0}"`, c.errors ? '  SetErrors' : '  ClearErrors', '  !insertmacro customUnInstallCheck', ...harnessDone(`${exe}.done`)];
      makensis(['-WX', '-V2', '-'], harnessScript({ out: exe, body }));
      return { name, c, exe };
    });
    // a message box without /SD would wait for a click until the harness is stopped at the timeout (exit code null)
    const statuses = await Promise.all(runs.map((r) => runHarness(r.exe, { timeout: 20000 })));
    const got = Object.fromEntries(runs.map((r, i) => [r.name, { status: statuses[i], done: fs.existsSync(`${r.exe}.done`) }]));
    assert.deepEqual(got, Object.fromEntries(runs.map((r) => [r.name, { status: r.c.status, done: r.c.status === 0 }])));
  });
});

// ================================================================== the hidden QA run (SIBERSENTEZ_QA_HIDDEN)
// The person at this computer keeps working while a QA run goes on: a hidden run never shows the window, puts no icon
// in the tray, opens no native dialog, shows no notification and starts no external program.
import {
  QA_ACTIONS_SCRIPTS,
  QA_SERVED_MODE_SCRIPT,
  QA_BRIDGE_PROBE_SCRIPT,
  QA_HIDDEN_POSITION,
  QA_KIT_PROBE_SCRIPT,
  QA_ABOUT_PROBE_SCRIPT,
  QA_PANEL_PATH,
  QA_PANEL_PROBE_SCRIPT,
  QA_LAPTOP_PATH,
  QA_LAPTOP_PROBE_SCRIPT,
  QA_LAPTOP_SIZE,
  QA_VIEWPORT_SCRIPT,
  QA_LAPTOP_DEMO_SCRIPT,
  QA_KEYS_SCRIPTS,
  createsTray,
  guardDialogs,
  readQaShellOptions,
  windowShowPlan,
} from '../electron/helpers.mjs';

describe('the hidden QA run', () => {
  const qaOn = readQaOptions({ env: { SIBERSENTEZ_QA_QUIT_MS: '1000' }, isPackaged: false });
  const qaOff = readQaOptions({ env: {}, isPackaged: false });
  // The shell's main module and its QA run (electron/qa-run.mjs, moved out of it: module-split-plan M1)
  const mainText = () => (fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'electron', 'qa-run.mjs'), 'utf8')).replace(/\r\n/g, '\n');
  const bodyOf = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    // Up to the "}" at the function's own indentation (functions inside createQaRun are indented)
    return src.slice(start, src.indexOf(`\n${(src.slice(src.lastIndexOf('\n', start) + 1, start).match(/^\s*/) || [''])[0]}}\n`, start));
  };

  test('SIBERSENTEZ_QA_HIDDEN=1, SIBERSENTEZ_QA_PROBES=1 and SIBERSENTEZ_QA_PROJECT_DIR only in QA mode; the project folder only in a hidden run', WIN, () => {
    const off = { hidden: false, probes: false, projectDir: null, rejected: null };
    assert.deepEqual(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1', SIBERSENTEZ_QA_PROBES: '1' }, qa: qaOff }), off, 'not QA: ignored');
    assert.deepEqual(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1' } }), off);
    const packagedNoSwitch = readQaOptions({ env: { SIBERSENTEZ_QA_QUIT_MS: '1000' }, argv: ['SiberSentez.exe'], isPackaged: true });
    assert.equal(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1' }, qa: packagedNoSwitch }).hidden, false, 'a packaged build without --qa');
    assert.deepEqual(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: ' 1 ', SIBERSENTEZ_QA_PROBES: '1' }, qa: qaOn }), { hidden: true, probes: true, projectDir: null, rejected: null });
    for (const v of ['0', 'true', 'yes', '']) assert.equal(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: v }, qa: qaOn }).hidden, false, v);
    const dir = path.join(TMP, 'qa-project');
    assert.equal(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1', SIBERSENTEZ_QA_PROJECT_DIR: dir }, qa: qaOn }).projectDir, dir);
    const visible = readQaShellOptions({ env: { SIBERSENTEZ_QA_PROJECT_DIR: dir }, qa: qaOn });
    assert.equal(visible.projectDir, null);
    assert.match(visible.rejected, /needs SIBERSENTEZ_QA_HIDDEN=1/);
    const unc = readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1', SIBERSENTEZ_QA_PROJECT_DIR: '\\\\server\\share\\p' }, qa: qaOn });
    assert.equal(unc.projectDir, null);
    assert.match(unc.rejected, /network or device path/);
    assert.equal(unc.hidden, true, 'a bad folder does not make the run visible');
  });

  test('window options: never shown, no taskbar button, off screen; it still paints and is not throttled (capturePage works)', () => {
    const hidden = windowOptions({ qaHidden: true, preload: 'p.cjs', icon: 'i.png' });
    assert.equal(hidden.show, false);
    assert.equal(hidden.skipTaskbar, true);
    assert.equal(hidden.x, QA_HIDDEN_POSITION);
    assert.equal(hidden.y, QA_HIDDEN_POSITION);
    assert.equal(QA_HIDDEN_POSITION, -32000);
    assert.equal(hidden.webPreferences.paintWhenInitiallyHidden, true);
    assert.equal(hidden.webPreferences.backgroundThrottling, false);
    const normal = windowOptions({ qaHidden: false, preload: 'p.cjs', icon: 'i.png' });
    assert.equal(normal.show, false, 'shown later, on ready-to-show');
    for (const k of ['x', 'y', 'skipTaskbar']) assert.equal(k in normal, false, k);
    assert.equal('backgroundThrottling' in normal.webPreferences, false);
    assert.deepEqual({ ...hidden, x: undefined, y: undefined, skipTaskbar: undefined, webPreferences: { ...hidden.webPreferences, backgroundThrottling: undefined } }, { ...normal, x: undefined, y: undefined, skipTaskbar: undefined, webPreferences: { ...normal.webPreferences, backgroundThrottling: undefined } }, 'otherwise the same window');
  });

  test('show plan: a hidden run never shows the window, not on ready-to-show, not for a tray click, a second launch or a hand-over', () => {
    for (const startHidden of [false, true]) {
      for (const bringUp of [false, true]) {
        assert.equal(windowShowPlan({ qa: true, qaHidden: true, startHidden, bringUp }), 'never', JSON.stringify({ startHidden, bringUp }));
      }
    }
    assert.equal(windowShowPlan({ qa: true, qaHidden: false }), 'inactive', 'a visible QA run: shown without the focus');
    assert.equal(windowShowPlan({ qa: false, qaHidden: true }), 'show', 'hidden means nothing outside QA');
    assert.equal(windowShowPlan({}), 'show');
    assert.equal(windowShowPlan({ startHidden: true }), 'stay', 'started at login: stays in the tray');
    assert.equal(windowShowPlan({ startHidden: true, bringUp: true }), 'show', 'until the tray opens it');
    assert.equal(windowShowPlan({ qa: true, bringUp: true }), 'show');
  });

  test('no tray icon in a hidden run', () => {
    assert.equal(createsTray({ qaHidden: true }), false);
    assert.equal(createsTray({ qaHidden: false }), true);
    assert.equal(createsTray(), true);
  });

  test('no native dialog in a hidden run: every call is logged and answered as cancelled; otherwise Electron is called unchanged', async () => {
    const calls = [];
    const electron = {
      showMessageBox: async (...a) => (calls.push(['showMessageBox', a.length]), { response: 1 }),
      showOpenDialog: async (...a) => (calls.push(['showOpenDialog', a.length]), { canceled: false, filePaths: ['C:\\x'] }),
      showErrorBox: (...a) => calls.push(['showErrorBox', a.length]),
    };
    const logs = [];
    const hidden = guardDialogs(electron, { hidden: true, log: (m) => logs.push(m) });
    assert.deepEqual(await hidden.showMessageBox({ message: 'm', buttons: ['Cancel', 'On'], cancelId: 0 }), { response: 0, checkboxChecked: false });
    assert.deepEqual(await hidden.showMessageBox({}, { message: 'm', buttons: ['On', 'Cancel'], cancelId: 1 }), { response: 1, checkboxChecked: false }, 'with a parent window: its cancel button');
    assert.deepEqual(await hidden.showOpenDialog({}, { properties: ['openDirectory'] }), { canceled: true, filePaths: [] });
    assert.deepEqual(await hidden.showSaveDialog({}, { title: 'Save' }), { canceled: true, filePath: '' }, 'the support bundle is never saved in a hidden run');
    assert.equal(hidden.showErrorBox('t', 'b'), undefined);
    assert.deepEqual(calls, [], 'Electron was never asked');
    assert.equal(logs.length, 5);
    for (const m of logs) assert.match(m, /^QA hidden: native .* skipped$/);
    const normal = guardDialogs(electron, { hidden: false });
    assert.deepEqual(await normal.showMessageBox({}, {}), { response: 1 });
    assert.deepEqual(await normal.showOpenDialog({}, {}), { canceled: false, filePaths: ['C:\\x'] });
    normal.showErrorBox('t', 'b');
    assert.deepEqual(calls, [['showMessageBox', 2], ['showOpenDialog', 2], ['showErrorBox', 2]]);
  });

  test('no notifications in a hidden run (the clipboard still works); the new QA variables never reach the server', () => {
    const origin = appOrigin(47712);
    assert.equal(permissionAllowed('notifications', `${origin}/`, origin, { qaHidden: true }), false);
    assert.equal(permissionAllowed('clipboard-sanitized-write', `${origin}/`, origin, { qaHidden: true }), true);
    assert.equal(permissionAllowed('notifications', `${origin}/`, origin, { qaHidden: false }), true);
    const env = buildServerEnv({ SIBERSENTEZ_QA_HIDDEN: '1', sibersentez_qa_probes: '1', SIBERSENTEZ_QA_PROJECT_DIR: 'C:\\p', PATH: 'x' }, { port: 1, hubPath: null, instance: 'i' });
    assert.deepEqual(Object.keys(env).sort(), ['PATH', 'SIBERSENTEZ_INSTANCE', 'SIBERSENTEZ_PORT']);
  });

  test('the probes run fixed scripts only; live is never among them as a switch that could succeed in QA', () => {
    for (const s of [QA_BRIDGE_PROBE_SCRIPT, QA_KIT_PROBE_SCRIPT, QA_ABOUT_PROBE_SCRIPT, QA_PANEL_PROBE_SCRIPT, QA_LAPTOP_PROBE_SCRIPT, QA_VIEWPORT_SCRIPT, QA_LAPTOP_DEMO_SCRIPT, ...Object.values(QA_KEYS_SCRIPTS), QA_SERVED_MODE_SCRIPT, ...Object.values(QA_ACTIONS_SCRIPTS)]) {
      assert.equal(typeof s, 'string');
      assert.doesNotMatch(s, /\$\{/, 'no template');
    }
    assert.ok(Object.isFrozen(QA_ACTIONS_SCRIPTS));
    assert.deepEqual(Object.keys(QA_ACTIONS_SCRIPTS), ['off', 'dry', 'live']);
    for (const [mode, s] of Object.entries(QA_ACTIONS_SCRIPTS)) assert.ok(s.startsWith(`window.sibersentezShell.setActionsMode('${mode}')`), mode);
    assert.equal(QA_PANEL_PATH, '/?qa=1&actpanel=choose');
    // The laptop probe only reads the page it loaded (no fetch, no bridge) at a fixed laptop size
    assert.equal(QA_LAPTOP_PATH, '/?qa=1');
    assert.deepEqual(QA_LAPTOP_SIZE, { width: 1366, height: 768 });
    assert.ok(Object.isFrozen(QA_LAPTOP_SIZE));
    assert.doesNotMatch(QA_LAPTOP_PROBE_SCRIPT, /fetch|sibersentezShell|localStorage|location/);
    assert.equal(QA_KIT_PROBE_SCRIPT.match(/fetch\(/g).length, 1);
    assert.ok(QA_KIT_PROBE_SCRIPT.includes("fetch('/api/snapshot')"), 'the kit probe reads only its own server');
    assert.ok(QA_KIT_PROBE_SCRIPT.includes('i < 30'), 'it waits for the roster, at most 30 s');
    assert.match(QA_ABOUT_PROBE_SCRIPT, /^fetch\('\/api\/about'\)/, 'the about probe reads only its own server');
    assert.match(QA_SERVED_MODE_SCRIPT, /^fetch\('\/api\/actions'/, 'the mode probe reads only its own server');
    assert.doesNotMatch(QA_SERVED_MODE_SCRIPT, /token/, 'never the token');
  });

  test('main.mjs: the hidden run is wired through the tested parts', () => {
    const src = mainText();
    assert.ok(src.includes('const QA_SHELL = readQaShellOptions({ env: process.env, qa: QA });'));
    // ready-to-show: the plan decides; showInactive only for 'inactive', show only for 'show'
    const ready = src.slice(src.indexOf("win.once('ready-to-show'"), src.indexOf("win.webContents.on('did-finish-load'"));
    assert.ok(ready.includes('const plan = windowShowPlan({ qa: QA.enabled, qaHidden: QA_SHELL.hidden, startHidden: START_HIDDEN });'));
    assert.ok(ready.includes("if (plan === 'inactive') win.showInactive();"));
    assert.ok(ready.includes("else if (plan === 'show') win.show();"));
    assert.equal((src.match(/\.showInactive\(/g) || []).length, 1, 'showInactive only there');
    assert.equal((src.match(/\bwin\.show\(\)/g) || []).length, 2, 'win.show() only on ready-to-show and in showWindow');
    const show = bodyOf(src, 'showWindow');
    assert.ok(show.indexOf("windowShowPlan({ qa: QA.enabled, qaHidden: QA_SHELL.hidden, bringUp: true }) === 'never'") < show.indexOf('win.show();'), 'the plan before the window comes up');
    assert.ok(/=== 'never'\) \{\n\s+log\([^\n]*\);\n\s+return;/.test(show), 'hidden: logged and nothing else');
    // no tray icon; every dialog through the guard; no external program; no Electron error dialog
    assert.ok(bodyOf(src, 'createTray').indexOf('if (!createsTray({ qaHidden: QA_SHELL.hidden })) {') < bodyOf(src, 'createTray').indexOf('new Tray('));
    assert.ok(src.includes('const dialog = guardDialogs(electronDialog, { hidden: QA_SHELL.hidden, log });'));
    assert.equal((src.match(/electronDialog/g) || []).length, 2, 'Electron\'s dialog module only in the import and the guard');
    assert.ok(src.includes("import { app, BrowserWindow, Menu, Tray, dialog as electronDialog,"));
    assert.ok(bodyOf(src, 'openExternal').startsWith("function openExternal(url) {\n  if (QA_SHELL.hidden) return log("));
    assert.ok(bodyOf(src, 'openHubFolder').includes("if (QA_SHELL.hidden) return log('QA hidden: hub folder not opened');"));
    assert.ok(src.includes("process.on('uncaughtException', (e) => {"));
    // notifications denied in a hidden run, on both handlers
    assert.equal((src.match(/permissionAllowed\(permission, .*, state\.origin, \{ qaHidden \}\)/g) || []).length, 2);
    assert.equal((src.match(/permissionAllowed\(/g) || []).length, 2);
    // the probes: fixed scripts through one function; the project probe only in a hidden run with its folder
    assert.equal((src.match(/executeJavaScript\(/g) || []).length, 3, 'the hand-over, the tray\'s new project and qaRun');
    const runArgs = [...src.matchAll(/qaRun\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'script');
    assert.deepEqual([...new Set(runArgs)].sort(), ['QA_ABOUT_PROBE_SCRIPT', 'QA_ACTIONS_SCRIPTS.live', 'QA_ACTIONS_SCRIPTS[mode]', 'QA_SERVED_MODE_SCRIPT', 'QA_BRIDGE_PROBE_SCRIPT', 'QA_KIT_PROBE_SCRIPT', 'QA_PANEL_PROBE_SCRIPT', 'QA_LAPTOP_PROBE_SCRIPT', 'QA_VIEWPORT_SCRIPT', 'QA_LAPTOP_DEMO_SCRIPT', 'QA_KEYS_SCRIPTS.focusSearch', 'QA_KEYS_SCRIPTS.searchState', 'QA_KEYS_SCRIPTS.focusMenu', 'QA_KEYS_SCRIPTS.menuState', 'QA_PERMISSION_PROBE'].sort());
    assert.ok(Object.isFrozen(QA_KEYS_SCRIPTS));
    for (const s of Object.values(QA_KEYS_SCRIPTS)) assert.doesNotMatch(s, /fetch|sibersentezShell|localStorage|location|click\(/, 'reads and focus only');
    assert.ok(bodyOf(src, 'runQaProbes').includes('if (QA_SHELL.hidden && QA_SHELL.projectDir) await qaProjectProbe();'));
    assert.ok(bodyOf(src, 'qaProjectProbe').includes('showOpenDialog: async () => ({ canceled: false, filePaths: [QA_SHELL.projectDir] }),'), 'no picker');
    assert.ok(bodyOf(src, 'qaProjectProbe').includes("add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder }),"), 'the picker\'s own server call');
    for (const line of bodyOf(src, 'qaProjectProbe').split('\n').filter((l) => l.includes('qaProbe('))) assert.doesNotMatch(line, /projectDir|\bfolder\b\)/, `no folder in the log: ${line.trim()}`);
  });
});
