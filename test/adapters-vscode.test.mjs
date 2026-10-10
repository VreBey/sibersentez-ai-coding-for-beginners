// The VS Code family's editors (Cursor, Antigravity) with this computer's own paths: their workspaces are found from
// workspaceStorage/<hash>/workspace.json (server/adapters/shared.mjs vscodeWorkspaces), so Linux and macOS check them
// too (independent review of 0.18.0 §9; test/adapters.test.mjs writes Windows paths). Run:
// node --test test/adapters-vscode.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cursor } from '../server/adapters/cursor.mjs';
import { antigravity } from '../server/adapters/antigravity.mjs';
import { hasEntries, isLowerCased } from '../server/fsutil.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-vscode-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function world(app) {
  const appDataDir = path.join(ROOT, app.replace(/\W/g, ''), 'appdata');
  const homeDir = path.join(ROOT, app.replace(/\W/g, ''), 'home');
  const proj = path.join(ROOT, app.replace(/\W/g, ''), 'projects', 'kafe');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const storage = path.join(appDataDir, app, 'User', 'workspaceStorage');
  const put = (hash, json) => {
    fs.mkdirSync(path.join(storage, hash), { recursive: true });
    fs.writeFileSync(path.join(storage, hash, 'workspace.json'), json);
  };
  put('a1', JSON.stringify({ folder: pathToFileURL(proj).href }));
  put('b2', '﻿' + JSON.stringify({ folder: pathToFileURL(proj).href })); // the same folder again, with a BOM
  put('c3', JSON.stringify({ workspace: 'file:///x.code-workspace' })); // a multi-root workspace: no folder
  put('d4', 'not json');
  put('e5', JSON.stringify({ folder: 'vscode-remote://ssh-remote+box/home/u/p' })); // not a local folder
  return { ctx: { appDataDir, homeDir, cache: {} }, proj, storage };
}
// Letter case decides only where the file system ignores it (Windows, macOS by default)
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const same = (a, b) => (caseless ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

for (const [adapter, app] of [
  [cursor, 'Cursor'],
  [antigravity, 'Antigravity IDE'],
]) {
  test(`${adapter.name}: seen when its settings are there; its local workspace folders once each, others left out`, () => {
    const { ctx, proj, storage } = world(app);
    assert.equal(adapter.detect(ctx), true);
    const found = adapter.findProjects(ctx);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.ok(same(found[0].path, proj), found[0].path);
    // Every workspace.json read is kept by its file (the unreadable JSON too, as no folder); a removed one leaves it
    assert.equal(ctx.cache.vscode.size, 5);
    assert.equal(adapter.findProjects(ctx).length, 1);
    fs.rmSync(path.join(storage, 'a1'), { recursive: true });
    fs.rmSync(path.join(storage, 'b2'), { recursive: true });
    assert.deepEqual(adapter.findProjects(ctx), []);
    assert.equal(ctx.cache.vscode.size, 3);
    assert.equal(adapter.detect({ appDataDir: path.join(ROOT, 'none'), homeDir: path.join(ROOT, 'none'), cache: {} }), false);
  });
}

test('the small file helpers the adapters use: a folder with entries; a spelling with no upper-case letter after the drive', () => {
  const dir = path.join(ROOT, 'helpers');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(hasEntries(dir), false, 'empty');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  assert.equal(hasEntries(dir), true);
  assert.equal(hasEntries(path.join(dir, 'missing')), false);
  assert.equal(isLowerCased('c:/users/u/projects/kafe'), true);
  assert.equal(isLowerCased('C:/Users/u/projects/kafe'), false);
  assert.equal(isLowerCased('/home/u/kafe'), true);
});
