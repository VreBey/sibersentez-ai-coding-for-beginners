// Open Claude Code sessions: ~/.claude/sessions/<pid>.json (busy/idle state).
// Only *.json is read; the .key files next to them are left alone.
// Windows reuses PIDs: so that a record left by a crashed session does not show a "ghost" session when its PID passes to
// another process, the process start time is compared with procStart in the record
// (both are FILETIME).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SESSIONS_DIR } from './config.mjs';
import { readJson, isAlive } from './util.mjs';

const EPOCH_DIFF_MS = 11644473600000; // between 1601-01-01 and 1970-01-01
const BACKOFF_MS = [10000, 60000, 300000]; // gap after 0, 1, 2+ failed reads in a row
// Control characters in a session's waitingFor text become spaces
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

// FILETIME (1601'den beri 100 ns) -> Unix ms
export function filetimeMs(ft) {
  try {
    return Number(BigInt(String(ft)) / 10000n) - EPOCH_DIFF_MS;
  } catch {
    return NaN;
  }
}

// WMI rounds the start time to microseconds, the value in the record is 100 ns precise: 1 ms tolerance.
// It is practically impossible for another process that took over the PID to have started in the same millisecond.
export function sameStart(a, b) {
  try {
    const d = BigInt(String(a)) - BigInt(String(b));
    return d > -10000n && d < 10000n;
  } catch {
    return false;
  }
}

// Pure decision (tested directly). table: pid -> start FILETIME, tableAt: the moment the table
// STARTED being taken (ms).
// 'live'  the process at the PID is the same as the one in the record.
// 'dead'  The table started being taken after the process started, but this process is not at that PID: the process was
//         already dead by then (the PID passed to another or is empty). A dead process does not come back.
// 'check' No table, or older than the process: it may not have seen this process. It is read again, and until then
//         counted as live. Equality is also 'check': a read that started in the same millisecond
//         may have missed the process, and one more look is cheap.
export function liveVerdict(procStart, pid, table, tableAt) {
  const ft = table ? table.get(pid) : undefined;
  if (ft !== undefined && sameStart(ft, procStart)) return 'live';
  const startMs = filetimeMs(procStart);
  if (!Number.isFinite(startMs)) return 'live'; // unreadable procStart: only "is it alive"
  if (!table) return 'check';
  return tableAt > startMs ? 'dead' : 'check';
}

// Gap before the next read (pure): 10 s normally, 60 s after one failed read, 300 s after two or more in a row. One
// success sets the failure count back to 0. While reads fail, the sessions count as live (liveVerdict says 'check').
export function refreshGapMs(failures) {
  const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
}

let failures = 0; // failed reads in a row
let startTimes = null; // pid -> FILETIME (string); null = not read yet
let startTimesAt = 0;
let refreshing = false;
let inflightAt = 0; // start of the read in progress
let lastBegan = 0;
let again = false; // a newer read was requested while one was running
let timer = null;

// Win32_Process.CreationDate is readable for all processes, including those started as administrator;
// Get-Process's StartTime stayed empty for processes without access permission.
const SCRIPT = "Get-CimInstance Win32_Process -Property ProcessId,CreationDate | ForEach-Object { if ($_.CreationDate) { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() } }";

function runRefresh() {
  refreshing = true;
  const began = Date.now();
  inflightAt = began;
  lastBegan = began;
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 30000, maxBuffer: 4 << 20 }, (err, stdout) => {
    refreshing = false;
    if (!err) {
      const m = new Map();
      for (const line of String(stdout).split(/\r?\n/)) {
        const [pid, ft] = line.trim().split(' ');
        if (pid && ft) m.set(Number(pid), ft);
      }
      startTimes = m;
      startTimesAt = began;
      failures = 0;
    } else {
      failures++;
    }
    if (again) {
      again = false;
      requestRefresh(Infinity);
    }
  });
}

// Ask for a read that started after `after`. If a running or scheduled read already
// satisfies it, no new one is opened; at least MIN_GAP_MS is left between reads.
function requestRefresh(after) {
  if (refreshing) {
    if (!(inflightAt > after)) again = true;
    return;
  }
  if (timer) return; // a scheduled read will start after now: it satisfies every request
  const wait = Math.max(0, lastBegan + refreshGapMs(failures) - Date.now());
  timer = setTimeout(() => {
    timer = null;
    runRefresh();
  }, wait);
  timer.unref?.();
}

// PowerShell takes ~0.7 s of CPU per call: it runs not continuously, only when a session that cannot be
// verified shows up, and every 5 minutes for safety (for a dead session whose PID was taken over at once)
export function startLiveVerifier() {
  runRefresh();
  setInterval(() => requestRefresh(Infinity), 5 * 60000).unref();
}

function sameProcess(d) {
  if (!isAlive(d.pid)) return false;
  if (!d.procStart) return true;
  const v = liveVerdict(d.procStart, d.pid, startTimes, startTimesAt);
  if (v === 'check') requestRefresh(filetimeMs(d.procStart));
  return v !== 'dead';
}

// A session file's state (pure): Claude Code writes busy, idle, or waiting while it asks the person something (a
// permission, a dialog, input needed); waitingFor then says what in a few words ("dialog open", "input needed"), kept
// short and printable. Anything else is idle.
export function liveStatus(d) {
  const status = d?.status === 'busy' ? 'busy' : d?.status === 'waiting' ? 'waiting' : 'idle';
  const waitingFor = status === 'waiting' && typeof d.waitingFor === 'string' ? d.waitingFor.replace(CONTROL_RE, ' ').trim().slice(0, 80) : '';
  return { status, waitingFor };
}

export function readLiveSessions() {
  const out = new Map();
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const d = readJson(path.join(SESSIONS_DIR, n));
    if (!d?.sessionId || !d.pid || !sameProcess(d)) continue;
    out.set(d.sessionId, {
      pid: d.pid,
      ...liveStatus(d),
      name: d.name || '',
      cwd: d.cwd || '',
      kind: d.kind || '',
      entrypoint: d.entrypoint || '',
      version: d.version || '',
      startedAt: d.startedAt || 0,
      updatedAt: d.updatedAt || 0,
      statusUpdatedAt: d.statusUpdatedAt || d.updatedAt || 0,
    });
  }
  return out;
}
