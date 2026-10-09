// @ts-check
// "A new version is out" (roadmap F3a, 2026-10-08). Off unless the person turned it on in Settings (the owner's choice:
// by default SiberSentez reaches nothing outside this computer). On, the page asks GET /api/update at most once a day;
// the server then asks GitHub's API for the latest release of SiberSentez's own repository and answers whether it is
// newer than this one. Nothing is sent but that one request (no identifier, no data of the person), nothing is
// downloaded or installed: the page shows the release page's link.
import fs from 'node:fs';
import https from 'node:https';
import { writeFileAtomic } from './atomic.mjs';

export const REPO = Object.freeze({ owner: 'VreBey', name: 'sibersentez-ai-coding-for-beginners' });
export const LATEST_URL = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/latest`;
// The release page the answer may name: this repository's releases only
const RELEASE_PAGE_RE = new RegExp(`^https://github\\.com/${REPO.owner}/${REPO.name}/releases/tag/v?\\d+\\.\\d+\\.\\d+[\\w.-]{0,20}$`);
const VERSION_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})([\w.-]{0,20})$/;
export const UPDATE_CHECK_FILE = 'update-check.json';
export const CHECK_TTL_MS = 24 * 3600 * 1000;
export const FAIL_TTL_MS = 3600 * 1000;
const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 256 * 1024;

// "1.2.3" or "v1.2.3" -> [1, 2, 3, pre]; null for anything else
export function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''] : null;
}

// Whether a is newer than b (pure). A pre-release ("0.17.0-beta") counts below its release; unknown versions are never newer
export function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (x[3] === y[3]) return false;
  return !x[3] && !!y[3];
}

// What GitHub's answer says (pure): { version, url } of a published, non-draft, non-pre-release release, or null
export function parseLatest(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
  const v = parseVersion(tag);
  if (!v || v[3]) return null;
  const url = typeof json.html_url === 'string' && RELEASE_PAGE_RE.test(json.html_url) ? json.html_url : null;
  return { version: `${v[0]}.${v[1]}.${v[2]}`, url: url || `https://github.com/${REPO.owner}/${REPO.name}/releases/latest` };
}

// One HTTPS GET to GitHub's API, its JSON or a reason; never follows a redirect, never reads more than MAX_BYTES
function defaultGet(url, { timeoutMs = TIMEOUT_MS, version = '0' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': `SiberSentez/${version}`, Accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish({ ok: false, reason: res.statusCode === 404 ? 'no-release' : res.statusCode === 403 || res.statusCode === 429 ? 'rate-limited' : 'http' });
        }
        let n = 0;
        const chunks = [];
        res.on('data', (c) => {
          n += c.length;
          if (n > MAX_BYTES) {
            req.destroy();
            return finish({ ok: false, reason: 'too-large' });
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            finish({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            finish({ ok: false, reason: 'bad-answer' });
          }
        });
        res.on('error', () => finish({ ok: false, reason: 'network' }));
      });
    } catch {
      return finish({ ok: false, reason: 'network' });
    }
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: 'timeout' });
    });
    req.on('error', () => finish({ ok: false, reason: 'network' }));
  });
}

// The last answer kept on disk (file: <hub>/update-check.json), so starting the app again does not ask again (review
// 2026-10-08: kept in memory only, every start asked). Read back only when it is well formed, for this same version
// and not from the future; anything else is as if never asked. Written whole through a temporary file; a failed write
// only means the next start asks once more.
export function readLast(file, current, now = Date.now) {
  if (!file) return null;
  let a;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4096) return null;
    a = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!a || typeof a !== 'object' || !Number.isFinite(a.checkedAt) || a.checkedAt > now() || (a.current || null) !== (current || null)) return null;
  if (a.ok !== true) return typeof a.reason === 'string' && /^[a-z-]{1,24}$/.test(a.reason) ? { ok: false, reason: a.reason, current: current || null, checkedAt: a.checkedAt } : null;
  const v = parseVersion(a.latest);
  if (!v || v[3]) return null;
  const latest = `${v[0]}.${v[1]}.${v[2]}`;
  const url = typeof a.url === 'string' && RELEASE_PAGE_RE.test(a.url) ? a.url : `https://github.com/${REPO.owner}/${REPO.name}/releases/latest`;
  return { ok: true, current: current || null, latest, newer: isNewer(latest, current), url, checkedAt: a.checkedAt };
}
function saveLast(file, a) {
  if (!file) return;
  try {
    // A new temporary file only (never through a link or over a file left there), then one rename
    writeFileAtomic(file, JSON.stringify(a));
  } catch {
    /* not kept: the next start asks again */
  }
}

// The checker: one request at a time, an answer kept CHECK_TTL_MS (a failure FAIL_TTL_MS), also across starts when file
// is given, so a page that asks on every start never asks GitHub more than once a day. check() -> { ok, current,
// latest, newer, url, checkedAt } or { ok: false, reason, current }.
/** @param {{ current?: string, get?: (url: string, o?: { timeoutMs?: number, version?: string }) => Promise<any>, now?: () => number, file?: string | null }} [options] */
export function createUpdateChecker({ current, get = defaultGet, now = Date.now, file = null } = {}) {
  let last = readLast(file, current, now);
  let running = null;
  async function run() {
    const r = await get(LATEST_URL, { version: current || '0' });
    if (!r?.ok) return { ok: false, reason: r?.reason || 'network', current: current || null, checkedAt: now() };
    const latest = parseLatest(r.json);
    if (!latest) return { ok: false, reason: 'no-release', current: current || null, checkedAt: now() };
    return { ok: true, current: current || null, latest: latest.version, newer: isNewer(latest.version, current), url: latest.url, checkedAt: now() };
  }
  function check() {
    if (last && now() - last.checkedAt < (last.ok ? CHECK_TTL_MS : FAIL_TTL_MS)) return Promise.resolve(last);
    if (!running) {
      running = run()
        .then((a) => {
          saveLast(file, a);
          return (last = a);
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }
  return { check, last: () => last };
}
