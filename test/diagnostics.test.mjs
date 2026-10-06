// Diagnostics (public/js/diagnostics.js, GET /api/about): the copied text says versions, Windows, the tools and what
// the setup check found; it never holds a path, a user name or an account, whatever the server sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnosticsText, collectDiagnostics } from '../public/js/diagnostics.js';
import { normalizeTools } from '../public/js/views/tools.js';
import { settingsHtml } from '../public/js/views/settings.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { aboutAnswer } from '../server/app.mjs';

const TOOLS = {
  status: 'ready',
  ...normalizeTools({
    tools: [
      { id: 'claude', installed: true, version: '2.1.284', via: 'native', ready: 'yes', installs: 2, others: [{ via: 'npm', version: '2.1.193' }] },
      { id: 'gemini', installed: true, version: '0.52.0', via: 'npm', ready: 'unknown', onPath: false, pathDir: 'npm' },
      { id: 'codex', installed: false, app: true },
    ],
    node: { installed: true, version: '18.20.0' },
    git: { installed: true, onPath: true },
    env: { anthropicKey: false },
  }),
};

test('/api/about: the app version from package.json, Windows and the runtimes; nothing personal', () => {
  const a = aboutAnswer();
  assert.equal(a.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(Object.keys(a), ['ok', 'version', 'os', 'arch', 'electron', 'node']);
  assert.doesNotMatch(JSON.stringify(a), /[A-Za-z]:\\|Users|@/);
});

test('the text: versions, mode, tools one per line, the setup check by id', () => {
  const text = diagnosticsText({ about: { version: '0.6.5', os: 'Windows 10.0.26200', arch: 'x64', electron: '44.1.0', node: '22.20.0' }, tools: TOOLS, mode: 'live', lang: 'tr', desktop: true, now: Date.UTC(2026, 8, 30) });
  const lines = text.split('\n');
  assert.equal(lines[0], 'SiberSentez 0.6.5 · Windows 10.0.26200 · x64 · Electron 44.1.0 · server Node 22.20.0');
  assert.equal(lines[1], 'Language: tr · Actions: live · desktop app');
  for (const w of ['Node.js: 18.20.0', 'Git: installed', 'ANTHROPIC_API_KEY set: no', '- Claude Code 2.1.284 (native; signed in: yes; 2 installs: npm 2.1.193)', '- Gemini CLI 0.52.0 (npm; signed in: unknown; not on PATH (npm))', '- Codex CLI: not installed (the desktop app is there, the command is not)', 'At: 2026-09-30T00:00:00.000Z']) assert.ok(lines.includes(w), w);
  assert.match(text, /Setup check: .*nodeOld.*notOnPath \(Gemini CLI\).*multiNpm \(Claude Code\)/);
});

test('nothing but versions and fixed words: a path or an address from the server is dropped; no check says so', () => {
  const text = diagnosticsText({ about: { version: 'C:\\Users\\Ayşe\\x', os: '/home/ayse', arch: 'x64', electron: 'a@b.c' }, tools: { status: 'error' } });
  assert.doesNotMatch(text, /Users|Ayşe|home|@/);
  assert.ok(text.startsWith('SiberSentez (version unknown) · x64\n'));
  assert.ok(text.includes('AI tools: not checked'));
});

test('collect: a failing server leaves its part out; tools are checked only when there is no answer yet', async () => {
  let loads = 0;
  const r = await collectDiagnostics({ fetch: async () => { throw new Error('down'); }, toolsState: () => ({ status: 'idle' }), loadTools: async () => (loads++, TOOLS) });
  assert.deepEqual([r.about, r.tools.status, loads], [null, 'ready', 1]);
  const again = await collectDiagnostics({ fetch: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }), toolsState: () => TOOLS, loadTools: async () => (loads++, TOOLS) });
  assert.deepEqual([again.about.version, loads], ['1.0.0', 1]);
});

test('Settings: the diagnostic row in both languages says nothing personal is in it', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = settingsHtml({ lang });
      assert.ok(h.includes('data-set-act="diag"') && h.includes(S.setDiagCopy), lang);
      for (const k of ['setDiagTitle', 'setDiagText', 'setDiagCopied', 'setDiagCopyFailed']) assert.ok(S[k], `${lang} ${k}`);
    }
  } finally {
    setLanguage('en');
  }
});
