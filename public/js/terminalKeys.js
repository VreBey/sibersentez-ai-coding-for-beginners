// @ts-check
// Copy and paste in the embedded terminal, as in Windows Terminal (reported 2026-10-09: Ctrl+C and Ctrl+V did nothing
// of the kind). xterm.js sends every Ctrl key to the program and cancels the browser's own action, so neither copy nor
// paste ever happened. These keys are left to the browser instead: its copy hands xterm's selection to the clipboard
// and its paste sends the text to the program (bracketed when the program asked for that); the page never reads the
// clipboard itself (that permission stays denied). Ctrl+C with nothing selected is still the program's interrupt.
//   copy   Ctrl+C with a selection, Ctrl+Shift+C, Ctrl+Insert with a selection
//   paste  Ctrl+V, Ctrl+Shift+V, Shift+Insert
//   terminal  everything else: to the program, as before
// The letter the key types decides (Turkish F puts c where Q-layouts have v: review 2026-10-09); the key's place (code)
// only when it types no Latin letter at all (a Cyrillic or Greek layout)
const isKey = (e, letter, code) => {
  const k = String(e.key || '').toLowerCase();
  return /^[a-z]$/.test(k) ? k === letter : e.code === code;
};

export function terminalKeyAction(e, hasSelection = false) {
  if (!e || e.type !== 'keydown' || e.altKey || e.metaKey) return 'terminal';
  if (e.ctrlKey && isKey(e, 'c', 'KeyC') && (e.shiftKey || hasSelection)) return 'copy';
  if (e.ctrlKey && isKey(e, 'v', 'KeyV')) return 'paste';
  if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey && hasSelection) return 'copy';
  if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey) return 'paste';
  return 'terminal';
}

// For term.attachCustomKeyEventHandler: true lets xterm send the key to the program; false leaves it to the browser.
// After a copy the selection is cleared (on the next turn, once the browser has copied it), so the next Ctrl+C
// interrupts again.
export function terminalKeyHandler(term, later = (fn) => setTimeout(fn, 0)) {
  return (e) => {
    const action = terminalKeyAction(e, term.hasSelection());
    if (action === 'terminal') return true;
    if (action === 'copy') later(() => term.clearSelection());
    return false;
  };
}
