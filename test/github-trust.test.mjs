// The trust line of a GitHub download (docs/github-import.md, "Trust line"): public/js/githubTrust.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghTrustHtml, STALE_DAYS } from '../public/js/githubTrust.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const f = { repo: 'acme/skills', commit: SHA, committedAt: '2026-09-20T10:00:00.000Z', method: 'tar' };

test('trust line: the source at the commit read, the last change, nothing run, the scan with its limits', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = ghTrustHtml(f, NOW);
      assert.ok(h.includes(`href="https://github.com/acme/skills/tree/${SHA}"`), lang);
      assert.ok(h.includes('rel="noopener noreferrer"'));
      assert.ok(h.includes(S.ghTrustUpdated.split('{when}')[0]), lang);
      assert.ok(h.includes(S.ghTrustNotRun));
      assert.ok(h.includes(S.ghTrustScanned));
      assert.ok(h.includes('data-hint=') && h.includes(esc(S.ghTrustScanLimits)), 'the scan limits in a hint');
      assert.ok(!h.includes('gh-trust-chip warn'));
    }
  } finally {
    setLanguage('en');
  }
});

test('trust line: an old commit is marked, an unknown date says so, a bad repo or commit adds no link', () => {
  const old = ghTrustHtml({ ...f, committedAt: new Date(NOW - (STALE_DAYS + 5) * 86400000).toISOString() }, NOW);
  assert.ok(old.includes('gh-trust-chip warn') && old.includes('Not changed for a long time'));
  assert.ok(ghTrustHtml({ ...f, committedAt: null }, NOW).includes(STRINGS.en.ghTrustUpdatedUnknown));
  assert.ok(ghTrustHtml({ ...f, commit: 'nope' }, NOW).includes('href="https://github.com/acme/skills"'), 'no commit: the repository');
  assert.equal(ghTrustHtml({ ...f, repo: 'javascript:alert(1)//x' }, NOW), '');
  assert.equal(ghTrustHtml({ ...f, repo: 'a/b"onmouseover=x' }, NOW), '');
  assert.equal(ghTrustHtml(null), '');
});

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
