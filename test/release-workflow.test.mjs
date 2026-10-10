// @ts-check
// The release build (.github/workflows/release.yml, independent review §10): both packages built from this source behind
// the same gates, one SHA256SUMS.txt, a provenance attestation, and every action of every workflow pinned to a commit.
// Read as text (no YAML library ships with the app): the checks look for the lines the workflow must hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
// One job's text: from its "  <name>:" line to the next job at the same depth
function job(text, name) {
  const lines = text.split(/\r?\n/);
  const at = lines.indexOf(`  ${name}:`);
  assert.ok(at > 0, `job ${name}`);
  let end = at + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[end])) end++;
  return lines.slice(at, end).join('\n');
}

test('every action of every workflow is pinned to a commit, with its version in a comment', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    for (const line of read(name).split(/\r?\n/).filter((l) => /^\s*(?:-\s+)?uses:/.test(l))) {
      assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/, `${name}: ${line.trim()}`);
    }
  }
});

test('the release build: the installer and the AppImage behind the same gates, then their sums and provenance', () => {
  const wf = read('release.yml');
  assert.match(wf, /^permissions:\n {2}contents: read\n {2}actions: read\n/m, 'read-only by default');
  const win = job(wf, 'build');
  const linux = job(wf, 'build-linux');
  const rel = job(wf, 'release');
  for (const [name, j, build, qa] of [
    ['build', win, 'npm run dist -- --publish never', 'tools/electron-qa.ps1'],
    ['build-linux', linux, 'npx electron-builder --linux AppImage --publish never', 'xvfb-run -a bash tools/linux-qa.sh'],
  ]) {
    const order = ['run: npm test', 'run: npm run typecheck', 'run: npm run lint', build, qa, 'upload-artifact'].map((s) => j.indexOf(s));
    assert.ok(order.every((i) => i > 0), `${name}: every step`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${name}: gates, then the build, its hidden checks, then the upload`);
    assert.doesNotMatch(j, /id-token|attestations: write|contents: write/, `${name}: no write rights`);
  }
  assert.match(rel, /needs: \[build, build-linux\]/);
  // What the builds upload is what the release job takes, by name (never a pattern an earlier run's output could match)
  const uploaded = (j) => [...j.matchAll(/upload-artifact@[^\n]+\n\s+with:\n\s+name: ([\w-]+)/g)].map((m) => m[1]);
  const taken = [...rel.matchAll(/download-artifact@[^\n]+\n\s+with:\n\s+name: ([\w-]+)/g)].map((m) => m[1]);
  // (the QA records each build keeps when a check fails are not release files)
  const files = (j) => uploaded(j).filter((n) => !n.startsWith('release-qa-'));
  assert.deepEqual(taken, [...files(win), ...files(linux)]);
  assert.deepEqual(uploaded(win).filter((n) => n.startsWith('release-qa-')), ['release-qa-windows'], 'the QA record, kept even when a check fails');
  assert.deepEqual(uploaded(linux).filter((n) => n.startsWith('release-qa-')), ['release-qa-linux']);
  assert.equal(((win + linux).match(/- if: always\(\)\n\s+uses: actions\/upload-artifact/g) || []).length, 2);
  assert.doesNotMatch(rel, /pattern:/);
  assert.match(rel, /permissions:\n\s+contents: read\n\s+actions: read\n\s+id-token: write\n\s+attestations: write\n/);
  assert.doesNotMatch(rel, /contents: write/, 'nothing is published from here');
  const steps = ['download-artifact', 'sha256sum SiberSentez-* > SHA256SUMS.txt', 'test "$(wc -l < SHA256SUMS.txt)" -eq 2', 'attest-build-provenance', 'subject-checksums: release/SHA256SUMS.txt', 'upload-artifact'].map((s) => rel.indexOf(s));
  assert.ok(steps.every((i) => i > 0), 'every step of the release job');
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  assert.doesNotMatch(wf, /gh release|softprops|--publish always/, 'the release itself is made by hand');
});
