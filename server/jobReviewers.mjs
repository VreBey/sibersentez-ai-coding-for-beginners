// @ts-check
// Who reviewed a job, as the AI's own log shows it (docs/internal/evidence-card-plan.md E4). Observed, never proof: the
// review's verdict is what REVIEW.md says (declared, server/team.mjs); this says whether the app saw a separate reviewer
// agent run in the job's sessions and what that agent's own last answer said. Only Claude Code's log shows its agents
// with their type (checked in real 2.1.294 job sessions, 2026-10-10): an agent's meta.agentType ("reviewer", the kit's
// quality/agents/reviewer.md), and its answer either as its last text ("... VERDICT: {...}", end_turn) or as the
// message of its SubagentHandback call. Only a whole-job review counts ("## Review: whole job", read as REVIEW.md is:
// the same agent also reviews single tasks, whose verdict is not the job's), and not one naming another Job-ID. Nothing
// of the answer is kept but the verdict's value, its Job-ID and when it was said.
// A review in another session (the kit's "open a new session and say: review the work") carries no Job-ID, so it is not
// seen: the card says so.
import { parseVerdict } from './team.mjs';
import { OBSERVED_TOOLS } from './tools.mjs';

// The agent types that review (the kit's reviewer and security-auditor, and any "*-reviewer")
const REVIEWER_TYPE = /(?:^|[\s:_-])reviewer$|^security-auditor$/i;
export const isReviewerType = (type) => typeof type === 'string' && type.length <= 80 && REVIEWER_TYPE.test(type.trim());

// The whole-job verdict an answer gives, read as team.mjs reads REVIEW.md (parseVerdict: the last VERDICT line, under
// a "## Review: whole job" heading, fenced templates left out): { value: 'APPROVE' | 'REVISE', jobId } or null. A task
// review's verdict ("## Review T3") is null. A very long answer is read from its end (the verdict is its last line)
const TEXT_MAX = 256 * 1024;
export function answerVerdict(text) {
  if (typeof text !== 'string' || !/VERDICT:/i.test(text)) return null;
  let body = text;
  if (text.length > TEXT_MAX) {
    // Cut at a review heading, never inside a fenced block (its fences would read the other way round)
    const tail = text.slice(-TEXT_MAX);
    const at = tail.search(/(?:^|\n) {0,3}##[ \t]+Review\b/i);
    body = at < 0 ? '' : tail.slice(at);
  }
  const v = parseVerdict(body);
  return v && v.scope === 'whole' ? { value: v.verdict, jobId: v.jobId } : null;
}

// The whole-job verdict in one assistant content block of an agent: its text, or its SubagentHandback message
export function blockVerdict(block) {
  if (block?.type === 'text') return answerVerdict(block.text);
  if (block?.type === 'tool_use' && block.name === 'SubagentHandback') return answerVerdict(block.input?.message);
  return null;
}

// The tools whose logs show agents with their type; any other says "not known for <tool>"
export const REVIEWER_TOOLS = OBSERVED_TOOLS;
const TYPES_SHOWN = 3;
// REVIEW.md is written after the answer it holds; a little slack for the clocks of a log line and a file
const SAID_SLACK_MS = 2000;

// The verdicts an agent's answers said, oldest first; a reviewer sent back for a second round answers again
export const VERDICTS_KEPT = 8;

// One job's reviewer agents across its sessions (agentsOf(id): a session's agents, ingest entries with type,
// verdicts: [{ value, jobId, at }], toolUseId, lastAt). jobId: the job's (an answer naming another Job-ID is not its).
// before: REVIEW.md's write time (the review the card shows); an answer said after it belongs to a later round and is
// not compared. -> null when no session of the job is known, else
//   { agents, types: [type], said: 'APPROVE' | 'REVISE' | null, saidAt, lastAt, unknownTools: [tool] }
// An agent seen in two sessions (a resumed or forked log) counts once (its tool-use id).
export function jobReviewersSummary(sessions, agentsOf = (_id) => [], { before = null, jobId = null } = {}) {
  if (!sessions.length) return null;
  const out = { agents: 0, types: /** @type {string[]} */ ([]), said: /** @type {string | null} */ (null), saidAt: /** @type {number | null} */ (null), lastAt: /** @type {number | null} */ (null), unknownTools: /** @type {string[]} */ ([]) };
  const seen = new Set();
  for (const s of sessions) {
    if (!REVIEWER_TOOLS.has(s.tool || 'claude')) {
      if (!out.unknownTools.includes(s.tool)) out.unknownTools.push(s.tool);
      continue;
    }
    for (const ag of agentsOf(s.id)) {
      if (!ag || !isReviewerType(ag.type)) continue;
      const key = ag.toolUseId || ag.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.agents++;
      const type = ag.type.trim();
      if (out.types.length < TYPES_SHOWN && !out.types.includes(type)) out.types.push(type);
      if (ag.lastAt && (!out.lastAt || ag.lastAt > out.lastAt)) out.lastAt = ag.lastAt;
      for (const said of ag.verdicts || []) {
        if (Number.isFinite(before) && before > 0 && said.at > before + SAID_SLACK_MS) continue;
        if (said.jobId && jobId && said.jobId !== jobId) continue;
        if (!out.saidAt || said.at > out.saidAt) {
          out.said = said.value;
          out.saidAt = said.at;
        }
      }
    }
  }
  return out;
}
