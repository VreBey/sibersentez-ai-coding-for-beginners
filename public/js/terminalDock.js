// The terminal dock (docs/embedded-terminal.md): terminals inside the SiberSentez window, one tab per terminal, at the
// bottom of the page. Only in the SiberSentez window: its preload gives window.sibersentezTerminal (ids, keystrokes, sizes);
// a plain browser has none, and the menus keep opening Windows Terminal there. The screen is xterm.js, served by our
// own server from /vendor/xterm (the page's CSP allows scripts from 'self' only), loaded on the first terminal.
import { esc, projectColor } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { stripAnsi, detectPrompt, detectError, promptHelpHtml, previewUrlIn } from './promptHelp.js';

// How long the second click that stops a running AI is waited for (askClose)
export const CLOSE_CONFIRM_MS = 4000;

const HEIGHT_KEY = 'sibersentez.dockHeight';
const MIN_H = 160;
const CHEVRON = '<svg class="ic td-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const THEME = { background: '#0b0d14', foreground: '#dfe3ec', cursor: '#8ab4ff', selectionBackground: 'rgba(138,180,255,0.3)' };

export const dockAvailable = () => typeof globalThis.sibersentezTerminal?.open === 'function';

// QA only (main.js ?qa=1&dock=demo): the bridge's shape with a fake terminal that prints a prompt and echoes.
// ask: text printed after the welcome (?qa=1&dock=ask: a Claude Code command question, for the prompt helper);
// ai: the terminal plays an AI tool's (no plain-shell label)
export function qaTerminalBridge(ask = '', { ai = false } = {}) {
  let onData = () => {};
  let n = 0;
  const prompt = 'PS C:\\Projects\\demo> ';
  return {
    open: async (target) => {
      const id = `t${++n}`;
      setTimeout(() => onData(id, `Windows PowerShell\r\n\x1b[32mSiberSentez QA\x1b[0m: a stand-in terminal (nothing runs)\r\n\r\n${ask || prompt}`), 50);
      return { ok: true, id, title: target?.projectId || 'demo', projectId: target?.projectId || null, ai };
    },
    write: (id, d) => onData(id, d === '\r' ? `\r\n${prompt}` : d),
    resize: () => {},
    close: async () => true,
    list: async () => [],
    onData: (fn) => (onData = fn),
    onExit: () => {},
  };
}

// Why a terminal did not open, in words (the shell's and the server's reasons)
export function openFailText(reason) {
  const k = { preview: 'dockPreview', off: 'dockOff', refused: 'dockRefused', 'too-many': 'dockTooMany', 'no-pty': 'dockNoPty', invalid: 'dockRefused' }[reason] || 'dockFailed';
  return t(k);
}

let xtermLib = null;
async function loadXterm() {
  if (!xtermLib) {
    xtermLib = Promise.all([import('/vendor/xterm/xterm.mjs'), import('/vendor/xterm/addon-fit.mjs')]).then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }));
    if (!document.querySelector('link[data-xterm]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/vendor/xterm/xterm.css';
      l.dataset.xterm = '';
      document.head.append(l);
    }
  }
  return xtermLib;
}

// toast({ tone, title, body }) for what did not work; root: where the dock goes (document.body)
// onSetupDone(): a command the person ran in the setup terminal finished (its shell is back at an empty prompt): the
// tools are checked again (main.js), so a tool just installed shows up by itself
// resumeFor(projectId): the Claude Code session an AI tab of that project just ran (null: none, or another tool);
// onResume(session): it goes on where it stopped (the session menu's own resume)
export function createTerminalDock({ toast = () => {}, root = document.body, onSetupDone = () => {}, resumeFor = () => null, onResume = () => {} } = {}) {
  const api = globalThis.sibersentezTerminal;
  if (!api) return { available: false, open: async () => ({ ok: false, reason: 'no-bridge' }), showProject: () => false, count: () => 0 };
  const tabs = new Map(); // id -> { term, fit, el, tabEl, title, projectId, ended, unread }
  let active = null;
  let collapsed = false;

  const dock = document.createElement('section');
  dock.className = 'term-dock';
  dock.hidden = true;
  dock.setAttribute('aria-label', t('dockLabel'));
  dock.innerHTML = `<div class="td-grip" role="separator" aria-orientation="horizontal" aria-label="${esc(t('dockResize'))}" tabindex="0"></div>
    <div class="td-bar"><div class="td-tabs" role="tablist" aria-label="${esc(t('dockTabs'))}"></div>
    <span class="td-kind" hidden></span>
    <button type="button" class="icon-btn td-fold" data-td="fold" aria-expanded="true" title="${esc(t('dockFold'))}" aria-label="${esc(t('dockFold'))}">${CHEVRON}</button></div>
    <div class="td-body"></div>`;
  root.append(dock);
  const tabsEl = dock.querySelector('.td-tabs');
  const kindEl = dock.querySelector('.td-kind');
  const body = dock.querySelector('.td-body');
  let height = MIN_H * 2;
  try {
    height = Math.max(MIN_H, Number(globalThis.localStorage?.getItem(HEIGHT_KEY)) || height);
  } catch {
    // storage blocked: the default height
  }
  const applyHeight = () => {
    const h = Math.min(Math.max(MIN_H, height), Math.round(innerHeight * 0.8));
    dock.style.setProperty('--td-h', `${h}px`);
    document.documentElement.style.setProperty('--dock-space', dock.hidden ? '0px' : collapsed ? '38px' : `${h}px`);
  };

  function show() {
    dock.hidden = !tabs.size;
    applyHeight();
  }

  function select(id) {
    active = id;
    for (const [k, x] of tabs) {
      const on = k === id;
      x.el.hidden = !on;
      x.tabEl.classList.toggle('on', on);
      x.tabEl.setAttribute('aria-selected', String(on));
      x.tabEl.tabIndex = on ? 0 : -1;
      if (on) x.unread = false;
      x.tabEl.classList.toggle('unread', !!x.unread);
    }
    const x = tabs.get(id);
    // A plain shell says so: a sentence typed into it runs as a command (the AI has a tab of its own)
    kindEl.hidden = !x || x.ai;
    kindEl.textContent = x && !x.ai ? t('dockPlain') : '';
    if (x && !collapsed) requestAnimationFrame(() => {
      fitOne(id);
      x.term.focus();
    });
  }

  function fitOne(id) {
    const x = tabs.get(id);
    if (!x || x.el.hidden || collapsed) return;
    try {
      x.fit.fit();
    } catch {
      return;
    }
    if (!x.ended) api.resize(id, x.term.cols, x.term.rows);
  }

  async function addTab(info, buffer = '') {
    const { Terminal, FitAddon } = await loadXterm();
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace', fontSize: 13, cursorBlink: true, theme: THEME, scrollback: 5000, allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const el = document.createElement('div');
    el.className = 'td-pane';
    el.setAttribute('role', 'tabpanel');
    el.hidden = true;
    body.append(el);
    term.open(el);
    if (buffer) term.write(buffer);
    term.onData((d) => {
      if (x.ended) return;
      api.write(info.id, d);
      // Enter in the setup terminal: a command runs; its end is looked for in the output
      if (x.setup && d.includes('\r')) x.ranCommand = true;
      // The person answered: the note goes, and the same question is not explained again
      if (x.help) {
        x.answered = x.help.sig;
        showHelp(x, null);
      }
    });
    // "What the AI asks" (promptHelp.js): a note over the terminal's top right, only explaining
    const helpEl = document.createElement('aside');
    helpEl.className = 'ph-box';
    helpEl.hidden = true;
    helpEl.setAttribute('role', 'note');
    helpEl.setAttribute('aria-label', t('phLabel'));
    helpEl.addEventListener('click', (e) => {
      // A fix command of a known error: copied, never typed into the terminal
      const cp = e.target.closest('[data-ai-copy]');
      if (cp) {
        const label = cp.querySelector('span');
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(cp.parentElement.querySelector('code')?.textContent || ''))
          .then(
            () => {
              if (label) label.textContent = t('aiCopied');
              setTimeout(() => label && (label.textContent = t('aiCopy')), 1500);
            },
            () => label && (label.textContent = t('aiCopyFailed')),
          );
        return;
      }
      if (!e.target.closest('[data-ph="close"]')) return;
      x.answered = x.help?.sig || x.answered;
      showHelp(x, null);
      x.term.focus();
    });
    el.append(helpEl);
    // The dev server's address, when one was printed (previewUrlIn): opened in the default browser by the shell's
    // link rule (http only, never inside SiberSentez's window)
    const previewEl = document.createElement('a');
    previewEl.className = 'td-preview act-btn primary';
    previewEl.target = '_blank';
    previewEl.rel = 'noopener noreferrer';
    previewEl.hidden = true;
    previewEl.innerHTML = `${icon('play')}<span></span>`;
    el.append(previewEl);
    const tabEl = document.createElement('button');
    tabEl.type = 'button';
    tabEl.className = 'td-tab';
    tabEl.setAttribute('role', 'tab');
    tabEl.dataset.term = info.id;
    tabEl.style.setProperty('--c', info.projectId ? projectColor(info.projectId) : '#8a93a6');
    tabEl.innerHTML = `<i class="td-dot"></i><span class="td-name">${esc(info.title || t('dockTerminal'))}</span><span class="td-x" data-td="close" role="button" aria-label="${esc(t('dockClose'))}" title="${esc(t('dockClose'))}">${icon('close')}</span>`;
    tabsEl.append(tabEl);
    const x = { term, fit, el, tabEl, title: info.title, projectId: info.projectId, ai: info.ai === true, ended: false, unread: false, helpEl, previewEl, preview: null, plain: stripAnsi(buffer).slice(-4000), help: null, answered: '', helpTimer: 0 };
    tabs.set(info.id, x);
    // A list() snapshot already holds what was said before it; for a new terminal the early output goes in now
    if (early.has(info.id)) {
      if (!buffer) {
        const text = early.get(info.id);
        term.write(text);
        // The shell's prompt may be in it: the plain text knows it too (typeInto waits for a prompt)
        x.plain = (x.plain + stripAnsi(text)).slice(-4000);
        x.lastData = Date.now();
      }
      early.delete(info.id);
    }
    show();
    select(info.id);
    if (earlyEnd.has(info.id)) {
      ended(info.id, earlyEnd.get(info.id));
      earlyEnd.delete(info.id);
    }
    return x;
  }

  // The note for what the tool asks now, else for a known error in the last lines; one already answered (or hidden)
  // stays quiet
  function checkHelp(x) {
    const hit = (!x.ended && detectPrompt(x.plain.slice(-2500))) || detectError(x.plain);
    showHelp(x, hit && hit.sig !== x.answered ? hit : null);
    showPreview(x, x.ended ? null : previewUrlIn(x.plain.slice(-2500), ownPort()));
  }
  // A local address a dev server printed (npm run dev, vite, python -m http.server): one link opens it in the browser,
  // as Claude Code Desktop shows the result beside its chat (2026-10-02). Gone once the terminal ended.
  const ownPort = () => Number(globalThis.location?.port) || 0;
  function showPreview(x, url) {
    if ((x.preview || '') === (url || '')) return;
    x.preview = url;
    x.previewEl.hidden = !url;
    if (!url) return;
    x.previewEl.href = url;
    x.previewEl.querySelector('span').textContent = t('dockOpenDev', { where: url.replace(/^https?:\/\//, '').replace(/\/$/, '') });
  }
  function showHelp(x, hit) {
    if ((x.help?.sig || '') === (hit?.sig || '') && !!x.help === !!hit) return;
    x.help = hit;
    // The tab says the tool asks, so a question in a tab behind (or a folded dock) is not missed
    const asks = !!hit && hit.id !== 'error';
    x.tabEl.classList.toggle('asks', asks);
    x.tabEl.title = asks ? t('dockAsks', { name: x.title || t('dockTerminal') }) : '';
    x.helpEl.hidden = !hit;
    x.helpEl.innerHTML = promptHelpHtml(hit);
  }

  function ended(id, code) {
    const x = tabs.get(id);
    if (!x || x.ended) return;
    x.ended = true;
    x.tabEl.classList.add('ended');
    // A question of the tool that ended is gone; a known error it printed stays explained
    checkHelp(x);
    x.term.write(`\r\n\x1b[90m${t('dockEnded', { code: code == null ? '—' : code })}\x1b[0m\r\n`);
    // An AI that ended by itself (/exit, a crash): its session can go on where it stopped, at a click
    const s = x.ai ? resumeFor(x.projectId) : null;
    if (s) showResume(x, s);
  }
  function showResume(x, s) {
    const bar = document.createElement('div');
    bar.className = 'td-resume';
    bar.setAttribute('role', 'note');
    const text = document.createElement('span');
    text.textContent = t('dockResumeText');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'act-btn';
    go.textContent = t('dockResume');
    go.addEventListener('click', () => {
      bar.remove();
      onResume(s);
    });
    bar.append(text, go);
    x.el.append(bar);
  }

  // Closing a tab ends what runs in it. A running AI stops with it (seen 2026-10-01: a job's terminal was closed and the
  // job ended half-way): its first close asks once, a second within CLOSE_CONFIRM_MS closes. A plain shell or an ended AI
  // closes at once.
  function askClose(id) {
    const x = tabs.get(id);
    if (!x) return;
    if (!x.ai || x.ended || x.confirmUntil > Date.now()) return void closeTab(id);
    x.confirmUntil = Date.now() + CLOSE_CONFIRM_MS;
    const name = x.tabEl.querySelector('.td-name');
    const close = x.tabEl.querySelector('.td-x');
    name.textContent = t('dockCloseAi');
    close.title = t('dockCloseAi');
    close.setAttribute('aria-label', t('dockCloseAi'));
    x.tabEl.classList.add('confirm');
    setTimeout(() => {
      if (!tabs.has(id) || x.confirmUntil > Date.now()) return;
      x.confirmUntil = 0;
      name.textContent = x.title || t('dockTerminal');
      close.title = t('dockClose');
      close.setAttribute('aria-label', t('dockClose'));
      x.tabEl.classList.remove('confirm');
    }, CLOSE_CONFIRM_MS + 50);
  }

  async function closeTab(id) {
    const x = tabs.get(id);
    if (!x) return;
    if (!x.ended) await api.close(id);
    tabs.delete(id);
    // Output or an exit that arrives after the tab closed is dropped, never kept for a tab that will not come back
    gone.add(id);
    early.delete(id);
    earlyEnd.delete(id);
    x.term.dispose();
    x.el.remove();
    x.tabEl.remove();
    if (active === id) select([...tabs.keys()].at(-1) || null);
    show();
  }

  // Output that arrives before its tab exists (the screen library still loading) waits here, then goes in first
  const early = new Map(); // id -> text
  const earlyEnd = new Map(); // id -> exit code
  const gone = new Set(); // ids of tabs the person closed
  api.onData((id, text) => {
    const x = tabs.get(id);
    if (!x) {
      if (gone.has(id)) return;
      if (typeof id === 'string' && early.size < 16) early.set(id, ((early.get(id) || '') + text).slice(-256 * 1024));
      return;
    }
    x.term.write(text);
    x.lastData = Date.now();
    // Keep the plain text of the last lines and look for a question once the output settles
    x.plain = (x.plain + stripAnsi(text)).slice(-4000);
    clearTimeout(x.helpTimer);
    x.helpTimer = setTimeout(() => {
      checkHelp(x);
      // The setup terminal's command ended: its shell waits at an empty prompt again
      if (x.setup && x.ranCommand && atPrompt(x)) {
        x.ranCommand = false;
        try {
          onSetupDone();
        } catch (err) {
          console.error(err);
        }
      }
    }, 250);
    if (id !== active || collapsed) {
      x.unread = true;
      x.tabEl.classList.add('unread');
    }
  });
  api.onExit((id, code) => (tabs.has(id) ? ended(id, code) : gone.has(id) ? undefined : earlyEnd.set(id, code)));

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.td-tab');
    if (!tab) return;
    if (e.target.closest('[data-td="close"]')) return void askClose(tab.dataset.term);
    if (collapsed) fold(false);
    select(tab.dataset.term);
  });
  // Tabs by keyboard: arrows move, Delete closes
  tabsEl.addEventListener('keydown', (e) => {
    const ids = [...tabs.keys()];
    const i = ids.indexOf(active);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      select(next);
      tabs.get(next)?.tabEl.focus();
    } else if (e.key === 'Delete' && active) askClose(active);
  });
  function fold(on) {
    collapsed = on;
    dock.classList.toggle('folded', on);
    dock.querySelector('.td-fold').setAttribute('aria-expanded', String(!on));
    applyHeight();
    if (!on && active) select(active);
  }
  dock.querySelector('[data-td="fold"]').addEventListener('click', () => fold(!collapsed));

  // Resizing: drag the grip, or arrows on it
  const grip = dock.querySelector('.td-grip');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      height = innerHeight - ev.clientY;
      applyHeight();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      try {
        globalThis.localStorage?.setItem(HEIGHT_KEY, String(Math.round(height)));
      } catch {
        // kept until a reload
      }
      fitOne(active);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
  });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    height += e.key === 'ArrowUp' ? 40 : -40;
    applyHeight();
    fitOne(active);
  });
  new ResizeObserver(() => fitOne(active)).observe(body);
  addEventListener('resize', applyHeight);

  // Opens a terminal in a project's (or a session's) folder; the answer says why not
  async function open(target) {
    const size = { cols: 100, rows: 24 };
    const r = await api.open(target, size.cols, size.rows);
    if (!r?.ok) {
      toast({ tone: r?.reason === 'preview' ? 'info' : 'err', title: t('dockNotOpened'), body: openFailText(r?.reason) });
      return r || { ok: false };
    }
    if (collapsed) fold(false);
    await addTab(r);
    return r;
  }

  // Types a command into a plain terminal of the project and never presses Enter (docs/run-hint.md): the person reads
  // it and runs it. A tab this opened before is used again only while its shell waits at an empty prompt (not while
  // a program it started runs, an AI tool the person started in it, or a command typed and not run yet); otherwise a
  // new one opens. A tab an AI tool was started in is never used. The text is one line of printable ASCII.
  const typedTabs = new Map(); // "p:<projectId>" or "setup" -> id of the tab opened for typing
  const typing = new Map(); // the same key -> the call in progress (two quick clicks share one tab)
  // An empty prompt of PowerShell or Command Prompt at the very end of the output
  const AT_PROMPT_RE = /(?:^|\n)(?:PS [^\n]*|[A-Za-z]:\\[^\n]*)> ?$/;
  const atPrompt = (x) => AT_PROMPT_RE.test(x.plain.replace(/[ \t]+$/, ' '));
  const quiet = (x) => Date.now() - (x.lastData || 0) > 400;
  function typeInto(projectId, text) {
    if (typeof projectId !== 'string') return Promise.resolve({ ok: false, reason: 'bad-text' });
    return typeQueued(`p:${projectId}`, { projectId }, text);
  }
  // The setup terminal (docs/embedded-terminal.md): an install command from the tools panel, in a plain shell of the
  // user's home folder; the same rules (one line, no Enter, a tab of its own reused only at an empty prompt)
  function typeSetup(text) {
    return typeQueued('setup', { setup: true }, text);
  }
  function typeQueued(key, target, text) {
    if (typeof text !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(text)) return Promise.resolve({ ok: false, reason: 'bad-text' });
    // One call at a time per terminal; a call that failed does not stop the next one (review round 2)
    const before = typing.get(key) || Promise.resolve();
    const run = before.then(() => typeNow(key, target, text));
    const done = run.catch(() => {}).finally(() => typing.get(key) === done && typing.delete(key));
    typing.set(key, done);
    return run;
  }
  async function typeNow(key, target, text) {
    let id = typedTabs.get(key);
    const old = tabs.get(id);
    if (!old || old.ended || !(atPrompt(old) && quiet(old))) {
      const r = await open(target);
      if (!r?.ok) return r || { ok: false };
      id = r.id;
      typedTabs.set(key, id);
      if (key === 'setup' && tabs.get(id)) tabs.get(id).setup = true;
    }
    const x = tabs.get(id);
    if (!x) return { ok: false, reason: 'no-tab' };
    // The shell is ready once it printed its prompt (or anything, for another shell) and has been quiet; at most 6 s
    for (let i = 0; i < 60 && !x.ended && !((atPrompt(x) || (i >= 20 && x.plain.trim())) && quiet(x)); i++) await new Promise((r) => setTimeout(r, 100));
    if (x.ended) return { ok: false, reason: 'ended' };
    if (collapsed) fold(false);
    select(id);
    api.write(id, text);
    return { ok: true, id };
  }

  // A reloaded page gets its running terminals back, with what they showed
  api.list().then(async (list) => {
    for (const info of Array.isArray(list) ? list : []) if (!tabs.has(info.id)) await addTab(info, info.buffer || '');
  });

  // The building's plan and result cards (docs/simplify.md): the newest running AI tab of a project comes forward and
  // takes the keyboard, so the person answers the AI's own question there. Nothing is typed. false: no such tab here
  function showProject(projectId) {
    let id = null;
    for (const [k, x] of tabs) if (x.ai && !x.ended && x.projectId === projectId) id = k;
    if (!id) return false;
    show();
    if (collapsed) fold(false);
    select(id);
    tabs.get(id).term.focus();
    return true;
  }

  return { available: true, open, typeInto, typeSetup, showProject, count: () => tabs.size, isOpen: () => !dock.hidden };
}
