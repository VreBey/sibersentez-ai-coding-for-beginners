// The light theme (plan E4, docs/theme.md): theme.css holds both looks with the same names, the colours keep their
// contrast in both, no stylesheet writes a colour by hand (except the dusk scene and the identity hues), the choice
// is kept and applied before the first paint, Settings offers it and the desktop shell's title bar follows it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { settingsHtml } from '../public/js/views/settings.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';
import { THEME_IPC_CHANNEL, THEME_CHOICES as SHELL_THEMES, WINDOW_BACKGROUND, windowOptions } from '../electron/helpers.mjs';

after(() => setLanguage('en'));
setLanguage('en');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const THEME = read('public/css/theme.css');

// name -> value of one block of theme.css
function block(start) {
  const at = THEME.indexOf(start);
  assert.ok(at >= 0, start);
  const body = THEME.slice(THEME.indexOf('{', at) + 1, THEME.indexOf('\n}', at));
  const out = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const DARK = block(':root,\n.dusk {');
const LIGHT = block(':root[data-theme="light"] {');
// Drawn only inside the dusk scene: no light value
const SCENE_ONLY = ['--hq-person-shirt', '--hq-person-hair', '--hq-skin', '--hq-skin-shade', '--hq-metal', '--hq-metal-dark', '--hq-chair-body', '--hq-shoe', '--hq-mark', '--hq-flash'];
// The same in both (shape, type; --left names --quiet, which each element resolves in its own look)
const SHARED = ['--radius', '--radius-sm', '--font', '--display', '--mono', '--left'];

const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('both looks hold the same names; light leaves out only what the dusk scene draws', () => {
  const dark = Object.keys(DARK);
  assert.ok(dark.length >= 85, 'the dark block was read');
  for (const name of dark) {
    if (SCENE_ONLY.includes(name) || SHARED.includes(name)) assert.equal(LIGHT[name], undefined, `${name}: no light value`);
    else assert.ok(LIGHT[name], `${name} has a light value`);
  }
  for (const name of Object.keys(LIGHT)) assert.ok(DARK[name], `${name} is a dark name too`);
  assert.match(THEME, /:root\[data-theme="light"\] \{[\s\S]*?color-scheme: light;/);
});

test('every -rgb channel is its named colour, in both looks', () => {
  for (const [label, t] of [['dark', DARK], ['light', LIGHT]]) {
    for (const name of Object.keys(t).filter((n) => n.endsWith('-rgb') && !['--tint-rgb', '--shade-rgb'].includes(n))) {
      const named = t[name.slice(0, -4)];
      assert.deepEqual(t[name].split(',').map((v) => Number(v.trim())), rgbOf(named), `${label} ${name} = ${named}`);
    }
  }
});

test('contrast (WCAG AA): text 4.5:1 on every surface, the meanings 3:1 (4.5:1 in light, where they are text too)', () => {
  const surfaces = ['--bg', '--panel', '--card', '--panel-low', '--raised', '--side-bg', '--panel-2'];
  for (const [label, t, meaningMin] of [['dark', DARK, 3], ['light', LIGHT, 4.5]]) {
    for (const s of surfaces) for (const fg of ['--text', '--text-2', '--muted']) assert.ok(ratio(t[fg], t[s]) >= 4.5, `${label} ${fg} on ${s}: ${ratio(t[fg], t[s]).toFixed(2)}`);
    for (const s of ['--bg', '--panel', '--card']) {
      for (const fg of ['--accent', '--busy', '--idle', '--stop', '--gold', '--orange', '--pink', '--teal', '--waiting', '--commit', '--quiet']) {
        assert.ok(ratio(t[fg], t[s]) >= meaningMin, `${label} ${fg} on ${s}: ${ratio(t[fg], t[s]).toFixed(2)}`);
      }
      for (const fg of ['--accent-ink', '--stop-ink', '--busy-ink', '--idle-ink', '--warn-ink', '--prompt-ink', '--text-strong']) assert.ok(ratio(t[fg], t[s]) >= 4.5, `${label} ${fg} on ${s}`);
    }
    assert.ok(ratio(t['--on-accent'], t['--accent']) >= (label === 'light' ? 4.5 : 4.5), `${label} text on the accent fill`);
    assert.ok(ratio(t['--hq-text'], t['--hq-surface']) >= 4.5 && ratio(t['--hq-soft'], t['--hq-surface']) >= 4.5 && ratio(t['--hq-gold'], t['--hq-surface']) >= 4.5, `${label} the workshop's frame`);
  }
});

// Every leaf rule of a stylesheet, with the selector it sits under (inside @media and @supports too)
function leafRules(css) {
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      stack.push({ sel: css.slice(start, i).trim(), at: i + 1, leaf: true });
      if (stack.length > 1) stack[stack.length - 2].leaf = false;
      start = i + 1;
    } else if (css[i] === '}') {
      const top = stack.pop();
      if (top?.leaf) out.push({ sel: top.sel, body: css.slice(top.at, i) });
      start = i + 1;
    }
  }
  return out;
}
const mixOf = (a, b, p) => {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return '#' + x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('');
};
const SHEETS = fs.readdirSync(new URL('../public/css/', import.meta.url)).filter((n) => n.endsWith('.css'));
const sheetRules = (f) => leafRules(read(`public/css/${f}`).replace(/\/\*[\s\S]*?\*\//g, ''));

test('no stylesheet writes a colour by hand: only theme.css, the dusk scene and the identity hues', () => {
  const NAMES = 'white|black|red|green|blue|navy|gr[ae]y|orange|yellow|purple|pink|silver|teal|maroon|olive|lime|aqua|fuchsia|gold|brown|cyan|magenta';
  const COLOUR = new RegExp(`#[0-9a-f]{3,8}(?![-\\w])|rgba?\\(\\s*\\d|hsla?\\(|(?<![-\\w])(${NAMES})(?![-\\w])`, 'i');
  // Always dark (an evening window in both looks): the old stage, its controls and clock, the floor bar, the terminal
  const DUSK = /^(\.stage-wrap|\.stage-controls|\.stage-clock|\.floor-bar|\.term-dock|\.td-tab)/;
  const sheets = SHEETS.filter((n) => n !== 'theme.css');
  assert.ok(sheets.length > 15);
  let rules = 0;
  for (const f of sheets) {
    for (const { sel, body } of sheetRules(f)) {
      rules++;
      if (sel.split(',').every((one) => DUSK.test(one.trim()))) continue;
      // A hue (a source's, a kind's, a licence's) is set as --sc/--gc, or mixed per theme: as text with --hue-ink, or
      // as a see-through tint of itself
      const rest = body.replace(/--(sc|gc)\s*:\s*#[0-9a-f]{6}/gi, '').replace(/color-mix\(in srgb, #[0-9a-f]{6} (var\(--hue-ink\), var\(--text\)|([0-9]|1[0-9]|20)%, transparent)\)/gi, '');
      assert.doesNotMatch(rest, COLOUR, `${f}: ${sel} writes a colour; use a theme token`);
    }
  }
  assert.ok(rules > 1000, `the rules inside @media are read too (${rules})`);
  // The page's scripts set no colour in an inline style either (identity hues go through --c, --k, --pc)
  const scripts = (dir) => fs.readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? scripts(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []));
  const js = scripts('public/js');
  assert.ok(js.length > 60);
  for (const f of js) {
    const src = read(f);
    assert.doesNotMatch(src, /style="[^"]*(?<![-\w])(color|background|border-color)\s*:/i, `${f}: an inline colour`);
    assert.doesNotMatch(src, /\.style\.(color|background(Color)?|borderColor)\s*=|setProperty\('(color|background|border-color)'/, `${f}: a colour set on an element`);
  }
});

test('a dusk element sets its own text colour, and no stylesheet but the theme sets a colour variable on :root', () => {
  assert.match(THEME, /\n\.dusk \{\n {2}color: var\(--text\);\n\}/);
  assert.equal(DARK['--left'], 'var(--quiet)', 'declared in the dark block, so a dusk element resolves it with its own grey');
  for (const f of SHEETS.filter((n) => n !== 'theme.css')) {
    for (const { sel, body } of sheetRules(f)) {
      if (sel !== ':root') continue;
      assert.doesNotMatch(body, /var\(--|#[0-9a-f]{3,8}|rgba?\(/i, `${f}: :root holds a colour (it would not reach a dusk element right)`);
    }
  }
  // The building's guide is a dialog over the page: outside the dusk scene
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.indexOf('<div class="ws-guide"') > ws.indexOf('<div class="ws-hint">'), 'after the scene closes');
});

test('the identity hues are mixed for the theme where they are text; every hue keeps 4.5:1 in light', () => {
  const css = SHEETS.map((f) => read(`public/css/${f}`)).join('\n');
  assert.doesNotMatch(css, /[;{]\s*color: var\(--(c|k|pc|sc|gc)\b/, 'a hue as text goes through color-mix with --hue-ink (or --mark-ink)');
  assert.ok((css.match(/var\(--hue-ink\), var\(--text\)\)/g) || []).length >= 10);
  assert.equal(DARK['--hue-ink'], '100%', 'dark: the hue as it was');
  const ink = parseFloat(LIGHT['--hue-ink']) / 100;
  // Every hue the page's code and stylesheets name, as text over a 14% tint of itself
  const src = ['public/js/format.js', 'public/js/toolTags.js', 'public/js/toasts.js', ...SHEETS.map((f) => `public/css/${f}`)].map(read).join('\n');
  const hues = [...new Set([...src.matchAll(/'#([0-9a-f]{6})'|--(?:sc|gc): #([0-9a-f]{6})|color-mix\(in srgb, #([0-9a-f]{6}) var\(--hue-ink/gi)].map((m) => `#${(m[1] || m[2] || m[3]).toLowerCase()}`))];
  assert.ok(hues.length > 30, `the hues were found (${hues.length})`);
  for (const h of hues) {
    for (const s of ['--bg', '--panel']) {
      const r = ratio(mixOf(h, LIGHT['--text'], ink), mixOf(h, LIGHT[s], 0.14));
      assert.ok(r >= 4.5, `light: ${h} as text on ${s}: ${r.toFixed(2)}`);
    }
  }
});

test('light: a meaning colour stays 4.5:1 as text on its own tint, the way the page uses it', () => {
  const t = LIGHT;
  const on = (fg, tint, base, p) => ratio(t[fg], mixOf(t[tint], t[base], p));
  const pairs = [
    ['--accent', '--accent', '--side-bg', 0.07, 'the chosen menu item'],
    ['--accent', '--accent', '--bg', 0.16, 'a chosen chip'],
    ['--accent', '--accent', '--panel', 0.1, 'a note'],
    ['--waiting', '--orange', '--bg', 0.12, 'waiting for you'],
    ['--quiet', '--quiet', '--bg', 0.1, 'left open'],
    ['--stop', '--stop', '--bg', 0.16, 'danger'],
    ['--busy', '--busy', '--bg', 0.12, 'working'],
    ['--idle', '--idle', '--bg', 0.12, 'waits'],
    ['--gold', '--gold', '--bg', 0.12, 'the library'],
  ];
  for (const [fg, tint, base, p, what] of pairs) assert.ok(on(fg, tint, base, p) >= 4.5, `${what}: ${fg} on ${Math.round(p * 100)}% ${tint} over ${base}: ${on(fg, tint, base, p).toFixed(2)}`);
  for (const [ink, tint] of [['--accent-ink', '--accent'], ['--stop-ink', '--stop'], ['--busy-ink', '--busy'], ['--idle-ink', '--idle'], ['--warn-ink', '--gold']]) {
    assert.ok(on(ink, tint, '--bg', 0.2) >= 4.5, `${ink} on a 20% ${tint} tint`);
  }
  // A field's edge is a boundary (WCAG 1.4.11): 3:1 against the card it sits on
  for (const [label, th] of [['light', t], ['dark', DARK]]) {
    for (const s of ['--card', '--field', '--panel']) assert.ok(ratio(th['--field-border'], th[s]) >= 3, `${label} the field border on ${s}: ${ratio(th['--field-border'], th[s]).toFixed(2)}`);
  }
});

test('the scene, the old stage and the terminal are dusk; the building reads its colours from its own canvas', () => {
  assert.ok(read('public/index.html').includes('<div class="stage-wrap dusk" id="stageWrap">'));
  assert.ok(read('public/js/views/workshop.js').includes('<section class="ws-stage dusk" data-ws="stage">'));
  assert.ok(read('public/js/terminalDock.js').includes("dock.className = 'term-dock dusk';"));
  assert.ok(read('public/js/hq-render.js').includes('const style = getComputedStyle(this.cv);'));
});

// A page with storage, a system answer and a root element (theme.js reads them from globalThis)
function fakePage({ stored = null, prefersLight = false } = {}) {
  const store = new Map(stored === null ? [] : [['sibersentez.theme', stored]]);
  const listeners = [];
  const media = { matches: prefersLight, addEventListener: (_e, fn) => listeners.push(fn) };
  const shellCalls = [];
  const g = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    matchMedia: () => media,
    document: { documentElement: { dataset: {} } },
    sibersentezShell: { setTheme: (v) => (shellCalls.push(v), Promise.resolve({ ok: true })) },
  };
  return { g, store, media, listeners, shellCalls };
}
let fresh = 0;
async function themeModuleOn(page) {
  const keys = Object.keys(page.g);
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of keys) Object.defineProperty(globalThis, k, { value: page.g[k], configurable: true, writable: true });
  const mod = await import(`../public/js/theme.js?fresh=${++fresh}`);
  return {
    mod,
    restore() {
      for (const k of keys) {
        if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
        else delete globalThis[k];
      }
    },
  };
}

test('theme.js: dark unless chosen; light; like the system, which it follows; the choice kept and the shell told', async () => {
  const { resolveTheme, THEME_CHOICES } = await import('../public/js/theme.js');
  assert.deepEqual(THEME_CHOICES, ['dark', 'light', 'system']);
  assert.deepEqual(SHELL_THEMES, THEME_CHOICES, 'the shell takes the same choices');
  assert.equal(resolveTheme('light'), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('blue', true), 'dark');

  const page = fakePage({ stored: 'nonsense' });
  const { mod, restore } = await themeModuleOn(page);
  try {
    assert.equal(mod.themeChoice(), 'dark', 'an unknown stored value is the dark theme');
    mod.startTheme();
    assert.equal(page.g.document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(page.shellCalls, ['dark'], 'the shell is told at the start');
    const seen = [];
    mod.onTheme((th) => seen.push(th));
    assert.equal(mod.setThemeChoice('light'), true);
    assert.equal(page.g.document.documentElement.dataset.theme, 'light');
    assert.equal(page.store.get('sibersentez.theme'), 'light');
    assert.equal(mod.setThemeChoice('light'), false, 'the same choice again changes nothing');
    assert.equal(mod.setThemeChoice('sepia'), false);
    mod.setThemeChoice('system');
    assert.equal(page.g.document.documentElement.dataset.theme, 'dark', 'the system answers dark');
    page.media.matches = true;
    for (const fn of page.listeners) fn();
    assert.equal(page.g.document.documentElement.dataset.theme, 'light', 'the system turned light: the page follows');
    mod.setThemeChoice('dark');
    for (const fn of page.listeners) fn();
    assert.equal(page.g.document.documentElement.dataset.theme, 'dark', 'a fixed choice does not follow the system');
    assert.deepEqual(seen, ['light', 'dark', 'light', 'dark']);
    assert.deepEqual(page.shellCalls, ['dark', 'light', 'system', 'dark']);
  } finally {
    restore();
  }
});

test('theme.js: the shell answers later: the page looks again then, and an answer to an older choice changes nothing', async () => {
  const page = fakePage({ stored: 'light' });
  const pending = [];
  page.g.sibersentezShell = { setTheme: (v) => new Promise((resolve) => pending.push({ v, resolve })) };
  const { mod, restore } = await themeModuleOn(page);
  try {
    mod.startTheme();
    const seen = [];
    mod.onTheme((th) => seen.push(th));
    const root = page.g.document.documentElement;
    assert.equal(root.dataset.theme, 'light');
    // While the window still answers the old fixed look, 'system' reads light; the shell then gives the system back
    page.media.matches = true;
    mod.setThemeChoice('system');
    assert.equal(root.dataset.theme, 'light');
    page.media.matches = false;
    pending.find((x) => x.v === 'system').resolve({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.dataset.theme, 'dark', 'looked again after the shell answered');
    // Two choices quickly: the late answer to the first one does not undo the second
    mod.setThemeChoice('light');
    mod.setThemeChoice('dark');
    page.media.matches = true;
    for (const x of pending) x.resolve({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.dataset.theme, 'dark');
    assert.deepEqual(seen, ['dark', 'light', 'dark'], 'each change heard once, nothing twice');
  } finally {
    restore();
  }
});

test('theme-boot.js sets the theme before the first paint, from the same key, before any stylesheet', () => {
  const src = read('public/js/theme-boot.js');
  const run = ({ stored = null, prefersLight = false, blocked = false } = {}) => {
    const root = { dataset: {} };
    const ctx = {
      localStorage: { getItem: (k) => {
        if (blocked) throw new Error('blocked');
        return k === 'sibersentez.theme' ? stored : null;
      } },
      matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: light)' && prefersLight }),
      document: { documentElement: root },
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx);
    return root.dataset.theme;
  };
  assert.equal(run(), 'dark');
  assert.equal(run({ stored: 'light' }), 'light');
  assert.equal(run({ stored: 'system', prefersLight: true }), 'light');
  assert.equal(run({ stored: 'system' }), 'dark');
  assert.equal(run({ stored: 'light', blocked: true }), 'dark', 'blocked storage: dark');
  const html = read('public/index.html');
  const boot = html.indexOf('<script src="/js/theme-boot.js"></script>');
  assert.ok(boot > 0 && boot < html.indexOf('<link rel="stylesheet"'), 'a plain script in the head, before the stylesheets');
  assert.ok(html.includes('<meta name="color-scheme" content="dark light">'));
});

test('Settings: the look, with the choice selected, in both languages', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const h = settingsHtml({ theme: 'light' });
    assert.ok(h.includes('data-set-theme'), lang);
    assert.ok(h.includes(`<option value="light" selected>${STRINGS[lang].setThemeLight}</option>`), lang);
    assert.ok(h.includes(`<option value="dark">${STRINGS[lang].setThemeDark}</option>`), lang);
    for (const k of ['setThemeTitle', 'setThemeText', 'setThemeDark', 'setThemeLight', 'setThemeSystem', 'setThemeSystem_unix']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  }
  setLanguage('en');
  const src = read('public/js/views/settings.js');
  assert.ok(src.includes("if (e.target.matches?.('[data-set-theme]')) {\n      setThemeChoice(e.target.value);"));
});

test('the desktop shell: one more checked channel; the title bar and the background follow, nothing is saved', () => {
  assert.equal(THEME_IPC_CHANNEL, 'sibersentez:set-theme');
  assert.equal(windowOptions({}).backgroundColor, WINDOW_BACKGROUND.dark);
  const main = read('electron/main.mjs');
  const fn = main.slice(main.indexOf('function onSetThemeRequest'), main.indexOf('// window.sibersentezShell.setLanguage(lang)'));
  assert.match(fn, /const check = bridgeSender\(senderFacts\(event\)\);\n\s+if \(!check\.ok\) return \{ ok: false, reason: 'refused' \};/, 'the sender rule first');
  assert.match(fn, /if \(!THEME_CHOICES\.includes\(theme\)\) return \{ ok: false, reason: 'invalid' \};/);
  assert.ok(fn.includes('nativeTheme.themeSource = theme;'));
  assert.doesNotMatch(fn, /write|fs\./, 'nothing written');
  assert.ok(main.includes('ipcMain.handle(THEME_IPC_CHANNEL, onSetThemeRequest);'));
  const preload = read('electron/preload.cjs');
  assert.ok(preload.includes("const THEME_CHANNEL = 'sibersentez:set-theme';") && preload.includes("const THEMES = ['dark', 'light', 'system'];"));
});
