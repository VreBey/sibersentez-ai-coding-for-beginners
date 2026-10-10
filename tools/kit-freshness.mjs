// Kit freshness check (2026-10-09): kit items that name outside tools and services (starters, release, backend, AI
// apps, security, or any item that links to an outside page) were checked against the official pages on the date in
// their metadata, sibersentez-checked. Commands, versions and free plans move, so docs/kit.md asks for a new check
// every six months. This lists each such item with that date: ok, due (older than six months) or unchecked (no date
// yet). A unit test never fails with the calendar; this runs before a release instead.
// Run before a release (docs/release.md): node tools/kit-freshness.mjs   (exit 1 when an item is due)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTSIDE_CATEGORIES = new Set(['starters', 'release', 'backend', 'ai-apps', 'security']);
const MAX_AGE_DAYS = 183;
// A link to a page outside the kit's own notices
const OUTSIDE_LINK_RE = /https?:\/\/(?!(?:www\.)?(?:sibersentez\.com|agentskills\.io|opensource\.org)\b)[a-z0-9.-]+\.[a-z]{2,}/i;

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const days = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// [{ category, name, checked (a date or null), age (days or null), status: ok | due | unchecked }], by category and
// name. kitDir: the kit folder; today: YYYY-MM-DD
export function kitFreshness(kitDir, today) {
  const rows = [];
  for (const category of fs.readdirSync(kitDir).sort()) {
    const skillsDir = path.join(kitDir, category, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const name of fs.readdirSync(skillsDir).sort()) {
      const dir = path.join(skillsDir, name);
      const skill = read(path.join(dir, 'SKILL.md'));
      if (!skill) continue;
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] || '';
      const checked = /^\s+sibersentez-checked:\s*"?(\d{4}-\d{2}-\d{2})"?\s*$/m.exec(front)?.[1] || null;
      const text = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'LICENSE.md')
        .map((f) => read(path.join(dir, f)))
        .join('\n');
      if (!checked && !OUTSIDE_CATEGORIES.has(category) && !OUTSIDE_LINK_RE.test(text)) continue;
      const age = checked ? days(checked, today) : null;
      rows.push({ category, name, checked, age, status: !checked ? 'unchecked' : age > MAX_AGE_DAYS ? 'due' : 'ok' });
    }
  }
  return rows;
}

function main() {
  const kitDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
  const rows = kitFreshness(kitDir, new Date().toISOString().slice(0, 10));
  for (const r of rows) console.log(`${r.status.padEnd(9)} ${(r.checked || '-').padEnd(10)} ${r.category}/${r.name}`);
  const due = rows.filter((r) => r.status === 'due').length;
  const unchecked = rows.filter((r) => r.status === 'unchecked').length;
  console.log(`\n${rows.length} items name outside tools or services: ${due} due (older than ${MAX_AGE_DAYS} days), ${unchecked} not checked yet.`);
  process.exitCode = due ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
