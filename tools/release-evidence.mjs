// The facts of a published release, as GitHub keeps them, for docs/release-evidence.md (independent review of 0.19.0
// §7.6, §11): the tag's commit, the files with their size and SHA-256 (GitHub's own digest of each upload), whether
// SHA256SUMS.txt says the same, the build provenance attestations kept for each file, and the workflow runs of that
// commit with their jobs. Read-only: it asks GitHub through the gh CLI (signed in) and prints Markdown; it writes nothing.
//   node tools/release-evidence.mjs v0.19.0
// The page's other parts (what was run by hand, what was not tested) are the maintainer's to write.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag || '')) {
  console.error('usage: node tools/release-evidence.mjs v<major>.<minor>.<patch>');
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repo = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(pkg.repository?.url || '')?.[1];
if (!repo) {
  console.error('package.json names no GitHub repository');
  process.exit(2);
}
const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

const release = gh(['release', 'view', tag, '-R', repo, '--json', 'tagName,publishedAt,url,assets']);
// The tag's commit (an annotated tag points at a tag object first)
let ref = gh(['api', `repos/${repo}/git/ref/tags/${tag}`]).object;
if (ref.type === 'tag') ref = gh(['api', `repos/${repo}/git/tags/${ref.sha}`]).object;
const commit = ref.sha;

const sha = (a) => String(a.digest || '').replace(/^sha256:/, '');
const files = release.assets.filter((a) => a.name !== 'SHA256SUMS.txt');
const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
let sums = null;
if (sumsAsset) {
  const res = await fetch(`https://github.com/${repo}/releases/download/${tag}/SHA256SUMS.txt`);
  if (res.ok) sums = new Map((await res.text()).trim().split('\n').map((l) => l.trim().split(/\s+\*?/)).map(([h, n]) => [n, h.toLowerCase()]));
}
const attested = (a) => {
  try {
    return gh(['api', `repos/${repo}/attestations/sha256:${sha(a)}`]).attestations.length;
  } catch {
    return 0;
  }
};

const runs = gh(['run', 'list', '-R', repo, '--commit', commit, '--limit', '50', '--json', 'databaseId,workflowName,event,conclusion,createdAt,url']);
// The newest run of each workflow at this commit (an earlier failed try is said too)
const byName = new Map();
for (const r of runs) {
  // Dependabot's own runs check the dependencies, not this release
  if (/^Dependabot/.test(r.workflowName)) continue;
  const list = byName.get(r.workflowName) || [];
  list.push(r);
  byName.set(r.workflowName, list);
}

const out = [];
out.push(`- Tag \`${release.tagName}\`, commit \`${commit}\`, published ${release.publishedAt.slice(0, 10)}: ${release.url}`);
out.push('', '| File | Size | SHA-256 | In SHA256SUMS.txt | Provenance attestations |', '|---|---|---|---|---|');
for (const a of files) {
  // GitHub keeps no digest for a file uploaded before it began to: nothing to compare, nothing to ask for
  if (!sha(a)) {
    out.push(`| \`${a.name}\` | ${(a.size / 1e6).toFixed(1)} MB | no digest | not compared | not asked |`);
    continue;
  }
  const inSums = !sums ? 'no file' : sums.get(a.name) === sha(a) ? 'same' : sums.has(a.name) ? 'DIFFERENT' : 'missing';
  out.push(`| \`${a.name}\` | ${(a.size / 1e6).toFixed(1)} MB | \`${sha(a)}\` | ${inSums} | ${attested(a)} |`);
}
out.push('', '| Workflow | Event | Result | Jobs | Run |', '|---|---|---|---|---|');
for (const [name, list] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
  const r = list[0];
  const jobs = gh(['run', 'view', String(r.databaseId), '-R', repo, '--json', 'jobs']).jobs.map((j) => `${j.name}: ${j.conclusion}`).join(', ');
  const earlier = list.slice(1).filter((x) => x.conclusion !== 'success').length;
  out.push(`| ${name} | ${r.event} | ${r.conclusion}${earlier ? ` (${earlier} earlier try not passed)` : ''} | ${jobs} | ${r.url} |`);
}
console.log(out.join('\n'));
