// "Add to the library" is easy to find and needs no typed path (docs/skills-flow.md §5): the library card's button,
// the palette command, and the desktop app's folder picker (electron/helpers.mjs libraryPickReply).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryPickReply, libraryFolderDialogOptions, systemFolderRules, LIBRARY_PICK_IPC_CHANNEL, LIBRARY_SOURCE_MAX } from '../electron/helpers.mjs';
import { STRINGS } from '../public/js/i18n.js';
import { WIN_ONLY } from './lib/winonly.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('folder picker answer: a local absolute folder the server takes, else a reason; never anything else', { skip: WIN_ONLY }, () => {
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: ['D:\\my-skills'] }), { ok: true, path: 'D:\\my-skills' });
  assert.deepEqual(libraryPickReply({ canceled: true, filePaths: [] }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(libraryPickReply(null), { ok: false, reason: 'cancelled' });
  for (const bad of ['relative\\x', '\\\\server\\share\\skills', 'D:\\a\u0007b', 42]) assert.deepEqual(libraryPickReply({ filePaths: [bad] }), { ok: false, reason: 'invalid' }, String(bad));
  assert.deepEqual(libraryPickReply({ filePaths: ['D:\\' + 'a'.repeat(LIBRARY_SOURCE_MAX)] }), { ok: false, reason: 'too-long' });
  assert.equal(LIBRARY_SOURCE_MAX, 260, 'the server refuses a longer scan source (bad-source)');
  const o = libraryFolderDialogOptions({ libraryPickTitle: 'T', libraryPickButton: 'B' });
  assert.deepEqual(o, { title: 'T', buttonLabel: 'B', properties: ['openDirectory', 'dontAddToRecent'] });
  assert.equal(LIBRARY_PICK_IPC_CHANNEL, 'sibersentez:pick-library-folder');
  assert.ok(read('electron', 'preload.cjs').includes(`const LIBRARY_PICK_CHANNEL = '${LIBRARY_PICK_IPC_CHANNEL}';`));
});

// The same rules with this computer's own paths, so Linux and macOS check them too (review of 0.18.0 §9)
test('folder picker answer with this computer\'s paths: absolute and local is taken; relative, a control character, too long or empty is not', () => {
  const here = path.join(os.tmpdir(), 'my-skills');
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: [here, '/ignored'] }), { ok: true, path: here }, 'the first chosen folder');
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: [] }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: ['relative/skills'] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: [`${here}\u0001`] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(libraryPickReply({ canceled: false, filePaths: [path.join(here, 'a'.repeat(LIBRARY_SOURCE_MAX))] }), { ok: false, reason: 'too-long' });
  assert.deepEqual(libraryFolderDialogOptions({ libraryPickTitle: 'T', libraryPickButton: 'B' }).properties, ['openDirectory', 'dontAddToRecent']);
});

test('system folders from the environment with this computer\'s paths: trees and roots, each once, blank and relative values ignored', () => {
  const sys = path.join(os.tmpdir(), 'ss-system-rules');
  const env = { systemroot: path.join(sys, 'Windows'), ProgramFiles: path.join(sys, 'Programs'), PROGRAMDATA: path.join(sys, 'Programs'), OneDrive: path.join(sys, 'OneDrive'), OneDriveCommercial: '   ', OneDriveConsumer: 'relative' };
  const r = systemFolderRules(env);
  assert.deepEqual(r.trees, [env.systemroot, env.ProgramFiles], 'any letter case; the same folder once');
  assert.deepEqual(r.roots, [env.OneDrive]);
  assert.deepEqual(systemFolderRules(), { trees: [], roots: [] });
});

test('the page: a primary "Add to the library" button on the library card, a palette command, the picker button in the desktop app only', () => {
  const roster = read('public', 'js', 'views', 'roster.js');
  assert.match(roster, /class="act-btn primary lc-add" data-imp-open/);
  assert.match(roster, /if \(e\.target\.closest\?\.\('\[data-imp-open\]'\)\) return openImport\(\);/);
  assert.match(roster, /return \{ render, openImport \};/);
  assert.match(roster, /canPick = typeof globalThis\.sibersentezShell\?\.pickLibraryFolder === 'function'/);
  assert.match(roster, /\$\{canPick \? btn\('pick', t\('skPickFolder'\)/);
  const main = read('public', 'js', 'main.js');
  assert.match(main, /\{ id: 'library-add', label: t\('rfLibAdd'\)[^\n]*run: \(\) => \(showTab\('roster'\), views\.roster\.openImport\(\)\) \}/);
  for (const lang of ['en', 'tr']) for (const k of ['rfLibAdd', 'rfLibAddSub', 'skPickFolder', 'skImportPathOr', 'skPickTooLong', 'skPickBusy', 'skPickFailed']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  assert.equal(STRINGS.tr.rfLibAdd, 'Kütüphaneye ekle');
});
