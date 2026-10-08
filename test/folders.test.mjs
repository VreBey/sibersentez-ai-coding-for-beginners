// Folders that are not projects (docs/folders.md): the server says where an unregistered folder sits (placeOf), the
// page keeps such folders out of the project groups, the count and the building's floors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Catalog } from '../server/catalog.mjs';
import { isOtherFolder } from '../public/js/attention.js';
import { projectGroups } from '../public/js/views/projects.js';

const HOME = String.raw`C:\Users\u`;
const cat = new Catalog({ hubDir: null, claudeDir: path.join(HOME, '.claude'), homeDir: HOME, env: { TEMP: String.raw`C:\Users\u\AppData\Local\Temp` } });
const adhoc = (p, extra = {}) => ({ kind: 'adhoc', path: p, ...extra });

test('placeOf: broad, temporary, chat folder, or a project; a registered project is always a project', () => {
  assert.equal(cat.placeOf(adhoc(HOME, { broad: true })), 'broad');
  assert.equal(cat.placeOf(adhoc(String.raw`C:\WINDOWS\system32`)), 'broad');
  assert.equal(cat.placeOf(adhoc(String.raw`C:\Users\u\AppData\Local\Temp\ork-plugin-dir-test`)), 'temp');
  assert.equal(cat.placeOf(adhoc(String.raw`C:\Users\u\Documents\Codex\2026-09-29\https-claude-ai-artifact`)), 'chat');
  assert.equal(cat.placeOf(adhoc(String.raw`C:\Users\u\Documents\Codex\my-tool`)), null, 'a folder in Codex that is not a dated chat');
  assert.equal(cat.placeOf(adhoc(String.raw`C:\Users\u\Documents\Codex\2026-09-29\chat\src`)), null, 'a folder below a chat folder');
  assert.equal(cat.placeOf(adhoc(String.raw`D:\Work\arena unity`)), null);
  assert.equal(cat.placeOf({ kind: 'registered', path: String.raw`C:\Users\u\AppData\Local\Temp\x` }), null);
  assert.equal(cat.placeOf(null), null);
});

test('the page: other folders go to one last group, out of the normal groups', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const ps = [
    { id: 'a', kind: 'registered', live: 1, lastActivity: now },
    { id: 'home', kind: 'adhoc', broad: true, place: 'broad', live: 1, lastActivity: now },
    { id: 'chat', kind: 'adhoc', place: 'chat', live: 0, lastActivity: now - 1000 },
    { id: 'b', kind: 'adhoc', place: null, live: 0, lastActivity: now - 1000 },
  ];
  assert.deepEqual(ps.map(isOtherFolder), [false, true, true, false]);
  const groups = projectGroups(ps, { sort: 'activity', now });
  assert.deepEqual(groups.map((g) => [g.items.map((p) => p.id).join(','), !!g.other]), [['a', false], ['b', false], ['home,chat', true]]);
  const spend = projectGroups(ps, { sort: 'spend', now, cost: true });
  assert.ok(spend.at(-1).other && !spend.slice(0, -1).some((g) => g.items.some(isOtherFolder)));
  // A moved project's old folder (only AI settings, the real one listed by the same name) folds away with them,
  // unless a session is open in it right now; one without a twin stays where it is
  const moved = [
    { id: 'd', name: 'arena game', kind: 'adhoc', path: 'D:\\p', exists: true, live: 0, lastActivity: now - 2000 },
    { id: 'old', name: 'arena game', kind: 'adhoc', path: 'C:\\old', exists: true, toolsOnly: true, live: 0, lastActivity: now - 1000 },
    { id: 'lone', name: 'alone', kind: 'adhoc', path: 'C:\\lone', exists: true, toolsOnly: true, live: 0, lastActivity: now - 1000 },
  ];
  const mg = projectGroups(moved, { sort: 'activity', now });
  assert.deepEqual(mg.map((g) => [g.items.map((p) => p.id).join(','), !!g.other]), [['d,lone', false], ['old', true]]);
  const open = projectGroups([moved[0], { ...moved[1], live: 1 }], { sort: 'activity', now });
  assert.ok(open[0].items.some((p) => p.id === 'old') && !open.some((g) => g.other), 'open now: shown');
});
