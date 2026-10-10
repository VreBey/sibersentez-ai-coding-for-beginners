// @ts-check
// What a job uses, before and after (plan B5, server/jobCost.mjs): before a job starts, the range of the recent jobs on
// this computer; after it, this job's own usage. Both are "about" (the ledger counts whole hours) and in API-equivalent
// dollars only for models with a price (Anthropic's), else in tokens. On a subscription nothing is billed per job: it
// counts toward the plan's usage, and the words say so. "Hide $" (Settings) hides the dollars here too. A job's line
// says how its numbers were made (independent review §7.7): the project's usage in the whole hours it ran, an hour shared
// with another job split, other sessions of the project in those hours included, a span cut at three hours, and the
// prices' date.
import { t } from './i18n.js';
import { tok } from './format.js';
import { usd, costShown, dateText } from './usage.js';

// The line under Start (pure): the range when there is one; '' when dollars are hidden or nothing is known yet
// tool: the tool a job would start with; the range is measured on Claude Code's priced models only (review B/C: a Codex
// job showed Claude's dollars)
export function estimateText(estimate, { showCost = costShown(), tool = 'claude' } = {}) {
  if (!showCost) return '';
  if (tool && tool !== 'claude') return t('jcNone');
  const e = estimate && typeof estimate === 'object' ? estimate : null;
  if (!e || !(e.jobs >= 2) || !Number.isFinite(e.low) || !Number.isFinite(e.high)) return t('jcNone');
  return t('jcRange', { count: e.jobs, low: usd(e.low), high: usd(e.high) });
}

// How a job's numbers were made (pure): the hours, and what else they hold
function howText(job) {
  const parts = [];
  if (job.split) parts.push(t('jcHowSplit'));
  if (job.others === null || job.others === undefined) parts.push(t('jcHowOthersUnknown'));
  else if (job.others > 0) parts.push(t(job.others === 1 ? 'jcHowOthers_one' : 'jcHowOthers', { count: job.others }));
  if (job.capped) parts.push(t('jcHowCapped'));
  return t('jcHow', { parts: parts.join('') });
}

// One job's line in its result (pure): dollars when priced and shown (with the prices' date), else its tokens, then how
// they were made; a job with no usage in its hours says so (its tool may not log it); '' when no job is known
export function jobCostText(job, { showCost = costShown(), pricedAt = '' } = {}) {
  if (!job) return '';
  // No usage in its hours: none recorded, or hours the app's logs no longer reach (others unknown)
  if (!(job.messages > 0)) return t(job.others === null || job.others === undefined ? 'jcThisJobUnknown' : 'jcThisJobNone');
  const tokens = tok(Number(job.processed) || 0);
  const priced = showCost && typeof job.usd === 'number';
  const head = priced ? t('jcThisJob', { usd: usd(job.usd), tokens }) : t('jcThisJobTokens', { tokens });
  return [head, howText(job), priced && pricedAt ? t('jcPricedAt', { date: dateText(pricedAt) }) : ''].filter(Boolean).join(' ');
}

async function fetchJobCosts(projectId) {
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  const res = await fetch(`/api/usage/jobs${q}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Answers per project (asked again after ttl ms; a job's numbers grow while it runs). onData(projectId): an answer
// arrived (the drawer redraws when that project is open)
export function createJobCosts({ fetchJson = fetchJobCosts, onData = (_projectId) => {}, now = () => Date.now(), ttl = 30000 } = {}) {
  const cache = new Map();
  function get(projectId) {
    if (typeof projectId !== 'string' || !projectId) return null;
    const e = cache.get(projectId);
    if (e && (e.pending || now() - e.at < ttl)) return e.data;
    cache.set(projectId, { at: e?.at || 0, data: e?.data || null, pending: true });
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => cache.set(projectId, { at: now(), data, pending: false }),
        () => cache.set(projectId, { at: now(), data: e?.data || null, pending: false }),
      )
      .then(() => {
        try {
          onData(projectId);
        } catch (err) {
          console.error(err);
        }
      });
    return e?.data || null;
  }
  return {
    get,
    estimate: (projectId) => get(projectId)?.estimate || null,
    job: (projectId, jobId) => (get(projectId)?.jobs || []).find((j) => j.jobId === jobId) || null,
    pricedAt: (projectId) => get(projectId)?.pricedAt || '',
  };
}
