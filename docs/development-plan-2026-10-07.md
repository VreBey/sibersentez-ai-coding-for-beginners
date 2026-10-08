# Development review and next plan — 2026-10-07

## Follow-up (local, not yet released; the version is chosen at release)

Package A and two items of the Turkish roadmap are done; each started from a reproduction turned into a test.

- **F1 / A1, resume eligibility:** one function for the Building, its next step and the drawer
  (`job.js` `resumeCandidate`). An AI tool of the project open in the terminal means nothing stopped; the job's marker
  now keeps the tool it was started with, and a job another tool started never offers a Claude session; a Claude
  session whose first prompt names this job's file is the one, one naming another job never is; a session naming no
  job keeps the 15-minute fallback. Found while fixing it: the terminal's `cmd /k` shell stays open after the tool, so
  an open tab was taken for a running AI (also by the restore guard). The launcher now leaves a mark when the tool
  ends; the desktop shell tells the server (`running: false`) and the page. Tests: `test/resume.test.mjs`,
  `test/terminal.test.mjs`.
- **F2 / A2, present availability:** `/restore` job records carry `available`; the job box checks the list (every 30 s
  while it shows a copy, at once after a start or going back) and says when a copy is gone; the current job's start
  copy is kept past the limit (one point more at most). Tests: `test/restore-coverage.test.mjs`.
- **Roadmap B3, result independent of Claude:** a job at `finish` is the next step whatever tool did it; it opens in
  the waiting lead, else the tool's open terminal, else "How to run it" (also shown at `finish` now).
- **Roadmap B5:** the licence paths in Settings keep their backslash.
- Documents corrected: the GitHub import fallback list, the installer evidence in the backlog.
- Correction to the baseline below: the packaged laptop probe measured the `working` and `demo` states, not `give`.

Not done here: package B (the end-to-end journey harness), C (the user study), D, E, and roadmap B4 (one primary
action on the empty first screen; the strip sits below the welcome card there).

## Decision

Keep the building and the beginner-first product direction. Version 0.16.0 implements the main proposals from the
October 6 review. The next increment should make the new features agree across the whole journey: which job is
running, which session can continue it, and whether its restore point still exists. Two reproducible gaps make this
the first priority. Then validate the journey with people before adding more tools or screens.

This document is a review and implementation plan. Application code was not changed in this pass.

## Baseline and evidence

- Source: version **0.16.0**, commit **cfa6aa5**; working tree clean before this review.
- Fresh full suite: `node --test --test-reporter=spec "test/*.test.mjs"` on October 7: **1,044 tests, 1,041 passed,
  0 failed, 3 skipped**, 76 suites, about 45 seconds. Log: `%TEMP%/sibersentez-review-20261007-tests.log`.
- Two additional reproductions used the current exported functions and a temporary project; no real AI tool was
  launched and no real project or hub was changed. Both are described below.
- Existing packaged-app evidence, inspected rather than rerun: `qa/electron-qa-sonuc.json`, dated October 6,
  reports version 0.16.0 and **41/41 checks**. Laptop checks cover `give` and `demo` at 1366 × 768; the terminal
  check loads node-pty and echoes a command. This is not evidence of the complete live AI/restore journey.
- Inspected the existing `qa/electron-panel.png`. No fresh interactive desktop walkthrough, installer exercise,
  user study, or performance benchmark was performed in this review.

The passing suite is useful evidence, but it did not catch the two compositions below. Some new wiring tests assert
source strings; add behavior tests at the boundaries rather than increasing that kind of assertion.

## What is implemented

| Earlier proposal | Current evidence | Remaining boundary |
|---|---|---|
| Whole-job review and job identity | `server/team.mjs`, `server/job-id.mjs`, review-gate and identity tests; migration handling added in 0.15.2 | Preserve these checks during later changes |
| Honest state for other tools | Embedded starts carry tool/project/job identity; terminal changes reach the server; recent traces are not called working | Resume selection still uses a different, Claude-session-only view; see F1 |
| One next action | `public/js/nextStep.js`, workshop strip and sign, rewind handling, bilingual strings | All transitions and real-user comprehension need validation |
| Restore coverage beside the job | Start answers, persisted `start-points.json`, reload retrieval, lean/full/failure text | A recorded copy is not proof the copy is still available; see F2 |
| Less disruptive roster refresh | Stepped scan, per-plugin yields, atomic publication, a newer full scan wins; catalog tests pass | Previous performance numbers were not rerun; action-triggered scans remain synchronous |

Do not schedule these implemented features again as new work. The earlier statement that only user validation is
left is too broad: F1 and F2 require code changes first.

## Reproduced findings

### F1 — An open Codex terminal can be presented as a stopped job with a Claude resume action (P1)

**Trigger:** a project has an unfinished current job, a Claude session that closed recently, and a Codex terminal
currently open. The old session is within the 15-minute job timestamp allowance.

**Observed:** `stoppedSession` returns the old Claude session; `toolActors` correctly reports Codex as `running`;
`nextStep({ stopped: true, running: true })` selects `{ key: 'stopped', act: 'resume' }`. The workshop can therefore
tell the person to continue the old session while their current tool is already open. This is an incorrect
suggestion, not an automatic launch.

**Evidence:** `public/js/views/job.js:80` considers logged sessions only. Workshop facts at
`public/js/views/workshop.js:787` and `:833` use that result without the dock state; `public/js/nextStep.js:21`
prioritizes stopped over running. The drawer also calls `stoppedSession` at `public/js/views/drawer.js:1825`.
The terminal dock itself has a Claude-only resume guard; that fix does not cover the workshop and drawer.

**Reproduction inputs:** `now = Date.now()`; closed session
`{ id: 'old-claude', projectId: 'p', lastAt: now - 60000, live: null }`; job updated at `now`; dock entry
`{ projectId: 'p', tool: 'codex' }`. Compose `stoppedSession`, `toolActors`, and `nextStep` as the workshop does.
Result: Codex actor `running`, resume candidate `old-claude`, next action `resume`.

**Fix direction:** one shared resume eligibility function for the workshop and drawer. Any known active embedded
AI in the same project prevents a stopped-job suggestion. For new jobs, prefer a verified job/tool/session
association; the timestamp window alone cannot establish ownership. Where a resumable session cannot be identified,
offer the current terminal or explain that continuation is unknown. Preserve a documented conservative fallback
for legacy jobs without identities.

### F2 — A pruned restore point still promises that the user can return to it (P1)

**Trigger:** a job's start point is recorded; five newer points are created. This can happen during the same long
job through resumes or other snapshots without creating a new job identity.

**Observed:** the original point disappears from the available list, but its job record survives. Rendering that
record in Turkish still says: "Bu işten önce projenin bir kopyası alındı: ona geri dönebilirsin."

**Evidence:** `server/restore.mjs` keeps 5 points (`RESTORE_KEEP`) and 20 job records (`JOB_POINTS_KEEP`).
`listJobPoints` at line 198 reads historical records without checking the point; `projectRestore` at line 516
returns those records alongside the available points. `public/js/restore.js` caches a found record and
`startPointText` treats its id as sufficient. `public/js/strings/restore.js:52` promises a return.

**Reproduction:** create a temporary hub/project with `a.txt`; call `createPoint({ reuse: false })` and
`recordJobPoint` for job `J` + 32 `a` characters. Change `a.txt` and create five more points with increasing times.
Call `projectRestore`, then `startPointText` on that job record. Result: `pointStillAvailable: false`,
`recordStillPresent: true`, `keptPoints: 5`, and the return promise above. Temporary data was removed afterward.

**Fix direction:** distinguish historical coverage from present availability. Preserve the historical record but
return an explicit available/expired/unavailable status, using the validated point list as evidence. Show an
expired copy plainly, refresh cached availability after point-changing actions and reloads, and direct the person
to points that actually remain. Merely changing the retention count postpones the problem.

## Ordered work packages

### A. Correct the two promises — next patch

Deliver F1 and F2 as separate focused changes, each with a reproduction test before the fix.

**A1: resume eligibility**

- Scope: `public/js/views/job.js`, workshop and drawer callers; dock/server metadata only where an identity is needed.
- Tests: closed Claude + open Codex; closed Claude + open Gemini; other project's open terminal; genuinely stopped
  Claude; current job versus another recent job; legacy job. Assert the selected session and actual offered action.
- Acceptance: the workshop, drawer and terminal agree; no unrelated session is offered as this job's continuation;
  no automatic response or resume is introduced. Existing plan, result, error, and rewind priorities remain valid.

**A2: current restore availability**

- Scope: `server/restore.mjs`, `public/js/restore.js`, restore strings, focused coverage tests.
- Tests: valid point; reused point; lean copy; failed copy; point aged out by retention; missing/damaged manifest;
  same open page after another point is created; reload. Exercise server response through rendered text.
- Acceptance: a missing point never promises a return. Existing snapshots and old start records remain readable;
  the historical coverage stays visible without inventing present availability. Both languages are covered.

Exit gate: both reproductions turn into passing regression tests and the full suite passes. No building redesign
or broad module rewrite belongs in this patch.

### B. Verify one complete job journey — after A

Add an isolated behavior harness with temporary project/hub data and fake tool lifecycle events. Use the existing
test seams and QA machinery; real credentials or paid AI runs are unnecessary for deterministic checks.

Cover: give a job → launcher prepared → terminal opens → plan waits → work → review requests changes → re-review
approves → user accepts → result/changes/restore are reachable. Also cover launcher failure, a full dock, terminal
close, server restart with a terminal still open, page reload, project switch, and returning from rewind.

Assert the visible instruction, action target, job identity and restore availability at each transition. Include
Codex/Gemini open-state cases and preserve unknown approval/usage states instead of deriving them from silence.
At 1366 × 768, test every reachable strip state in Turkish and English with keyboard focus, not just `give` and
`demo`; include enlarged text and the terminal open.

**Additional review boundary, not a reproduced race:** terminal-state delivery in `electron/main.mjs` is asynchronous;
restore eligibility in `server/actions.mjs` reads the last received list. Exercise delayed/missing delivery and
server restart. If the test exposes an unsafe interval, reserve a project launch before spawning and clear or
confirm it on explicit outcomes. A missing notification must not silently mean that no tool is active.

Acceptance: user-facing transitions are exercised through real module boundaries; failed starts and unknown state
have an understandable action. Keep source-string assertions only for static wiring that cannot be tested better.

### C. Validate the beginner journey — after A, using B's scenarios

Invite five people unfamiliar with the app for a short observed session. No background analytics is required.
Use a prepared disposable project. Ask them to create/select a project, give a small job, answer a plan, identify
a stopped tool, inspect the result, and explain what a lean or expired restore point means.

Proposed decision thresholds: at least four of five find the next action within 10 seconds without coaching;
none mistakes the example for live work or an expired point for an available restore; all can find the result and
the changes. Record where they hesitate and any keyboard/focus failures. These are proposed targets, not measured
outcomes or statistical proof.

Preserve the building. Reuse the existing run, changes, answer and restore actions rather than adding a competing
dashboard. Simplify placement or wording only where the observations show a problem.

### D. Strengthen identity before expanding integrations — following increment

Two existing backlog items deserve separate design-and-test changes:

1. **Same-named plugin origins:** `server/catalog.mjs:839` still merges roster entries by lowercase `kind:name`.
   Define stable origin-aware identity for plugins and a migration/compatibility map for saved selections and action
   ids. First reproduce the collision with two adapters; ensure choosing one cannot target the other's plugin id.
   Do not split intentional shared skill entries blindly. Audit installation/toggle/import consumers before changing keys.
2. **Moved project history:** design a user-confirmed relink with a preview of histories to join. Keep old ids as
   aliases so usage is not double counted and sessions, jobs and restore history remain attributable. A matching
   name or remote alone must not automatically merge independent clones. Test same-name projects, separate clones,
   a missing old folder and rollback of a mistaken relink.

These are known backlog/source-design issues, not newly reproduced end-to-end defects in this review. Keep them
behind A–C unless actual support cases make one urgent. Add no new tool adapter until its identity and capability
boundaries are clear.

### E. Keep release evidence current — alongside the next release

Record the exact commit, packaged version, full-suite result, packaged QA result and installer smoke result together.
Exercise install → upgrade → first launch → uninstall with user data retained in a disposable Windows environment.
The backlog still says installer testing never happened, whereas `docs/direction.md` records an older install/upgrade
smoke test; reconcile those records by version and scope rather than treating either as proof of the current release.

Keep the existing manual publication/signing boundaries. Signing status in `docs/code-signing.md` is local project
documentation, not newly verified provider eligibility. No publication or certificate purchase is proposed here.

## Work deliberately deferred

- A full UI rewrite, new framework, mobile/remote access, parallel worktrees and PR management.
- More agents/skills without a demonstrated beginner need.
- Guessed quota, waiting state or usage for tools that do not expose it.
- A worker-thread rewrite or xterm acknowledgement redesign without a new measured bottleneck. The stepped scan is
  already implemented; rerun the existing performance fixture when changing its data flow or output rate.

## Handoff

Start with **A1**, then **A2**; use **B** as the integration gate. Preserve concurrent edits, work against the actual
current revision, and keep each change independently reviewable. A completed task must state the triggering case,
the new behavior, the behavior tests run, and any remaining real-machine validation. User study C and release
exercise E are separate evidence: a passing automated suite must not be reported as either one.
