// The project drawer as a dialog (review U02): where Tab goes while it is open (views/drawer.js drawerTabTarget)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerTabTarget } from '../public/js/views/drawer.js';

test('inside the open drawer Tab and Shift+Tab go round; in the middle the browser moves', () => {
  assert.equal(drawerTabTarget({ inside: true, atLast: true }), 'first');
  assert.equal(drawerTabTarget({ inside: true, shift: true, atFirst: true }), 'last');
  assert.equal(drawerTabTarget({ inside: true }), null);
  assert.equal(drawerTabTarget({ inside: true, shift: true }), null);
  // One focusable element: it is first and last, Tab stays on it either way
  assert.equal(drawerTabTarget({ inside: true, atFirst: true, atLast: true }), 'first');
  assert.equal(drawerTabTarget({ inside: true, shift: true, atFirst: true, atLast: true }), 'last');
});

test('focus that fell to the page body after a redraw comes back into the drawer', () => {
  assert.equal(drawerTabTarget({ onBody: true }), 'first');
  assert.equal(drawerTabTarget({ onBody: true, shift: true }), 'last');
});

test('the terminal dock over the open drawer keeps its own Tab and Shift+Tab (completion, Claude Code mode switch); so do the notices (review round 2)', () => {
  // Focus in the terminal or on a notice: outside the drawer, not on the body
  assert.equal(drawerTabTarget({ inside: false }), null);
  assert.equal(drawerTabTarget({ inside: false, shift: true }), null);
});
