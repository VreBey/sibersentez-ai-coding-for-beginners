// A stand-in for xterm.js in the DOM tests (test/dom/env.mjs maps /vendor/xterm/*.mjs here): the parts of its API
// public/js/terminalDock.js uses, with a way to type into it and to select text. Nothing is drawn.
export class Terminal {
  static all = [];
  constructor(options = {}) {
    this.options = { ...options };
    this.cols = 80;
    this.rows = 24;
    this.written = '';
    this.selection = '';
    this.dataFns = [];
    this.keyHandler = null;
    this.disposed = false;
    Terminal.all.push(this);
  }
  loadAddon(addon) {
    addon.activate?.(this);
  }
  open(el) {
    this.element = el;
    const ta = el.ownerDocument.createElement('textarea');
    ta.className = 'xterm-helper-textarea';
    el.append(ta);
    this.textarea = ta;
  }
  write(text) {
    this.written += text;
  }
  onData(fn) {
    this.dataFns.push(fn);
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(fn) {
    this.keyHandler = fn;
  }
  hasSelection() {
    return this.selection.length > 0;
  }
  getSelection() {
    return this.selection;
  }
  clearSelection() {
    this.selection = '';
  }
  focus() {
    this.focused = true;
  }
  dispose() {
    this.disposed = true;
  }
  // Test helpers: what the person types, and a key as xterm would first offer it to the page's handler
  type(text) {
    for (const fn of this.dataFns) fn(text);
  }
  key(e) {
    return this.keyHandler ? this.keyHandler(e) : true;
  }
}

export class FitAddon {
  activate() {}
  fit() {}
}
