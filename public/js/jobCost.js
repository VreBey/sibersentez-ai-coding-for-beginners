// @ts-check
// What a job uses, before and after (plan B5, server/jobCost.mjs): before a job starts, the range of the recent jobs on
// this computer; after it, this job's own usage. Both are "about" (the ledger counts whole hours) and in API-equivalent
// dollars only for models with a price (Anthropic's), else in tokens. On a subscription nothing is billed per job: it
// counts toward the plan's usage, and the words say so. "Hide $" (Settings) hides the dollars here too.
import { t } from './i18n.js';
import { tok } from './format.js';
import { usd, costShown } from './usage.js';

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

// One job's line in its result (pure): dollars when priced and shown, else its tokens; '' when it did nothing
export function jobCostText(job, { showCost = costShown() } = {}) {
  if (!job || !(job.messages > 0)) return '';
  const tokens = tok(Number(job.processed) || 0);
  if (showCost && typeof job.usd === 'number') return t('jcThisJob', { usd: usd(job.usd), tokens });
  return t('jcThisJobTokens', { tokens });
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
  };
}
