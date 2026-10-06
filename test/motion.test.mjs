// Motion (docs/motion.md): the tokens exist, reduced motion switches the new motion off, the helpers are safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transitionName, reducedMotion } from '../public/js/motion.js';

const css = fs.readFileSync(new URL('../public/css/motion.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('one set of durations and easings; the page loads it', () => {
  for (const token of ['--dur-fast', '--dur-med', '--dur-slow', '--ease-out', '--ease-in', '--ease-in-out']) assert.match(css, new RegExp(`${token}:`), token);
  assert.ok(html.includes('<link rel="stylesheet" href="/css/motion.css">'));
});

test('reduced motion: every CSS animation and transition off, view transitions too; the script helper says so', () => {
  assert.match(app, /prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*::view-transition-group\(\*\)[\s\S]*animation: none !important/);
  assert.equal(reducedMotion(), false, 'no matchMedia in node: motion is not refused');
});

test('only transform, translate and opacity move in the new motion (no layout properties)', () => {
  const props = [...css.matchAll(/transition:\s*([^;]+);/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+/)[0]));
  for (const p of props) assert.ok(['opacity', 'translate', 'display', 'overlay'].includes(p), p);
  assert.doesNotMatch(css, /@keyframes[^}]*\b(width|height|top|left|margin)\s*:/);
});

test('transition names are short, CSS-safe and stable for any id', () => {
  const a = transitionName('pc', 'x-c-users-someone-desktop-arena.unity');
  assert.match(a, /^pc-[0-9a-z]+$/);
  assert.equal(a, transitionName('pc', 'x-c-users-someone-desktop-arena.unity'));
  assert.notEqual(a, transitionName('pc', 'x-d-projects-arena-unity'));
});
