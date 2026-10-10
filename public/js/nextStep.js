// @ts-check
// The person's next step (docs/internal/development-review-2026-10-06.md §3): one sentence and at most one button above the
// building, so the next required action comes before every secondary control. The sign reads the same answer, so
// the two never disagree. Pure: what is known about the shown project in, { key, act } out; strings/workshop.js
// holds the words (wsNext_<key>, wsNextGo_<key>), views/workshop.js the buttons.
//
// In order, the first that holds:
//   demo        the example plays: nothing here really runs (back to the person's projects)
//   past        a past moment is on screen (the rewind): the next step is about now (back to now)
//   newProject  no project of the person's own yet (create one for an idea)
//   error       the AI stopped on an error: a limit, sign-in, the connection (the job box says which)
//   plan        the AI's plan waits for the person's answer
//   result      the result is ready to be checked and accepted, whatever tool did the job (resultAt: where it is
//               opened: 'lead' the waiting Claude lead's card, 'terminal' the tool open in SiberSentez's terminal,
//               'drawer' the project's "How to run it")
//   waiting     an AI session waits for the person's answer
//   stopped     the job stopped before it was finished and no AI runs (go on where it stopped)
//   working     the team works: nothing to do (no button)
//   running     a tool is open in SiberSentez's terminal: what it does is shown there
//   give        nothing runs: say what should be done next
export const NEXT_STEPS = Object.freeze(['demo', 'past', 'newProject', 'error', 'plan', 'result', 'waiting', 'stopped', 'working', 'running', 'give']);
const ACTS = Object.freeze({ demo: 'back-live', past: 'back-now', newProject: 'new-project', error: 'jobbox', plan: 'open-lead', result: 'open-lead', waiting: 'open-session', stopped: 'resume', working: null, running: 'show-terminal', give: 'give' });

const RESULT_ACTS = Object.freeze({ lead: 'open-lead', terminal: 'show-terminal', drawer: 'open-run' });
export function nextStep({ demo = false, past = false, hasProject = true, error = false, planPending = false, resultReady = false, resultAt = 'lead', waiting = 0, stopped = false, busy = false, running = false } = {}) {
  const key = demo ? 'demo' : past ? 'past' : !hasProject ? 'newProject' : error ? 'error' : planPending ? 'plan' : resultReady ? 'result' : waiting > 0 ? 'waiting' : stopped ? 'stopped' : busy ? 'working' : running ? 'running' : 'give';
  return { key, act: key === 'result' ? RESULT_ACTS[resultAt] || ACTS.result : ACTS[key] };
}
