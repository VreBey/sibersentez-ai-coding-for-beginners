// Live usage tracking (docs/usage.md): tokens in and out of every Claude Code message and their API-equivalent cost,
// per hour, project and model, kept in a ledger that survives restarts and the deletion of old logs.
//
// Counting. Every assistant line of a log carries message.usage. Claude Code writes one line per content block of a
// response, so one response appears on several lines with the same message.id and requestId: the key of a message is
// "<message.id>|<requestId>" across all files (a sub-agent file can repeat a line of its parent session), or
// "<log file>|<message.id>" when there is no requestId. For one key every field keeps its largest value (older logs
// start a response with a small output_tokens and grow it), so reading a line twice never counts it twice.
// Lines of the synthetic model are not counted. The message is booked in the hour and the project of its first line.
//
// Where the numbers come from. Messages of the last HORIZON_DAYS days are counted from the logs on every start: the
// log reader (server/ingest.mjs) hands its assistant lines over, and scanOlderLogs() reads the log files that reader
// skips (older than its own window) itself, parsing only lines that contain "usage". Hours older than the horizon
// are frozen: they come from the ledger file only. Per hour and project the ledger file and the counted logs are
// compared and the side with more messages wins (ties go to the logs), so a restart never adds a message twice, a
// half-written hour is replaced by the complete one, and the history stays when Claude Code deletes old logs.
//
// File: <hub>/usage/ledger.json, the program's own memory (like registry/discovered.json: written whatever the
// actions mode is), written atomically (temporary file + rename), debounced. Without a hub the ledger lives in memory.
// A broken file, and one larger than LEDGER_MAX_BYTES (never read), is kept aside as ledger.json.broken and rebuilt
// from the logs; a copy set aside before keeps a time-stamped name (ledger.json.broken-<time>), at most BROKEN_KEPT in all.
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { PRICED_AT, costOf, priceOf } from './prices.mjs';

export const HOUR = 3600000;
const DAY = 86400000;
export const LEDGER_VERSION = 1;
// Messages newer than this are counted from the logs on every start (covers "30 days" and a whole calendar month)
export const HORIZON_DAYS = 32;
// Hour buckets older than this are folded into day buckets in the file
export const HOURS_KEPT_DAYS = 40;
export const PERIODS = Object.freeze(['24h', '7d', 'month', '30d']);
export const DAILY_DAYS = 30;
// Cell layout: the four token kinds (cache writes split by lifetime), then the message count
export const FIELDS = Object.freeze(['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']);
const MSG = 5;
const CELL = 6;

export function ledgerFile(hubDir) {
  return hubDir ? path.join(hubDir, 'usage', 'ledger.json') : null;
}

// A ledger file larger than this is not read (reading and parsing it would hold the server start); a real one stays
// far below it (hours are folded into days after HOURS_KEPT_DAYS)
export const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
// Set-aside copies kept: ledger.json.broken (the newest) and the older time-stamped ones
export const BROKEN_KEPT = 3;

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// message.usage -> [input, cacheWrite5m, cacheWrite1h, cacheRead, output]. The cache write split comes from
// cache_creation.ephemeral_5m/1h_input_tokens; a log without the split books the whole write as 5-minute.
export function usageValues(u) {
  if (!u || typeof u !== 'object') return [0, 0, 0, 0, 0];
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
  const w1h = count(cc.ephemeral_1h_input_tokens);
  const w5 = cc.ephemeral_5m_input_tokens !== undefined && cc.ephemeral_5m_input_tokens !== null ? count(cc.ephemeral_5m_input_tokens) : Math.max(0, count(u.cache_creation_input_tokens) - w1h);
  return [count(u.input_tokens), w5, w1h, count(u.cache_read_input_tokens), count(u.output_tokens)];
}

// Key of the message on a log line: "<id>|<requestId>", or "<fileKey>|<id>" without a requestId; null without an id
export function usageKey(o, fileKey) {
  const id = o?.message?.id;
  if (typeof id !== 'string' || !id) return null;
  const req = typeof o.requestId === 'string' && o.requestId ? o.requestId : '';
  return req ? `${id}|${req}` : `${fileKey || '?'}|${id}`;
}

const pad = (n) => String(n).padStart(2, '0');
// Local calendar day of an instant: 'YYYY-MM-DD'
export function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Hour bucket <-> its label in the file (UTC, readable): 2026-09-29T07
export const hourLabel = (h) => new Date(h * HOUR).toISOString().slice(0, 13);
export function parseHourLabel(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}:00:00Z`);
  return Number.isFinite(t) ? t / HOUR : null;
}

// Hours of a period, ending with the current hour. 24h, 7d and 30d slide in whole hours, like the panel's other
// "24 h" numbers (the current hour plus the 23 before it); month starts at local midnight of the 1st.
export function periodRange(period, now = Date.now()) {
  const toHour = Math.floor(now / HOUR);
  let fromHour;
  if (period === 'month') {
    const d = new Date(now);
    fromHour = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / HOUR);
  } else {
    const hours = period === '7d' ? 7 * 24 : period === '30d' ? 30 * 24 : 24;
    fromHour = toHour - hours + 1;
  }
  return { fromHour, toHour, from: fromHour * HOUR, to: now };
}

// The last `days` local days, oldest first, as { day, start } (start: local midnight in ms)
export function lastLocalDays(days, now = Date.now()) {
  const d = new Date(now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push({ day: localDay(x.getTime()), start: x.getTime() });
  }
  return out;
}

const newCell = () => new Array(CELL).fill(0);
const msgsOf = (models) => {
  let n = 0;
  for (const c of models.values()) n += c[MSG];
  return n;
};
const copyModels = (models) => new Map([...models].map(([m, c]) => [m, c.slice()]));

function cellFrom(v) {
  if (!Array.isArray(v) || v.length !== CELL) return null;
  const c = v.map(count);
  return c.some((x) => x > 0) ? c : null;
}

// { pid: { model: [6 numbers] } } from the file -> Map(pid -> Map(model -> cell)); bad rows are skipped
function readProjects(obj) {
  const out = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [pid, models] of Object.entries(obj)) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    const mm = new Map();
    for (const [model, v] of Object.entries(models)) {
      const c = cellFrom(v);
      if (c && model) mm.set(model, c);
    }
    if (mm.size) out.set(pid, mm);
  }
  return out;
}

const writeProjects = (pm) => Object.fromEntries([...pm].sort((a, b) => a[0].localeCompare(b[0])).map(([pid, mm]) => [pid, Object.fromEntries([...mm].sort((a, b) => a[0].localeCompare(b[0])).map(([m, c]) => [m, c]))]));

// Totals of Map(model -> cell) (or several added up): token kinds, messages, "processed" (new input + cache writes
// + output: what the model really worked through), the cache share of all input, API-equivalent dollars and the
// models without a price (their tokens are counted, their dollars are not: usdPartial)
export function totalsOf(models) {
  const s = newCell();
  let usd = 0;
  const unpriced = [];
  for (const [model, c] of models) {
    for (let i = 0; i < CELL; i++) s[i] += c[i];
    const cost = costOf(model, { input: c[0], cacheWrite5m: c[1], cacheWrite1h: c[2], cacheRead: c[3], output: c[4] });
    if (cost === null) {
      if (c[MSG] || c[0] || c[1] || c[2] || c[3] || c[4]) unpriced.push(model);
    } else usd += cost;
  }
  const cacheWrite = s[1] + s[2];
  const allInput = s[0] + cacheWrite + s[3];
  return {
    input: s[0],
    cacheWrite5m: s[1],
    cacheWrite1h: s[2],
    cacheWrite,
    cacheRead: s[3],
    output: s[4],
    messages: s[MSG],
    processed: s[0] + cacheWrite + s[4],
    cacheShare: allInput ? s[3] / allInput : 0,
    usd: Math.round(usd * 100) / 100,
    usdPartial: unpriced.length > 0,
    unpriced: unpriced.sort(),
  };
}

// Add the cells of Map(model -> cell) into another such map
function addModels(into, models) {
  for (const [m, c] of models) {
    let t = into.get(m);
    if (!t) into.set(m, (t = newCell()));
    for (let i = 0; i < CELL; i++) t[i] += c[i];
  }
}

// The compact totals the snapshot carries (strip, project cards)
function compact(t) {
  return { input: t.input, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output, processed: t.processed, messages: t.messages, cacheShare: t.cacheShare, usd: t.usd, usdPartial: t.usdPartial };
}

export class UsageLedger {
  // hubDir null: memory only. debounceMs 0: every change is written at once (tests). now(): the clock (tests).
  // apiKeyEnv: ANTHROPIC_API_KEY is set in the server's environment (the page warns that the ~$ may then be a real bill).
  constructor({ hubDir = null, now = () => Date.now(), log = (line) => console.warn(line), debounceMs = 15000, horizonDays = HORIZON_DAYS, apiKeyEnv = false } = {}) {
    this.apiKeyEnv = apiKeyEnv === true;
    this.file = ledgerFile(hubDir);
    this.now = now;
    this.log = log;
    this.debounceMs = debounceMs;
    this.horizonDays = horizonDays;
    this.archive = { hours: new Map(), days: new Map() }; // from the file: hour -> pid -> model -> cell; day -> ...
    this.fresh = new Map(); // counted from the logs in this run: hour -> pid -> model -> cell
    this.keys = new Map(); // message key -> { h, pid, cell, v: [5 largest values] }
    this.version = 0;
    this.state = 'ready'; // 'scanning' while the logs of the horizon are still being read (server/index.mjs)
    this.scanInfo = { done: 0, total: 0 };
    this.touched = new Set(); // projects whose numbers changed since takeTouched()
    this.dirty = false;
    this.timer = null;
    this.saves = 0;
    this.sentStamp = null; // the stamp the last patch carried (server/views.mjs)
    this.cache = null;
    this.load();
  }

  horizonHour() {
    return Math.floor((this.now() - this.horizonDays * DAY) / HOUR);
  }

  // ---------- counting ----------

  // One message line. t: ms or an ISO time; projectId: the project of the session (''/null: none); usage: the raw
  // message.usage. Returns true when a number changed.
  add({ key, t, projectId, model, usage }) {
    if (typeof key !== 'string' || !key || !usage || typeof usage !== 'object') return false;
    if (model === '<synthetic>') return false;
    const ms = typeof t === 'number' ? t : Date.parse(t);
    if (!Number.isFinite(ms) || ms <= 0) return false;
    const h = Math.floor(ms / HOUR);
    // Older than the horizon: that hour is frozen in the file (and its keys are forgotten, see sweep)
    if (h < this.horizonHour()) return false;
    const v = usageValues(usage);
    let rec = this.keys.get(key);
    let changed = false;
    if (!rec) {
      const pid = typeof projectId === 'string' ? projectId : '';
      rec = { h, pid, cell: this.freshCell(h, pid, typeof model === 'string' && model ? model : 'unknown'), v: [0, 0, 0, 0, 0] };
      this.keys.set(key, rec);
      rec.cell[MSG]++;
      changed = true;
    }
    for (let i = 0; i < 5; i++) {
      if (v[i] > rec.v[i]) {
        rec.cell[i] += v[i] - rec.v[i];
        rec.v[i] = v[i];
        changed = true;
      }
    }
    if (changed) {
      this.version++;
      this.touched.add(rec.pid);
      this.touch();
    }
    return changed;
  }

  // An assistant line from the log reader (server/ingest.mjs). fileKey names the log file (used only for a message
  // without a requestId); projectId is the project the reader gave the session.
  line(o, { fileKey, projectId } = {}) {
    const m = o?.message;
    if (!m || !m.usage || !m.id) return false;
    return this.add({ key: usageKey(o, fileKey), t: o.timestamp, projectId, model: m.model, usage: m.usage });
  }

  freshCell(h, pid, model) {
    let pm = this.fresh.get(h);
    if (!pm) this.fresh.set(h, (pm = new Map()));
    let mm = pm.get(pid);
    if (!mm) pm.set(pid, (mm = new Map()));
    let c = mm.get(model);
    if (!c) mm.set(model, (c = newCell()));
    return c;
  }

  // ---------- the merged view ----------

  // [hour, projectId, Map(model -> cell)] for every hour from..to (inclusive): per hour and project the side with
  // more messages, the file or the logs of this run (ties: the logs)
  *cells(fromHour, toHour) {
    const hours = new Set();
    for (const h of this.fresh.keys()) if (h >= fromHour && h <= toHour) hours.add(h);
    for (const h of this.archive.hours.keys()) if (h >= fromHour && h <= toHour) hours.add(h);
    for (const h of hours) {
      const f = this.fresh.get(h);
      const a = this.archive.hours.get(h);
      const pids = new Set([...(f ? f.keys() : []), ...(a ? a.keys() : [])]);
      for (const pid of pids) {
        const fm = f?.get(pid);
        const am = a?.get(pid);
        const pick = !am ? fm : !fm ? am : msgsOf(am) > msgsOf(fm) ? am : fm;
        if (pick && pick.size) yield [h, pid, pick];
      }
    }
  }

  // Report of one period (GET /api/usage): totals, per project (without projectId), per model, per local day for
  // the last DAILY_DAYS days, the price table date and the models without a price.
  // nameOf(projectId) -> the project's name or null.
  report(period, { projectId = null, nameOf = () => null } = {}) {
    const now = this.now();
    const r = periodRange(period, now);
    const all = new Map();
    const byProject = new Map();
    for (const [, pid, mm] of this.cells(r.fromHour, r.toHour)) {
      if (projectId !== null && pid !== projectId) continue;
      addModels(all, mm);
      if (projectId === null) {
        let pm = byProject.get(pid);
        if (!pm) byProject.set(pid, (pm = new Map()));
        addModels(pm, mm);
      }
    }
    const totals = totalsOf(all);
    const noList = ({ unpriced, ...t }) => t;
    const models = [...all]
      .map(([model, c]) => ({ model, priced: !!priceOf(model), ...noList(totalsOf(new Map([[model, c]]))) }))
      .sort((a, b) => b.usd - a.usd || b.processed - a.processed || a.model.localeCompare(b.model));
    const projects =
      projectId === null
        ? [...byProject]
            .map(([id, mm]) => ({ id, name: nameOf(id) || null, ...noList(totalsOf(mm)) }))
            .sort((a, b) => b.usd - a.usd || b.processed - a.processed || a.id.localeCompare(b.id))
        : undefined;
    const days = lastLocalDays(DAILY_DAYS, now);
    const perDay = new Map(days.map((d) => [d.day, new Map()]));
    for (const [h, pid, mm] of this.cells(Math.floor(days[0].start / HOUR), r.toHour)) {
      if (projectId !== null && pid !== projectId) continue;
      const bucket = perDay.get(localDay(h * HOUR));
      if (bucket) addModels(bucket, mm);
    }
    const daily = days.map((d) => {
      const t = totalsOf(perDay.get(d.day));
      return { day: d.day, processed: t.processed, cacheRead: t.cacheRead, output: t.output, messages: t.messages, usd: t.usd };
    });
    const { unpriced, ...rest } = totals;
    return {
      period,
      from: r.from,
      to: r.to,
      ready: this.state === 'ready',
      scanning: this.state !== 'ready',
      pricedAt: PRICED_AT,
      projectId: projectId === null ? undefined : projectId,
      totals: rest,
      projects,
      models,
      daily,
      unpriced,
    };
  }

  // What the snapshot and every patch carry: compact totals of the four periods and, per project, the last 30 days
  // (the project cards). Cached until a number changes or the hour turns.
  summary() {
    const now = this.now();
    const hour = Math.floor(now / HOUR);
    if (this.cache && this.cache.version === this.version && this.cache.hour === hour && this.cache.state === this.state) return this.cache.value;
    const ranges = Object.fromEntries(PERIODS.map((p) => [p, periodRange(p, now)]));
    const minHour = Math.min(...Object.values(ranges).map((r) => r.fromHour));
    const sums = Object.fromEntries(PERIODS.map((p) => [p, new Map()]));
    const perProject = new Map();
    const from30 = ranges['30d'].fromHour;
    for (const [h, pid, mm] of this.cells(minHour, hour)) {
      for (const p of PERIODS) if (h >= ranges[p].fromHour) addModels(sums[p], mm);
      if (h >= from30) {
        let pm = perProject.get(pid);
        if (!pm) perProject.set(pid, (pm = new Map()));
        addModels(pm, mm);
      }
    }
    const unpriced = new Set();
    const periods = {};
    for (const p of PERIODS) {
      const t = totalsOf(sums[p]);
      for (const m of t.unpriced) unpriced.add(m);
      periods[p] = { ...compact(t), from: ranges[p].from };
    }
    const projects = new Map([...perProject].map(([pid, mm]) => [pid, compact(totalsOf(mm))]));
    const value = { ready: this.state === 'ready', scanning: this.state !== 'ready', pricedAt: PRICED_AT, periods, unpriced: [...unpriced].sort(), apiKeyEnv: this.apiKeyEnv };
    this.cache = { version: this.version, hour, state: this.state, value, projects };
    return value;
  }

  // A project's last 30 days (compact totals), or null when it has none
  projectUsage(pid) {
    this.summary();
    return this.cache.projects.get(pid) || null;
  }

  // Changes when a number, the hour or the scan state changes: a patch is sent when it differs from sentStamp
  stamp() {
    return `${this.version}:${Math.floor(this.now() / HOUR)}:${this.state}`;
  }

  // Projects whose numbers changed since the last call (the patch sends their cards again)
  takeTouched() {
    const out = [...this.touched];
    this.touched.clear();
    return out;
  }

  // ---------- scan state ----------

  beginScan() {
    this.state = 'scanning';
    this.scanInfo = { done: 0, total: 0 };
    this.version++;
  }

  finishScan() {
    this.state = 'ready';
    this.version++;
    this.dirty = true;
    this.flush();
  }

  // Keys and log hours that left the horizon: a line older than the horizon is ignored, so a forgotten key can never
  // be counted again; the hours move into the file's side of the merge (kept there, then folded into days)
  sweep() {
    const hz = this.horizonHour();
    for (const [k, rec] of this.keys) if (rec.h < hz) this.keys.delete(k);
    let moved = false;
    for (const [h, pm] of this.fresh) {
      if (h >= hz) continue;
      this.mergeHourIntoArchive(h, pm);
      this.fresh.delete(h);
      moved = true;
    }
    if (moved) {
      this.version++;
      this.touch();
    }
  }

  mergeHourIntoArchive(h, pm) {
    let a = this.archive.hours.get(h);
    if (!a) this.archive.hours.set(h, (a = new Map()));
    for (const [pid, mm] of pm) {
      const am = a.get(pid);
      if (!am || msgsOf(mm) >= msgsOf(am)) a.set(pid, copyModels(mm));
    }
  }

  // ---------- the file ----------

  load() {
    if (!this.file) return;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log(`usage ledger unreadable (${e?.code || 'error'}); rebuilt from the logs`);
      return;
    }
    if (size > LEDGER_MAX_BYTES) {
      this.log('usage ledger is larger than 8 MB; kept aside as ledger.json.broken (not read) and rebuilt from the logs');
      this.setAside();
      return;
    }
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log(`usage ledger unreadable (${e?.code || 'error'}); rebuilt from the logs`);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!obj(data) || data.version !== LEDGER_VERSION || !obj(data.hours) || !obj(data.days)) {
      this.log('usage ledger is broken; kept aside as ledger.json.broken and rebuilt from the logs');
      this.setAside();
      return;
    }
    for (const [label, pids] of Object.entries(data.hours)) {
      const h = parseHourLabel(label);
      if (h === null) continue;
      const pm = readProjects(pids);
      if (pm.size) this.archive.hours.set(h, pm);
    }
    for (const [day, pids] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const pm = readProjects(pids);
      if (pm.size) this.archive.days.set(day, pm);
    }
  }

  // Moves the ledger file aside as ledger.json.broken; it is rebuilt from the logs. A copy set aside before is never
  // written over: it moves on to ledger.json.broken-<its time> (a -N suffix when that name is taken), and only the
  // BROKEN_KEPT - 1 newest of those stay.
  setAside() {
    const broken = `${this.file}.broken`;
    try {
      if (fs.existsSync(broken)) {
        const stamp = new Date(fs.statSync(broken).mtimeMs).toISOString().replace(/[:.]/g, '-');
        let target = `${broken}-${stamp}`;
        for (let i = 1; fs.existsSync(target); i++) target = `${broken}-${stamp}-${i}`;
        fs.renameSync(broken, target);
      }
      fs.renameSync(this.file, broken);
    } catch {
      /* rebuilt anyway */
    }
    try {
      const dir = path.dirname(this.file);
      const head = `${path.basename(broken)}-`;
      const older = fs.readdirSync(dir).filter((n) => n.startsWith(head)).sort();
      for (const n of older.slice(0, Math.max(0, older.length - (BROKEN_KEPT - 1)))) fs.rmSync(path.join(dir, n), { force: true });
    } catch {
      /* tried again next time */
    }
    this.dirty = true;
  }

  // The merged view as the file holds it. The file's own side becomes the merged view (the merge is idempotent), and
  // hours older than HOURS_KEPT_DAYS are folded into their local day (each hour once: it leaves the hour map).
  toJSON() {
    for (const [h, pm] of this.fresh) this.mergeHourIntoArchive(h, pm);
    const keepFrom = Math.floor((this.now() - HOURS_KEPT_DAYS * DAY) / HOUR);
    for (const [h, pm] of [...this.archive.hours]) {
      if (h >= keepFrom) continue;
      const day = localDay(h * HOUR);
      let dm = this.archive.days.get(day);
      if (!dm) this.archive.days.set(day, (dm = new Map()));
      for (const [pid, mm] of pm) {
        let into = dm.get(pid);
        if (!into) dm.set(pid, (into = new Map()));
        addModels(into, mm);
      }
      this.archive.hours.delete(h);
    }
    const hours = {};
    for (const h of [...this.archive.hours.keys()].sort((a, b) => a - b)) hours[hourLabel(h)] = writeProjects(this.archive.hours.get(h));
    const days = {};
    for (const d of [...this.archive.days.keys()].sort()) days[d] = writeProjects(this.archive.days.get(d));
    return { version: LEDGER_VERSION, savedAt: new Date(this.now()).toISOString(), pricedAt: PRICED_AT, fields: [...FIELDS, 'messages'], hours, days };
  }

  touch() {
    this.dirty = true;
    if (!this.file || this.state !== 'ready') return; // written once the scan is done (finishScan)
    if (this.debounceMs <= 0) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  // Write now if there is anything to write. Atomic: a temporary file next to the target, then a rename.
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return false;
    const tmp = `${this.file}.tmp-${process.pid}-${this.saves}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON()) + '\n', 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`usage ledger could not be written (${e?.code || 'error'}); will retry`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      return false;
    }
    this.dirty = false;
    this.saves++;
    return true;
  }
}

// ---------- reading the logs the live reader skips ----------

const NEEDLE_USAGE = Buffer.from('"usage"');
const NEEDLE_CWD = Buffer.from('"cwd":"');
const NL = 10;

function parseAt(buf, a, b) {
  try {
    return JSON.parse(buf.toString('utf8', a, b));
  } catch {
    return null;
  }
}

// Reads a whole log file; onUsage(o) for each complete line that contains "usage" (parsed). Returns the file's first
// working directory (the "cwd" of its first line that has one), or null. Only lines holding a needle are parsed.
export async function readUsageLines(file, onUsage) {
  const fh = await open(file, 'r');
  let firstCwd = null;
  try {
    const { size } = await fh.stat();
    const chunk = 4 << 20;
    const buf = Buffer.allocUnsafe(chunk);
    let pos = 0;
    let carry = null;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(chunk, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = data.lastIndexOf(NL);
      if (end === -1) {
        carry = Buffer.from(data);
        continue;
      }
      if (firstCwd === null) {
        let p = data.indexOf(NEEDLE_CWD);
        while (p !== -1 && p < end && firstCwd === null) {
          const ls = data.lastIndexOf(NL, p) + 1;
          const le = data.indexOf(NL, p);
          const o = parseAt(data, ls, le);
          if (o && typeof o.cwd === 'string' && o.cwd) firstCwd = o.cwd;
          p = data.indexOf(NEEDLE_CWD, le + 1);
        }
      }
      let p = data.indexOf(NEEDLE_USAGE);
      while (p !== -1 && p < end) {
        const ls = data.lastIndexOf(NL, p) + 1;
        const le = data.indexOf(NL, p);
        const o = parseAt(data, ls, le);
        if (o) onUsage(o);
        p = data.indexOf(NEEDLE_USAGE, le + 1);
      }
      carry = end + 1 < data.length ? Buffer.from(data.subarray(end + 1)) : null;
    }
  } finally {
    await fh.close();
  }
  return firstCwd;
}

// Counts the log files of the horizon that the live reader does not read (their last change is older than its own
// window, `before`): main session files first, then sub-agent files, like the reader. A file's project follows the
// reader's rule: its first working directory through catalog.resolve; a sub-agent takes its session's project.
// ingest gives walk(), classify() and the sessions it knows. Progress in ledger.scanInfo.
export async function scanOlderLogs(ledger, { ingest, catalog, projectsDir, before }) {
  const from = ledger.now() - ledger.horizonDays * DAY;
  const rank = { main: 0, agent: 1 };
  const files = (await ingest.walk(projectsDir))
    .filter((f) => f.mtime >= from && f.mtime < before)
    .map((f) => ({ ...f, c: ingest.classify(f.abs) }))
    .filter((f) => f.c && (f.c.kind === 'main' || f.c.kind === 'agent'))
    .sort((a, b) => rank[a.c.kind] - rank[b.c.kind] || a.mtime - b.mtime);
  ledger.scanInfo = { done: 0, total: files.length };
  const sessionProject = new Map();
  const resolve = (cwd, slug) => {
    try {
      return catalog?.resolve ? catalog.resolve(cwd || null, slug) || '' : '';
    } catch {
      return '';
    }
  };
  let last = Date.now();
  for (const f of files) {
    // Only what counting needs is kept until the file's project is known (its first working directory)
    const lines = [];
    let cwd = null;
    try {
      cwd = await readUsageLines(f.abs, (o) => {
        const m = o.message;
        if (!m?.usage || !m.id || m.model === '<synthetic>') return;
        lines.push({ timestamp: o.timestamp, requestId: o.requestId, message: { id: m.id, model: m.model, usage: m.usage } });
      });
    } catch {
      // locked or deleted meanwhile: its messages come back with the next start
    }
    const fileKey = f.c.kind === 'agent' ? `${f.c.sessionId}/${f.c.agentId}` : f.c.sessionId;
    let pid;
    if (f.c.kind === 'main') {
      pid = resolve(cwd, f.c.slug);
      sessionProject.set(f.c.sessionId, pid);
    } else {
      pid = ingest.sessions?.get(f.c.sessionId)?.projectId || sessionProject.get(f.c.sessionId) || resolve(cwd, f.c.slug);
    }
    for (const o of lines) ledger.line(o, { fileKey, projectId: pid });
    ledger.scanInfo.done++;
    if (Date.now() - last > 100) {
      last = Date.now();
      await new Promise((r) => setImmediate(r));
    }
  }
  return files.length;
}
