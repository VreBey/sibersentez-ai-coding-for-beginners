// The product was renamed (Orkestra -> SiberSentez, 2026-09-30): what was saved under the old name keeps working.
// The old name is written in parts, so a later search-and-replace can never turn these checks into the new name.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLegacyEnv, resolveConfig, LEGACY_CONFIG_FILE, CONFIG_FILE, DEFAULT_HUB_NAME } from '../server/config.mjs';
import { writeFirstMessage, takeOverLegacyFolder, FIRST_DIR, LEGACY_FIRST_DIR } from '../server/launch.mjs';
import { teamFacts } from '../server/team.mjs';
import { legacyHubPlan, buildServerEnv, HUB_DIR_NAME, LEGACY_HUB_DIR_NAME } from '../electron/helpers.mjs';
import { terminalEnv } from '../electron/terminals.mjs';

const OLD = ['Ork', 'estra'].join('');
const old = OLD.toLowerCase();
const OLDU = OLD.toUpperCase();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-rename-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test('names: the new product name everywhere, the old one only where old data is read', () => {
  assert.equal(HUB_DIR_NAME, 'SiberSentez');
  assert.equal(DEFAULT_HUB_NAME, 'SiberSentez');
  assert.equal(LEGACY_HUB_DIR_NAME, OLD);
  assert.equal(CONFIG_FILE, 'sibersentez.json');
  assert.equal(LEGACY_CONFIG_FILE, `${old}.json`);
  assert.equal(FIRST_DIR, '.sibersentez');
  assert.equal(LEGACY_FIRST_DIR, `.${old}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.productName, 'SiberSentez');
  assert.equal(pkg.build.productName, 'SiberSentez');
  assert.equal(pkg.build.appId, 'com.sibersentez.app');
  assert.match(pkg.build.artifactName, /^SiberSentez-Setup-/);
});

test('environment: an old variable is taken over under the new name, a new one set by hand wins; the server and the terminals drop both', () => {
  const env = { [`${OLDU}_PORT`]: '4600', [`${OLDU}_HUB`]: 'C:\\old', SIBERSENTEZ_HUB: 'C:\\new', PATH: 'x' };
  assert.equal(adoptLegacyEnv(env), 1);
  assert.equal(env.SIBERSENTEZ_PORT, '4600');
  assert.equal(env.SIBERSENTEZ_HUB, 'C:\\new', 'the new name set by hand wins');
  assert.equal(adoptLegacyEnv({}), 0);
  const server = buildServerEnv({ [`${OLDU}_ACTIONS`]: 'live', SIBERSENTEZ_ACTIONS: 'live', [`${OLDU}_PORT`]: '1', PATH: 'x' }, { port: 4700, hubPath: 'C:\\h', instance: 'i' });
  assert.deepEqual(Object.keys(server).sort(), ['PATH', 'SIBERSENTEZ_HUB', 'SIBERSENTEZ_INSTANCE', 'SIBERSENTEZ_PORT'], 'the old ACTIONS never reaches the server');
  assert.deepEqual(terminalEnv({ [`${OLDU}_HUB`]: 'x', SIBERSENTEZ_HUB: 'y', PATH: 'p' }), { PATH: 'p', COLORTERM: 'truecolor' });
});

test('config file: the new name, else the old one', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  fs.writeFileSync(path.join(dir, LEGACY_CONFIG_FILE), JSON.stringify({ port: 4611 }));
  assert.equal(resolveConfig({ env: {}, appDir: dir, homeDir: dir }).port, 4611, 'the old file is read');
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ port: 4622 }));
  assert.equal(resolveConfig({ env: {}, appDir: dir, homeDir: dir }).port, 4622, 'the new one wins');
});

test('hub: only the default hub under the old name is moved, and only when the new one is not there', () => {
  assert.equal(legacyHubPlan({ source: 'default', newExists: false, oldIsDir: true }), 'move');
  assert.equal(legacyHubPlan({ source: 'default', newExists: true, oldIsDir: true }), 'none');
  assert.equal(legacyHubPlan({ source: 'default', newExists: false, oldIsDir: false }), 'none');
  assert.equal(legacyHubPlan({ source: 'env', newExists: false, oldIsDir: true }), 'none', 'a hub the person named is theirs');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
  assert.ok(main.includes('state.hubPath = migrateLegacyHub(hub);'));
});

test("a project's old hand-off folder: read by the team bar, taken over by the next start, never when both exist or it is a link", () => {
  const p = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.mkdirSync(path.join(p, `.${old}`));
  fs.writeFileSync(path.join(p, `.${old}`, 'PLAN.md'), '# Plan: x\nApproved: yes\n');
  fs.writeFileSync(path.join(p, `.${old}`, 'TASKS.md'), '## T1: a\n- status: doing\n');
  assert.equal(teamFacts(p).plan.approved, true, 'read from the old folder meanwhile');
  const w = writeFirstMessage(p, 'hello');
  assert.equal(w.ok, true);
  assert.ok(fs.existsSync(path.join(p, '.sibersentez', 'PLAN.md')), 'the old folder was renamed, the team goes on');
  assert.ok(!fs.existsSync(path.join(p, `.${old}`)));
  assert.equal(teamFacts(p).tasks[0].status, 'doing');
  // Both exist: nothing moves
  const q = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.mkdirSync(path.join(q, `.${old}`));
  fs.mkdirSync(path.join(q, '.sibersentez'));
  assert.equal(takeOverLegacyFolder(q), false);
  assert.ok(fs.existsSync(path.join(q, `.${old}`)));
  // A junction in the old place: never followed or moved
  const r = fs.mkdtempSync(path.join(TMP, 'proj-'));
  const target = fs.mkdtempSync(path.join(TMP, 'elsewhere-'));
  fs.symlinkSync(target, path.join(r, `.${old}`), 'junction');
  assert.equal(takeOverLegacyFolder(r), false);
});

test('remembered projects and page settings: the old names read as the new ones', () => {
  const memory = fs.readFileSync(path.join(ROOT, 'server', 'memory.mjs'), 'utf8');
  assert.ok(memory.includes(`(v === '${old}' ? SIBERSENTEZ_VIA : v)`), 'a folder added under the old name reads as added by the person');
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.ok(main.includes(`const OLD_PREFIX = '${old}.';`) && main.includes("const next = 'sibersentez.' + k.slice(OLD_PREFIX.length);"), 'the browser settings are copied once');
});

test('actions left On by the old app are taken over with its hub, not reported as switched on outside the app', () => {
  const main = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  const migrate = main.slice(main.indexOf('function migrateLegacyHub('), main.indexOf('async function prepareHub('));
  assert.ok(migrate.indexOf("!== 'move') return hub.path;") < migrate.indexOf('state.hubFromLegacy = true;'), 'only when the old hub is taken');
  assert.ok(migrate.indexOf('state.hubFromLegacy = true;') < migrate.indexOf('fs.renameSync(oldPath, hub.path);'), 'moved or kept in place');
  assert.match(main, /state\.hubPath = migrateLegacyHub\(hub\);\s*rememberLegacyMode\(\);/);
  const remember = main.slice(main.indexOf('function rememberLegacyMode('), main.indexOf('function rememberActionsMode('));
  assert.match(remember, /if \(!state\.hubFromLegacy\) return;\s*const mode = currentActionsMode\(\);\s*rememberActionsMode\(mode\);/);
});
