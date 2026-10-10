// @ts-check
// "This job's result" in the project drawer (docs/comprehensive-roadmap-tr-2026-10-07.md package 3): once a job reached
// its result (finish) or was accepted (done), what was asked, what changed since the job's own start copy, what was
// checked and by whom, how to open it and whether going back is there, in one place. Three kinds of evidence stay
// apart: the AI reviewer's own report, what SiberSentez itself ran (nothing yet) and the person's acceptance.
// jobResultHtml is pure (tested in node); createJobResult keeps the answers of GET /api/projects/<id>/job-changes and
// of GET /api/projects/<id>/job-result (the app's own record: when it saw the verdict and the acceptance, and whether
// the files are still those the verdict was about; docs/internal/evidence-card-plan.md E2).
import { esc, dayTime } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { startPointText } from './restore.js';

export const RESULT_STEPS = Object.freeze(['finish', 'done']);
const NAMES_SHOWN = 8;
const BASES = new Set(['no-record', 'no-copy', 'gone', 'unreadable']);
const NO_RECORD_TTL_MS = 3000;
const NO_RECORD_SOON_MS = 60000;

async function fetchJobChanges(projectId, jobId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/job-changes?job=${encodeURIComponent(jobId)}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function fetchJobRecord(projectId, jobId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/job-result?job=${encodeURIComponent(jobId)}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Why the app cannot tell whether the files are still those of the verdict (server/jobResults.mjs projectJobResult),
// in words a beginner reads: the scan's limits are one sentence, a folder that cannot be looked at another
const UNKNOWN_GROUP = {
  'no-record': 'no-record',
  'written-before-seen': 'written-before-seen',
  'no-review-time': 'no-review-time',
  unreadable: 'unreadable',
  'too-many-files': 'too-big',
  'too-large': 'too-big',
  'file-too-large': 'too-big',
  'too-deep': 'too-big',
  'folder-missing': 'folder-missing',
  folder: 'folder',
  'no-hub': 'folder',
  'legacy-hub': 'folder',
};

// What the app itself saw of the verdict (observed, apart from the reviewer's own words above it): when it saw it and
// whether the files changed since. result: the /job-result answer or null (still asked: nothing said yet). A record of
// another verdict than the one shown (the app has not looked at the new one yet: another value, or another round's
// counts) says nothing. "The same" is said only of the files compared (restore.mjs treeFingerprint: the folders a
// restore copy leaves out are not, nor a lean copy's big files and logs), never of the whole project. Pure.
const sameCount = (a, b) => !Number.isInteger(b) || a === b;
function freshHtml(team, result) {
  const review = team.review;
  const verdict = review?.verdict;
  if (!result || (verdict !== 'APPROVE' && verdict !== 'REVISE')) return '';
  const seen = result.record?.verdict;
  if (seen && (seen.value !== verdict || !sameCount(seen.blockers, review.blockers) || !sameCount(seen.nits, review.nits))) return '';
  const lead = seen ? `${t('jrSeen', { time: dayTime(seen.seenAt) })} ` : '';
  const fresh = result.fresh;
  if (fresh === 'same' || fresh === 'same-content') {
    const lean = result.record?.tree?.scope === 'lean' ? ` ${t('jrFreshLean')}` : '';
    return `<li class="jr-seen">${esc(lead + t(`jrFresh_${fresh}`) + lean)}</li>`;
  }
  if (fresh === 'changed') {
    return `<li class="jr-seen jr-stale">${esc(lead)}<b>${esc(t('jrFresh_changed'))}</b> <button type="button" class="act-btn" data-jr-act="re-review" data-fk="jr:re-review">${icon('prompt')}<span>${esc(t('jrActReReview'))}</span></button></li>`;
  }
  // A verdict the app never kept has no "seen" lead; without a record every reason is that one, and with one "no
  // record" (its files' part unreadable) is no reason to tell
  const group = !seen ? 'no-record' : result.reason === 'no-record' ? 'other' : UNKNOWN_GROUP[result.reason] || 'other';
  return `<li class="jr-seen">${esc(lead + t(`jrFreshUnknown_${group}`))}</li>`;
}

// The commands the job's AI ran and how they ended, as its own log shows them (server/jobCommands.mjs, plan E3):
// observed, not proof; an exit code says how a command ended, not what it checked. commands: the /job-result answer's
// part (null: no session of the job seen); undefined (still asked, or an older server) says nothing. Pure.
const TOOL_SHOWN = Object.freeze({ codex: 'Codex', gemini: 'Gemini', qwen: 'Qwen Code', opencode: 'OpenCode', cursor: 'Cursor', copilot: 'Copilot' });
const FAILS_SHOWN = 3;
export function commandsHtml(commands) {
  if (commands === undefined) return '';
  if (commands === null) return `<li class="jr-cmds">${esc(t('jrCmdsNoSession'))}</li>`;
  const c = commands;
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const parts = [];
  const unknown = (Array.isArray(c.unknownTools) ? c.unknownTools : []).map((k) => TOOL_SHOWN[k] || String(k));
  const ran = n(c.ran);
  // A job whose only sessions are of tools the app cannot read says that alone (never "ran no commands")
  if (ran || !unknown.length) parts.push(esc(t(`${!ran ? 'jrCmdsNone' : n(c.failed) ? 'jrCmds' : 'jrCmdsNoFail'}${ran === 1 ? '_one' : ''}`, { ran, failed: n(c.failed) })));
  const listed = Array.isArray(c.failures) ? c.failures : [];
  const fails = listed.slice(0, FAILS_SHOWN).map((f) => {
    const label = `${f.label}${f.more ? ' …' : ''}`;
    const later = f.laterOk === true ? t('jrCmdLaterOk') : f.laterOk === false ? t('jrCmdNotAgain') : '.';
    return `<li><code translate="no">${esc(label)}</code> ${esc(t('jrCmdFail', { code: f.code, time: dayTime(f.at) }) + later)}</li>`;
  });
  // Every failed line is counted, though only the newest are named (the server keeps the newest of a long job)
  const unnamed = Math.max(n(c.failedLines), listed.length) - fails.length;
  if (unnamed > 0) fails.push(`<li class="muted">${esc(t('jrCmdFailMore', { count: unnamed }))}</li>`);
  const rest = [];
  if (n(c.noEnd)) rest.push(t('jrCmdsNoEnd', { count: n(c.noEnd) }));
  if (n(c.notRun)) rest.push(t('jrCmdsNotRun', { count: n(c.notRun) }));
  if (unknown.length) rest.push(t('jrCmdsUnknown', { tools: unknown.join(', ') }));
  const note = ran ? ` <span class="muted">${esc(t('jrCmdsNote'))}</span>` : '';
  return `<li class="jr-cmds">${parts.join(' ')}${fails.length ? `<ul class="jr-cmd-fails">${fails.join('')}</ul>` : ''}${rest.length ? ` ${esc(rest.join(' '))}` : ''}${note}</li>`;
}

// Who reviewed, as the AI's own log shows it (server/jobReviewers.mjs, plan E4): observed, apart from the review file's
// words; what the reviewer agent's own last answer said is compared with the verdict shown only when the app's record is
// of that verdict and holds REVIEW.md's write time (the server leaves out the answers said after it: another round's).
// The live answer wins unless the record's copy (kept when the app saw the verdict) knows more agents: it speaks for a
// log gone from the app's window (agents leave it apart from their session). Nothing when neither is known (the
// commands line says the session was not seen). Pure.
export function reviewersHtml(team, result) {
  const agents = (x) => (Number.isInteger(x?.agents) && x.agents > 0 ? x.agents : 0);
  const live = result?.reviewers;
  const kept = result?.record?.reviewers;
  const r = live && !(kept && agents(kept) > agents(live)) ? live : kept;
  if (!r) return '';
  const n = agents(r);
  const unknown = (Array.isArray(r.unknownTools) ? r.unknownTools : []).map((k) => TOOL_SHOWN[k] || String(k));
  const parts = [];
  let warn = false;
  if (n) {
    const types = (Array.isArray(r.types) ? r.types : []).join(', ');
    const one = n === 1 ? '_one' : '';
    parts.push(esc(t(`jrRevSeen${one}`, { count: n, types: types ? ` (${types})` : '' })));
    const verdict = team.review?.verdict;
    const seen = result.record?.verdict;
    const same = !!seen?.reviewAt && (seen.value === verdict && sameCount(seen.blockers, team.review?.blockers) && sameCount(seen.nits, team.review?.nits));
    if ((r.said === 'APPROVE' || r.said === 'REVISE') && same && (verdict === 'APPROVE' || verdict === 'REVISE')) {
      warn = r.said !== verdict;
      const said = esc(t(`${warn ? 'jrRevSaidOther' : 'jrRevSaid'}${one}`, { said: r.said, verdict }));
      parts.push(warn ? `<b>${said}</b>` : said);
    }
  } else if (!unknown.length) parts.push(esc(t('jrRevNone')));
  if (unknown.length) parts.push(esc(t('jrRevUnknown', { tools: unknown.join(', ') })));
  return `<li class="jr-revs${warn ? ' jr-stale' : ''}">${parts.join(' ')}</li>`;
}

// The person's acceptance: when the app first saw it, once it did (never "accepted at": the moment is the AI's)
function acceptedText(team, result) {
  if (team.step !== 'done') return t('jrNotAccepted');
  const at = result?.record?.acceptedSeenAt;
  return at ? t('jrAcceptedSeen', { time: dayTime(at) }) : t('jrAccepted');
}

// What changed, in words and a short list (pure); null: still asked
function changesHtml(c) {
  if (!c) return `<p class="small muted">${esc(t('jrLoading'))}</p>`;
  if (c.basis !== 'start') return `<p class="small">${esc(t(BASES.has(c.basis) ? `jrBasis_${c.basis}` : 'jrBasis_unreadable'))}</p>`;
  const lines = [];
  const unknownCount = c.counts?.unknown ?? (Array.isArray(c.unknown) ? c.unknown.length : 0);
  // Nothing changed among the files that could be read: never "nothing changed" while some could not be (Z1)
  if (!c.total) lines.push(`<p class="small">${esc(t(unknownCount ? 'jrNoChangesRead' : 'jrNoChanges'))}</p>`);
  else {
    // The whole counts (the server cuts the names at its maximum)
    const n = c.counts || { changed: c.changed.length, added: c.added.length, deleted: c.deleted.length };
    lines.push(`<p class="small">${esc(t('jrChanges', n))}</p>`);
    const all = [...c.changed.map((f) => ['changed', f]), ...c.added.map((f) => ['added', f]), ...c.deleted.map((f) => ['deleted', f])];
    const shown = all.slice(0, NAMES_SHOWN).map(([kind, f]) => `<li class="jr-${kind}"><code translate="no" title="${esc(f)}">${esc(f)}</code></li>`).join('');
    const rest = c.total - Math.min(all.length, NAMES_SHOWN);
    lines.push(`<ul class="jr-files">${shown}${rest > 0 ? `<li class="muted">${esc(t('jrMore', { count: rest }))}</li>` : ''}</ul>`);
  }
  if (unknownCount) lines.push(`<p class="small">${esc(t('jrUnknown', { count: unknownCount }))}</p>`);
  if (c.notes > 0) lines.push(`<p class="small muted">${esc(t(c.total ? 'jrNotes' : 'jrNotesOnly'))}</p>`);
  if (c.scope === 'lean' && c.leftOut > 0) lines.push(`<p class="small muted">${esc(t('jrLean', { count: c.leftOut }))}</p>`);
  lines.push(`<p class="small muted">${esc(t('jrBasis'))}</p>`);
  return lines.join('');
}

// The way to answer a result that waits (review U08): the job's own AI session (its terminal tab, or the session going
// on where it stopped: main.js open-ai-terminal), never "the lead's terminal" the person has to find (pure)
function tipsHtml(tips) {
  const list = (Array.isArray(tips) ? tips : []).filter((k) => k === 'short' || k === 'many');
  return list.length ? `<div class="jr-tips"><p class="small"><b>${esc(t('jrTipsTitle'))}</b></p><ul>${list.map((k) => `<li class="small">${esc(t(`jrTip_${k}`))}</li>`).join('')}</ul></div>` : '';
}

function goHtml(go) {
  if (!go) return '';
  if (go.session === null && !go.tab) return `<p class="small">${esc(t('jrNoSession'))}</p>`;
  const stopped = go.stopped ? `<p class="small job-now">${esc(t('wsJobStopped'))}</p>` : '';
  return `${stopped}<div class="jr-go"><button type="button" class="act-btn" data-job-act="open-ai"${go.session ? ` data-job-session="${esc(go.session)}"` : ''} data-fk="job:open-ai">${icon('prompt')}<span>${esc(t('jrGoAi'))}</span></button></div>`;
}

// The result's four ways, in one row while it waits (review B3, UX plan §6.4): open it (the run section's own way),
// ask for a change and accept it (a draft into the AI's tab, never with Enter: the AI waits for the person's answer
// there), go back to before the job (the preview of its start copy, like any restore point). Open leads. Pure.
// back: { mode, busy } of the restore section (review B/C): with actions off the button asks to turn them on, as the
// section's own buttons do; while a restore runs it is disabled
export function resultActsHtml(point = null, { mode = 'live', busy = false } = {}) {
  const dis = (mode === 'dry' || mode === 'live' ? '' : ' aria-disabled="true"') + (busy ? ' disabled' : '');
  const back = point && typeof point.id === 'string' && point.available !== false ? `<button type="button" class="act-btn" data-rst-act="preview" data-rst-id="${esc(point.id)}" data-fk="jr:back"${dis}>${icon('replay')}<span>${esc(t('jrActBack'))}</span></button>` : '';
  return `<div class="jr-acts" role="group" aria-label="${esc(t('jrActsLabel'))}"><button type="button" class="act-btn primary" data-jr-act="open" data-fk="jr:open">${icon('play')}<span>${esc(t('jrActOpen'))}</span></button><button type="button" class="act-btn" data-jr-act="change" data-fk="jr:change">${icon('spark')}<span>${esc(t('jrActChange'))}</span></button><button type="button" class="act-btn" data-jr-act="accept" data-fk="jr:accept">${icon('check')}<span>${esc(t('jrActAccept'))}</span></button><button type="button" class="act-btn" data-jr-act="explain" data-fk="jr:explain">${icon('prompt')}<span>${esc(t('jrActExplain'))}</span></button>${back}</div><p class="small muted jr-acts-note">${esc(t('jrActsNote'))}</p>`;
}

// team: the /team answer (step, plan, review); changes: the /job-changes answer or null; point: the job's start
// point as the job box knows it (restore.js startPointOf) or null. '' before the result.
// steps: the job's steps (job.js stepsHtml), shown here when the result comes first in the drawer (review U07); go:
// { session: the job's session id or null, tab: an AI tab of the project runs, stopped: its AI no longer runs } while
// the result waits (finish)
// A tip for the next job, from the person's own words (plan C4; the job's start copy keeps its first 80 characters):
// 'short' when it says too little to go on, 'many' when it puts several jobs into one. At most two keys. Pure.
// Joining words as whole words in any alphabet (review B/C: \b took "güve" and "düve" for "ve"); commas count only
// beside a joining word ("add a menu, a form and colours"), so a list of adjectives ("a blue, big, round button") is
// one job
const JOIN_RE = /(?<![\p{L}\p{N}])(ve|ayrıca|sonra da|and|also|then)(?![\p{L}\p{N}])/giu;
export function jobTips(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return [];
  const words = s.split(/\s+/).filter(Boolean).length;
  const conj = (s.match(JOIN_RE) || []).length;
  const joins = conj + (conj > 0 ? (s.match(/[,;]/g) || []).length : 0);
  const tips = [];
  if (words < 6) tips.push('short');
  if (words >= 8 && joins >= 2) tips.push('many');
  return tips.slice(0, 2);
}

// cost: this job's usage in a line (jobCost.js jobCostText); '' says nothing
// tips: jobTips keys for "next time" (plan C4)
// result: the /job-result answer (the app's own record) or null
// guide: the acceptance guide (acceptGuide.js acceptGuideHtml): before Accept while the result waits, after the
// checks once accepted; '' says nothing
export function jobResultHtml({ team = null, changes = null, result = null, point = null, steps = '', go = null, cost = '', tips = [], back: backOpts = {}, guide = '' } = {}) {
  if (!team || !RESULT_STEPS.includes(team.step)) return '';
  const asked = team.plan?.title ? `<p class="small"><b>${esc(t('jrAsked'))}</b> ${esc(team.plan.title)}</p>` : '';
  const verdict = team.review?.verdict;
  const review = verdict === 'APPROVE' ? t('jrReviewApproved') : verdict === 'REVISE' ? t('jrReviewRevise') : t('jrReviewNone');
  const checks = `<p class="small"><b>${esc(t('jrChecks'))}</b></p><ul class="jr-checks"><li>${esc(review)}</li>${freshHtml(team, result)}${reviewersHtml(team, result)}${commandsHtml(result?.commands)}<li>${esc(t('jrNotRun'))}</li><li>${esc(acceptedText(team, result))}</li></ul>`;
  const back = startPointText(point);
  return `<section class="dr-sec job-result" data-sec="result" aria-labelledby="jrH"><h3 id="jrH">${icon('check')} ${esc(t('jrTitle'))}</h3>${steps}${asked}${changesHtml(changes)}${cost ? `<p class="small muted jr-cost">${esc(cost)}</p>` : ''}${team.step === 'finish' ? guide + resultActsHtml(point, backOpts) : ''}${checks}${team.step === 'done' ? guide : ''}${team.step === 'finish' ? goHtml(go) : ''}${tipsHtml(tips)}<p class="small">${esc(t('jrOpen'))}</p>${back ? `<p class="small"><b>${esc(t('jrBack'))}</b> ${esc(back)}</p>` : ''}</section>`;
}

// The answers per project and job: asked again after ttl (files change while the person tries the result). The
// app's record is asked as often as the server keeps its answer (server/jobResults.mjs JOB_RESULT_TTL_MS)
export function createJobResult({ fetchJson = fetchJobChanges, fetchRecord = fetchJobRecord, onData = (_projectId) => {}, now = () => Date.now(), ttl = 20000, recordTtl = 15000 } = {}) {
  // keepOnFail: a failed answer keeps the last good one (the changes); lifeOf(data, first): how long an answer is kept,
  // first: when the first answer for the job came
  function cached(fetchOne, failed, lifeOf, keepOnFail = true) {
    const cache = new Map();
    return (projectId, jobId) => {
      if (typeof projectId !== 'string' || !projectId || !/^J[0-9a-f]{32}$/.test(jobId || '')) return null;
      const k = `${projectId}|${jobId}`;
      const e = cache.get(k);
      if (e && (e.pending || now() - e.at < lifeOf(e.data, e.first ?? e.at))) return e.data;
      cache.set(k, { at: e?.at || 0, first: e?.first, data: e?.data || null, pending: true });
      Promise.resolve()
        .then(() => fetchOne(projectId, jobId))
        .then(
          (data) => cache.set(k, { at: now(), first: e?.first ?? now(), data, pending: false }),
          () => cache.set(k, { at: now(), first: e?.first ?? now(), data: (keepOnFail && e?.data) || failed, pending: false }),
        )
        .then(() => {
          try {
            onData(projectId);
          } catch (err) {
            console.error(err);
          }
        });
      return e?.data || null;
    };
  }
  const get = cached(fetchJson, { basis: 'unreadable' }, () => ttl);
  // A record that could not be read says nothing rather than something old (review E2: a "same" kept after the server
  // stopped answering). No record yet is asked again soon: the app writes it just after it sees the verdict
  // (server/jobResults.mjs observeTeamAnswer), so the first look often comes before it. Only in the first minute: a
  // record that stays missing (no hub, a refused folder) is asked as often as any other answer
  const getRecord = cached(fetchRecord, { failed: true }, (d, first) => (d && !d.record && d.reason === 'no-record' && now() - first < NO_RECORD_SOON_MS ? NO_RECORD_TTL_MS : recordTtl), false);
  return {
    get,
    getRecord,
    // opts: { steps, go } as jobResultHtml takes them
    html(p, team, point, opts = {}) {
      if (!team || !RESULT_STEPS.includes(team.step)) return '';
      // A job from before job ids has no start copy of its own, and no record of the app's
      const jobId = team.plan?.jobId;
      const changes = jobId ? get(p.id, jobId) : { basis: 'no-record' };
      const asks = jobId && (team.review?.verdict === 'APPROVE' || team.review?.verdict === 'REVISE' || team.step === 'done');
      const answer = asks ? getRecord(p.id, jobId) : null;
      return jobResultHtml({ team, changes, result: answer?.failed ? null : answer, point, ...opts });
    },
  };
}
