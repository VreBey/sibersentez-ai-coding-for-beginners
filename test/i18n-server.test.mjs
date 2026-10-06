// Fixed texts the server writes into its data in English (events, project notes, the home folder's name, the built-in
// agents' descriptions) reach the page in its language: each one the server writes has its page key, in both
// languages. A changed server text breaks this test instead of showing up in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventText, projectDescription, itemDescription, BUILTIN_AGENT_KEYS } from '../public/js/format.js';
import { localProject } from '../public/js/store.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { BUILTIN_AGENTS } from '../server/adapters/claude-code.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the built-in agents: the page knows every description the server writes, under the same name', () => {
  assert.deepEqual(
    Object.entries(BUILTIN_AGENTS).map(([name, desc]) => [desc, name]).sort(),
    Object.entries(BUILTIN_AGENT_KEYS).sort(),
  );
});

test('the server still writes exactly the texts the page translates', () => {
  const catalog = read('server/catalog.mjs');
  const ingest = read('server/ingest.mjs');
  for (const s of ["'Not in the registry; found in AI tool records.'", "'Added in SiberSentez as a new project.'", "'Only seen in temporary (scratchpad) folders; the real folder is not known yet.'", "'Home folder'"]) assert.ok(catalog.includes(s), s);
  assert.ok(ingest.includes("kind: 'compact'") && ingest.includes("meta: { status: 'closed' }"));
});

test('in Turkish: the compact event, the scratchpad note, the home folder, a built-in agent; anything else as it is', () => {
  try {
    setLanguage('tr');
    const S = STRINGS.tr;
    assert.equal(eventText({ kind: 'compact', text: 'Context compacted (/compact)' }), S.evCompacted);
    assert.equal(projectDescription('Only seen in temporary (scratchpad) folders; the real folder is not known yet.'), S.evProjectScratch);
    assert.equal(localProject({ id: 'h', name: 'Home folder', broad: true }).name, 'Ana klasör');
    assert.equal(localProject({ id: 'p', name: 'Oyun' }).name, 'Oyun');
    assert.equal(itemDescription(BUILTIN_AGENTS.Explore), S.evBuiltin_Explore);
    assert.equal(itemDescription('A skill of my own.'), 'A skill of my own.');
    for (const name of Object.keys(BUILTIN_AGENTS)) for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang][`evBuiltin_${name}`], `${lang} ${name}`);
  } finally {
    setLanguage('en');
  }
});
