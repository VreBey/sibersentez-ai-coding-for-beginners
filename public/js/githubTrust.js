// The trust line of a GitHub download (docs/github-import.md, "Trust line"): where the files came from, how old the
// commit is, that nothing was run, and what the safety scan can and cannot see. Pure (tested in node, no DOM).
import { esc, ago } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { hintHtml } from './hints.js';

export const STALE_DAYS = 365;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// f: the fetch result ({ repo, commit, committedAt, method }); now: the clock (tests)
export function ghTrustHtml(f, now = Date.now()) {
  if (!f || !REPO_RE.test(String(f.repo || ''))) return '';
  const chips = [];
  const commit = SHA_RE.test(String(f.commit || '')) ? f.commit : '';
  // The source, at the very commit that was read (a public repository on github.com only)
  const href = `https://github.com/${f.repo}${commit ? `/tree/${commit}` : ''}`;
  chips.push(`<a class="gh-trust-chip src" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(t('ghTrustSourceTip'))}">${icon('globe')}<span translate="no">github.com/${esc(f.repo)}</span></a>`);
  const at = Date.parse(f.committedAt || '');
  if (Number.isFinite(at)) {
    const stale = now - at > STALE_DAYS * 86400000;
    chips.push(`<span class="gh-trust-chip${stale ? ' warn' : ''}" title="${esc(new Date(at).toISOString().slice(0, 10))}">${icon('clock')}<span>${esc(t(stale ? 'ghTrustStale' : 'ghTrustUpdated', { when: ago(at, now) }))}</span></span>`);
  } else chips.push(`<span class="gh-trust-chip muted">${icon('clock')}<span>${esc(t('ghTrustUpdatedUnknown'))}</span></span>`);
  chips.push(`<span class="gh-trust-chip ok">${icon('check')}<span>${esc(t('ghTrustNotRun'))}</span></span>`);
  chips.push(`<span class="gh-trust-chip">${icon('search')}<span>${esc(t('ghTrustScanned'))}</span>${hintHtml(t('ghTrustScanLimits'))}</span>`);
  return `<div class="gh-trust" role="group" aria-label="${esc(t('ghTrustLabel'))}">${chips.join('')}</div>`;
}
