// Plan D5: what the page does on a timer only for the person's eyes waits while the window is hidden, and runs once
// when it shows again (public/js/whileVisible.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { whileVisible, everyVisible } from '../public/js/whileVisible.js';

function fakeDoc() {
  const listeners = new Set();
  return {
    hidden: false,
    addEventListener: (type, fn) => type === 'visibilitychange' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'visibilitychange' && listeners.delete(fn),
    set(hidden) {
      this.hidden = hidden;
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
}

test('while visible it runs at once; hidden runs are only marked and happen once when the window shows', () => {
  const doc = fakeDoc();
  const calls = [];
  const run = whileVisible((x) => calls.push(x), { doc });
  run('a');
  assert.deepEqual(calls, ['a']);
  doc.set(true);
  run('b');
  run('c');
  assert.deepEqual(calls, ['a'], 'nothing while hidden');
  assert.equal(run.missed(), true);
  doc.set(false);
  assert.deepEqual(calls, ['a', undefined], 'one catch-up run, however many were skipped');
  doc.set(true);
  doc.set(false);
  assert.equal(calls.length, 2, 'showing again without a skipped run does nothing');
  run.stop();
  assert.equal(doc.listeners.size, 0);
});

test('everyVisible: an interval through it, and one call stops both', () => {
  const doc = fakeDoc();
  let tick = null;
  let cleared = null;
  const timers = { setInterval: (fn, ms) => ((tick = fn), assert.equal(ms, 5000), 7), clearInterval: (id) => (cleared = id) };
  let n = 0;
  const stop = everyVisible(() => n++, 5000, { doc, timers });
  tick();
  doc.set(true);
  tick();
  tick();
  assert.equal(n, 1);
  doc.set(false);
  assert.equal(n, 2);
  stop();
  assert.equal(cleared, 7);
  assert.equal(doc.listeners.size, 0);
});

test('the clock, the relative times, the screens, the drawer and the tools wizard go through it; notifications do not', () => {
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /everyVisible\(tickClock, 1000\)/);
  assert.match(main, /everyVisible\(\(\) => fillAgo\(document\), 5000\)/);
  assert.match(main, /if \(document\.hidden\) return drawWhenShown\(\);/);
  // The only plain interval left is the guided tour's, which runs while the person watches it
  assert.deepEqual(main.match(/setInterval\(/g), ['setInterval('], 'one plain interval in main.js');
  assert.match(main, /tourTimer = setInterval\(/);
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.match(drawer, /everyVisible\(\(\) => \{\n\s+if \(current\?\.type === 'project'\) render\(\);/);
  const tools = fs.readFileSync(new URL('../public/js/views/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /poll = everyVisible\(/);
  const notify = fs.readFileSync(new URL('../public/js/notify.js', import.meta.url), 'utf8');
  assert.match(notify, /setInterval\(\(\) => store\.loaded && checkLimits\(\), 30000\)/, 'the limit check runs while hidden too');
});
