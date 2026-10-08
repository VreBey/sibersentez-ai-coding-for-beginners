// The AI's permission mode in plain words (public/js/permMode.js, server/ingest.mjs `user`): Claude Code writes
// permissionMode on every line the person writes; the newest one is kept on the lead session and shown as a chip.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Ingest } from '../server/ingest.mjs';
import { sessionView } from '../server/views.mjs';
import { permModeWords, permModeChip, permModeLine } from '../public/js/permMode.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
setLanguage('en');
const fakeCatalog = () => ({ resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() });
const userLine = (text, permissionMode, t) => ({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content: text }, timestamp: t, permissionMode, cwd: 'C:\\p1' });
function feed(ing, ctx, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  ing.line(ctx, {}, buf, 0, buf.length);
}

test('ingest: the newest line\'s mode is kept on the lead; an older line or an odd value does not replace it', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, userLine('Plan it', 'plan', '2026-10-02T09:00:00Z'));
  assert.equal(s.permissionMode, 'plan');
  feed(ing, s, userLine('Go', 'acceptEdits', '2026-10-02T09:10:00Z'));
  assert.equal(s.permissionMode, 'acceptEdits');
  feed(ing, s, userLine('old', 'default', '2026-10-02T08:00:00Z'));
  assert.equal(s.permissionMode, 'acceptEdits', 'an older line');
  feed(ing, s, userLine('odd', 'x<script>', '2026-10-02T09:20:00Z'));
  assert.equal(s.permissionMode, 'acceptEdits', 'not a plain word');
  assert.equal(sessionView(ing, s).permissionMode, 'acceptEdits', 'the page gets it');
});

test('ingest: a mode the tool changes itself (its own "permission-mode" line, as Claude Code 2.1.29x writes after the plan is approved) is kept until the person\'s next line', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, { type: 'permission-mode', permissionMode: 'plan', sessionId: 's1' });
  feed(ing, s, userLine('Plan it', 'plan', '2026-10-02T09:00:00Z'));
  assert.equal(s.permissionMode, 'plan');
  feed(ing, s, { type: 'permission-mode', permissionMode: 'default', sessionId: 's1' });
  assert.equal(s.permissionMode, 'default', 'the plan approved in the terminal');
  feed(ing, s, { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: 's1' });
  assert.equal(sessionView(ing, s).permissionMode, 'acceptEdits', 'then "accept edits" chosen: the page gets it');
  feed(ing, s, { type: 'permission-mode', permissionMode: 'x<script>', sessionId: 's1' });
  assert.equal(s.permissionMode, 'acceptEdits', 'not a plain word');
  feed(ing, s, userLine('Go on', 'auto', '2026-10-02T09:30:00Z'));
  assert.equal(s.permissionMode, 'auto', 'the person\'s next line decides again');
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, 'C:\\none\\agent-a1.jsonl');
  feed(ing, ag, { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's1' });
  assert.ok(!ag.permissionMode, 'only the lead');
});

test('the page: every mode Claude Code writes has words in both languages and a tone; unknown says nothing', () => {
  const tones = { plan: 'ok', default: 'ok', dontAsk: 'ok', acceptEdits: 'warn', auto: 'warn', bypassPermissions: 'stop' };
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    for (const [m, tone] of Object.entries(tones)) {
      const w = permModeWords(m);
      assert.equal(w.label, STRINGS[lang][`pm_${m}`], `${lang} ${m}`);
      assert.ok(w.hint && w.tone === tone, `${lang} ${m}`);
    }
  }
  setLanguage('en');
  assert.equal(permModeWords('nonsense'), null);
  assert.equal(permModeWords('toString'), null, 'not a property of every object');
  assert.equal(permModeChip(null), '');
  assert.match(permModeChip('bypassPermissions'), /class="perm-chip stop" title="[^"]+">Asks nothing<\/span>/);
});

test('a project\'s drawer line: the mode of its newest open session only', () => {
  const s = (id, projectId, live, lastAt, permissionMode) => ({ id, projectId, live, lastAt, permissionMode });
  const list = [s('a', 'p', { status: 'idle' }, 1, 'plan'), s('b', 'p', { status: 'busy' }, 5, 'auto'), s('c', 'p', null, 9, 'bypassPermissions'), s('d', 'q', { status: 'busy' }, 9, 'default')];
  const line = permModeLine(list, 'p');
  assert.ok(line.includes(STRINGS.en.pm_auto) && line.includes('warn'), 'the newest open one, not the closed one');
  assert.equal(permModeLine(list, 'none'), '');
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const drawer = read('public/js/views/drawer.js');
  assert.ok(drawer.includes('${permModeLine(store.sessions.values(), p.id)}') && drawer.includes('${permModeChip(d.permissionMode)}'));
  assert.ok(read('public/js/views/workshop.js').includes("a.kind === 'session' ? permModeChip(a.data?.permissionMode, 'ws-chip perm-chip') : ''"));
});
