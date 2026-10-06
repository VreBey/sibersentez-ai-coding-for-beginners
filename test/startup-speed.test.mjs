// Startup speed (measured 2026-10-02 on the owner's machine: 30 projects, 2,450 skills and agents, 700 log files).
// The first answer waited for a skill scan that the scan after the logs repeats anyway (1.6-2.6 s -> about 0.5 s),
// and every roster build ran a disk check per item to decide whether "Add to the library" is offered (about a second
// in the first snapshot -> 0.2 s). The list now asks a string-only question; the action still checks the disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Catalog } from '../server/catalog.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the first catalog load skips the skill scan; the scan after the logs does it', () => {
  const index = read('server/index.mjs');
  assert.ok(index.includes('catalog.load({ roster: false });'));
  const after = index.slice(index.indexOf('await ingest.initialScan('));
  assert.ok(after.includes('reloadCatalog();'), 'the full roster comes after the first log scan');
});

test('the list offers "Add to the library" from the item places alone; library, kit, the hub and the home folder never', () => {
  const c = new Catalog({ hubDir: 'C:\\Users\\u\\SiberSentez', claudeDir: 'C:\\Users\\u\\.claude', homeDir: 'C:\\Users\\u', adapters: [], env: {} });
  c.itemFiles = new Map([
    ['skill:mine', [{ source: 'project', file: 'C:\\work\\app\\.claude\\skills\\mine\\SKILL.md' }]],
    ['skill:lib', [{ source: 'library', file: 'C:\\Users\\u\\SiberSentez\\library\\x\\skills\\lib\\SKILL.md' }]],
    ['skill:inhub', [{ source: 'project', file: 'C:\\Users\\u\\SiberSentez\\trials\\inhub\\SKILL.md' }]],
    ['agent:helper', [{ source: 'personal', file: 'C:\\Users\\u\\.claude\\agents\\helper.md' }]],
    ['agent:loose', [{ source: 'project', file: 'C:\\work\\app\\notes\\loose.md' }]],
    ['skill:unc', [{ source: 'project', file: '\\\\server\\share\\skills\\unc\\SKILL.md' }]],
  ]);
  assert.equal(c.itemOriginLikely('skill', 'mine'), true);
  assert.equal(c.itemOriginLikely('skill', 'MINE'), true, 'kind and name in any case');
  assert.equal(c.itemOriginLikely('skill', 'lib'), false, 'already in the library');
  assert.equal(c.itemOriginLikely('skill', 'inhub'), false, 'inside the hub');
  assert.equal(c.itemOriginLikely('agent', 'helper'), true);
  assert.equal(c.itemOriginLikely('agent', 'loose'), false, 'an agent lives in a folder named agents');
  assert.equal(c.itemOriginLikely('skill', 'unc'), false, 'a network path is never offered');
  assert.equal(c.itemOriginLikely('plugin', 'mine'), false);
  assert.equal(c.itemOriginLikely('skill', 'none'), false);
  assert.ok(read('server/views.mjs').includes('catalog.itemOriginLikely(it.kind, it.name)'), 'the roster view uses it');
  assert.ok(read('server/actions.mjs').includes('catalog.itemOrigin(it.kind, it.name)'), 'the action keeps the disk check');
});
