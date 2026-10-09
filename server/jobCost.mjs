// @ts-check
// What a job cost, and what the next one may cost (plan B5, 2026-10-09). A job's span runs from its start record (the
// copy kept when it started, restore.mjs recordJobPoint) to the project's next job start, at most JOB_SPAN_MAX_MS, and
// never past now. Its usage is the project's usage in the ledger's hours of that span (usage.mjs UsageLedger.hoursOf),
// whole UTC hours, an hour two jobs touch split evenly between them; another session in the same project and hour
// counts too, so the page says "about". The estimate is the range of the recent jobs on this computer whose every
// model has a price; a tool without a price (Codex, Gemini...) is shown by its tokens only, never by a made-up dollar
// amount. Nothing is written here.
import { listJobPoints } from './restore.mjs';
import { totalsOf } from './usage.mjs';

export const JOB_SPAN_MAX_MS = 3 * 60 * 60 * 1000;
// Jobs looked at for the estimate (newest first, across projects), and the fewest that make a range
const ESTIMATE_JOBS = 10;
export const ESTIMATE_MIN = 2;

// records: [{ projectId, jobId, at }] (any order) -> one span per record, the newest first
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
      out.push({ projectId: r.projectId, jobId: r.jobId, at: r.at, until: Math.min(next, r.at + JOB_SPAN_MAX_MS, now) });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// One job's numbers from the ledger's totals (usage.mjs totalsOf): tokens always, dollars only when every model has a price
function jobNumbers(span, t) {
  return { projectId: span.projectId, jobId: span.jobId, at: span.at, until: span.until, messages: t.messages, processed: Math.round(t.processed), output: Math.round(t.output), usd: t.usdPartial ? null : t.usd };
}

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
    for (const [h, mm] of hours[i]) {
      const share = 1 / touched.get(`${s.projectId}|${h}`);
      for (const [model, cell] of mm) {
        let sum = models.get(model);
        if (!sum) models.set(model, (sum = cell.map(() => 0)));
        cell.forEach((v, j) => (sum[j] += v * share));
      }
    }
    return jobNumbers(s, totalsOf(models));
  });
}

// The range of the recent priced jobs that did anything; null below ESTIMATE_MIN
export function estimateOf(jobs) {
  const usd = jobs.filter((j) => j.messages > 0 && j.usd !== null).slice(0, ESTIMATE_JOBS).map((j) => j.usd).sort((a, b) => a - b);
  if (usd.length < ESTIMATE_MIN) return null;
  const mid = Math.floor(usd.length / 2);
  const median = usd.length % 2 ? usd[mid] : Math.round(((usd[mid - 1] + usd[mid]) / 2) * 100) / 100;
  return { jobs: usd.length, low: usd[0], high: usd[usd.length - 1], median };
}

// GET /api/usage/jobs[?project=<id>] -> { status, body: { jobs (this project's, or every project's), estimate } }.
// ledger: the UsageLedger; catalog: for the projects and the hub; readRecords: for tests.
/** @param {{ ledger?: any, catalog?: any, projectId?: string | null, now?: number, readRecords?: (o: { hubDir: string, projectId: string }) => any[] }} [options] */
export function jobCostsRoute({ ledger, catalog, projectId = null, now = Date.now(), readRecords = listJobPoints } = {}) {
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
  const jobs = projectId === null ? all.slice(0, ESTIMATE_JOBS) : all.filter((j) => j.projectId === projectId).slice(0, ESTIMATE_JOBS);
  return { status: 200, body: { jobs, estimate: estimateOf(all), pricedOnly: 'anthropic' } };
}
