// @ts-check
// Who reviewed a job, as the AI's own log shows it (server/jobReviewers.mjs, docs/internal/evidence-card-plan.md E4):
// the shapes come from real Claude Code 2.1.294 job sessions (a reviewer agent ending in text, one ending in a
// SubagentHandback call)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReviewerType, answerVerdict, blockVerdict, jobReviewersSummary, VERDICTS_KEPT } from '../server/jobReviewers.mjs';
import { Ingest } from '../server/ingest.mjs';
import { reviewersHtml, jobResultHtml } from '../public/js/jobResult.js';
import { setLanguage } from '../public/js/i18n.js';

const J = 'J764b5cd98f2fd06dfaf205c587fb8833';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-job-reviewers-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('which agent types review', () => {
  for (const t of ['reviewer', 'code-reviewer', 'plugin:reviewer', 'UI Finish-Gate Reviewer', 'security-auditor']) assert.equal(isReviewerType(t), true, t);
  for (const t of ['builder', 'reviewers', 'reviewer-helper', 'general-purpose', '', null, 'x'.repeat(90) + '-reviewer']) assert.equal(isReviewerType(t), false, String(t));
});

test('the verdict an answer says on the whole job, as REVIEW.md is read; a task review\'s is not the job\'s', () => {
  // One answer with the task review and the whole-job review (as in the real sessions): the whole job's counts
  const answer = `## Review T1\n\nJob-ID: ${J}\n\nVERDICT: {"verdict":"REVISE","blockers":[{"file":"a"}],"nits":[]}\n\n## Review: whole job\n\nJob-ID: ${J}\n\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":["x"]}`;
  assert.deepEqual(answerVerdict(answer), { value: 'APPROVE', jobId: J });
  assert.deepEqual(answerVerdict('## Review: whole job (round 2)\r\n\r\nVERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}\r\n'), { value: 'REVISE', jobId: null });
  // A task review alone, or a verdict under no heading, says nothing of the whole job
  assert.equal(answerVerdict(`## Review T3\n\nJob-ID: ${J}\n\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}`), null);
  assert.equal(answerVerdict('VERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}'), null);
  // The format the reviewer was given (its prompt quotes it, fenced or not) is no verdict; nor is a broken or unknown one
  assert.equal(answerVerdict('## Review: whole job\nEnd with VERDICT: {"verdict":"APPROVE"|"REVISE", ...}'), null);
  assert.equal(answerVerdict('## Review: whole job\n```\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n```'), null);
  assert.equal(answerVerdict('## Review: whole job\nVERDICT: {"verdict":"MAYBE","blockers":[],"nits":[]}'), null);
  assert.equal(answerVerdict('no verdict here'), null);
  // A very long answer is read from its last review heading on, never from inside a fenced block
  const long = '```\n' + 'x'.repeat(300 * 1024) + '\n```\n## Review: whole job\n\nVERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}';
  assert.deepEqual(answerVerdict(long), { value: 'REVISE', jobId: null });
  assert.equal(answerVerdict('## Review: whole job\n' + 'x'.repeat(300 * 1024) + '\nVERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}'), null, 'its heading cut off: not known');
  assert.equal(answerVerdict(undefined), null);
  assert.deepEqual(blockVerdict({ type: 'text', text: answer }), { value: 'APPROVE', jobId: J });
  assert.deepEqual(blockVerdict({ type: 'tool_use', name: 'SubagentHandback', input: { message: answer } }), { value: 'APPROVE', jobId: J });
  assert.equal(blockVerdict({ type: 'tool_use', name: 'Write', input: { content: answer } }), null, 'a file it writes is not its answer');
  assert.equal(blockVerdict({ type: 'thinking', thinking: answer }), null);
});

// ---------------- ingest ----------------
function fakeCatalog() {
  return { resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() };
}
const T0 = Date.parse('2026-10-10T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const feed = (ing, ctx, o) => {
  const buf = Buffer.from(JSON.stringify(o));
  ing.line(ctx, {}, buf, 0, buf.length);
};
const first = (text = `Read .sibersentez/job-${J}.md and do the job.`) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: at(0), cwd: 'C:\\nowhere-sibersentez', message: { role: 'user', content: text } });
const say = (s, content) => ({ parentUuid: 'x', isSidechain: true, type: 'assistant', timestamp: at(s), message: { model: 'claude-opus-5-5', id: 'm' + s, role: 'assistant', content, usage: { output_tokens: 1 }, stop_reason: 'end_turn' } });
const verdictText = (v) => `## Review: whole job\n\nVERDICT: {"verdict":"${v}","blockers":[],"nits":[]}`;
// An agent of a session, its type from its meta file as Claude Code writes it
let agentNo = 0;
function agent(ing, sessionId, type, toolUseId = `toolu_${++agentNo}`) {
  const id = `a${++agentNo}`;
  const dir = path.join(ROOT, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: 'review', toolUseId, spawnDepth: 1, requestShape: 'background' }));
  return ing.getAgent({ agentId: id, sessionId, slug: 'x', workflowRunId: null }, path.join(dir, `agent-${id}.jsonl`));
}

test('ingest: a job\'s reviewer agent and what its own answers said, by text or hand-back; other agents and sessions say nothing', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  const builder = agent(ing, 's1', 'builder');
  feed(ing, builder, say(1, [{ type: 'text', text: verdictText('APPROVE') }]));
  let sum = ing.jobReviewers(J);
  assert.deepEqual([sum.agents, sum.said], [0, null], 'a builder quoting a verdict is no reviewer');
  const rev = agent(ing, 's1', 'reviewer');
  feed(ing, rev, say(2, [{ type: 'tool_use', id: 'toolu_r1', name: 'Bash', input: { command: 'git status --short' } }]));
  feed(ing, rev, say(3, [{ type: 'text', text: verdictText('REVISE') }]));
  // Sent back for round 2: its hand-back holds the new answer
  feed(ing, rev, say(10, [{ type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: { message: verdictText('APPROVE') } }]));
  sum = ing.jobReviewers(J);
  assert.deepEqual([sum.agents, sum.types, sum.said, sum.saidAt], [1, ['reviewer'], 'APPROVE', Date.parse(at(10))]);
  // REVIEW.md written between the two answers: the later one is another round's
  sum = ing.jobReviewers(J, { before: Date.parse(at(5)) });
  assert.deepEqual([sum.said, sum.saidAt], ['REVISE', Date.parse(at(3))]);
  assert.equal(JSON.stringify(sum).includes('Review'), false, 'nothing of the answer leaves but its verdict');
  // A line read twice is one answer
  feed(ing, rev, say(10, [{ type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: { message: verdictText('APPROVE') } }]));
  assert.equal(rev.verdicts.length, 2);
  // Later it reviews a single task, then answers on another job: neither is this job's whole-job answer
  feed(ing, rev, say(12, [{ type: 'text', text: `## Review T3\n\nJob-ID: ${J}\n\nVERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}` }]));
  feed(ing, rev, say(14, [{ type: 'text', text: `## Review: whole job\n\nJob-ID: J${'f'.repeat(32)}\n\nVERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}` }]));
  assert.deepEqual([ing.jobReviewers(J).said, ing.jobReviewers(J).saidAt], ['APPROVE', Date.parse(at(10))]);
  // While the first scan runs (agents are read after their sessions) nothing is said yet
  ing.scan.state = 'loading';
  assert.equal(ing.jobReviewers(J), null);
  ing.scan.state = 'ready';
  // A session with no job, and a job no session of which is known
  const other = ing.getSession('s2', null);
  feed(ing, other, first('fix the bug'));
  feed(ing, agent(ing, 's2', 'reviewer'), say(4, [{ type: 'text', text: verdictText('APPROVE') }]));
  assert.equal(ing.jobReviewers(J).agents, 1);
  assert.equal(ing.jobReviewers('J' + '0'.repeat(32)), null);
});

test('ingest: no reviewer agent in the job\'s sessions; an agent seen in a forked session counts once; answers are bounded', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  const s = ing.getSession('s1', null);
  feed(ing, s, first());
  agent(ing, 's1', 'builder');
  assert.deepEqual(ing.jobReviewers(J), { agents: 0, types: [], said: null, saidAt: null, lastAt: null, unknownTools: [] });
  const fork = ing.getSession('s1-fork', null);
  feed(ing, fork, first());
  agent(ing, 's1', 'reviewer', 'toolu_same');
  agent(ing, 's1-fork', 'reviewer', 'toolu_same');
  const sec = agent(ing, 's1-fork', 'security-auditor');
  for (let i = 0; i < VERDICTS_KEPT + 3; i++) feed(ing, sec, say(i + 1, [{ type: 'text', text: verdictText(i % 2 ? 'APPROVE' : 'REVISE') }]));
  const sum = ing.jobReviewers(J);
  assert.deepEqual([sum.agents, sum.types], [2, ['reviewer', 'security-auditor']]);
  assert.equal(sec.verdicts.length, VERDICTS_KEPT);
});

test('a job with sessions of tools that show no agents says so', () => {
  assert.deepEqual(jobReviewersSummary([{ id: 'c1', tool: 'codex' }]), { agents: 0, types: [], said: null, saidAt: null, lastAt: null, unknownTools: ['codex'] });
  assert.equal(jobReviewersSummary([]), null);
});

// ---------------- the result card ----------------
const team = (verdict = 'APPROVE', more = {}) => ({ step: 'finish', plan: { jobId: J, title: 'Menu' }, review: { verdict, blockers: 0, nits: 0, scope: 'whole', jobId: J }, ...more });
const record = (value = 'APPROVE', reviewAt = T0) => ({ jobId: J, verdict: { value, blockers: 0, nits: 0, reviewAt, seenAt: T0 + 1000 }, tree: null, reviewers: null, acceptedSeenAt: null });
const seen = (more = {}) => ({ agents: 1, types: ['reviewer'], said: 'APPROVE', saidAt: T0 - 1000, lastAt: T0 - 1000, unknownTools: [], ...more });

test('the card: the reviewer agent seen and its own last answer, apart from the review file\'s words; a different answer stands out', () => {
  setLanguage('en');
  assert.equal(reviewersHtml(team(), null), '');
  assert.equal(reviewersHtml(team(), { record: null, reviewers: null }), '', 'no session seen: the commands line says so');
  const same = reviewersHtml(team(), { record: record(), reviewers: seen() });
  assert.match(same, /saw a separate reviewer agent \(reviewer\) run in this job’s sessions\. Its own last answer on the whole job before the review file was written said APPROVE\./);
  assert.doesNotMatch(same, /jr-stale/);
  const other = reviewersHtml(team(), { record: record(), reviewers: seen({ said: 'REVISE' }) });
  assert.match(other, /class="jr-revs jr-stale"/);
  assert.match(other, /<b>Its own last answer on the whole job before the review file was written said REVISE, but the review file says APPROVE\.<\/b>/);
  // No record of this verdict (not seen yet, another verdict, or no REVIEW.md time): the answer is not compared
  for (const rec of [null, record('REVISE'), record('APPROVE', null)]) {
    const html = reviewersHtml(team(), { record: rec, reviewers: seen({ said: 'REVISE' }) });
    assert.match(html, /saw a separate reviewer agent/);
    assert.doesNotMatch(html, /said REVISE/);
  }
  assert.match(reviewersHtml(team(), { record: record(), reviewers: seen({ agents: 2, types: ['reviewer', 'security-auditor'] }) }), /saw 2 separate reviewer agents \(reviewer, security-auditor\) run in this job’s sessions\. The newest answer of these agents on the whole job/);
  assert.match(reviewersHtml(team(), { record: record(), reviewers: seen({ types: [] }) }), /saw a separate reviewer agent run in/, 'no empty parentheses');
  assert.match(reviewersHtml(team(), { record: record(), reviewers: seen({ agents: 0, types: [], said: null }) }), /saw no separate reviewer agent in this job’s Claude Code sessions \(a review done in another session is not seen\)/);
  const codex = reviewersHtml(team(), { record: record(), reviewers: seen({ agents: 0, types: [], said: null, unknownTools: ['codex'] }) });
  assert.match(codex, /Whether a separate reviewer ran is not known for Codex\./);
  assert.doesNotMatch(codex, /saw no separate/);
  // The log gone from the app's window: the record's copy speaks
  assert.match(reviewersHtml(team(), { record: { ...record(), reviewers: { ...seen(), at: T0 } }, reviewers: null }), /said APPROVE/);
  // The live summary knows fewer agents than the record (the agent left the window apart from its session): the record
  assert.match(reviewersHtml(team(), { record: { ...record(), reviewers: { ...seen(), at: T0 } }, reviewers: seen({ agents: 0, types: [], said: null }) }), /said APPROVE/);
  assert.match(reviewersHtml(team(), { record: { ...record(), reviewers: { ...seen(), at: T0 } }, reviewers: seen({ said: 'REVISE' }) }), /said REVISE/, 'as many: the live one');
  // A type is escaped
  assert.doesNotMatch(reviewersHtml(team(), { record: record(), reviewers: seen({ types: ['<i>'] }) }), /<i>/);
  // In the card's checks, after the app's own look at the verdict
  const card = jobResultHtml({ team: team(), result: { record: record(), fresh: 'same', reviewers: seen(), commands: undefined } });
  assert.ok(card.indexOf('jr-seen') < card.indexOf('jr-revs'));
  setLanguage('tr');
  assert.match(reviewersHtml(team(), { record: record(), reviewers: seen({ said: 'REVISE' }) }), /ayrı bir inceleyici ajanın \(reviewer\) çalıştığını gördü\. <b>Ajanın, inceleme dosyası yazılmadan önce işin tamamı için verdiği son cevaptaki karar: REVISE; inceleme dosyasında ise APPROVE yazıyor\.<\/b>/);
  assert.match(reviewersHtml(team(), { record: record(), reviewers: seen({ agents: 0, types: [], said: null, unknownTools: ['gemini'] }) }), /Gemini için bilinmiyor/);
  setLanguage('en');
});
