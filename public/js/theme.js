// @ts-check
// The look (plan E4, docs/theme.md): dark, light, or like the system. The choice is a page preference (localStorage,
// like the other preferences); theme-boot.js applies it before the first paint and this module keeps it. The page
// tells the desktop shell too, so the window's title bar and its background follow (preload setTheme).

export const THEME_KEY = 'sibersentez.theme';
export const THEME_CHOICES = Object.freeze(['dark', 'light', 'system']);

const listeners = new Set();
let choice = null;
let media = null;

function readPref() {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) ?? null;
  } catch {
    return null;
  }
}
function writePref(value) {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, value);
  } catch {
    // storage blocked: kept until a reload
  }
}

// choice: 'dark' | 'light' | 'system'; prefersLight: the system's answer -> the theme the page shows
export function resolveTheme(c, prefersLight = false) {
  if (c === 'light') return 'light';
  if (c === 'system') return prefersLight ? 'light' : 'dark';
  return 'dark';
}

// Anything that is not a known choice is the dark theme, the one SiberSentez had first
export function themeChoice() {
  if (choice === null) {
    const v = readPref();
    choice = v && THEME_CHOICES.includes(v) ? v : 'dark';
  }
  return choice;
}

function mediaQuery() {
  if (media === null) media = globalThis.matchMedia?.('(prefers-color-scheme: light)') ?? false;
  return media || null;
}

// The theme in use now
export function currentTheme() {
  return resolveTheme(themeChoice(), !!mediaQuery()?.matches);
}

// The theme last shown: listeners hear only a change
let shown = null;

function apply() {
  const theme = currentTheme();
  const root = globalThis.document?.documentElement;
  if (root && root.dataset.theme !== theme) root.dataset.theme = theme;
  if (theme === shown) return;
  shown = theme;
  for (const fn of listeners) {
    try {
      fn(theme);
    } catch (e) {
      console.error(e);
    }
  }
}

// The desktop shell follows the choice itself (nativeTheme), 'system' included; a browser has no shell
function tellShell(c) {
  const shell = /** @type {any} */ (globalThis).sibersentezShell;
  if (typeof shell?.setTheme !== 'function') return Promise.resolve(false);
  return Promise.resolve(shell.setTheme(c)).then(() => true, () => false);
}

export function setThemeChoice(c) {
  if (!THEME_CHOICES.includes(c) || c === themeChoice()) return false;
  choice = c;
  writePref(c);
  apply();
  // The shell's answer comes later: with 'system' the window gets the system's look back, and the media query may
  // only then answer the system's way (until then it answered the old fixed choice). So once more after it.
  tellShell(c).then((told) => told && choice === c && apply());
  return true;
}

export function onTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Once at the start: the page's theme, the shell told, and the system followed while the choice is 'system'
export function startTheme() {
  tellShell(themeChoice());
  apply();
  mediaQuery()?.addEventListener?.('change', () => themeChoice() === 'system' && apply());
}
