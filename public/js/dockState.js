// @ts-check
// The embedded terminal's decisions, apart from its screen (terminalDock.js keeps the tabs and draws them): which tab
// still runs an AI, which one a "show the terminal" brings forward, what a tool-ended event does to a tab that is not
// there yet, and which Claude session a tab whose tool ended may go on with. Pure, so the tests run it without a
// window (docs/development-plan-2026-10-07.md, the roadmap's Y1 and Y2).
import { sessionJobId } from './jobId.js';
import { detectPrompt } from './promptHelp.js';

// An AI tab whose tool still runs: not ended (its shell closed) and not toolEnded (the launcher's mark, its shell open)
export const isRunningAi = (x) => !!x && x.ai === true && !x.ended && !x.toolEnded;

// A draft typed into an AI tool's input for the person to read and send (review U09): one line of at most 300
// characters, any language, no control character (no Enter, no escape sequence)
export const AI_DRAFT_MAX = 300;
export const aiDraftOk = (text) => typeof text === 'string' && text.length > 0 && text.length <= AI_DRAFT_MAX && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
// Whether the draft may be typed into a tab now (pure): 'type', 'bad-text', or 'asks' while the tool's screen asks
// something (promptHelp.js detectPrompt on its last text: a permission or a menu). Some menus take one key, Codex's
// "y" (yes) and "a" (always), so the draft's letters could answer them: nothing is typed then (review U09, round 1).
// A prompt that is not recognized is not caught (docs/run-hint.md).
export function aiDraftCheck(text, screen) {
  if (!aiDraftOk(text)) return 'bad-text';
  return detectPrompt(String(screen || '').slice(-2500)) ? 'asks' : 'type';
}

// The tab a "show the terminal" for a project brings forward: the newest tab of that project whose AI still runs
// (tabs: Map id -> tab, in the order they were opened); null when none runs. A tab whose tool ended is never chosen:
// the person's answer would go to an empty shell.
export function pickRunningTab(tabs, projectId) {
  let id = null;
  for (const [k, x] of tabs) if (isRunningAi(x) && x.projectId === projectId) id = k;
  return id;
}

// A tool-ended event (electron/terminals.mjs) may come before its tab exists (the screen library still loading):
// kept until the tab is added, then applied. Bounded: at most EARLY_MAX ids wait; an id of a closed tab is dropped.
export const EARLY_MAX = 16;
export function toolEndedEvent({ tabs, early, gone }, id) {
  if (typeof id !== 'string') return 'ignored';
  const x = tabs.get(id);
  if (!x) {
    if (gone.has(id) || early.size >= EARLY_MAX) return 'ignored';
    early.add(id);
    return 'kept';
  }
  if (!x.ai || x.ended || x.toolEnded) return 'ignored';
  x.toolEnded = true;
  return 'marked';
}
// A tab was added: a tool-ended event that came first applies now (true when it did)
export function takeEarlyToolEnd({ tabs, early }, id) {
  if (!early.has(id)) return false;
  early.delete(id);
  const x = tabs.get(id);
  if (!x || !x.ai || x.ended) return false;
  x.toolEnded = true;
  return true;
}

// The Claude session a Claude tab may go on with once its tool ended or its shell closed: one of its project at work
// in the last RECENT_MS. A session that names this tab's job (its first prompt, server/ingest.mjs jobId) comes first;
// a job's tab never takes one that names another job (the Building's rule, job.js resumeCandidate). A tab of no job (a
// resumed session) takes the newest, but never one of a job whose AI still runs in another tab (busyJobs: resuming
// it would open a running session twice). null when none.
export const RECENT_MS = 2 * 60000;
/** @param {any[]} sessions @param {{ projectId?: string | null, jobId?: string | null, busyJobs?: Set<string>, tool?: string }} [options] @param {number} [now] */
export function tabResumeSession(sessions, { projectId, jobId = null, busyJobs = new Set(), tool = 'claude' } = {}, now = Date.now()) {
  let named = null;
  let loose = null;
  const newer = (a, b) => !a || (b.lastAt || 0) > (a.lastAt || 0);
  for (const s of sessions) {
    if (!s || s.projectId !== projectId || now - (s.lastAt || 0) >= RECENT_MS) continue;
    // A tab goes on with a session of its own tool only (other tools' logs are read too: server/toolLogs.mjs)
    if ((s.tool || 'claude') !== (tool || 'claude')) continue;
    const sj = sessionJobId(s);
    if (sj && busyJobs.has(sj) && sj !== jobId) continue;
    if (jobId && sj === jobId) {
      if (newer(named, s)) named = s;
      continue;
    }
    // A job's tab never goes on with another job's session; a tab of no job (a resumed session) takes the newest
    if (jobId && sj) continue;
    if (newer(loose, s)) loose = s;
  }
  return named || loose;
}
