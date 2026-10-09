// @ts-check
// Projects the person hid from the lists (2026-10-02): a folder found once in the AI tools' records ("proje", "deneme")
// stayed in Projects for good. Hiding touches nothing on disk and tells the server nothing: the ids are kept in this
// browser only (localStorage; the desktop app keeps its own profile), and a hidden project folds away with the other
// folders (attention.js isOtherFolder), where "Show in the list" brings it back.
const KEY = 'sibersentez.hiddenProjects';
const MAX = 500;
let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  cache = new Set();
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(KEY) || '[]');
    if (Array.isArray(list)) for (const id of list.slice(-MAX)) if (typeof id === 'string' && id) cache.add(id);
  } catch {
    /* storage blocked or broken: nothing hidden */
  }
  return cache;
}

export function isHiddenProject(id) {
  return typeof id === 'string' && load().has(id);
}

export function setProjectHidden(id, hidden) {
  if (typeof id !== 'string' || !id) return false;
  const set = load();
  if (hidden === set.has(id)) return false;
  if (hidden) set.add(id);
  else set.delete(id);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...set].slice(-MAX)));
  } catch {
    /* storage blocked: hidden for this window only */
  }
  for (const fn of listeners) {
    try {
      fn(id, hidden);
    } catch (e) {
      console.error(e);
    }
  }
  return true;
}

export function onHiddenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Tests start from an empty set
export function resetHiddenProjects() {
  cache = null;
}
