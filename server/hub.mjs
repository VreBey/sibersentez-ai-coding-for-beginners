// @ts-check
// Hub folder layout (contract §2, §6A, §9): creating the skeleton and reading the registry, library and settings.
// Pure module: only node built-ins and util.mjs, never config.mjs. The Electron main process calls initHub on
// first launch; the server itself never creates the hub.
//
// Read order: English paths and keys first; otherwise a compatibility adapter for a legacy hub
// (registry/projeler.json with projeler/ad/yol/aciklama/paketler, kutuphane/katalog.json with
// ogeler/ad/tur/kategori/aciklama), so users can point the app at the hub they already have.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';

const json = (v) => JSON.stringify(v, null, 2) + '\n';

const LIBRARY_README = `# SiberSentez library

This folder is your skill library. The app lists the skills and agents in \`catalog.json\` with the "Library" source.

Layout:

- \`<category>/skills/<name>/SKILL.md\`
- \`<category>/agents/<name>.md\`

SiberSentez does not ship skills or agents; you fill the library yourself. Setup never overwrites files in this
folder, and uninstalling the app does not delete it.
`;

// Relative path ('/' separated) -> initial content
export const HUB_SKELETON = Object.freeze({
  'settings.json': json({ version: 1, language: 'auto' }),
  'registry/projects.json': json({ projects: [] }),
  'library/catalog.json': json({ updated: null, count: 0, items: [] }),
  'library/README.md': LIBRARY_README,
});

// Legacy counterparts: when one exists, the English file of that group is not created, so a legacy hub keeps
// working as it is and nothing new (an empty skeleton that would hide its data) is written next to it
const LEGACY_OF = Object.freeze({
  'registry/projects.json': 'registry/projeler.json',
  'library/catalog.json': 'kutuphane/katalog.json',
  'library/README.md': 'kutuphane/katalog.json',
});

function hubError(code, message) {
  return Object.assign(new Error(message), { code });
}

function mkdirOrThrow(dir, root) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw hubError('HUB_MKDIR_FAILED', `cannot create hub folder: ${dir === root ? root : path.relative(root, dir)} (${e?.code || e?.message})`);
  }
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw hubError('HUB_MKDIR_FAILED', `cannot create hub folder: ${dir === root ? root : path.relative(root, dir)} is not a folder`);
}

// Creates the skeleton and NEVER overwrites an existing file ('wx': create only if missing, no race).
// In a legacy hub the English registry and library files are not created (see LEGACY_OF).
// Returns the files created by this call as relative '/' separated paths, in HUB_SKELETON order.
// Throws an Error with code HUB_PATH_MISSING, HUB_MKDIR_FAILED or HUB_WRITE_FAILED.
export function initHub(hubPath) {
  if (typeof hubPath !== 'string' || !hubPath.trim()) throw hubError('HUB_PATH_MISSING', 'hub path is missing');
  const root = path.resolve(hubPath.trim());
  mkdirOrThrow(root, root);
  const created = [];
  for (const [rel, content] of Object.entries(HUB_SKELETON)) {
    const file = path.join(root, ...rel.split('/'));
    const legacy = LEGACY_OF[rel];
    if (legacy && isFile(path.join(root, ...legacy.split('/')))) continue;
    mkdirOrThrow(path.dirname(file), root);
    try {
      fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
      created.push(rel);
    } catch (e) {
      if (e?.code === 'EEXIST') continue; // the user's file: left untouched
      throw hubError('HUB_WRITE_FAILED', `cannot write hub file: ${rel} (${e?.code || e?.message})`);
    }
  }
  return created;
}

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// English file first. When both exist, the legacy file wins only if the English one holds no rows (an empty
// skeleton or an unreadable file) while the legacy one does, so an empty skeleton never hides the user's data.
// Neither exists: the English path (a reader treats a missing file as empty).
function pickFile(hubDir, english, legacy, rows) {
  if (!hubDir) return null;
  const en = path.join(hubDir, ...english);
  const old = path.join(hubDir, ...legacy);
  const hasEn = isFile(en);
  const hasOld = isFile(old);
  if (hasEn && hasOld) return rows(en) === 0 && rows(old) > 0 ? old : en;
  if (hasEn) return en;
  return hasOld ? old : en;
}

// Project registry: registry/projects.json, else legacy registry/projeler.json. null without a hub.
export function registryFile(hubDir) {
  return pickFile(hubDir, ['registry', 'projects.json'], ['registry', 'projeler.json'], (f) => normalizeRegistry(readJson(f)).projects.length);
}

// Library catalog: library/catalog.json, else legacy kutuphane/katalog.json. null without a hub.
export function libraryFile(hubDir) {
  return pickFile(hubDir, ['library', 'catalog.json'], ['kutuphane', 'katalog.json'], (f) => normalizeLibrary(readJson(f)).items.length);
}

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
// Legacy "yol" values may carry notes around the path: take the first Windows path
const DRIVE_PATH = /[A-Za-z]:\\[^()\n]+/;
function extractPath(v) {
  if (!v || typeof v !== 'string') return null;
  const m = DRIVE_PATH.exec(v);
  return m ? m[0].trim() : null;
}
// Legacy memory folder names ("C--Users-...") used to match Claude Code project folders
function memorySlug(v) {
  if (!v || typeof v !== 'string') return null;
  const t = v.trim().split(/\s+/)[0];
  return t && /^[A-Za-z]-/.test(t) ? t.toLowerCase() : null;
}

// Registry JSON (either format) -> normalized projects:
// { id, name, path, description, status, phase, stack, packages, rules, build, extraPaths, memorySlugs }.
// Rows without an id, duplicates and non-objects are skipped so a broken row never takes the app down.
export function normalizeRegistry(raw) {
  const english = Array.isArray(raw?.projects);
  const rows = english ? raw.projects : arr(raw?.projeler);
  const out = [];
  const seen = new Set();
  for (const p of rows) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    if (english) {
      const where = str(p.path).trim() || null;
      out.push({
        id: p.id,
        name: str(p.name) || p.id,
        path: where,
        description: str(p.description),
        status: str(p.status),
        phase: str(p.phase),
        stack: arr(p.stack),
        packages: arr(p.packages),
        rules: arr(p.rules),
        build: str(p.build).trim() || null,
        extraPaths: [],
        memorySlugs: [],
      });
    } else {
      out.push({
        id: p.id,
        name: str(p.ad) || p.id,
        path: extractPath(p.yol),
        description: str(p.aciklama),
        status: str(p.durum),
        phase: str(p.faz),
        stack: arr(p.stack),
        packages: arr(p.paketler),
        rules: arr(p.dogrulanma_kurallari),
        build: extractPath(p.build_yolu),
        extraPaths: [extractPath(p.yol_eski)].filter(Boolean),
        memorySlugs: [memorySlug(p.hafiza_proje), memorySlug(p.hafiza_proje_eski)].filter(Boolean),
      });
    }
  }
  return { format: english ? 'english' : Array.isArray(raw?.projeler) ? 'legacy' : 'empty', projects: out };
}

// Library catalog JSON (either format) -> normalized items: { name, kind: 'skill'|'agent', category, description }.
// Items without a name or with another kind are skipped.
export function normalizeLibrary(raw) {
  const english = Array.isArray(raw?.items);
  const rows = english ? raw.items : arr(raw?.ogeler);
  const out = [];
  for (const o of rows) {
    if (!o || typeof o !== 'object') continue;
    const name = english ? o.name : o.ad;
    const kind = english ? o.kind : o.tur;
    if (typeof name !== 'string' || !name || (kind !== 'skill' && kind !== 'agent')) continue;
    out.push({ name, kind, category: str(english ? o.category : o.kategori), description: str(english ? o.description : o.aciklama) });
  }
  return { format: english ? 'english' : Array.isArray(raw?.ogeler) ? 'legacy' : 'empty', items: out };
}

// Hub settings file and the action modes it may hold (docs/actions-toggle.md §3.1)
const SETTINGS_FILE = 'settings.json';
export const ACTION_MODES = Object.freeze(['off', 'dry', 'live']);

// "actions" from <hub>/settings.json, read by the server once at start. Only the desktop shell writes this key
// (tray menu); the server never writes settings.json. Returns { mode, problem }:
//   mode     'off' | 'dry' | 'live'. No hub, no file, no key or a blank value: 'off'. Anything else unknown: 'off'.
//   problem  null, or a short English reason when the file or the value exists but cannot be used (the caller logs
//            it; it carries no path, since paths hold the user name).
export function readActionsSetting(hubDir) {
  if (typeof hubDir !== 'string' || !hubDir) return { mode: 'off', problem: null };
  let text;
  try {
    text = fs.readFileSync(path.join(hubDir, SETTINGS_FILE), 'utf8');
  } catch (e) {
    const missing = e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
    return { mode: 'off', problem: missing ? null : `${SETTINGS_FILE} unreadable (${e?.code || 'error'})` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { mode: 'off', problem: `${SETTINGS_FILE} is invalid (not a JSON object)` };
  const raw = data.actions;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { mode: 'off', problem: null };
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (ACTION_MODES.includes(v)) return { mode: v, problem: null };
  return { mode: 'off', problem: `${SETTINGS_FILE}: actions is invalid` };
}

export function readRegistry(hubDir) {
  const file = registryFile(hubDir);
  return normalizeRegistry(file ? readJson(file) : null);
}

export function readLibrary(hubDir) {
  const file = libraryFile(hubDir);
  return normalizeLibrary(file ? readJson(file) : null);
}
