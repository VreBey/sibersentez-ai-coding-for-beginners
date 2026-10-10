// @ts-check
// What a job cost, and what the next one may cost (plan B5, 2026-10-09). A job's span runs from its start record (the
// copy kept when it started, restore.mjs recordJobPoint) to the project's next job start, at most JOB_SPAN_MAX_MS, and
// never past now. Its usage is the project's usage in the ledger's hours of that span (usage.mjs UsageLedger.hoursOf),
// whole UTC hours, an hour two jobs touch split evenly between them; another session in the same project and hour
// counts too, so the page says "about". The estimate is the range of the recent jobs on this computer whose every
// model has a price; a tool without a price (Codex, Gemini...) is shown by its tokens only, never by a made-up dollar
// amount. Nothing is written here. Each job says how its numbers were made (independent review §7.7: costs looked more
// exact than they are): an hour shared with another job (split), its span cut at JOB_SPAN_MAX_MS (capped), and how many
// other sessions of the project were open in its hours (others: from their start to their last line, idle or not; null
// when the log window no longer holds them).
import { listJobPoints } from './restore.mjs';
import { totalsOf, HOUR } from './usage.mjs';
import { PRICED_AT } from './prices.mjs';

export const JOB_SPAN_MAX_MS = 3 * 60 * 60 * 1000;
// Jobs looked at for the estimate (newest first, across projects), and the fewest that make a range
const ESTIMATE_JOBS = 10;
export const ESTIMATE_MIN = 2;

// records: [{ projectId, jobId, at }] (any order) -> one span per record, the newest first; capped: the span ends at
// JOB_SPAN_MAX_MS, before the next start and now
export function jobSpans(records, now = Date.now()) {
  const byProject = new Map();
  for (const r of records) {
    if (!r || typeof r.projectId !== 'string' || typeof r.jobId !== 'string' || !Number.isFinite(r.at) || r.at > now) continue;
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
    byProject.get(r.projectId).push(r);
  }
  const out = [];
  for (const list of byProject.values()) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((r, i) => {
      const next = list[i + 1]?.at ?? Infinity;
      const end = Math.min(next, now);
      out.push({ projectId: r.projectId, jobId: r.jobId, at: r.at, until: Math.min(end, r.at + JOB_SPAN_MAX_MS), capped: r.at + JOB_SPAN_MAX_MS < end });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// One job's numbers from the ledger's totals (usage.mjs totalsOf): tokens always, dollars only when every model has a price
function jobNumbers(span, t, how) {
  return { projectId: span.projectId, jobId: span.jobId, at: span.at, until: span.until, messages: t.messages, processed: Math.round(t.processed), output: Math.round(t.output), usd: t.usdPartial ? null : t.usd, capped: !!span.capped, ...how };
}

// The whole hours the ledger counts for a span (usage.mjs hoursOf): [from, to)
const hoursSpan = (s) => [Math.floor(s.at / HOUR) * HOUR, (Math.floor(Math.max(s.at, s.until - 1) / HOUR) + 1) * HOUR];

// Each job's usage, an hour two jobs of a project touch split evenly between them (review B/C: two jobs started in the
// same hour each took the whole hour, so a job read up to twice its cost). ledger: UsageLedger (hoursOf)
function jobUsage(spans, ledger) {
  const hours = spans.map((s) => ledger.hoursOf(s.projectId, s.at, s.until));
  const touched = new Map();
  spans.forEach((s, i) => {
    for (const [h] of hours[i]) touched.set(`${s.projectId}|${h}`, (touched.get(`${s.projectId}|${h}`) || 0) + 1);
  });
  return spans.map((s, i) => {
    const models = new Map();
    let split = false;
    for (const [h, mm] of hours[i]) {
      const share = 1 / touched.get(`${s.projectId}|${h}`);
      if (share < 1) split = true;
      for (const [model, cell] of mm) {
        let sum = models.get(model);
        if (!sum) models.set(model, (sum = cell.map(() => 0)));
        cell.forEach((v, j) => (sum[j] += v * share));
      }
    }
    return jobNumbers(s, totalsOf(models), { split });
  });
}

// How many other sessions of the project were open in a job's whole hours, or null when not known
function othersOf(othersIn, j) {
  try {
    const n = othersIn(j.projectId, ...hoursSpan(j), j.jobId);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// The range of the recent priced jobs that did anything; null below ESTIMATE_MIN
export function estimateOf(jobs) {
  const usd = jobs.filter((j) => j.messages > 0 && j.usd !== null).slice(0, ESTIMATE_JOBS).map((j) => j.usd).sort((a, b) => a - b);
  if (usd.length < ESTIMATE_MIN) return null;
  const mid = Math.floor(usd.length / 2);
  const median = usd.length % 2 ? usd[mid] : Math.round(((usd[mid - 1] + usd[mid]) / 2) * 100) / 100;
  return { jobs: usd.length, low: usd[0], high: usd[usd.length - 1], median };
}

// GET /api/usage/jobs[?project=<id>] -> { status, body: { jobs (this project's, or every project's), estimate, pricedAt } }.
// ledger: the UsageLedger; catalog: for the projects and the hub; othersIn(projectId, from, to, jobId): how many other
// sessions of the project were at work in [from, to) (ingest.mjs otherSessionsIn; null: not known); readRecords: for tests.
/** @param {{ ledger?: any, catalog?: any, projectId?: string | null, now?: number, othersIn?: (projectId: string, from: number, to: number, jobId: string) => number | null, readRecords?: (o: { hubDir: string, projectId: string }) => any[] }} [options] */
export function jobCostsRoute({ ledger, catalog, projectId = null, now = Date.now(), othersIn = () => null, readRecords = listJobPoints } = {}) {
  if (!ledger) return { status: 404, body: { error: 'not-found' } };
  const hubDir = catalog?.hubDir || null;
  if (projectId !== null && !catalog?.getProject?.(projectId)) return { status: 404, body: { error: 'project-not-found' } };
  const records = [];
  if (hubDir) {
    for (const p of catalog.allProjects?.() || []) {
      for (const r of readRecords({ hubDir, projectId: p.id })) if (r?.jobId && Number.isFinite(r.at)) records.push({ projectId: p.id, jobId: r.jobId, at: r.at });
    }
  }
  const all = jobUsage(jobSpans(records, now), ledger);
  const listed = projectId === null ? all.slice(0, ESTIMATE_JOBS) : all.filter((j) => j.projectId === projectId).slice(0, ESTIMATE_JOBS);
  // Other sessions only for the jobs answered (the estimate does not use them)
  const jobs = listed.map((j) => ({ ...j, others: othersOf(othersIn, j) }));
  return { status: 200, body: { jobs, estimate: estimateOf(all), pricedOnly: 'anthropic', pricedAt: PRICED_AT } };
}
