// @ts-check
// Pure roster model: source labels, filtering by source and folder, library and folder counts, hub/library state.
// No DOM access (imported by node tests: test/contextmenu.test.mjs, test/roster-folders.test.mjs).
import { t } from './i18n.js';

// A frozen table of localized strings: each read looks the text up in the current language (string ids given by key)
/** @type {(ids: Record<string, string>) => Readonly<Record<string, string>>} */
const localized = (ids) => Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, { get: () => t(id), enumerable: true }]))));

// Roster sources sent by the server (contract §4) in filter order. 'other' = seen only in logs,
// no installed location found on this machine.
export const SOURCE_ORDER = Object.freeze(['library', 'personal', 'claudeai', 'project', 'plugin', 'builtin', 'other']);

// The SiberSentez kit (docs/kit.md): SiberSentez's own skills and agents, shipped with the app. A source of its own, kept
// out of the contract table above (the source filter and its counts list the contract sources).
export const KIT_SOURCE = 'kit';
const EXTRA_SOURCE = localized({ kit: 'srcKit' });

// The single label table for sources (texts in strings/common.js); keys are the server's English source values.
export const SOURCE = localized({
  library: 'srcLibrary',
  personal: 'srcPersonal',
  claudeai: 'srcClaudeai',
  project: 'srcProject',
  plugin: 'srcPlugin',
  builtin: 'srcBuiltin',
  other: 'srcOther',
});

// What each source means (tooltip and the drawer's "Access" row)
export const SOURCE_HINT = localized({
  library: 'srcHint_library',
  personal: 'srcHint_personal',
  claudeai: 'srcHint_claudeai',
  project: 'srcHint_project',
  plugin: 'srcHint_plugin',
  builtin: 'srcHint_builtin',
  other: 'srcHint_other',
  kit: 'srcHint_kit',
});

// Transitional: pre-release servers sent Turkish source keys. Mapped so the panel keeps working
// while server and client are updated separately; safe to delete once no such server remains.
const LEGACY_SOURCE_KEYS = Object.freeze({ kutuphane: 'library', kisisel: 'personal', proje: 'project', eklenti: 'plugin', yerlesik: 'builtin', diger: 'other' });

// Sources that are available in every project (a plugin item counts too when its plugin is enabled)
const EVERYWHERE = new Set(['personal', 'claudeai', 'builtin']);

// Library folder name inside the hub (contract: <hub>\library)
const LIBRARY_DIR = 'library';

// Server value → known source key; anything unknown becomes 'other' (never crashes on new names)
export function normalizeSource(key) {
  if (typeof key !== 'string' || !key) return 'other';
  if (Object.prototype.hasOwnProperty.call(SOURCE, key) || Object.prototype.hasOwnProperty.call(EXTRA_SOURCE, key)) return key;
  return LEGACY_SOURCE_KEYS[key] || 'other';
}

// Is this value a source name (current or transitional)? Used to hide category chips that only repeat the source.
export function isSourceKey(key) {
  return typeof key === 'string' && (Object.prototype.hasOwnProperty.call(SOURCE, key) || Object.prototype.hasOwnProperty.call(EXTRA_SOURCE, key) || Object.prototype.hasOwnProperty.call(LEGACY_SOURCE_KEYS, key));
}

export function sourceLabel(key) {
  const k = normalizeSource(key);
  return SOURCE[k] || EXTRA_SOURCE[k];
}

// All sources of an item: primary `source` first, then `sources[]` (deduplicated, empties dropped)
export function sourcesOf(item) {
  const out = [];
  if (!item) return out;
  for (const s of [item.source, ...(Array.isArray(item.sources) ? item.sources : [])]) {
    if (typeof s !== 'string' || !s) continue;
    const k = normalizeSource(s);
    if (!out.includes(k)) out.push(k);
  }
  return out.length ? out : ['other'];
}

// Is this a library item (installable from the library)?
export function isLibraryItem(item) {
  return !!item && normalizeSource(item.source) === 'library';
}

// Is this item in the SiberSentez kit (installable from the kit)?
export function isKitItem(item) {
  return !!item && sourcesOf(item).includes(KIT_SOURCE);
}

// Ready in every project: personal, claude.ai, built-in; an item of an enabled plugin; or server says global
export function everywhere(item) {
  if (!item) return false;
  if (item.global === true) return true;
  const src = sourcesOf(item);
  if (src.some((s) => EVERYWHERE.has(s))) return true;
  return src.includes('plugin') && item.enabled === true;
}

// Where the item applies (drawer "Access" row), plain UI text
export function accessText(item) {
  if (!item) return '';
  const src = sourcesOf(item);
  if (item.kind === 'plugin') return item.enabled ? t('accPluginOn') : t('accPluginOff');
  if (src.includes('plugin') && !src.some((s) => EVERYWHERE.has(s))) {
    if (item.enabled === true) return t('accItemPluginOn');
    if (item.enabled === false) return t('accItemPluginOff');
    return SOURCE_HINT.plugin;
  }
  if (everywhere(item)) return `${t('accEverywhere')} ${SOURCE_HINT[src.find((s) => EVERYWHERE.has(s)) || src[0]] || ''}`.trim();
  const n = Array.isArray(item.installedIn) ? item.installedIn.length : 0;
  if (n) return n === 1 ? t('accOneProject') : t('accNProjects', { n });
  if (src.includes('library')) return t('accInLibrary');
  if (src.includes(KIT_SOURCE)) return t('accInKit');
  return SOURCE_HINT[src[0]] || SOURCE_HINT.other;
}

// Filter: { q, kind, source, category, folder, used } ('all' = everything). q must already be lower-cased.
// An item matches a source filter if ANY of its sources matches, and a folder filter if it is in that folder (or in
// any folder of a 'group:<group>' key).
export function matchesFilter(item, f = {}) {
  if (!item) return false;
  if (f.kind && f.kind !== 'all' && item.kind !== f.kind) return false;
  if (f.source && f.source !== 'all' && !sourcesOf(item).includes(normalizeSource(f.source))) return false;
  if (f.category && f.category !== 'all' && item.category !== f.category) return false;
  if (f.folder && f.folder !== 'all' && !matchesFolder(item, f.folder)) return false;
  if (f.used && !(item.usage && item.usage.count)) return false;
  // Which AI tool reads it (docs/tool-view.md): the adapters in item.tools
  if (f.tool && f.tool !== 'all' && !(item.tools || []).includes(f.tool)) return false;
  if (f.q) {
    const hay = `${item.name || ''} ${item.description || ''} ${item.category || ''} ${item.plugin || ''}`.toLocaleLowerCase('tr-TR');
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

// Item count per source (an item counts once in each of its sources); 'all' = total items
export function sourceCounts(items) {
  const counts = { all: 0 };
  for (const k of SOURCE_ORDER) counts[k] = 0;
  for (const it of items || []) {
    if (!it) continue;
    counts.all++;
    for (const s of sourcesOf(it)) counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

// Filter buttons: the six contract sources always (even at 0); 'other' only when it has items
export function sourceOptions(counts) {
  return SOURCE_ORDER.filter((k) => k !== 'other' || (counts && counts.other > 0)).map((k) => ({ key: k, label: SOURCE[k], count: (counts && counts[k]) || 0 }));
}

// Hub and library state from the snapshot's `hub` field:
//   hub === undefined → 'unknown' (older server without the field: no empty state is shown)
//   hub === null      → 'none'    (no hub folder)
//   library 0         → 'empty'   (library is still empty)
//   otherwise         → 'ready'
// libraryPath: the server's own value if it sends one, else <hub>\library.
export function libraryState(hub) {
  if (hub === undefined) return { state: 'unknown', path: null, libraryPath: null, library: 0, projects: 0 };
  if (!hub || typeof hub !== 'object' || typeof hub.path !== 'string' || !hub.path) return { state: 'none', path: null, libraryPath: null, library: 0, projects: 0 };
  const library = Number(hub.library) > 0 ? Math.floor(Number(hub.library)) : 0;
  const projects = Number(hub.projects) > 0 ? Math.floor(Number(hub.projects)) : 0;
  const sep = hub.path.includes('\\') || !hub.path.includes('/') ? '\\' : '/';
  const libraryPath = typeof hub.libraryPath === 'string' && hub.libraryPath ? hub.libraryPath : hub.path.replace(/[\\/]+$/, '') + sep + LIBRARY_DIR;
  return { state: library ? 'ready' : 'empty', path: hub.path, libraryPath, library, projects };
}

// ---------------------------------------------------------------------------------------------------------------
// Copies and folders (roster counts and the folder filter)
// ---------------------------------------------------------------------------------------------------------------

// The part of a name after its namespace: "zoom-plugin:start" -> "start"
export function baseName(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Items with the same kind and the same base name (case-insensitive) are copies of one another: they count once
export function copyKey(item) {
  return `${item?.kind || ''}:${baseName(item?.name).toLowerCase()}`;
}

// Skills and agents in the hub library, copies counted once: { skill, agent, total }
export function libraryCounts(items) {
  return countsIn(items, 'library');
}

// Skills and agents in the SiberSentez kit, copies counted once: { skill, agent, total }
export function kitCounts(items) {
  return countsIn(items, KIT_SOURCE);
}

function countsIn(items, source) {
  const out = { skill: 0, agent: 0, total: 0 };
  const seen = new Set();
  for (const it of items || []) {
    if (!it || (it.kind !== 'skill' && it.kind !== 'agent') || !sourcesOf(it).includes(source)) continue;
    const k = copyKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out[it.kind]++;
    out.total++;
  }
  return out;
}

// Folder groups in display order. Folder keys:
//   lib:<category>   a library category folder (<hub>\library\<category>)
//   kit:<category>   a category folder of the SiberSentez kit (the server's kitCategory)
//   proj:<id>        a project folder (the item is installed in or owned by that project: installedIn)
//   home:<dir>       a personal folder, home-relative as the server sends it in personalDirs ("~/.claude/skills");
//                    'home:' alone when the server did not say which one
//   plugin:<name>    a plugin (lower-cased name, without the @marketplace part)
//   claudeai | builtin | other   skills synced from claude.ai, items that come with the tools, items seen only in logs
// 'group:<group>' selects every folder of a group; 'all' every item.
export const FOLDER_GROUPS = Object.freeze(['library', 'kit', 'projects', 'personal', 'plugins', 'more']);
const SINGLE_FOLDERS = Object.freeze(['claudeai', 'builtin', 'other']);
const PREFIX_GROUP = Object.freeze([
  ['lib:', 'library'],
  ['kit:', 'kit'],
  ['proj:', 'projects'],
  ['home:', 'personal'],
  ['plugin:', 'plugins'],
]);
// Groups a 'group:' key may select ('more' holds three single folders, each selectable on its own)
const SELECTABLE_GROUPS = Object.freeze(['library', 'kit', 'projects', 'personal', 'plugins']);
const FOLDER_KEY_MAX = 300;

// Group of a folder key; null for anything else
export function folderGroupOf(key) {
  if (typeof key !== 'string') return null;
  if (SINGLE_FOLDERS.includes(key)) return 'more';
  for (const [prefix, group] of PREFIX_GROUP) if (key.startsWith(prefix)) return group;
  return null;
}

// Plugin an item belongs to (display spelling): a plugin item itself, the plugin field ("name@marketplace"), else
// the namespace of its name ("gh:review"); '' when none is known
function pluginNameOf(item) {
  if (item.kind === 'plugin') return String(item.name || '');
  if (typeof item.plugin === 'string' && item.plugin) return item.plugin.split('@')[0] || item.plugin;
  const n = String(item.name || '');
  const i = n.indexOf(':');
  return i > 0 ? n.slice(0, i) : '';
}

// Folder keys of an item, in group order. An item can sit in several folders (installed in two projects, a personal
// skill that is also in the library). Cached per item object: the roster is replaced, never changed in place.
const folderCache = new WeakMap();
export function foldersOf(item) {
  if (!item || typeof item !== 'object') return [];
  const hit = folderCache.get(item);
  if (hit) return hit;
  const src = sourcesOf(item);
  const out = [];
  const push = (k) => {
    if (!out.includes(k)) out.push(k);
  };
  if (src.includes('library')) push(`lib:${typeof item.category === 'string' ? item.category : ''}`);
  if (src.includes(KIT_SOURCE)) {
    const c = typeof item.kitCategory === 'string' && item.kitCategory ? item.kitCategory : typeof item.category === 'string' ? item.category : '';
    push(`kit:${c}`);
  }
  for (const pid of Array.isArray(item.installedIn) ? item.installedIn : []) if (typeof pid === 'string' && pid) push(`proj:${pid}`);
  if (src.includes('personal')) {
    const dirs = (Array.isArray(item.personalDirs) ? item.personalDirs : []).filter((d) => typeof d === 'string' && d);
    if (dirs.length) for (const d of dirs) push(`home:${d}`);
    else push('home:');
  }
  const plugin = item.kind === 'plugin' || item.plugin || src.includes('plugin') ? pluginNameOf(item) : '';
  if (plugin) push(`plugin:${plugin.toLowerCase()}`);
  // A plugin synced from claude.ai (and its skills) is listed under its plugin, not under claude.ai
  if (src.includes('claudeai') && !plugin) push('claudeai');
  if (src.includes('builtin')) push('builtin');
  if (src.includes('other') || !out.length) push('other');
  const frozen = Object.freeze(out);
  folderCache.set(item, frozen);
  return frozen;
}

// Is the item in this folder (or, for 'group:<group>', in any folder of that group)? 'all' or empty: always.
export function matchesFolder(item, folder) {
  if (!folder || folder === 'all') return true;
  const keys = foldersOf(item);
  if (folder.startsWith('group:')) {
    const g = folder.slice(6);
    return keys.some((k) => folderGroupOf(k) === g);
  }
  return keys.includes(folder);
}

// Plain display name of a folder key before localization: the category, project id, personal folder or plugin name
// (the plugin's spelling comes from the item that first named it)
function rawFolderName(key, item) {
  if (key.startsWith('plugin:')) return pluginNameOf(item) || key.slice(7);
  const g = PREFIX_GROUP.find(([p]) => key.startsWith(p));
  return g ? key.slice(g[0].length) : key;
}

const emptyCounts = () => ({ skill: 0, agent: 0, plugin: 0, total: 0 });
const KINDS = Object.freeze(['skill', 'agent', 'plugin']);

// Skills, agents and plugins per folder: Map key -> { key, group, name, counts: { skill, agent, plugin, total } }.
// With a filter only matching items count (its folder part is ignored: every folder is counted). Copies count once
// per folder (copyKey).
export function folderIndex(items, filter) {
  const map = new Map();
  const seen = new Map();
  const f = filter ? { ...filter, folder: 'all' } : null;
  for (const it of items || []) {
    if (!it || (f && !matchesFilter(it, f))) continue;
    const ck = copyKey(it);
    for (const k of foldersOf(it)) {
      let e = map.get(k);
      if (!e) {
        map.set(k, (e = { key: k, group: folderGroupOf(k), name: rawFolderName(k, it), counts: emptyCounts() }));
        seen.set(k, new Set());
      }
      const s = seen.get(k);
      if (s.has(ck)) continue;
      s.add(ck);
      if (KINDS.includes(it.kind)) e.counts[it.kind]++;
      e.counts.total++;
    }
  }
  return map;
}

// Skills, agents and plugins in a folder or group key, copies counted once: { skill, agent, plugin, total }
export function folderCounts(items, folder) {
  const out = emptyCounts();
  const seen = new Set();
  for (const it of items || []) {
    if (!it || !matchesFolder(it, folder)) continue;
    const ck = copyKey(it);
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (KINDS.includes(it.kind)) out[it.kind]++;
    out.total++;
  }
  return out;
}

// Folder entries (from folderIndex) grouped in display order: [{ key: group, folders: [entry] }]. Every group is
// listed, empty ones too. Folders are sorted by label (labelOf(entry), default the raw name); the single folders of
// 'more' keep their fixed order.
export function folderGroups(entries, labelOf = (e) => e.name) {
  const by = new Map(FOLDER_GROUPS.map((g) => [g, []]));
  for (const e of entries || []) if (e && by.has(e.group)) by.get(e.group).push(e);
  const cmp = (a, b) => String(labelOf(a)).localeCompare(String(labelOf(b)), 'tr', { sensitivity: 'base' }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return FOLDER_GROUPS.map((g) => {
    const list = by.get(g);
    if (g === 'more') list.sort((a, b) => SINGLE_FOLDERS.indexOf(a.key) - SINGLE_FOLDERS.indexOf(b.key));
    else list.sort(cmp);
    return { key: g, folders: list };
  });
}

// A folder value from the address (?folder=): a known shape, else 'all'. Nothing is looked up here: a folder that
// no longer exists is dropped by the view once the roster is known.
export function parseFolder(v) {
  if (typeof v !== 'string' || !v || v.length > FOLDER_KEY_MAX || /[\u0000-\u001f]/.test(v)) return 'all';
  if (v === 'all') return 'all';
  if (v.startsWith('group:')) return SELECTABLE_GROUPS.includes(v.slice(6)) ? v : 'all';
  return folderGroupOf(v) ? v : 'all';
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub import (docs/github-import.md): the result table, the picks, the install buttons, the items to check
// ---------------------------------------------------------------------------------------------------------------

const LEVEL_RANK = Object.freeze({ ok: 0, caution: 1, danger: 2 });
const CONF_RANK = Object.freeze({ high: 0, medium: 1 });
const bestFit = (it) => (Array.isArray(it?.fits) && it.fits.length ? Math.min(...it.fits.map((f) => CONF_RANK[f.confidence] ?? 2)) : 3);

// The rows of a download's result table: items that fit a project first (the best fit first), then by safety (safe
// first) and name. Without showAll the items that fit no project are left out; hidden says how many there are.
// Returns { rows, hidden }.
export function githubRows(items, { showAll = false } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const fits = (it) => Array.isArray(it.fits) && it.fits.length > 0;
  const shown = showAll ? list.slice() : list.filter(fits);
  shown.sort((a, b) => bestFit(a) - bestFit(b) || (LEVEL_RANK[a.review?.level] ?? 3) - (LEVEL_RANK[b.review?.level] ?? 3) || String(a.name).localeCompare(String(b.name), 'tr') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rows: shown, hidden: list.length - list.filter(fits).length };
}

// Can a row be ticked: the server's word (selectable), else the same rule: no problem, not the same as the library
// copy, not a danger
export function githubSelectable(it) {
  if (!it) return false;
  if (typeof it.selectable === 'boolean') return it.selectable;
  return it.review?.level !== 'danger' && !(it.problems || []).length && it.status !== 'same';
}

// The picks an import sends: ticked (picks: Map path -> { on, category, replace }), selectable, and a conflict only
// when replace is ticked. Returns [{ path, category, replace? }] in item order.
export function githubPicks(items, picks) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const p = picks?.get?.(it.path);
    if (!p?.on || !githubSelectable(it)) continue;
    if (it.status === 'conflict' && !p.replace) continue;
    out.push({ path: it.path, category: p.category || it.category, ...(p.replace && it.status === 'conflict' ? { replace: true } : {}) });
  }
  return out;
}

// The install buttons after an import: for every project an imported item fits (installable projects only), the
// items that fit it, at most max each. imported: [{ kind, name, fits }]. Sorted by how many items (most first), then
// how many fit very well, then the project id. Returns [{ projectId, items: [{ kind, name }], high, medium }].
export function installGroups(imported, { max = 25 } = {}) {
  const by = new Map();
  for (const it of Array.isArray(imported) ? imported : []) {
    for (const f of Array.isArray(it?.fits) ? it.fits : []) {
      if (!f || !f.installable || typeof f.projectId !== 'string') continue;
      let g = by.get(f.projectId);
      if (!g) by.set(f.projectId, (g = { projectId: f.projectId, items: [], high: 0, medium: 0 }));
      if (g.items.length >= max || g.items.some((x) => x.kind === it.kind && x.name === it.name)) continue;
      g.items.push({ kind: it.kind, name: it.name });
      if (f.confidence === 'high') g.high++;
      else g.medium++;
    }
  }
  return [...by.values()].sort((a, b) => b.items.length - a.items.length || b.high - a.high || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
}

// Library items that came from GitHub (the roster's origin), by repository then name: [{ id, kind, name, origin }]. An
// item whose name is also active elsewhere (claude.ai, personal) is still a library copy: any source counts.
export function githubItems(roster) {
  return (Array.isArray(roster) ? roster : [])
    .filter((i) => i && (i.kind === 'skill' || i.kind === 'agent') && i.origin && i.origin.type === 'github' && sourcesOf(i).includes('library'))
    .map((i) => ({ id: i.id, kind: i.kind, name: i.name, origin: i.origin }))
    .sort((a, b) => String(a.origin.repo).localeCompare(String(b.origin.repo)) || String(a.name).localeCompare(String(b.name), 'tr'));
}

// "acme/skills @ a1b2c3d" (the license is shown apart)
export function originRepo(origin) {
  if (!origin || typeof origin.repo !== 'string') return '';
  return origin.commit ? `${origin.repo} @ ${origin.commit}` : origin.repo;
}

// The older ?source= filter as a folder value: a source becomes its group (or its single folder)
const SOURCE_FOLDER = Object.freeze({ library: 'group:library', kit: 'group:kit', personal: 'group:personal', project: 'group:projects', plugin: 'group:plugins', claudeai: 'claudeai', builtin: 'builtin', other: 'other' });
export function sourceFolder(source) {
  if (typeof source !== 'string' || !source || source === 'all') return 'all';
  const k = normalizeSource(source);
  if (k === 'other' && source !== 'other') return 'all';
  return SOURCE_FOLDER[k] || 'all';
}
