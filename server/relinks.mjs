// @ts-check
// Moved projects linked to their new folder (docs/internal/project-relink-plan.md): <hub>/registry/relinks.json, the
// program's own memory (like discovered.json; the person's registry is never written). One link keeps a project's id,
// and so its history (usage, restore points, job results), and gives it its new folder:
//   { id: the project kept, path: its new folder, oldPath: its folder before (an unregistered project's id is made from
//     it), from: the id the new folder had on its own (null: it was not listed), at }
// The catalog applies the links where ids are made (catalog.mjs applyLinks, resolve), the usage ledger books the new
// folder's own hours under the kept id (usage.mjs setJoins). Undoing a link gives the folder back as a project of its
// own, but the hours already joined stay with the kept project: the file keeps a join { from, to, until } for them, so
// the ledger never counts them twice (the logs would book them under the folder's own id again). Written whole and
// renamed; only known fields of this version are read back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './atomic.mjs';
import { PROJECT_ID_RE, normPath, slugify } from './util.mjs';
import { isLocalAbsolute } from './platform.mjs';

export const RELINKS_FILE = 'relinks.json';
const VERSION = 1;
export const RELINKS_MAX = 200;
const FILE_MAX = 256 * 1024;

const relinksPath = (hubDir) => (hubDir ? path.join(hubDir, 'registry', RELINKS_FILE) : null);
const time = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : null);
const folder = (x) => typeof x === 'string' && x.length > 0 && x.length <= 1024 && !/[\u0000-\u001f]/.test(x) && isLocalAbsolute(x);

// One link, known fields of known shapes only (null: not one)
export function relinkOf(l) {
  if (!l || typeof l !== 'object') return null;
  if (typeof l.id !== 'string' || !PROJECT_ID_RE.test(l.id) || !folder(l.path) || !folder(l.oldPath) || !time(l.at)) return null;
  const from = typeof l.from === 'string' && PROJECT_ID_RE.test(l.from) && l.from !== l.id ? l.from : null;
  return { id: l.id, path: l.path, oldPath: l.oldPath, from, at: time(l.at) };
}

// The hours of an undone link that stay with the kept project: { from, to, until } (null: not one)
export function joinOf(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.from !== 'string' || !PROJECT_ID_RE.test(j.from) || typeof j.to !== 'string' || !PROJECT_ID_RE.test(j.to) || j.from === j.to || !time(j.until)) return null;
  return { from: j.from, to: j.to, until: time(j.until) };
}

// A file that is there but cannot be read is said once per state of the file (the catalog reads it at every load): its
// links and joins do not apply while it is so, and the hours they joined may then show under both ids
let unreadable = '';
function readFile(hubDir) {
  const file = relinksPath(hubDir);
  if (!file) return null;
  let st = null;
  try {
    st = fs.lstatSync(file);
    if (!st.isFile() || st.size > FILE_MAX) throw Object.assign(new Error('not a file of its size'), { code: 'not-read' });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== VERSION) throw Object.assign(new Error('another version'), { code: 'version' });
    unreadable = '';
    return data;
  } catch (e) {
    const key = st ? `${st.size}:${st.mtimeMs}` : '';
    if (st && key !== unreadable) {
      unreadable = key;
      console.error(`project links (${RELINKS_FILE}) not read (${e?.code || 'invalid'}): they do not apply until it is fixed`);
    }
    return null;
  }
}

// The links, the newest last; a project linked twice keeps its newest link. [] without a hub or a readable file
export function readRelinks(hubDir) {
  const data = readFile(hubDir);
  if (!Array.isArray(data?.links)) return [];
  const byId = new Map();
  for (const l of data.links.map(relinkOf).filter(Boolean)) {
    byId.delete(l.id);
    byId.set(l.id, l);
  }
  return [...byId.values()].slice(-RELINKS_MAX);
}

// The joins of undone links, the newest last; one folder id keeps its newest join
export function readJoins(hubDir) {
  const data = readFile(hubDir);
  if (!Array.isArray(data?.joins)) return [];
  const byFrom = new Map();
  for (const j of data.joins.map(joinOf).filter(Boolean)) {
    byFrom.delete(j.from);
    byFrom.set(j.from, j);
  }
  return [...byFrom.values()].slice(-RELINKS_MAX);
}

// Writes the links and the joins (atomic; the joins as they are unless given). Never throws: false when not written
export function writeRelinks(hubDir, links, joins = readJoins(hubDir)) {
  const file = relinksPath(hubDir);
  if (!file) return false;
  const clean = links.map(relinkOf).filter(Boolean).slice(-RELINKS_MAX);
  const kept = joins.map(joinOf).filter(Boolean).slice(-RELINKS_MAX);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ version: VERSION, links: clean, joins: kept }), { tmp: `${file}.${crypto.randomBytes(4).toString('hex')}.tmp` });
    return true;
  } catch (e) {
    console.error('project links not written:', e?.code || 'error');
    return false;
  }
}

// What linking a project to a folder would do (the preview, and the check before writing; nothing is written here).
// catalog: the Catalog; projectId: the project kept; folder: a folder the person picked, or from: the listed project
// whose folder it is; counts(id): { points, jobs } a project holds in the hub (restore points, job results);
// sessions(id): how many sessions the app knows of it. -> { ok: true, kept, folder, from, joining, counts } or
// { ok: false, problem }:
//   not-a-project, not-moved (its folder is still there: nothing to link), already-linked (undo that link first),
//   folder rules of a new project (catalog.mjs checkNewProjectFolder: broad, home, hub, personal, missing, link,
//   network, ...), same-folder, another-project (the folder belongs to a registered or linked project, or lies inside
//   another listed project's folder), holds-projects (other listed projects live inside it: their sessions would join),
//   new-folder-has-points (the new folder's own project holds restore points or job results: they would not follow, so
//   the link is refused rather than leave them behind), folder-joined (an undone link of another project keeps that
//   folder's earlier hours: one folder id joins one project only, or its hours would be counted twice).
// planId: a digest of what was shown (the kept project, the folder, the project that joins); the link is written only
// when the plan still has it (actions.mjs).
export function planRelink({ catalog, projectId, folder = null, from = null, appDir = null, counts = (_id) => ({ points: 0, jobs: 0 }), sessions = (_id) => 0 }) {
  const fail = (problem) => ({ ok: false, problem });
  const kept = catalog?.getProject?.(projectId);
  if (!kept || kept.tmpOnly || kept.broad) return fail('not-a-project');
  if (kept.linked) return fail('already-linked');
  if (kept.exists !== false) return fail('not-moved');
  let target = folder;
  if (from) {
    const cand = catalog.getProject(from);
    if (!cand || cand.kind !== 'adhoc' || !cand.path || cand.id === kept.id) return fail('another-project');
    target = cand.path;
  }
  const check = catalog.checkNewProjectFolder(target, { appDir });
  if (!check.ok) return fail(check.reason);
  const oldPath = kept.path;
  const n = normPath(check.path);
  if (typeof oldPath === 'string' && normPath(oldPath) === n) return fail('same-folder');
  // The folder's own project now: none, an unregistered one of exactly this folder (it joins), or one that may not be
  // taken (registered, linked, or a project whose folder holds this one: its other sessions are not this folder's)
  const own = catalog.knownProjectFor(check.path);
  if (own && own.id !== kept.id && (own.kind !== 'adhoc' || own.linked || normPath(own.path) !== n)) return fail('another-project');
  const joiningId = own && own.id !== kept.id ? own.id : null;
  // Listed projects inside the folder: as the kept project's folder it would take their sessions over
  const inside = (catalog.allProjects?.() || []).some((p) => p.id !== kept.id && p.id !== joiningId && p.path && !p.tmpOnly && !p.broad && normPath(p.path).startsWith(`${n}/`));
  if (inside) return fail('holds-projects');
  const joining = joiningId ? { id: joiningId, ...counts(joiningId), sessions: sessions(joiningId) } : null;
  if (joining && (joining.points || joining.jobs)) return fail('new-folder-has-points');
  // The folder's id: its listed project's, or the one it takes when it is listed (made from its path, as the catalog
  // makes it), so the refusal holds while the folder is not listed again yet
  const folderId = joiningId || catalog.adhocIdFor?.(n, slugify(n).toLowerCase()) || null;
  if (folderId && (catalog.joins || []).some((j) => j.from === folderId && j.to !== kept.id)) return fail('folder-joined');
  const planId = crypto.createHash('sha256').update(JSON.stringify([kept.id, n, joiningId])).digest('hex').slice(0, 16);
  return { ok: true, planId, kept: { id: kept.id, name: kept.name, oldPath, ...counts(kept.id), sessions: sessions(kept.id) }, folder: check.path, from: joiningId, joining };
}

// Adds a project's link. Returns the links written, or null when it could not be written (or was not a valid link)
export function setRelink(hubDir, id, link) {
  const links = readRelinks(hubDir).filter((l) => l.id !== id);
  links.push(link);
  // A join of an earlier undo from the same folder id is taken over by the link (it joins all of that id's hours)
  const joins = readJoins(hubDir).filter((j) => !(link?.from && j.from === link.from && j.to === id));
  if (!writeRelinks(hubDir, links, joins)) return null;
  const written = readRelinks(hubDir);
  return written.some((l) => l.id === id) ? written : null;
}

// Undoes a project's link. The folder becomes a project of its own again; the hours its own id had joined until now
// stay with the kept project (a join), so they are neither lost nor counted twice. folderId: the id the folder takes
// again when the link had none (it was not listed then; its sessions were booked under the kept project all the same).
// Returns the links, or null
export function removeRelink(hubDir, id, now = Date.now(), { folderId = null } = {}) {
  const all = readRelinks(hubDir);
  const link = all.find((l) => l.id === id);
  if (!link) return null;
  const from = link.from || folderId;
  const joins = readJoins(hubDir).filter((j) => !(j.from === from && j.to === id));
  if (from && from !== id) joins.push({ from, to: id, until: now });
  if (!writeRelinks(hubDir, all.filter((l) => l.id !== id), joins)) return null;
  const written = readRelinks(hubDir);
  return written.some((l) => l.id === id) ? null : written;
}
