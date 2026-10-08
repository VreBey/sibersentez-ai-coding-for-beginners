// Tests for switching actions on and off in the installed app (docs/actions-toggle.md §5).
// Every file lives under a fresh folder in the system temp folder; the real home folder, hub, app data and 4545
// are never touched. The real-server test starts a copy of server/ and public/ from a temporary app folder (so the
// repository's sibersentez.json is never read) on an ephemeral port with a fake home, and only ever uses the preview
// (dry) mode: no action runs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../server/config.mjs';
import { HUB_SKELETON, initHub, readActionsSetting } from '../server/hub.mjs';
import { createHandler } from '../server/app.mjs';
import {
  ACTIONS_CONFIRM_OK,
  ACTION_MODES,
  SHELL_ACTIONS_MODE_PATH,
  SHELL_STATE_FILE,
  SUPERVISOR_DEFAULTS,
  actionsConfirmOptions,
  actionsMenuItems,
  actionsSubmenuTemplate,
  appOrigin,
  buildServerEnv,
  changeActionsMode,
  checkActionsOnReady,
  confirmActionsLive,
  decideNavigation,
  explicitLanguage,
  initialSupervisor,
  isShellActionsModeUrl,
  normalizeActionsMode,
  probeServer,
  readHubActionsSetting,
  readQaActionsMode,
  readQaOptions,
  readShellState,
  requestAllowed,
  restartDelay,
  settingsRestartPlan,
  shellNavigation,
  stopServerProcess,
  superviseStep,
  switchActionsMode,
  unexpectedLiveMode,
  updateShellState,
  waitForServer,
  windowUrl,
  writeHubActionsSetting,
} from '../electron/helpers.mjs';
import { STRINGS as SHELL_STRINGS, getStrings } from '../electron/strings.mjs';
import { STRINGS as PAGE_STRINGS, LANGUAGES, pickLanguage, setLanguage, t, modeName } from '../public/js/i18n.js';
import * as CONTEXT_MENU from '../public/js/contextmenu.js';

const { menuModel, errorText } = CONTEXT_MENU;
// The path an old page navigated its window to (its helpers left public/js/contextmenu.js with the in-app switch)
const RETIRED_PAGE_PATH = '/__shell/actions-mode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-actions-toggle-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
// A fresh world: app folder (sibersentez.json), home folder, hub folder (absent until asked for)
function world() {
  const base = path.join(TMP, `w${++n}`);
  const appDir = path.join(base, 'app');
  const homeDir = path.join(base, 'home');
  const hub = path.join(base, 'hub');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const logs = [];
  return {
    base,
    appDir,
    homeDir,
    hub,
    logs,
    makeHub(settings) {
      fs.mkdirSync(hub, { recursive: true });
      if (settings !== undefined) fs.writeFileSync(path.join(hub, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
      return hub;
    },
    sibersentezJson: (v) => fs.writeFileSync(path.join(appDir, 'sibersentez.json'), JSON.stringify(v)),
    resolve(env = {}) {
      logs.length = 0;
      return resolveConfig({ env, appDir, homeDir, log: (l) => logs.push(l) });
    },
  };
}
const read = (f) => fs.readFileSync(f);

// ------------------------------------------------------------------ server settings order
describe('server: where the actions mode comes from', () => {
  test('order is environment > sibersentez.json > hub settings.json > off', () => {
    const w = world();
    w.makeHub({ version: 1, language: 'auto', actions: 'dry' });
    const env = { SIBERSENTEZ_HUB: w.hub };
    assert.equal(w.resolve(env).actions, 'dry', 'settings.json alone decides');
    w.sibersentezJson({ actions: 'live' });
    assert.equal(w.resolve(env).actions, 'live', 'sibersentez.json beats settings.json');
    w.sibersentezJson({ actions: 'off' });
    assert.equal(w.resolve(env).actions, 'off', 'an explicit off in sibersentez.json beats settings.json');
    w.sibersentezJson({ actions: 'live' });
    assert.equal(w.resolve({ ...env, SIBERSENTEZ_ACTIONS: 'dry' }).actions, 'dry', 'the environment beats both files');
    assert.equal(w.resolve({ ...env, SIBERSENTEZ_ACTIONS: '0' }).actions, 'off', 'an environment off beats both files');
    // Blank values count as not set: the next source applies
    w.sibersentezJson({ actions: '' });
    assert.equal(w.resolve({ ...env, SIBERSENTEZ_ACTIONS: '  ' }).actions, 'dry');
    w.sibersentezJson({});
    assert.equal(w.resolve(env).actions, 'dry');
    // The default hub (<home>\SiberSentez) is read the same way
    const w2 = world();
    fs.mkdirSync(path.join(w2.homeDir, 'SiberSentez'));
    fs.writeFileSync(path.join(w2.homeDir, 'SiberSentez', 'settings.json'), JSON.stringify({ actions: 'live' }));
    assert.equal(w2.resolve().actions, 'live');
  });

  test('unknown values are off, never fall through to a lower source, and log one line without a path', () => {
    const w = world();
    const env = { SIBERSENTEZ_HUB: w.hub };
    for (const bad of ['on', 'true', 'yes', '1', 'live!', true, 1, ['live'], { mode: 'live' }]) {
      w.makeHub({ actions: bad });
      assert.equal(w.resolve(env).actions, 'off', JSON.stringify(bad));
      assert.equal(w.logs.length, 1, `one line for ${JSON.stringify(bad)}`);
      assert.match(w.logs[0], /settings\.json: actions is invalid; actions off/);
      assert.ok(!w.logs[0].includes(w.base), 'no path in the log');
    }
    for (const [raw, mode] of [['LIVE', 'live'], [' Dry ', 'dry'], ['off', 'off']]) {
      w.makeHub({ actions: raw });
      assert.equal(w.resolve(env).actions, mode, raw);
      assert.deepEqual(w.logs, []);
    }
    // An unknown value in a higher source is off even when settings.json says live
    w.makeHub({ actions: 'live' });
    w.sibersentezJson({ actions: 'yes' });
    assert.equal(w.resolve(env).actions, 'off');
    fs.rmSync(path.join(w.appDir, 'sibersentez.json'));
    assert.equal(w.resolve({ ...env, SIBERSENTEZ_ACTIONS: 'yes' }).actions, 'off');
    assert.equal(w.resolve(env).actions, 'live');
  });

  test('a missing hub, a missing file, a missing key or a broken file is off', () => {
    const w = world();
    assert.equal(w.resolve().actions, 'off', 'no hub at all');
    assert.deepEqual(w.logs, []);
    // An explicit hub that does not exist yields no hub, even when the default hub says live
    fs.mkdirSync(path.join(w.homeDir, 'SiberSentez'));
    fs.writeFileSync(path.join(w.homeDir, 'SiberSentez', 'settings.json'), JSON.stringify({ actions: 'live' }));
    assert.equal(w.resolve({ SIBERSENTEZ_HUB: path.join(w.base, 'missing') }).actions, 'off');
    const env = { SIBERSENTEZ_HUB: w.hub };
    w.makeHub();
    assert.equal(w.resolve(env).actions, 'off', 'hub without settings.json');
    assert.deepEqual(w.logs, [], 'a missing file is silent');
    w.makeHub({ version: 1, language: 'tr' });
    assert.equal(w.resolve(env).actions, 'off', 'no actions key');
    assert.deepEqual(w.logs, []);
    for (const broken of ['{ broken', '[1, 2]', 'null', '"live"', '']) {
      w.makeHub(broken);
      assert.equal(w.resolve(env).actions, 'off', JSON.stringify(broken));
      assert.equal(w.logs.length, 1);
      assert.match(w.logs[0], /settings\.json is invalid/);
    }
    // settings.json is a folder: unreadable, off, one line
    fs.rmSync(path.join(w.hub, 'settings.json'));
    fs.mkdirSync(path.join(w.hub, 'settings.json'));
    assert.equal(w.resolve(env).actions, 'off');
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /settings\.json unreadable/);
    // A byte order mark is tolerated
    const w3 = world();
    w3.makeHub(String.fromCharCode(0xfeff) + '{"actions":"dry"}');
    assert.equal(w3.resolve({ SIBERSENTEZ_HUB: w3.hub }).actions, 'dry');
  });

  test('the hub skeleton carries no actions key (absent means off)', () => {
    assert.equal('actions' in JSON.parse(HUB_SKELETON['settings.json']), false);
    const w = world();
    initHub(w.hub);
    assert.equal(w.resolve({ SIBERSENTEZ_HUB: w.hub }).actions, 'off');
    assert.deepEqual(w.logs, []);
  });

  test('the server and the shell read settings.json the same way', () => {
    const w = world();
    const cases = ['{"actions":"dry"}', '{"actions":"LIVE"}', '{"actions":" off "}', '{"actions":"on"}', '{"actions":true}', '{"actions":""}', '{}', '[]', '{ broken', '\ufeff{"actions":"dry"}'];
    for (const raw of cases) {
      w.makeHub(raw);
      assert.equal(readHubActionsSetting(w.hub), readActionsSetting(w.hub).mode, raw);
    }
    fs.rmSync(path.join(w.hub, 'settings.json'));
    assert.equal(readHubActionsSetting(w.hub), 'off');
    assert.equal(readActionsSetting(w.hub).mode, 'off');
    assert.equal(readHubActionsSetting(path.join(w.base, 'missing')), readActionsSetting(path.join(w.base, 'missing')).mode);
    assert.deepEqual(readActionsSetting(null), { mode: 'off', problem: null });
    assert.deepEqual([...ACTION_MODES], ['off', 'dry', 'live']);
    for (const v of ['off', 'dry', 'live']) assert.equal(normalizeActionsMode(v), v);
    for (const v of ['on', '', null, undefined, 1, {}]) assert.equal(normalizeActionsMode(v), 'off', String(v));
  });
});

// ------------------------------------------------------------------ the shell's writer
describe("shell: writing the mode into the hub's settings.json", () => {
  const tmpFiles = (hub) => fs.readdirSync(hub).filter((f) => f.endsWith('.tmp'));

  test('keeps every other key and value (and their order), sets actions, leaves no temporary file', () => {
    const w = world();
    const before = { version: 1, language: 'tr', custom: { list: [1, 2, 3], nested: { a: 'b' } }, actions: 'off', zeta: 'last' };
    w.makeHub(JSON.stringify(before, null, 2));
    const r = writeHubActionsSetting(w.hub, 'dry');
    assert.deepEqual(r, { ok: true, file: path.join(w.hub, 'settings.json') });
    const after = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.deepEqual(after, { ...before, actions: 'dry' });
    assert.deepEqual(Object.keys(after), Object.keys(before), 'key order kept');
    assert.deepEqual(tmpFiles(w.hub), []);
    // A file without the key gets it appended; a missing file is created with the key only
    w.makeHub({ version: 1, language: 'auto' });
    writeHubActionsSetting(w.hub, 'live');
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { version: 1, language: 'auto', actions: 'live' });
    fs.rmSync(r.file);
    assert.equal(writeHubActionsSetting(w.hub, 'dry').ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { actions: 'dry' });
    // A byte order mark is tolerated; the result is plain UTF-8 JSON
    fs.writeFileSync(r.file, '\ufeff{"language":"en"}');
    assert.equal(writeHubActionsSetting(w.hub, 'off').ok, true);
    const raw = read(r.file);
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(JSON.parse(raw.toString('utf8')), { language: 'en', actions: 'off' });
    // The server reads what the shell wrote
    assert.equal(readActionsSetting(w.hub).mode, 'off');
    writeHubActionsSetting(w.hub, 'dry');
    assert.equal(readActionsSetting(w.hub).mode, 'dry');
  });

  test('atomic: a new temporary file next to settings.json replaces it in one rename; settings.json is never opened for writing', () => {
    const w = world();
    w.makeHub({ language: 'tr' });
    const file = path.join(w.hub, 'settings.json');
    const calls = [];
    const spy = {
      statSync: (...a) => fs.statSync(...a),
      readFileSync: (...a) => fs.readFileSync(...a),
      writeFileSync: (p, data, opts) => {
        calls.push(['write', p, opts]);
        return fs.writeFileSync(p, data, opts);
      },
      renameSync: (a, b) => {
        calls.push(['rename', a, b]);
        return fs.renameSync(a, b);
      },
      rmSync: (p, o) => {
        calls.push(['rm', p]);
        return fs.rmSync(p, o);
      },
    };
    assert.equal(writeHubActionsSetting(w.hub, 'dry', { fsImpl: spy, suffix: () => 'fixed' }).ok, true);
    const tmp = path.join(w.hub, 'settings.json.fixed.tmp');
    assert.deepEqual(calls, [
      ['write', tmp, { encoding: 'utf8', flag: 'wx' }],
      ['rename', tmp, file],
    ]);
    assert.ok(!calls.some(([op, p]) => op === 'write' && p === file), 'settings.json itself is never written in place');
    assert.equal(fs.existsSync(tmp), false);
    assert.equal(readActionsSetting(w.hub).mode, 'dry');
  });

  test('a failing write or rename leaves settings.json byte for byte as it was and removes the temporary file', () => {
    for (const failAt of ['write', 'rename']) {
      const w = world();
      w.makeHub('{\n  "language": "tr",\n  "actions": "off"\n}\n');
      const file = path.join(w.hub, 'settings.json');
      const before = read(file);
      const boom = (code) => Object.assign(new Error(code), { code });
      const spy = {
        statSync: (...a) => fs.statSync(...a),
        readFileSync: (...a) => fs.readFileSync(...a),
        writeFileSync: (p, d, o) => {
          if (failAt === 'write') {
            fs.writeFileSync(p, String(d).slice(0, 5), o); // a half-written temporary file
            throw boom('ENOSPC');
          }
          return fs.writeFileSync(p, d, o);
        },
        renameSync: (a, b) => {
          if (failAt === 'rename') throw boom('EPERM');
          return fs.renameSync(a, b);
        },
        rmSync: (...a) => fs.rmSync(...a),
      };
      const r = writeHubActionsSetting(w.hub, 'live', { fsImpl: spy });
      assert.equal(r.ok, false, failAt);
      assert.equal(r.code, 'WRITE_FAILED');
      assert.equal(r.detail, failAt === 'write' ? 'ENOSPC' : 'EPERM');
      assert.ok(read(file).equals(before), `${failAt}: settings.json unchanged`);
      assert.deepEqual(tmpFiles(w.hub), [], `${failAt}: no temporary file left`);
      assert.equal(readActionsSetting(w.hub).mode, 'off');
    }
  });

  test('a broken settings.json is kept aside, byte for byte, and a new one written; unreadable, unknown mode and missing hub are refused', () => {
    const w = world();
    const file = path.join(w.hub, 'settings.json');
    for (const broken of ['{ broken', '[1, 2]', 'null', '"live"', '', '{"a":1']) {
      w.makeHub(broken);
      const before = read(file);
      const r = writeHubActionsSetting(w.hub, 'dry');
      assert.equal(r.ok, true, JSON.stringify(broken));
      assert.equal(r.keptAside, `${file}.broken`);
      assert.ok(read(`${file}.broken`).equals(before), 'the broken file is kept, not overwritten');
      assert.deepEqual(JSON.parse(read(file).toString('utf8')), { actions: 'dry' });
      assert.deepEqual(fs.readdirSync(w.hub).sort(), ['settings.json', 'settings.json.broken']);
      fs.rmSync(`${file}.broken`);
    }
    // A second broken file does not replace the first one kept aside
    w.makeHub('{ one');
    writeHubActionsSetting(w.hub, 'dry');
    fs.writeFileSync(file, '{ two');
    assert.equal(writeHubActionsSetting(w.hub, 'off').keptAside, `${file}.broken-2`);
    assert.equal(read(`${file}.broken`).toString(), '{ one');
    fs.rmSync(`${file}.broken`);
    fs.rmSync(`${file}.broken-2`);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.equal(writeHubActionsSetting(w.hub, 'dry').code, 'SETTINGS_UNREADABLE');
    fs.rmSync(file, { recursive: true });
    for (const bad of ['on', 'LIVE', '', null, undefined, 'dry ']) {
      assert.equal(writeHubActionsSetting(w.hub, bad).code, 'INVALID_MODE', String(bad));
    }
    assert.deepEqual(fs.readdirSync(w.hub), [], 'nothing written for an unknown mode');
    const missing = path.join(w.base, 'no-hub');
    assert.equal(writeHubActionsSetting(missing, 'dry').code, 'NO_HUB');
    assert.equal(fs.existsSync(missing), false, 'the hub folder is never created');
    const notDir = path.join(w.base, 'hub-file');
    fs.writeFileSync(notDir, 'x');
    assert.equal(writeHubActionsSetting(notDir, 'dry').code, 'NO_HUB');
    assert.equal(writeHubActionsSetting(null, 'dry').code, 'NO_HUB');
  });
});

// ------------------------------------------------------------------ the tray's switch flow
describe('shell: the switch flow behind the tray menu', () => {
  function spies(opts = {}) {
    // `in`, not a default value: an explicit undefined answer must stay undefined
    const confirmResult = 'confirmResult' in opts ? opts.confirmResult : true;
    const writeResult = opts.writeResult ?? { ok: true };
    const log = [];
    return {
      log,
      confirm: async () => {
        log.push('confirm');
        if (confirmResult instanceof Error) throw confirmResult;
        return confirmResult;
      },
      write: (mode) => {
        log.push(`write:${mode}`);
        return writeResult;
      },
      apply: async (mode) => {
        log.push(`apply:${mode}`);
      },
    };
  }

  test('turning actions On asks first; cancel (or a failing dialog) never writes and never restarts', async () => {
    for (const answer of [false, undefined, 'yes', 1, new Error('dialog failed')]) {
      const s = spies({ confirmResult: answer });
      const r = await changeActionsMode({ current: 'off', requested: 'live', ...s });
      assert.deepEqual(r, { changed: false, mode: 'off', reason: 'cancelled' }, String(answer));
      assert.deepEqual(s.log, ['confirm'], 'nothing after the dialog');
    }
    const s = spies({ confirmResult: true });
    assert.deepEqual(await changeActionsMode({ current: 'dry', requested: 'live', ...s }), { changed: true, mode: 'live', reason: 'saved' });
    assert.deepEqual(s.log, ['confirm', 'write:live', 'apply:live']);
  });

  test('Off and Preview need no confirmation; the same mode or an unknown one does nothing; a failed write restarts nothing', async () => {
    for (const [current, requested] of [['off', 'dry'], ['live', 'dry'], ['live', 'off'], ['dry', 'off']]) {
      const s = spies();
      const r = await changeActionsMode({ current, requested, ...s });
      assert.equal(r.reason, 'saved');
      assert.deepEqual(s.log, [`write:${requested}`, `apply:${requested}`], `${current} -> ${requested}`);
    }
    for (const [current, requested, reason] of [['dry', 'dry', 'same'], ['off', 'off', 'same'], ['junk', 'off', 'same'], ['off', 'on', 'invalid'], ['off', 'LIVE', 'invalid']]) {
      const s = spies();
      assert.equal((await changeActionsMode({ current, requested, ...s })).reason, reason, `${current} -> ${requested}`);
      assert.deepEqual(s.log, []);
    }
    const s = spies({ writeResult: { ok: false, code: 'SETTINGS_INVALID' } });
    const r = await changeActionsMode({ current: 'off', requested: 'dry', ...s });
    assert.deepEqual(r, { changed: false, mode: 'off', reason: 'write-failed', error: { ok: false, code: 'SETTINGS_INVALID' } });
    assert.deepEqual(s.log, ['write:dry']);
  });

  test('with the real writer: a cancelled On leaves settings.json byte for byte; an accepted one writes it', async () => {
    const w = world();
    w.makeHub('{"language":"en","actions":"dry"}');
    const file = path.join(w.hub, 'settings.json');
    const before = read(file);
    const run = (answer) =>
      changeActionsMode({ current: readHubActionsSetting(w.hub), requested: 'live', confirm: async () => answer, write: (m) => writeHubActionsSetting(w.hub, m), apply: async () => {} });
    assert.equal((await run(false)).reason, 'cancelled');
    assert.ok(read(file).equals(before));
    assert.equal((await run(true)).reason, 'saved');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language: 'en', actions: 'live' });
  });

  test('tray submenu: three localized radio items, the stored mode checked (unknown reads as Off)', () => {
    const en = actionsMenuItems(getStrings('en'), 'dry');
    assert.deepEqual(en, [
      { id: 'actions-off', mode: 'off', type: 'radio', label: 'Off', checked: false },
      { id: 'actions-dry', mode: 'dry', type: 'radio', label: 'Preview: commands are only shown', checked: true },
      { id: 'actions-live', mode: 'live', type: 'radio', label: 'On', checked: false },
    ]);
    assert.deepEqual(actionsMenuItems(getStrings('tr'), 'live').map((i) => [i.label, i.checked]), [['Kapalı', false], ['Önizleme: komutlar yalnız gösterilir', false], ['Açık', true]]);
    assert.deepEqual(actionsMenuItems(getStrings('en'), 'bogus').map((i) => i.checked), [true, false, false]);
    assert.equal(getStrings('en').trayActions, 'Actions');
    assert.equal(getStrings('tr').trayActions, 'Eylemler');
  });

  // A stand-in for Electron's dialog.showMessageBox: records how it was called and answers with `response`
  function fakeBox(response) {
    const calls = [];
    const box = async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return { response, checkboxChecked: false };
    };
    return { box, calls };
  }

  test('confirmation dialog: Cancel is the first button, the default and the Esc answer; the texts come from the string table', () => {
    for (const lang of ['en', 'tr']) {
      const S = getStrings(lang);
      const o = actionsConfirmOptions(S);
      assert.deepEqual(o, {
        type: 'warning',
        title: S.actionsConfirmTitle,
        message: S.actionsConfirmTitle,
        detail: S.actionsConfirmBody,
        buttons: [S.actionsConfirmCancel, S.actionsConfirmOk],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      assert.equal(o.buttons[ACTIONS_CONFIRM_OK], S.actionsConfirmOk, 'the On button is the one that confirms');
    }
    assert.equal(ACTIONS_CONFIRM_OK, 1);
  });

  test('confirmation: only the On button turns actions on; Cancel, Esc, any other answer or a failing dialog do not; QA never asks', async () => {
    const S = getStrings('en');
    const ok = fakeBox(ACTIONS_CONFIRM_OK);
    assert.equal(await confirmActionsLive({ S, showMessageBox: ok.box }), true);
    assert.deepEqual(ok.calls, [[actionsConfirmOptions(S)]], 'no parent: one argument, the options');
    for (const answer of [0, 2, -1, '1', null, undefined, new Error('dialog failed')]) {
      const b = fakeBox(answer);
      assert.equal(await confirmActionsLive({ S, showMessageBox: b.box }), false, String(answer));
      assert.equal(b.calls.length, 1);
    }
    // A visible window is passed as the parent, so the dialog is modal to it
    const parent = { id: 'window' };
    const withParent = fakeBox(ACTIONS_CONFIRM_OK);
    assert.equal(await confirmActionsLive({ S, parent, showMessageBox: withParent.box }), true);
    assert.deepEqual(withParent.calls, [[parent, actionsConfirmOptions(S)]]);
    // QA mode: the dialog is never shown and the answer is always no, whatever the dialog would have said
    const qa = fakeBox(ACTIONS_CONFIRM_OK);
    assert.equal(await confirmActionsLive({ S, qa: true, showMessageBox: qa.box }), false);
    assert.deepEqual(qa.calls, []);
  });

  test('switch flow with the real hub: the stored mode is read from settings.json, On needs the dialog, an overlapping hub is never written', async () => {
    const w = world();
    w.makeHub('{"language":"tr","actions":"live"}');
    const file = path.join(w.hub, 'settings.json');
    const S = getStrings('en');
    const applied = [];
    const remembered = [];
    const flow = (requested, box, extra = {}) =>
      switchActionsMode({
        hubPath: w.hub,
        requested,
        confirm: () => confirmActionsLive({ S, showMessageBox: box }),
        apply: async (m) => applied.push(m),
        remember: (m) => remembered.push(m),
        ...extra,
      });
    // live -> off: the current mode comes from the file, so Off really writes off (no dialog for Off)
    const off = fakeBox(ACTIONS_CONFIRM_OK);
    assert.deepEqual(await flow('off', off.box), { changed: true, mode: 'off', reason: 'saved', from: 'live' });
    assert.deepEqual(off.calls, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language: 'tr', actions: 'off' });
    // off -> live, the user presses Cancel (or Esc): settings.json stays byte for byte, nothing is applied or remembered
    const before = read(file);
    const cancel = fakeBox(0);
    assert.deepEqual(await flow('live', cancel.box), { changed: false, mode: 'off', reason: 'cancelled', from: 'off' });
    assert.equal(cancel.calls.length, 1);
    assert.ok(read(file).equals(before));
    // off -> live, the user presses On: written, remembered before the restart, applied
    const on = fakeBox(ACTIONS_CONFIRM_OK);
    assert.equal((await flow('live', on.box)).reason, 'saved');
    assert.equal(readHubActionsSetting(w.hub), 'live');
    assert.deepEqual(applied, ['off', 'live']);
    assert.deepEqual(remembered, ['off', 'live']);
    // The hub overlaps the program folder: every write is refused, the file stays, nothing is applied
    const stay = read(file);
    const r = await flow('dry', fakeBox(ACTIONS_CONFIRM_OK).box, { writable: false });
    assert.deepEqual(r, { changed: false, mode: 'live', reason: 'write-failed', error: { ok: false, code: 'NO_HUB' }, from: 'live' });
    assert.ok(read(file).equals(stay));
    assert.deepEqual(applied, ['off', 'live']);
    // In QA mode On is never confirmed, even with a dialog that would say yes
    const qa = await switchActionsMode({ hubPath: w.hub, requested: 'off', confirm: async () => true, apply: async () => {} });
    assert.equal(qa.reason, 'saved');
    const qaOn = await switchActionsMode({ hubPath: w.hub, requested: 'live', confirm: () => confirmActionsLive({ S, qa: true, showMessageBox: fakeBox(1).box }), apply: async () => {} });
    assert.equal(qaOn.reason, 'cancelled');
    assert.equal(readHubActionsSetting(w.hub), 'off');
  });

  test('the confirmation says what On does, in both languages', () => {
    for (const lang of ['en', 'tr']) {
      const S = SHELL_STRINGS[lang];
      for (const k of ['actionsConfirmTitle', 'actionsConfirmBody', 'actionsConfirmOk', 'actionsConfirmCancel', 'actionsErrorTitle', 'actionsErrorNoHub', 'actionsErrorInvalid', 'actionsErrorRead', 'actionsErrorWrite']) {
        assert.ok(typeof S[k] === 'string' && S[k].trim(), `${lang}.${k}`);
      }
    }
    // The context menu opens a plain terminal in the project folder (any AI tool can be started there) and resumes
    // Claude Code sessions; it no longer starts a new Claude session by itself
    assert.match(SHELL_STRINGS.en.actionsConfirmBody, /opens a terminal in the project folder \(you start the AI tool you want there\)/);
    assert.match(SHELL_STRINGS.en.actionsConfirmBody, /resumes Claude Code sessions/);
    assert.match(SHELL_STRINGS.en.actionsConfirmBody, /Explorer and in VS Code/);
    assert.match(SHELL_STRINGS.en.actionsConfirmBody, /installs skills and agents into project folders/);
    assert.match(SHELL_STRINGS.tr.actionsConfirmBody, /proje klasöründe terminal açar \(istediğin yapay zekâ aracını orada başlatırsın\)/);
    assert.match(SHELL_STRINGS.tr.actionsConfirmBody, /Claude Code oturumuna devam eder/);
    assert.match(SHELL_STRINGS.tr.actionsConfirmBody, /Gezgin’de ve VS Code’da açar/);
    assert.match(SHELL_STRINGS.tr.actionsConfirmBody, /skill ve ajanları proje klasörlerine kurar/);
    assert.doesNotMatch(SHELL_STRINGS.en.actionsConfirmBody, /terminals with Claude Code sessions/);
    assert.doesNotMatch(SHELL_STRINGS.tr.actionsConfirmBody, /oturumlarıyla terminal/);
    assert.notEqual(SHELL_STRINGS.en.actionsConfirmBody, SHELL_STRINGS.tr.actionsConfirmBody);
  });
});

// ------------------------------------------------------------------ restart after the change
describe('shell: the restart that applies the mode', () => {
  const T0 = 1_760_000_000_000;

  test('a requested restart never counts as a failure: no higher count, no backoff delay, never gives up', () => {
    let s = initialSupervisor();
    s = superviseStep(s, { type: 'failed', at: T0 }).state;
    s = superviseStep(s, { type: 'failed', at: T0 + 1000 }).state;
    s = superviseStep(s, { type: 'ready', at: T0 + 5000 }).state;
    const r = superviseStep(s, { type: 'requested', at: T0 + 10000 });
    assert.deepEqual(r.action, { type: 'restart', delayMs: 0, attempt: 0 });
    assert.equal(r.state.failures, 2, 'the count stays at 2');
    // The next real failure backs off as if the requested restart had not happened (restartDelay(2), not (3))
    const next = superviseStep(r.state, { type: 'failed', at: T0 + 11000 });
    assert.equal(next.action.delayMs, restartDelay(2));
    assert.equal(next.state.failures, 3);
    // Many requested restarts in a row, even at the edge of giving up, never give up
    let edge = { failures: SUPERVISOR_DEFAULTS.maxFailures, readyAt: T0 };
    for (let i = 1; i <= 20; i++) {
      const step = superviseStep(edge, { type: 'requested', at: T0 + i * 1000 });
      assert.equal(step.action.type, 'restart');
      assert.equal(step.state.failures, SUPERVISOR_DEFAULTS.maxFailures);
      edge = step.state;
    }
    // A run that was stable by then ends with a fresh start (as a later failure would have found it)
    const stable = superviseStep({ failures: 3, readyAt: T0 }, { type: 'requested', at: T0 + SUPERVISOR_DEFAULTS.stableMs });
    assert.deepEqual(stable.state, { failures: 0, readyAt: 0 });
  });

  test('restart plan: a running server restarts now, a starting one once it is ready, otherwise the next start reads it', () => {
    assert.equal(settingsRestartPlan({ serverAlive: true }), 'restart-now');
    assert.equal(settingsRestartPlan({ launching: true, serverAlive: true }), 'after-launch');
    assert.equal(settingsRestartPlan({ launching: true }), 'after-launch');
    assert.equal(settingsRestartPlan({}), 'next-launch', 'a scheduled restart or a gap between processes');
    assert.equal(settingsRestartPlan({ quitting: true, serverAlive: true }), 'none');
    assert.equal(settingsRestartPlan(), 'next-launch');
  });

  test('main.mjs wiring: tray and QA share one path; the restart is "requested", never a failure; the window reloads', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
    const body = (name) => {
      const start = src.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `missing function ${name}`);
      const end = src.indexOf('\n}\n', start);
      return src.slice(start, end);
    };
    assert.ok(body('actionsSubmenu').includes('return actionsSubmenuTemplate(S, currentActionsMode(), chooseActionsMode, source);'), 'tray radio items call chooseActionsMode');
    assert.ok(src.includes("chooseActionsMode(QA_ACTIONS.mode, 'qa')"), 'the QA switch uses the same function');
    assert.ok(src.includes("{ label: S.trayActions, submenu: actionsSubmenu('tray') }"));
    const choose = body('chooseActionsMode');
    for (const needle of [
      // How On is confirmed is the tested requestActionsMode's decision (test/actions-in-app.test.mjs); the native
      // dialog stays the answer for every route but the panel's own and QA's
      'requestActionsMode({',
      'confirmNative: confirmActionsOn,',
      'handOver: handOverToPanel,',
      'switchActionsMode({',
      'hubPath: state.hubPath,',
      'writable: !state.hubOverlaps,',
      'confirm,',
      'remember: rememberActionsMode,',
      'apply: (mode) => applyActionsMode(mode),',
      'refreshMenus()',
    ]) {
      assert.ok(choose.includes(needle), `chooseActionsMode: ${needle}`);
    }
    // The dialog and its answer are the tested helper's; main.mjs only passes QA, the parent and Electron's dialog
    const confirm = body('confirmActionsOn');
    assert.ok(confirm.includes('return confirmActionsLive({ S, qa: QA.enabled, parent, showMessageBox: (...args) => dialog.showMessageBox(...args) });'), 'QA gate and dialog wired');
    assert.doesNotMatch(confirm, /response|buttons|return true/, 'no answer is interpreted here');
    assert.equal(body('currentActionsMode').trim().split('\n').slice(1).join('\n').trim(), 'return readHubActionsSetting(state.hubPath);', 'the tray shows the stored mode');
    const restart = body('restartServerOnRequest');
    assert.ok(restart.includes("superviseStep(state.supervisor, { type: 'requested'"));
    assert.ok(restart.indexOf('state.server = null;') < restart.indexOf('stopServerProcess(old'), 'the old process stops being current before it is stopped');
    assert.ok(restart.indexOf('serverGone();') < restart.indexOf('stopServerProcess(old'), 'the window reaches no server from here on');
    assert.ok(restart.indexOf('state.retired.add(old);') < restart.indexOf('stopServerProcess(old'), 'tracked until it exits');
    assert.ok(!/onServerFailure|type: 'failed'/.test(restart), 'a requested restart never reports a failure');
    assert.ok(body('serverGone').includes('state.origin = null;') && body('serverGone').includes('state.reloadOnReady = true;'));
    assert.ok(body('onServerReady').includes('else if (changed || reload) win.loadURL(pageUrl());'));
    assert.ok(body('onServerExit').includes('state.retired.delete(handle);'));
    assert.ok(body('onServerExit').includes('if (state.server !== handle) return;'), 'an old process stopped on purpose is ignored');
    assert.ok(body('onServerExit').indexOf('serverGone();') > body('onServerExit').indexOf('state.server = null;'), 'a crash also closes the window off until the next server');
    assert.ok(/for \(const old of state\.retired\)[\s\S]*old\.forceKill\(\)/.test(body('stopServer')), 'quitting stops old processes too');
    const apply = body('applyServerSettingsChange');
    assert.ok(apply.includes('settingsRestartPlan({'));
    assert.ok(body('launchServer').indexOf('state.restartAfterLaunch = false;') < body('launchServer').indexOf('spawnServer('), 'the flag is cleared before a new process starts');
    // settings.json is written only through the tested helpers; the renderer's only way in is the one IPC handler,
    // which goes through chooseActionsMode like the menus (test/actions-in-app.test.mjs checks it in detail)
    assert.equal((src.match(/writeHubActionsSetting\(/g) || []).length, 0);
    assert.doesNotMatch(src, /settings\.json['"`]\s*\)\s*,\s*JSON/);
    // The bridge's three handlers (the actions mode, and the new project's folder picker and idea: docs/start-flow.md)
    assert.equal((src.match(/\bipcMain\.\w+\(/g) || []).join(), 'ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.handle(,ipcMain.on(,ipcMain.on(', 'the bridge handlers (actions, project folder, library folder, language, idea, a project made from an idea, attention) and five for the terminal (open, list, close; write and resize as sends: test/terminal.test.mjs), nothing else');
    assert.doesNotMatch(src, /contextBridge|ipcRenderer/);
    // The one send into the page: the embedded terminals' output, only while the window shows the app
    assert.equal((src.match(/webContents\.send\(/g) || []).length, 1);
    assert.ok(src.includes('if (win && !win.isDestroyed() && panelWindowReady()) win.webContents.send(channel, ...args);'));
  });

  test('while no server is ready (origin null) the window reaches nothing: no request, no navigation, no permission', () => {
    const old = appOrigin(47712);
    for (const url of [`${old}/api/actions`, `${old}/`, `ws://127.0.0.1:47712/`]) assert.equal(requestAllowed(url, null), false, url);
    for (const kind of ['navigate', 'redirect', 'frame']) assert.equal(decideNavigation(kind, `${old}/`, null).cancel, true, kind);
  });

  test('stopping the old server: kill, then force-kill after the wait, and report a process that never exits', async () => {
    // A stand-in for a server handle: exits when told to by kill() or forceKill(), as configured
    function fakeHandle({ onKill = false, onForce = false, killThrows = false } = {}) {
      const calls = [];
      let exit;
      const h = { alive: true, exited: new Promise((resolve) => (exit = resolve)), calls };
      const die = () => {
        h.alive = false;
        exit();
      };
      h.kill = () => {
        calls.push('kill');
        if (killThrows) throw new Error('kill failed');
        if (onKill) setTimeout(die, 5);
      };
      h.forceKill = () => {
        calls.push('forceKill');
        if (onForce) setTimeout(die, 5);
      };
      return h;
    }
    const polite = fakeHandle({ onKill: true });
    assert.equal(await stopServerProcess(polite, { waitMs: 200 }), 'exited');
    assert.deepEqual(polite.calls, ['kill'], 'no force kill when it exits in time');
    const stubborn = fakeHandle({ onForce: true });
    assert.equal(await stopServerProcess(stubborn, { waitMs: 50 }), 'forced');
    assert.deepEqual(stubborn.calls, ['kill', 'forceKill']);
    const throwing = fakeHandle({ killThrows: true, onForce: true });
    assert.equal(await stopServerProcess(throwing, { waitMs: 50 }), 'forced', 'a failing kill still leads to the force kill');
    const stuck = fakeHandle();
    const t0 = Date.now();
    assert.equal(await stopServerProcess(stuck, { waitMs: 50 }), 'stuck');
    assert.ok(Date.now() - t0 < 1000, 'the restart does not wait forever');
    assert.deepEqual(stuck.calls, ['kill', 'forceKill']);
    const gone = fakeHandle();
    gone.alive = false;
    assert.equal(await stopServerProcess(gone), 'exited');
    assert.deepEqual(gone.calls, [], 'a process that already exited is left alone');
    assert.equal(await stopServerProcess(null), 'exited');
  });

  test('stopping a real process that ignores the polite stop: the force kill ends it', async (ctx) => {
    // A Node child that stays alive; kill() here does nothing, forceKill() terminates it by pid (as main.mjs does)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    ctx.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    await new Promise((resolve) => child.once('spawn', resolve));
    const handle = { pid: child.pid, alive: true, exited, kill: () => {}, forceKill: () => process.kill(child.pid, 'SIGKILL') };
    exited.then(() => (handle.alive = false));
    assert.equal(await stopServerProcess(handle, { waitMs: 300 }), 'forced');
    assert.equal(handle.alive, false);
  });
});

// ------------------------------------------------------------------ actions switched on outside the tray
describe('shell: actions found on without the tray', () => {
  test('warned when settings.json says live and this shell neither wrote live for this hub nor warned about it', () => {
    const hub = 'C:\\Users\\a\\SiberSentez';
    assert.equal(unexpectedLiveMode({ mode: 'live', seen: undefined, hubPath: hub }), true, 'nothing recorded');
    assert.equal(unexpectedLiveMode({ mode: 'live', seen: { hub, mode: 'dry' }, hubPath: hub }), true, 'the shell last set Preview');
    assert.equal(unexpectedLiveMode({ mode: 'live', seen: { hub: 'D:\\other-hub', mode: 'live' }, hubPath: hub }), true, 'live was set for another hub (SIBERSENTEZ_HUB)');
    assert.equal(unexpectedLiveMode({ mode: ' LIVE ', seen: { hub, mode: 'off' }, hubPath: hub }), true, 'read like the server reads it');
    assert.equal(unexpectedLiveMode({ mode: 'live', seen: { hub, mode: 'live' }, hubPath: hub }), false, 'set (or already reported) by this shell');
    if (process.platform === 'win32') assert.equal(unexpectedLiveMode({ mode: 'live', seen: { hub: 'c:\\users\\a\\sibersentez\\', mode: 'live' }, hubPath: hub }), false, 'same folder, other spelling');
    for (const mode of ['off', 'dry', 'on', '', undefined]) assert.equal(unexpectedLiveMode({ mode, seen: undefined, hubPath: hub }), false, String(mode));
    for (const seen of [null, 'live', { mode: 'live' }, { hub: 7, mode: 'live' }]) assert.equal(unexpectedLiveMode({ mode: 'live', seen, hubPath: hub }), true, JSON.stringify(seen));
  });

  test("the shell's state file keeps every other key; a missing or broken file reads as empty", () => {
    const w = world();
    const file = path.join(w.base, SHELL_STATE_FILE);
    assert.equal(SHELL_STATE_FILE, 'shell.json');
    assert.deepEqual(readShellState(file), {});
    assert.equal(updateShellState(file, { trayHintShown: true }), true);
    assert.equal(updateShellState(file, { actionsModeSeen: { hub: w.hub, mode: 'live' } }), true);
    assert.deepEqual(readShellState(file), { trayHintShown: true, actionsModeSeen: { hub: w.hub, mode: 'live' } }, 'the tray hint flag survives');
    fs.writeFileSync(file, '{ broken');
    assert.deepEqual(readShellState(file), {});
    fs.writeFileSync(file, '[1]');
    assert.deepEqual(readShellState(file), {});
    assert.equal(updateShellState(path.join(w.base, 'missing-folder', SHELL_STATE_FILE), { a: 1 }), false, 'a failed save is reported, never thrown');
    assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
  });

  test("the shell's state file is replaced atomically: a new temporary file, one rename; shell.json is never opened for writing", () => {
    const w = world();
    const file = path.join(w.base, SHELL_STATE_FILE);
    fs.writeFileSync(file, JSON.stringify({ trayHintShown: true }) + '\n');
    const calls = [];
    const spy = {
      readFileSync: (...a) => fs.readFileSync(...a),
      writeFileSync: (p, data, opts) => {
        calls.push(['write', p, opts]);
        return fs.writeFileSync(p, data, opts);
      },
      renameSync: (a, b) => {
        calls.push(['rename', a, b]);
        return fs.renameSync(a, b);
      },
      rmSync: (p, o) => {
        calls.push(['rm', p]);
        return fs.rmSync(p, o);
      },
    };
    assert.equal(updateShellState(file, { actionsModeSeen: { hub: w.hub, mode: 'live' } }, { fsImpl: spy, suffix: () => 'fixed' }), true);
    const tmp = path.join(w.base, `${SHELL_STATE_FILE}.fixed.tmp`);
    assert.deepEqual(calls, [
      ['write', tmp, { encoding: 'utf8', flag: 'wx' }],
      ['rename', tmp, file],
    ]);
    assert.equal(fs.existsSync(tmp), false);
    assert.deepEqual(readShellState(file), { trayHintShown: true, actionsModeSeen: { hub: w.hub, mode: 'live' } });
  });

  test("a failing write or rename leaves shell.json byte for byte as it was (the warning record is not lost) and no temporary file", () => {
    for (const failAt of ['write', 'rename']) {
      const w = world();
      const file = path.join(w.base, SHELL_STATE_FILE);
      fs.writeFileSync(file, JSON.stringify({ trayHintShown: true, actionsModeSeen: { hub: w.hub, mode: 'live' } }) + '\n');
      const before = read(file);
      const boom = (code) => Object.assign(new Error(code), { code });
      const spy = {
        readFileSync: (...a) => fs.readFileSync(...a),
        writeFileSync: (p, d, o) => {
          if (failAt === 'write') {
            fs.writeFileSync(p, String(d).slice(0, 7), o); // a cut temporary file, as a full disk leaves it
            throw boom('ENOSPC');
          }
          return fs.writeFileSync(p, d, o);
        },
        renameSync: (a, b) => {
          if (failAt === 'rename') throw boom('EPERM');
          return fs.renameSync(a, b);
        },
        rmSync: (...a) => fs.rmSync(...a),
      };
      assert.equal(updateShellState(file, { trayHintShown: false }, { fsImpl: spy }), false, failAt);
      assert.ok(read(file).equals(before), `${failAt}: shell.json unchanged`);
      assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.endsWith('.tmp')), [], `${failAt}: no temporary file left`);
      assert.equal(unexpectedLiveMode({ mode: 'live', seen: readShellState(file).actionsModeSeen, hubPath: w.hub }), false, `${failAt}: the record still keeps the warning from coming back`);
    }
  });

  test('end to end: a hand edit to live is reported once; the tray setting live is not', async () => {
    const w = world();
    w.makeHub({ language: 'en', actions: 'off' });
    const state = path.join(w.base, SHELL_STATE_FILE);
    const seen = () => readShellState(state).actionsModeSeen;
    const remember = (mode) => updateShellState(state, { actionsModeSeen: { hub: w.hub, mode } });
    // Another program writes live: reported, then remembered as seen (as main.mjs does), so the next start is quiet
    fs.writeFileSync(path.join(w.hub, 'settings.json'), JSON.stringify({ language: 'en', actions: 'live' }));
    assert.equal(unexpectedLiveMode({ mode: readHubActionsSetting(w.hub), seen: seen(), hubPath: w.hub }), true);
    remember(readHubActionsSetting(w.hub));
    assert.equal(unexpectedLiveMode({ mode: readHubActionsSetting(w.hub), seen: seen(), hubPath: w.hub }), false);
    // The user switches to Preview in the tray, then something sets live again: reported again
    await switchActionsMode({ hubPath: w.hub, requested: 'dry', confirm: async () => true, apply: async () => {}, remember });
    fs.writeFileSync(path.join(w.hub, 'settings.json'), JSON.stringify({ language: 'en', actions: 'live' }));
    assert.equal(unexpectedLiveMode({ mode: readHubActionsSetting(w.hub), seen: seen(), hubPath: w.hub }), true);
    // Switching On in the tray (confirmed) is never reported
    await switchActionsMode({ hubPath: w.hub, requested: 'off', confirm: async () => true, apply: async () => {}, remember });
    await switchActionsMode({ hubPath: w.hub, requested: 'live', confirm: async () => true, apply: async () => {}, remember });
    assert.equal(unexpectedLiveMode({ mode: readHubActionsSetting(w.hub), seen: seen(), hubPath: w.hub }), false);
  });

  test('every ready server: the tray shows the stored mode, and a change to live made while the app runs is reported once (the record in shell.json, not a once-per-run flag)', async () => {
    const w = world();
    w.makeHub({ language: 'en', actions: 'off' });
    const settings = path.join(w.hub, 'settings.json');
    const stateFile = path.join(w.base, SHELL_STATE_FILE);
    const S = getStrings('en');
    const events = [];
    let tray = null; // the tray's Actions submenu as main.mjs builds it: radio items from the stored mode
    const ready = (qa = false) =>
      checkActionsOnReady({
        hubPath: w.hub,
        qa,
        read: () => readHubActionsSetting(w.hub),
        seen: () => readShellState(stateFile).actionsModeSeen,
        remember: (mode) => updateShellState(stateFile, { actionsModeSeen: { hub: w.hub, mode } }),
        warn: (mode) => events.push(`warn ${mode}`),
        refreshTray: () => (tray = actionsMenuItems(S, readHubActionsSetting(w.hub)).find((it) => it.checked).mode),
        log: (line) => events.push(`log ${line.split(':')[0]}`),
      });
    // First start: off, nothing to report
    assert.equal(ready(), 'none');
    assert.equal(tray, 'off');
    // While the app runs, another program writes live; then the server crashes and the supervisor starts it again
    fs.writeFileSync(settings, JSON.stringify({ language: 'en', actions: 'live' }));
    assert.equal(ready(), 'warned', 'reported at the restart, not only at the first start');
    assert.equal(tray, 'live', 'the tray shows the mode the new server uses');
    assert.deepEqual(readShellState(stateFile).actionsModeSeen, { hub: w.hub, mode: 'live' }, 'recorded before the warning');
    // Later restarts (and the next app run) do not report the same change again
    assert.equal(ready(), 'none');
    assert.equal(ready(), 'none');
    assert.deepEqual(events.filter((e) => e.startsWith('warn')), ['warn live']);
    // The user switches to Preview in the tray; something sets live again: reported again at the next ready
    await switchActionsMode({ hubPath: w.hub, requested: 'dry', confirm: async () => true, apply: async () => ready(), remember: (mode) => updateShellState(stateFile, { actionsModeSeen: { hub: w.hub, mode } }) });
    assert.equal(tray, 'dry');
    fs.writeFileSync(settings, JSON.stringify({ language: 'en', actions: 'live' }));
    assert.equal(ready(), 'warned');
    assert.deepEqual(events.filter((e) => e.startsWith('warn')), ['warn live', 'warn live']);
    // QA mode only logs: no warning, nothing recorded
    fs.writeFileSync(stateFile, '{}\n');
    events.length = 0;
    assert.equal(ready(true), 'logged');
    assert.deepEqual(events, ['log actions are on, but not switched on from this tray']);
    assert.deepEqual(readShellState(stateFile), {});
  });

  test('main.mjs: every ready server runs the tested check; tray balloon and a dialog, texts from the string table', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
    const body = (name) => {
      const start = src.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `missing function ${name}`);
      return src.slice(start, src.indexOf('\n}\n', start));
    };
    const check = body('checkActionsMode');
    for (const needle of [
      'checkActionsOnReady({',
      'hubPath: state.hubPath,',
      'qa: QA.enabled,',
      'read: currentActionsMode,',
      'seen: () => readShellState(shellStateFile()).actionsModeSeen,',
      'remember: rememberActionsMode,',
      'warn: showUnexpectedLiveWarning,',
      'refreshTray: refreshMenus,',
    ]) {
      assert.ok(check.includes(needle), needle);
    }
    const warn = body('showUnexpectedLiveWarning');
    for (const needle of ['formatString(S.actionsUnexpectedBody,', "tray?.displayBalloon({ iconType: 'warning', title: S.actionsUnexpectedTitle, content: detail });", 'buttons: [S.actionsUnexpectedOk]']) {
      assert.ok(warn.includes(needle), needle);
    }
    assert.doesNotMatch(src, /unexpectedLiveChecked|warnIfUnexpectedLive/, 'no once-per-run flag');
    assert.ok(body('onServerReady').trim().endsWith('checkActionsMode();'), 'after every ready server, not only the first');
    for (const lang of ['en', 'tr']) {
      const S = SHELL_STRINGS[lang];
      for (const k of ['actionsUnexpectedTitle', 'actionsUnexpectedBody', 'actionsUnexpectedOk']) assert.ok(S[k]?.trim(), `${lang}.${k}`);
      assert.match(S.actionsUnexpectedBody, /\{file\}/);
    }
    assert.notEqual(SHELL_STRINGS.en.actionsUnexpectedBody, SHELL_STRINGS.tr.actionsUnexpectedBody);
  });
});

// ------------------------------------------------------------------ the window menu and the retired shell path (§3a, §3b)
describe('shell: the window menu, and the retired path of the old native chooser (§3a, §3b)', () => {
  const origin = appOrigin(47712);
  const exact = `${origin}${SHELL_ACTIONS_MODE_PATH}`;
  // Source text with LF line ends (the working tree may use CRLF), so a function body ends at its own closing brace
  const textOf = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
  const mainSrc = () => textOf('electron', 'main.mjs');
  const bodyOf = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `end of function ${name}`);
    return src.slice(start, end);
  };

  test('retired path: only exactly <origin>/__shell/actions-mode is recognised', () => {
    assert.equal(SHELL_ACTIONS_MODE_PATH, '/__shell/actions-mode');
    assert.equal(RETIRED_PAGE_PATH, SHELL_ACTIONS_MODE_PATH, 'the path a stale caller in the page would still send');
    for (const gone of ['ACTIONS_CHOOSER_PATH', 'inDesktopShell', 'requestActionsChooser']) assert.equal(gone in CONTEXT_MENU, false, `${gone} is gone from the page`);
    assert.equal(isShellActionsModeUrl(exact, origin), true);
    assert.equal(isShellActionsModeUrl(new URL(RETIRED_PAGE_PATH, `${origin}/?lang=tr`).href, origin), true);
    for (const url of [
      `${exact}?`,
      `${exact}?mode=live`,
      `${exact}#`,
      `${exact}#live`,
      `${exact}/`,
      `${exact}/live`,
      `${origin}/__shell/actions-mode2`,
      `${origin}/__shell/`,
      `${origin}/__SHELL/actions-mode`,
      `${origin}/__shell/Actions-Mode`,
      `${origin}/__shell/actions%2Dmode`,
      `${origin}/%5F%5Fshell/actions-mode`,
      `${origin}/x/__shell/actions-mode`,
      'http://127.0.0.1:47713/__shell/actions-mode',
      'http://localhost:47712/__shell/actions-mode',
      'https://127.0.0.1:47712/__shell/actions-mode',
      'http://user:pw@127.0.0.1:47712/__shell/actions-mode',
      'file:///__shell/actions-mode',
      '/__shell/actions-mode',
      null,
    ]) {
      assert.equal(isShellActionsModeUrl(url, origin), false, String(url));
      assert.equal(shellNavigation({ url, origin }), null, `${url}: not the retired path, the ordinary rules apply`);
    }
    // No origin (no server ready): nothing is the retired path, and the ordinary rules block everything
    assert.equal(isShellActionsModeUrl(exact, null), false);
    assert.equal(shellNavigation({ url: exact, origin: null }), null);
    assert.equal(decideNavigation('navigate', exact, null).cancel, true);
  });

  test('retired path: always cancelled and nothing else, whatever started it; never sent to the browser; other paths keep the ordinary rules', () => {
    const fromPage = { kind: 'navigate', mainWindow: true, currentUrl: `${origin}/?lang=tr`, initiator: { top: true, url: `${origin}/` } };
    for (const extra of [{}, fromPage, { kind: 'redirect' }, { kind: 'frame' }, { kind: 'window-open' }, { mainWindow: false }]) {
      assert.deepEqual(shellNavigation({ ...extra, url: exact, origin }), { cancel: true, openExternal: false }, JSON.stringify(extra));
    }
    // Own-origin pages still load, external links still go to the browser: the guard only adds the retired path
    assert.deepEqual(decideNavigation('navigate', `${origin}/?lang=tr`, origin), { cancel: false, openExternal: false });
    assert.deepEqual(decideNavigation('navigate', 'https://nodejs.org/', origin), { cancel: true, openExternal: true });
  });

  test('main.mjs: the retired path is decided (and only cancelled) before the ordinary rules; the native chooser is gone', () => {
    const src = mainSrc();
    assert.ok(src.includes("contents.on('will-navigate', (event, url) => applyNavigation('navigate', url, () => event.preventDefault()));"));
    assert.ok(src.includes("contents.on('will-redirect', (event, url) => applyNavigation('redirect', url, () => event.preventDefault()));"));
    assert.ok(src.includes("applyNavigation('frame', details.url, () => details.preventDefault());"));
    const apply = bodyOf(src, 'applyNavigation');
    const iShell = apply.indexOf('const retired = shellNavigation({ url, origin: state.origin });');
    const iOrdinary = apply.indexOf('const d = decideNavigation(kind, url, state.origin);');
    assert.ok(iShell >= 0 && iOrdinary > iShell, 'the retired path first');
    const branch = apply.slice(iShell, iOrdinary);
    assert.ok(branch.includes('if (retired.cancel) cancel();'), 'the navigation is cancelled');
    assert.ok(branch.includes('return retired;'), 'never falls through to the ordinary rules');
    assert.doesNotMatch(branch, /openExternal\(|chooseActionsMode|showMessageBox|setImmediate/, 'it opens nothing');
    assert.doesNotMatch(src, /openActionsChooser|actionsChooserFlow|pickActionsMode|navigationSource|choosingActions/, 'no native chooser is left');
    for (const lang of ['en', 'tr']) {
      for (const k of Object.keys(SHELL_STRINGS[lang])) assert.doesNotMatch(k, /^actionsChooser/, `${lang}.${k}: the chooser's texts are gone`);
    }
  });

  test('window menu: the same three radio items as the tray, each calling the same function (chooseActionsMode) with its source', () => {
    for (const lang of ['en', 'tr']) {
      const S = getStrings(lang);
      for (const mode of ['off', 'dry', 'live']) {
        const calls = [];
        const choose = (...args) => calls.push(args);
        const tray = actionsSubmenuTemplate(S, mode, choose, 'tray');
        const menu = actionsSubmenuTemplate(S, mode, choose, 'menu');
        const shape = (items) => items.map(({ label, type, checked }) => ({ label, type, checked }));
        assert.deepEqual(shape(menu), shape(tray), `${lang} ${mode}: same items`);
        assert.deepEqual(shape(tray), actionsMenuItems(S, mode).map(({ label, type, checked }) => ({ label, type, checked })));
        for (const it of [...tray, ...menu]) it.click();
        assert.deepEqual(calls, [['off', 'tray'], ['dry', 'tray'], ['live', 'tray'], ['off', 'menu'], ['dry', 'menu'], ['live', 'menu']]);
      }
    }
    const src = mainSrc();
    assert.ok(bodyOf(src, 'actionsSubmenu').includes('return actionsSubmenuTemplate(S, currentActionsMode(), chooseActionsMode, source);'));
    assert.ok(bodyOf(src, 'buildAppMenu').includes("{ label: S.trayActions, submenu: actionsSubmenu('menu') },"), 'the window menu');
    assert.ok(bodyOf(src, 'refreshTrayMenu').includes("{ label: S.trayActions, submenu: actionsSubmenu('tray') },"), 'the tray');
    // Rebuilt together whenever the mode may have changed: after every switch attempt and every ready server
    const refresh = bodyOf(src, 'refreshMenus');
    assert.ok(refresh.includes('refreshTrayMenu();') && refresh.includes('buildAppMenu();'));
    assert.ok(bodyOf(src, 'chooseActionsMode').includes('refreshMenus();'));
    assert.ok(bodyOf(src, 'checkActionsMode').includes('refreshTray: refreshMenus,'));
    assert.doesNotMatch(src, /submenu:\s*actionsMenuItems\(/, 'no menu built from the bare items (they have no click)');
  });

  test('page: the indicator never navigates the window; the page reaches the shell only through the bridge', () => {
    const main = textOf('public', 'js', 'main.js');
    const sw = textOf('public', 'js', 'actionsSwitch.js');
    for (const [name, text] of [['main.js', main], ['actionsSwitch.js', sw]]) {
      assert.doesNotMatch(text, /__shell|requestActionsChooser|location\.(assign|replace)|location\.href\s*=/, name);
    }
    assert.ok(main.includes("import { createActionsSwitch, shellBridge, qaBridge, keepPlace, resumeRecord, readResume, RESUME_KEY } from './actionsSwitch.js';"));
    assert.ok(main.includes("openActionsChooser: () => $('#actMode')?.click(),"), "the drawer's Change actions opens the same switch");
    assert.match(textOf('public', 'index.html'), /<button type="button"[^>]*id="actMode"/);
  });

  test('server: the reserved path is no route; a direct request gets 404 in every mode', async (ctx) => {
    // The real request handler in this process on an ephemeral port; the action layer is a stand-in that must never
    // be reached (the reserved path is not an action route), so no action can run whatever the mode says
    const untouched = () => {
      throw new Error('the action layer was reached');
    };
    for (const mode of ['off', 'dry', 'live']) {
      let handler = null;
      const server = http.createServer((req, res) => handler(req, res));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ctx.after(() => server.listening && server.close());
      const { port } = server.address();
      handler = createHandler({ ingest: {}, catalog: {}, clients: new Set(), port, publicDir: path.join(ROOT, 'public'), actions: { mode, handleGet: untouched, handlePost: untouched, rejectMethod: untouched }, instance: 'test' });
      for (const [url, headers] of [
        [SHELL_ACTIONS_MODE_PATH, {}],
        [SHELL_ACTIONS_MODE_PATH, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
        [SHELL_ACTIONS_MODE_PATH, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
        [`${SHELL_ACTIONS_MODE_PATH}?mode=live`, { 'Sec-Fetch-Site': 'same-origin' }],
        ['/__shell/', { 'Sec-Fetch-Site': 'same-origin' }],
      ]) {
        const r = await request(port, { url, headers });
        assert.equal(r.status, 404, `${mode} ${url} ${JSON.stringify(headers)}`);
      }
      assert.equal((await request(port, { method: 'HEAD', url: SHELL_ACTIONS_MODE_PATH })).status, 404, `${mode} HEAD`);
      // The same handler still serves the page, so the 404 is about the path and not a broken setup
      assert.equal((await request(port, { url: '/', headers: { 'Sec-Fetch-Site': 'none' } })).status, 200, `${mode} /`);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ------------------------------------------------------------------ environment and QA
describe('shell: the environment cannot switch actions on', () => {
  test('SIBERSENTEZ_ACTIONS and SIBERSENTEZ_QA_ACTIONS (any case) never reach the server environment', () => {
    const env = buildServerEnv({ PATH: 'C:\\Windows', SIBERSENTEZ_ACTIONS: '1', sibersentez_actions: 'live', SiberSentez_Qa_Actions: 'dry', SIBERSENTEZ_QA_ACTIONS: 'dry' }, { port: 47712, hubPath: 'C:\\hub', instance: 'x' });
    assert.deepEqual(Object.keys(env).filter((k) => /actions/i.test(k)), []);
    assert.equal(env.PATH, 'C:\\Windows');
  });

  test('QA switch: only off or dry, only in QA mode; live is refused', () => {
    const qa = readQaOptions({ env: { SIBERSENTEZ_QA_QUIT_MS: '1000' }, isPackaged: false });
    assert.equal(qa.enabled, true);
    assert.deepEqual(readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: 'dry' }, qa }), { mode: 'dry', rejected: null });
    assert.deepEqual(readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: ' OFF ' }, qa }), { mode: 'off', rejected: null });
    const live = readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: 'live' }, qa });
    assert.equal(live.mode, null);
    assert.match(live.rejected, /refused/);
    assert.equal(readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: '1' }, qa }).mode, null);
    // Without QA mode (or in a packaged build without --qa) the variable does nothing
    assert.deepEqual(readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: 'dry' }, qa: readQaOptions({ env: {} }) }), { mode: null, rejected: null });
    const packaged = readQaOptions({ env: { SIBERSENTEZ_QA_QUIT_MS: '1000' }, argv: ['SiberSentez.exe'], isPackaged: true });
    assert.equal(readQaActionsMode({ env: { SIBERSENTEZ_QA_ACTIONS: 'dry' }, qa: packaged }).mode, null);
  });
});

// ------------------------------------------------------------------ real server process
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function request(port, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

describe('real server: the mode after a shell-requested restart', () => {
  test('off -> (shell writes dry) -> restart -> dry, from an isolated copy of the app; the user environment (SIBERSENTEZ_ACTIONS) is ignored; the page cannot change it', async (ctx) => {
    if (process.platform !== 'win32') return ctx.skip('Windows paths');
    const w = world();
    const project = path.join(w.base, 'work', 'sample');
    fs.mkdirSync(project, { recursive: true });
    initHub(w.hub);
    fs.writeFileSync(path.join(w.hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'sample', name: 'Sample', path: project }] }));
    // A minimal environment with a fake home: the real logs, hub and app data are never read
    const fakeRoaming = path.join(w.base, 'AppData', 'Roaming');
    const fakeLocal = path.join(w.base, 'AppData', 'Local');
    fs.mkdirSync(fakeRoaming, { recursive: true });
    fs.mkdirSync(fakeLocal, { recursive: true });
    const userEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      USERPROFILE: w.homeDir,
      HOME: w.homeDir,
      APPDATA: fakeRoaming,
      LOCALAPPDATA: fakeLocal,
      // What a user might have set; the shell strips both spellings. The value is dry on purpose: even if stripping
      // broke, this test could never start a server that runs actions (the first check would fail instead).
      SIBERSENTEZ_ACTIONS: 'dry',
      sibersentez_actions: 'dry',
    };
    const port = await freePort();
    const instance = `test-${process.pid}`;
    const env = buildServerEnv(userEnv, { port, hubPath: w.hub, instance });
    const settingsBefore = read(path.join(w.hub, 'settings.json'));
    // The server runs from a copy of server/ and public/ in a temporary app folder: the server reads sibersentez.json
    // from its own app folder (config.mjs), so a developer's sibersentez.json in the repository (say "actions": "live")
    // can never reach this test. The copy's sibersentez.json is broken on purpose: the server logs that and uses the
    // defaults, which shows that it read the copy's file and nothing else.
    const appDir = path.join(w.base, 'app-copy');
    for (const d of ['server', 'public']) fs.cpSync(path.join(ROOT, d), path.join(appDir, d), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'sibersentez.json'), '{ not json');

    let child = null;
    let exited = null; // settles when the current child is gone (a killed child keeps exitCode null)
    const output = [];
    const start = async () => {
      child = spawn(process.execPath, [path.join(appDir, 'server', 'index.mjs')], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdout.on('data', (d) => output.push(String(d)));
      child.stderr.on('data', (d) => output.push(String(d)));
      assert.equal(await waitForServer(port, { instance, timeoutMs: 20000, intervalMs: 100 }), 'ready', output.join(''));
    };
    const stop = async () => {
      if (!child) return;
      child.kill();
      await exited;
    };
    ctx.after(stop);
    const site = { 'Sec-Fetch-Site': 'same-origin' };

    await start();
    assert.match(output.join(''), /sibersentez\.json is invalid \(not a JSON object\); using defaults/, "the server read the copy's sibersentez.json");
    assert.equal((await request(port, { url: '/api/actions', headers: site })).status, 404, 'settings.json has no actions key: off (the environment asked for dry)');

    // The shell's writer, then the requested restart (the same process order main.mjs follows)
    assert.equal(writeHubActionsSetting(w.hub, 'dry').ok, true);
    await stop();
    await start();
    const list = await request(port, { url: '/api/actions', headers: site });
    assert.equal(list.status, 200);
    assert.equal(list.json.mode, 'dry', 'the restarted server reads the new mode from settings.json');
    assert.match(list.json.token, /^[0-9a-f]{64}$/);

    // A context-menu action in preview: the reply carries the command, nothing is started
    const post = (body, url = '/api/action') =>
      request(port, { method: 'POST', url, headers: { ...site, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-SiberSentez-Token': list.json.token }, body: JSON.stringify(body) });
    const dry = await post({ action: 'explorer', projectId: 'sample' });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.mode, 'dry');
    assert.deepEqual(dry.json.argv, ['explorer.exe', `"${project}"`]);

    // The page has no way to change the mode: no such action, no writable mode route
    assert.equal((await post({ action: 'mode', mode: 'live' })).status, 400);
    assert.equal((await post({ mode: 'live' }, '/api/actions')).status, 405);
    for (const url of ['/api/settings', '/api/actions/mode', '/settings.json']) {
      assert.ok([403, 404, 405].includes((await post({ actions: 'live' }, url)).status), url);
    }
    assert.equal((await request(port, { url: '/api/actions', headers: site })).json.mode, 'dry');
    await stop();
    // The server never wrote settings.json: only the shell's writer changed it
    const settingsAfter = JSON.parse(fs.readFileSync(path.join(w.hub, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsAfter, { ...JSON.parse(settingsBefore.toString('utf8')), actions: 'dry' });
    assert.ok(output.join('').includes('explorer'), 'the server logged the preview request');
  });
});

// ------------------------------------------------------------------ page: strings, language, context menu
describe('page: localized strings and the off-mode hint', () => {
  after(() => setLanguage('en'));

  test('i18n: every language has the same keys and placeholders; none is empty', () => {
    assert.deepEqual([...LANGUAGES].sort(), Object.keys(PAGE_STRINGS).sort());
    const keys = Object.keys(PAGE_STRINGS.en).sort();
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const lang of LANGUAGES) {
      assert.deepEqual(Object.keys(PAGE_STRINGS[lang]).sort(), keys, lang);
      for (const k of keys) {
        assert.ok(PAGE_STRINGS[lang][k].trim(), `${lang}.${k}`);
        assert.deepEqual(ph(PAGE_STRINGS[lang][k]), ph(PAGE_STRINGS.en[k]), `${lang}.${k}`);
      }
    }
  });

  test('language: the hub language (?lang=tr|en) wins, else the browser language, else English', () => {
    assert.equal(pickLanguage({ setting: 'tr', browser: 'en-US' }), 'tr');
    assert.equal(pickLanguage({ setting: 'en', browser: 'tr-TR' }), 'en');
    assert.equal(pickLanguage({ setting: ' TR-tr ', browser: 'de' }), 'tr');
    for (const setting of [null, undefined, '', 'auto', 'de', 'x']) {
      assert.equal(pickLanguage({ setting, browser: 'tr-TR' }), 'tr', String(setting));
      assert.equal(pickLanguage({ setting, browser: 'en-GB' }), 'en', String(setting));
      assert.equal(pickLanguage({ setting, browser: 'fr-FR' }), 'en', String(setting));
    }
    assert.equal(pickLanguage(), 'en');
    assert.equal(setLanguage('tr'), 'tr');
    assert.equal(modeName('dry'), 'Önizleme');
    assert.equal(t('actionsIndicator', { mode: modeName('live') }), 'Eylemler: Açık');
    assert.equal(setLanguage('xx'), 'en');
    assert.equal(t('actionsIndicator', { mode: modeName('bogus') }), 'Actions: Off');
    assert.equal(t('no-such-key'), 'no-such-key');
    // The shell passes only an explicit hub language to the page
    assert.equal(explicitLanguage('tr'), 'tr');
    assert.equal(explicitLanguage('EN-us'), 'en');
    for (const v of ['auto', '', null, 'de', 7]) assert.equal(explicitLanguage(v), null, String(v));
    assert.equal(windowUrl('http://127.0.0.1:47712', 'tr'), 'http://127.0.0.1:47712/?lang=tr');
    assert.equal(windowUrl('http://127.0.0.1:47712', null), 'http://127.0.0.1:47712/');
    assert.equal(windowUrl('http://127.0.0.1:47712', 'x&y'), 'http://127.0.0.1:47712/');
  });

  test('context menu while off: one line says how to switch on (the header indicator and the tray menu) in the page language; items and copy/details unchanged', () => {
    const projects = new Map([['alpha', { id: 'alpha', name: 'Alpha', kind: 'registered', path: 'D:\\Work\\alpha', exists: true, broad: false, packages: [] }]]);
    const data = { projects, sessions: new Map(), agents: new Map(), roster: [] };
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const m = menuModel({ type: 'project', id: 'alpha' }, data, 'off');
      assert.equal(m[0].tip, PAGE_STRINGS[lang].actionsOffMenuTip, lang);
      assert.equal(m[0].note, PAGE_STRINGS[lang].shCmOffNote);
      assert.deepEqual(m.filter((x) => !x.header && !x.sep).map((x) => x.id), ['copy-path', 'hide', 'open']);
      for (const mode of ['dry', 'live']) assert.equal(menuModel({ type: 'project', id: 'alpha' }, data, mode)[0].tip, undefined, mode);
      const err = errorText({ ok: false, status: 0, error: 'actions-off' });
      assert.equal(err, PAGE_STRINGS[lang].actionsOffError);
    }
    // Both places (§3a): the header indicator and the tray menu
    assert.match(PAGE_STRINGS.en.actionsOffMenuTip, /tray menu/);
    assert.match(PAGE_STRINGS.en.actionsOffMenuTip, /Actions indicator at the top/);
    assert.match(PAGE_STRINGS.tr.actionsOffMenuTip, /tepsi menüsünden/);
    assert.match(PAGE_STRINGS.tr.actionsOffMenuTip, /Eylemler göstergesinden/);
    assert.match(PAGE_STRINGS.en.actionsOffError, /indicator/);
    assert.match(PAGE_STRINGS.en.actionsOffError, /tray menu/);
    assert.match(PAGE_STRINGS.tr.actionsOffError, /göstergesinden/);
    assert.match(PAGE_STRINGS.tr.actionsOffError, /tepsi menüsünden/);
  });

  test("header indicator: a button that reads the mode; in a plain browser its tooltip and accessible name name both places (the indicator and the tray)", () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /<button type="button" class="chip chip-btn act-mode" id="actMode" data-mode="off" hidden><\/button>/);
    const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(main.includes("setLanguage(pickLanguage({ setting: params.get('lang'), browser: navigator.language }))"));
    assert.ok(main.includes('actionsReady().then(() => actSwitch.setMode(actionsState().mode));'));
    assert.ok(main.includes("getMode: () => actionsState().mode,"));
    // The indicator's texts (actionsSwitch.js indicatorModel; the switch itself is tested in test/actions-in-app.test.mjs)
    const sw = fs.readFileSync(path.join(ROOT, 'public', 'js', 'actionsSwitch.js'), 'utf8');
    assert.ok(sw.includes("const title = `${text}. ${t('actionsHowTo')}`;"), 'browser tooltip');
    assert.ok(sw.includes("button.setAttribute('aria-label', m.label);"), 'accessible name');
    assert.match(PAGE_STRINGS.en.actionsHowTo, /click this indicator/);
    assert.match(PAGE_STRINGS.en.actionsHowTo, /system tray/);
    assert.match(PAGE_STRINGS.tr.actionsHowTo, /bu göstergeye tıkla/);
    assert.match(PAGE_STRINGS.tr.actionsHowTo, /sistem tepsisindeki/);
    // Nothing but the switch's one bridge call could change the mode
    for (const f of ['main.js', 'actions.js', 'contextmenu.js', 'i18n.js']) {
      const text = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
      assert.doesNotMatch(text, /settings\.json|requestActionsMode|setActionsMode/, f);
    }
    const code = sw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.deepEqual(code.match(/[\w.]*setActionsMode\(/g), ['bridge.setActionsMode('], 'actionsSwitch.js: one call, through the bridge');
  });
});
