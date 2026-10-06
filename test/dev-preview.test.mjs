// A dev server's address in a terminal (public/js/promptHelp.js previewUrlIn, terminalDock.js showPreview): one link
// opens what the person runs, as Claude Code Desktop shows the result beside its chat (2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { previewUrlIn } from '../public/js/promptHelp.js';
import { STRINGS } from '../public/js/i18n.js';

test('the last local address a dev server printed, normalised; never another computer or SiberSentez itself', () => {
  assert.equal(previewUrlIn('  VITE v6.0.0  ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'), 'http://localhost:5173/');
  assert.equal(previewUrlIn('▲ Next.js 16\n- Local:        http://localhost:3000\n- Network:      http://192.168.1.20:3000'), 'http://localhost:3000/', 'the network address is not this computer');
  assert.equal(previewUrlIn('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), 'http://localhost:8000/', '0.0.0.0 opens as localhost');
  assert.equal(previewUrlIn('Running on http://127.0.0.1:5000'), 'http://127.0.0.1:5000/');
  assert.equal(previewUrlIn('listening on http://[::1]:4321/app.'), 'http://localhost:4321/app');
  assert.equal(previewUrlIn('first http://localhost:3000 then http://localhost:3001'), 'http://localhost:3001/', 'the newest one');
  assert.equal(previewUrlIn('SiberSentez: http://127.0.0.1:4545/', 4545), null, 'never SiberSentez itself');
  assert.equal(previewUrlIn('see https://example.com:8080/x and http://evil.localhost.example:80/'), null, 'another computer');
  assert.equal(previewUrlIn('http://localhost:99999/'), null, 'not a port');
  assert.equal(previewUrlIn('http://localhost:5173/"><img src=x onerror=alert(1)>'), 'http://localhost:5173/', 'the path stops at anything unusual');
  assert.equal(previewUrlIn('javascript:alert(1)//localhost:3000'), null);
  assert.equal(previewUrlIn(''), null);
  assert.equal(previewUrlIn(null), null);
});

test('wiring: the dock shows the link while the terminal lives, as text and href only; words in both languages', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes('showPreview(x, x.ended ? null : previewUrlIn(x.plain.slice(-2500), ownPort()));'));
  assert.ok(dock.includes("previewEl.target = '_blank';") && dock.includes("previewEl.rel = 'noopener noreferrer';") && dock.includes('x.previewEl.href = url;'));
  assert.ok(dock.includes("x.previewEl.querySelector('span').textContent = t('dockOpenDev'"), 'the address goes in as text');
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].dockOpenDev.includes('{where}'), lang);
});

test('a port of six digits is no port: no link with a shortened one (review 2026-10-05)', () => {
  assert.equal(previewUrlIn('http://localhost:123456/'), null);
  assert.equal(previewUrlIn('http://localhost:12345/'), 'http://localhost:12345/');
});
