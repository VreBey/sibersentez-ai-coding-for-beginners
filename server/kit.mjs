// The SiberSentez kit (docs/kit.md): SiberSentez's own skills and agents, shipped with the app and only ever read.
//
// Where it lives: <app>/kit when the app runs from its source folder; next to the app archive in the installed app
// (<resources>/kit, package.json build.extraResources: the kit is kept out of app.asar, because copying a folder
// out of the archive is not reliable). SIBERSENTEZ_KIT names another folder (tests); a folder named there that does
// not exist means no kit, never a fallback. config.mjs resolves the same place as KIT_DIR; defaultKitDir() below
// is that resolution for the modules that cannot import config.mjs (install.mjs, fit.mjs).
//
// Layout: the hub library's (<category>/skills/<name>/SKILL.md, <category>/agents/<name>.md, see library.mjs
// listItemsIn), plus catalog.json (the kit version) and LICENSE.md. Each item's frontmatter carries the matching
// metadata of the fit engine: metadata.sibersentez-tags (tag ids of tags.mjs), sibersentez-stage (start|build|ship|any),
// sibersentez-keywords-tr (Turkish words of idea sentences, '*' marks a stem), sibersentez-offer (empty-folder: offered
// in a folder with nothing in it yet) and version.
//
// No kit (folder missing, unreadable): every reader returns an empty kit, silently.
// Pure module: node built-ins and modules that never import config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from './util.mjs';
import { listItemsIn, isRealDir, lstat, validName } from './library.mjs';
import { TAG_BY_ID, sortTags } from './tags.mjs';

export const KIT_ENV = 'SIBERSENTEZ_KIT';
export const KIT_SOURCE = 'kit';
export const KIT_STAGES = Object.freeze(['start', 'build', 'ship', 'any']);
export const KIT_OFFERS = Object.freeze(['empty-folder']);
// Frontmatter bytes read for the metadata; keywords kept per item and their length
const HEAD_BYTES = 8000;
const MAX_KEYWORDS = 40;
const KEYWORD_MAX = 60;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The folder that holds an archive segment of a path ('C:\x\resources\app.asar\server' -> 'C:\x\resources'); null
// when the path has none
export function asarParent(p) {
  const m = /^(.*?)[\\/][^\\/]+\.asar(?:[\\/]|$)/i.exec(String(p || ''));
  return m && m[1] ? m[1] : null;
}

// The kit folder (pure): SIBERSENTEZ_KIT > the folder next to the app archive (installed app) > <app>/kit. Only a real
// folder counts (a link is not followed); anything else is null.
export function resolveKitDir({ env = {}, appDir = APP_ROOT } = {}) {
  const raw = env && typeof env[KIT_ENV] === 'string' ? env[KIT_ENV].trim() : '';
  if (raw) {
    const p = path.resolve(raw);
    return isRealDir(p) ? p : null;
  }
  if (typeof appDir !== 'string' || !appDir) return null;
  const outside = asarParent(appDir);
  const dir = outside ? path.join(outside, 'kit') : path.join(appDir, 'kit');
  return isRealDir(dir) ? dir : null;
}

// The kit folder of this process (the environment and the app folder, as config.mjs KIT_DIR), resolved once
let defaultDir;
export function defaultKitDir() {
  if (defaultDir === undefined) defaultDir = resolveKitDir({ env: process.env, appDir: APP_ROOT });
  return defaultDir;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

const unquote = (v) => {
  const s = String(v).trim();
  return /^"[^"]*"$/.test(s) || /^'[^']*'$/.test(s) ? s.slice(1, -1) : s;
};
const list = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// The metadata map of a frontmatter (the `metadata:` key and its indented `key: value` lines) and its license line.
// Returns { license, metadata: { key: value } }; {} when the file cannot be read.
export function readKitMeta(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      text = b.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const out = { license: null, metadata: {} };
  let inMeta = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '---') break;
    const sub = /^\s+([a-z][a-z0-9-]*):\s*(.*)$/.exec(l);
    if (sub && inMeta) {
      out.metadata[sub[1]] = unquote(sub[2]);
      continue;
    }
    const top = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(l);
    if (!top) continue;
    inMeta = top[1] === 'metadata' && top[2].trim() === '';
    if (top[1] === 'license') out.license = unquote(top[2]);
  }
  return out;
}

// A keyword as the matcher reads it: lower case (Turkish rules), words separated by single spaces, '*' only at the
// end; anything else is dropped
function cleanKeyword(k) {
  const s = String(k || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > KEYWORD_MAX || !/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*\*?$/u.test(s)) return null;
  return s;
}

function readCatalogVersion(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8').replace(/^\uFEFF/, ''));
    return typeof j?.version === 'string' && VERSION_RE.test(j.version) ? j.version : null;
  } catch {
    return null;
  }
}

// Every file the kit is read from with its modification time and size: the kit is read again only when it changes
function signature(dir) {
  const parts = [];
  const st = (p) => {
    const s = lstat(p);
    return s ? `${s.mtimeMs}:${s.size}` : '-';
  };
  parts.push(`catalog|${st(path.join(dir, 'catalog.json'))}`);
  let cats = [];
  try {
    cats = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return null;
  }
  for (const c of cats.map((d) => d.name).sort()) {
    for (const group of ['skills', 'agents']) {
      const g = path.join(dir, c, group);
      parts.push(`${c}/${group}|${st(g)}`);
      let ents = [];
      try {
        ents = fs.readdirSync(g, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents.map((d) => d.name).sort()) parts.push(`${c}/${group}/${e}|${st(group === 'skills' ? path.join(g, e, 'SKILL.md') : path.join(g, e))}`);
    }
  }
  return parts.join('\n');
}

const EMPTY = Object.freeze({ dir: null, version: null, items: Object.freeze([]) });
const cache = new Map(); // dir -> { sig, kit }

// The kit in a folder: { dir, version (catalog.json), items: [{ kind, name, category, description, path, rel,
// origin ('kit'), kitVersion, version, tags, stage, keywords, offer }] } in library order (categories, then skills
// before agents, by name). An item has the fields of a library item (listItemsIn), so install.mjs copies it alike.
// tags: the known tag ids of sibersentez-tags; stage: one of KIT_STAGES ('any' when missing); keywords: cleaned, at
// most MAX_KEYWORDS; offer: known values of sibersentez-offer. Items with a name the hub would refuse are left out.
// frontmatter(file): the name and description reader (the catalog passes its cached one).
export function readKit(dir, { frontmatter = readFrontmatter } = {}) {
  if (typeof dir !== 'string' || !dir || !isRealDir(dir)) return EMPTY;
  const sig = signature(dir);
  if (sig === null) return EMPTY;
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.kit;
  const items = [];
  const kitVersion = readCatalogVersion(dir);
  for (const it of listItemsIn(dir, KIT_SOURCE, { frontmatter })) {
    if (!validName(it.name)) continue;
    const main = it.kind === 'skill' ? path.join(it.path, 'SKILL.md') : it.path;
    const { metadata = {} } = readKitMeta(main);
    const stage = KIT_STAGES.includes(metadata['sibersentez-stage']) ? metadata['sibersentez-stage'] : 'any';
    const keywords = [...new Set(list(metadata['sibersentez-keywords-tr']).map(cleanKeyword).filter(Boolean))].slice(0, MAX_KEYWORDS);
    items.push(
      Object.freeze({
        ...it,
        origin: KIT_SOURCE,
        kitVersion,
        version: VERSION_RE.test(metadata.version || '') ? metadata.version : null,
        tags: Object.freeze(sortTags(list(metadata['sibersentez-tags']).filter((t) => TAG_BY_ID.has(t)))),
        stage,
        keywords: Object.freeze(keywords),
        offer: Object.freeze(list(metadata['sibersentez-offer']).filter((o) => KIT_OFFERS.includes(o))),
      }),
    );
  }
  const kit = Object.freeze({ dir, version: kitVersion, items: Object.freeze(items) });
  cache.set(dir, { sig, kit });
  return kit;
}

// A kit item of a kind and name (case-insensitive), or null
export function findKitItem(kit, kind, name) {
  const k = `${kind}:${name}`.toLowerCase();
  return (kit?.items || []).find((it) => `${it.kind}:${it.name}`.toLowerCase() === k) || null;
}

// Counts of a kit: { skill, agent, total }
export function kitCounts(kit) {
  const out = { skill: 0, agent: 0, total: 0 };
  for (const it of kit?.items || []) {
    out[it.kind]++;
    out.total++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Keyword matching (docs/kit.md §4): Turkish letters folded on both sides, whole words and phrases, a trailing '*'
// matches any word that starts with it; a keyword scores its word count
// ---------------------------------------------------------------------------------------------------------------

const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
export function foldTr(s) {
  return String(s ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşüâîû]/g, (c) => FOLD[c]);
}

// The words of a text: [{ w: folded, raw: as written }]. A written word that folds into several parts ("e-ticaret"
// is two words already; a letter the fold does not know splits one) gives each part the written word.
export function kitWords(text) {
  const out = [];
  for (const m of String(text ?? '').normalize('NFC').matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const w of foldTr(m[0]).split(/[^a-z0-9]+/)) if (w) out.push({ w, raw: m[0] });
  }
  return out;
}

// The keywords of an item found in a text (kitWords): [{ keyword, count (its word count), raw (the words as written
// in the text) }], each keyword once, in the item's order
export function keywordHits(keywords, ws) {
  const out = [];
  for (const kw of keywords || []) {
    const stem = kw.endsWith('*');
    const parts = kitWords(stem ? kw.slice(0, -1) : kw).map((x) => x.w);
    if (!parts.length) continue;
    const last = parts.length - 1;
    for (let i = 0; i + last < ws.length; i++) {
      let ok = true;
      for (let k = 0; k <= last && ok; k++) {
        const w = ws[i + k].w;
        ok = k === last && stem ? w.startsWith(parts[k]) : w === parts[k];
      }
      if (ok) {
        const raw = [...new Set(ws.slice(i, i + parts.length).map((x) => x.raw))].join(' ');
        out.push({ keyword: kw, count: parts.length, raw });
        break;
      }
    }
  }
  return out;
}
