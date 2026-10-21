// Electron's own advisories (independent review of 0.20.0). Electron is a dev dependency, since the installer bundles
// it, so `npm audit --omit=dev` never looks at it; yet it is the app's runtime (Chromium and Node). This asks npm's
// audit for the whole tree and fails only on an advisory against the electron package itself: @electron/get, which
// only downloads Electron while it is installed, and the other build tools are checked by hand (docs/release.md).
// Run: node tools/audit-electron.mjs (exit 0: none; 1: advisories, each printed; 2: the audit could not be read)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUNTIME_PACKAGES = Object.freeze(['electron']);

// Whether npm's answer is an audit at all: a failed request (no registry, a blocked endpoint) prints JSON too, with an
// error and no vulnerabilities, which must never read as "none found"
/** @param {any} report */
export function isAuditReport(report) {
  return !!report && typeof report === 'object' && !report.error && !!report.vulnerabilities && typeof report.vulnerabilities === 'object' && !!report.metadata && typeof report.metadata === 'object';
}

// The advisories npm's audit JSON lists against the runtime packages themselves: [{ name, severity, titles }]. An entry
// npm adds only because a dependency of the package is affected (its via holds names, such as @electron/get, which only
// downloads Electron at install time) is not one: the dependency is checked by hand with the other build tools.
/** @param {any} report */
export function runtimeAdvisories(report) {
  const out = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities || {})) {
    if (!RUNTIME_PACKAGES.includes(name) || !v || typeof v !== 'object') continue;
    const own = (Array.isArray(v.via) ? v.via : []).filter((x) => x && typeof x === 'object');
    if (!own.length) continue;
    out.push({ name, severity: String(v.severity || 'unknown'), titles: own.map((x) => String(x.title || x.url || '')).filter(Boolean) });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let text = '';
  try {
    text = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    // npm audit exits 1 when it finds anything at all (the build tools' known ones too): its report is still on stdout
    text = e?.stdout || '';
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    report = null;
  }
  if (!isAuditReport(report)) {
    console.error(`audit-electron: npm audit gave no report${report?.message ? `: ${report.message}` : ''}`);
    process.exit(2);
  }
  const found = runtimeAdvisories(report);
  for (const f of found) console.log(`${f.name}: ${f.severity}${f.titles.length ? ` (${f.titles.join('; ')})` : ''}`);
  console.log(found.length ? `audit-electron: ${found.length} advisory` : 'audit-electron: no advisory against Electron');
  process.exit(found.length ? 1 : 0);
}
