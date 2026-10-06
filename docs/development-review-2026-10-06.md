# Development review - 2026-10-06

## Follow-up implementation - 2026-10-06

The confirmed task-vs-whole-job and malformed-final-verdict defects below are fixed in the local source tree.
The review parser now preserves the latest section's scope, requires an explicit whole-job approval to finish,
validates blocker/nit arrays, rejects an unfinished latest review, and ignores fenced Markdown examples.
Known task coverage must include every current task. English and Turkish status text explains the pending
whole-job approval. Older unscoped approvals do not finish an active job; archive acceptance stays historical.

Seven regression tests cover task approvals, unresolved earlier blockers followed by another task approval,
valid whole-job approval and subsequent revisions, malformed/incomplete records, quoted examples, large task
sets, and changing files read through the project endpoint. The initial six test cases failed before the fix.
The first fix's full suite reported 1,014 tests: 1,011 passed, 0 failed, 3 skipped, across 76 suites.

The subsequent job-identity change issues a random id for each new app job, writes an immutable message and an
atomic active-job marker, and requires matching ids in the plan, task list and latest review section. Old
completed files are hidden while a new plan is pending. Preview and resume retain the active identity. Kit 0.6.1
propagates the format, and both the drawer and building explain a mismatched review in English and Turkish.
Legacy files remain readable, but active completion without identity requires fresh verification; archived
acceptance remains historical. Ids establish consistency, not independent proof of an AI's truthfulness.

Final validation after job identity: **1,022 tests: 1,019 passed, 0 failed, 3 skipped**, across 76 suites.
The new checks cover reused T1 ids across jobs, malformed/duplicate/missing ids, pending new jobs over old
completed files, atomic marker write failure, link/unknown-file refusal, both UI languages and the building's
data path. A start-action test launches eleven simulated jobs with identical text, verifies unique persistent
ids without the former nine-message limit, and confirms preview/resume preserve identity. Real AI tools were
not launched; their process starts are fakes and all test writes are in temporary folders.

Second pass (0.15.1, then 0.15.2): an independent review found that jobs accepted before job ids fell back to
Check after the upgrade; such jobs (no Job-ID line, no marker) stay done. A Job-ID written with Markdown emphasis,
code marks or a list bullet is read as the plain id; review headings may say "whole job, round 2" and name task
ranges ("T1-T3"). An unknown plain marker is set aside as `current-job.json.bak-<random>` and the new job starts;
a marker that is a link, a folder or a large file stops the start with its own reason (`job-marker-unknown`), a
marker that cannot be read just now asks to try again (`job-marker-busy`). Kit 0.6.2 tells a job started outside
the app to write its own marker so the app follows it.

After 0.15.2 the four remaining proposals were carried out too (each "Done" note below says what and what is still
open): honest tool states and a restore guard over every embedded AI tool (§2), the next-step strip (§3), the restore
coverage next to the job (§4) and the measured performance changes (§5). The only part left is the one no code can do:
validating the next-step strip with real users.

## Scope and baseline

Reviewed SiberSentez 0.15.0, commit `96951f3`.
The working tree was clean before this review. The hub folder the app creates (`%USERPROFILE%\SiberSentez`) holds data, not the source.

Evidence: source and repository documentation, the shipped `docs/screenshots/hero.webp` screenshot, the complete existing automated test suite, and three in-memory reproductions against the real team parser. The installed desktop app, real AI sessions, installer, and interactive accessibility were not exercised. Screenshot-based UX observations below are hypotheses, not findings from a live usability study.

Validation: Node v24.18.0; 62 `test/*.test.mjs` files; `node --test --test-reporter=dot "test/*.test.mjs"` exited 0. The reporter emitted 1,083 success dots. This is a baseline pass, not proof that the newly identified cases work.

## Product and architecture

The product helps beginners go from an idea to a working result using an AI coding tool they already have. Its core journey is project -> job -> plan approval -> work -> review -> result -> next step or undo.

| Layer | Current implementation |
| --- | --- |
| Desktop shell | Electron; window, tray, local server lifecycle, terminal bridge |
| Local server | Node ES modules; project discovery, actions, skills, job state, restore points |
| UI | Plain JavaScript ES modules and CSS; English and Turkish strings |
| Terminal | node-pty with vendored xterm; embedded interactive sessions |
| Team workflow | Bundled skills and agents; progress parsed from `.sibersentez/PLAN.md`, `TASKS.md`, `REVIEW.md` |
| Tool support | Multiple tools can launch; detailed live sessions and token ingestion are primarily Claude Code based |

Strengths worth preserving: a beginner-oriented journey, embedded terminal, restore previews, project-specific skills, bilingual text, a distinctive building view, and broad automated checks. Old-name references largely implement data/configuration migration and must not be removed through a blanket rename.

## Confirmed findings

### P1 - A task review can incorrectly advance the whole job to Finish

Sources: `server/team.mjs:45` (`parseVerdict`), `server/team.mjs:66` (`teamStep`), `server/team.mjs:78` (`reviewOf`).

Reproduction A: an approved plan, T1 and T2 both marked done, and only a `## Review T1` APPROVE record. Result: `finish`, although T2 and the whole job have no review.

Reproduction B: T1 has a REVISE with one blocker, followed by T2 APPROVE with no blockers. Both tasks are marked done. Result: `finish`; the earlier task's unresolved blocker is lost.

Why: the parser keeps the last verdict and combines task ids from all preceding review headings. `reviewOf` accepts any overlap with the current task ids. It does not establish coverage or require the whole-job pass described in `kit/team/skills/orchestrate-review/SKILL.md`, section 3b.

User impact: the app can display the result as ready for acceptance before the required independent checks have completed. This is a display/state defect; it does not itself submit the user's acceptance to the AI.

Proposed fix: preserve each review section's scope and verdict; distinguish task approval from a whole-job approval. Require an explicit, valid whole-job approval before Finish, and reject stale reviews from previous jobs. Add a job id to the workflow format to prevent task ids reused across jobs from being mistaken for current evidence. Define compatibility for older files explicitly instead of silently treating missing scope as full approval.

Acceptance: the two reproductions remain at Check; a valid whole-job approval advances to Finish; a later revision returns to Check; reused task ids from a different job cannot pass the gate. Existing migration/history behavior remains covered.

### P1 - A malformed latest verdict revives an older approval

Source: `server/team.mjs:47`.

Reproduction: a valid APPROVE followed by `## Review: whole job` and `VERDICT: not-json`. Result: the old approval is used and the job reaches `finish`.

Why: the regular expression only collects verdict lines with a complete brace-wrapped object. A later malformed or partly written line is invisible to the parser. A partially written review is plausible while another process writes the file.

Proposed fix: find the final verdict marker first, then parse and validate its payload. An incomplete/invalid latest verdict means no current approval. Validate required field types rather than interpreting malformed blocker data as an empty list.

Acceptance: truncated JSON, non-object values, invalid field types and unknown verdicts never fall back to an older approval; a valid final verdict still parses; CRLF is supported.

## Development priorities

### 1. Make job state trustworthy

Address the confirmed findings together in a focused change to the team parser and tests. Explain an unreadable review in plain language instead of showing a completed check. Avoid a broad UI redesign in the same change.

Exit criterion: the job only becomes ready for acceptance after the current whole-job review actually passes.

### 2. Give each tool an honest capability and lifecycle model

`server/adapters/codex.mjs` intentionally reads only the first rollout line to discover project paths; it is not a full Codex live-session adapter. `public/js/hq-live.js` separates detailed sessions/agents from other-tool activity figures, and quota is currently null. A successful launch is not evidence of working, waiting, or completed state.

Introduce explicit per-tool capabilities (launch, process state, session events, approval state, usage). First cover the app's own embedded sessions with process/terminal lifecycle information, then add tool-specific event ingestion using supported interfaces. Show unknown states honestly. Review the restore guard in `server/actions.mjs:845`, which currently checks ingested live sessions, against all tools the app can launch; this is a follow-up risk to test, not a reproduced data-loss finding.

Exit criterion: Codex and Gemini launches show correct running/exited state; unsupported approval/usage data is not guessed; an active supported tool cannot race a restore unnoticed.

Done (after 0.15.2): the embedded terminal keeps the tool and the app job of every AI start
(`electron/terminals.mjs`) and tells the server after every open, exit and close, and again to a restarted server
(`terminal-state` over the shell channel, `actions.terminalState`). A restore is refused while any AI tool runs in the
project's embedded terminal, not only a Claude session with logs (`aiActiveIn`). The building no longer reads a recent
file of Codex, Gemini and the others as "working": a recent trace is "active recently (state not known)", a tool open
in SiberSentez's terminal for the project is "open in the terminal", and only a verified state turns the sign to
working. A Codex or Gemini tab that ends never offers to resume a Claude session. A resumed start keeps its project.
Still not known and not guessed: whether such a tool waits for an answer, and its usage.

### 3. Put the user's next action ahead of secondary controls

The shipped hero screenshot presents onboarding, a job field, counters, a building toolbar and a team panel together. Preserve the approved building design, but make one state-dependent instruction and primary action prominent: create a project, give a job, answer the plan, inspect the result, or continue an interrupted job. Keep the simulated example clearly distinguishable from live activity.

Start with a small layout prototype and test it at a laptop-sized viewport and with keyboard navigation. Do not infer mobile support from the Windows desktop scope.

Exit criterion: a first-time user can identify the next required action without opening a help panel; simulated activity is never mistaken for a running job. Validate with actual users before calling this a proven improvement.

Done (after 0.15.2): `public/js/nextStep.js` decides the one next step from what is known about the shown project
(demo, no project, an AI error, the plan, the result, a waiting session, a stopped job, working, a tool open in the
terminal, else "say what should be done"). A strip above the building says it in one sentence with at most one
button, before the job box, the toolbar and the hidden navigation buttons; the sign reads the same step, so an error
or a stopped job is never "resting". The demo says it is an example in which nothing runs, with a way back; a rewound
past moment says so and goes back to now. Checked by the packaged app's QA run at a 1366 x 768 laptop screen, in a
live state and in the example (`qaLaptopProbe`): the strip is in the first screen, fits one line, causes no sideways
scroll, and its button is the first control the keyboard reaches. Not yet validated with users.

### 4. Make restore coverage understandable

A restore point is not an unconditional full backup. `server/restore.mjs` has a full scope (3,000 files, 50 MiB total, 16 MiB per file) and a lean fallback (up to 6,000 files / 150 MiB, skipping files over 2 MiB and logs). Generated folders are excluded. `takeStartPoint` in `server/actions.mjs` reports a backup problem but does not itself stop an AI start.

Audit existing notices, then show the latest point's scope, skipped content and failure clearly next to the current job. Align broad documentation promises such as "Undo is always there" with the actual coverage. Avoid duplicate confirmations where an adequate notice already exists.

Exit criterion: the user can tell whether this job has a restore point and what it will not restore; full, lean and failed cases are covered by UI checks.

Done (after 0.15.2): the start answer carries what its point holds (scope, files left out, files, bytes); no hub is
said (`no-hub`), not silent. The job box says, next to the job, whether a full copy, a lean one (how many big files
and logs it left out) or none was kept, with a way to the restore points; the start notice says a lean copy too. The
drawer shows what a copy never holds in plain sight. The point problem texts name the real limits (a lean copy first:
150 MB, 6000 files); README and the site no longer promise "always". The hub keeps what each app job's start kept
(`start-points.json`, docs/restore.md §8), so the job box says it after a reload and in another window too.

### 5. Improve responsiveness and maintainability after correctness

The documented roster scan still performs synchronous disk work; terminal backpressure does not yet use xterm write acknowledgements. Measure responsiveness under large libraries and sustained terminal output before choosing a worker or queue design. Keep these separate from cosmetic changes.

Large modules include `public/js/views/drawer.js` (~116 KB), `server/actions.mjs` (~80 KB), and `electron/helpers.mjs` (~74 KB). Extract a coherent responsibility when touching these files; avoid a wholesale rewrite without a user-facing reason.

Exit criterion: measured worst-case interaction latency improves on the same fixture; terminal output remains complete and ordered; project discovery results remain unchanged.

Measured 2026-10-06 on the owner's machine (2,378 skills and agents, 30 projects, 6 tools): the minute's reload is
about 0.1 s (projects 84 ms, views 20 ms, JSON 11 ms, 1.4 MB); the skill and agent scan 0.45-0.5 s in one piece (60 %
of it file system calls: stat, readdir, lstat), cold 1.5 s once at start. Done: the five-minute rescan runs in steps
(`catalog.loadRosterInSteps`: the library and the kit, each tool's global items, each project folder) and gives the
loop back between them; the roster, the counts, the hub and the kit change together at the end, and a full scan after
an action wins. Same fixture: the longest pause 515 ms -> about 220 ms (the largest step was Codex's global items,
about 0.13-0.2 s in one adapter call: 165 cached plugins). Then the tools that read many plugins hand their global
items over in parts (`globalItemSteps`: Codex one part per cached plugin, Claude Code one per plugin) and the rescan
gives the loop back inside one tool's read once 16 ms went by: the longest pause about 145 ms -> about 60 ms (now one
project folder); the total stays about 0.45 s; the answer is the same item for item (2,378 items and every project's
counts compared with the code before). An action still rescans in one piece, so its reply counts the change.

Terminal output, measured 2026-10-06 in the app's page in an Electron window (off screen, rendering, the QA stand-in
terminal fed at the rate the main process sends at most: 128 KB every 32 ms, about 3.9 MB/s for 4 s, 15 MB of
coloured build lines): no task of 50 ms or more, frames at the display's 144 fps, a timer (a key's echo) waits at most
6 ms, and the last line is on screen 35 ms after the output stops. With the CPU slowed four times (a weak laptop):
86 fps, the longest frame 25 ms, a timer at most 39 ms, 48 ms to settle. xterm keeps up with everything the window can
be sent, so an xterm write acknowledgement is not needed: the 32 ms batches and the pty paused at 128 KB waiting are
enough. Not measured here: the IPC hop from the main process (one structured-clone message per 32 ms).

## Suggested implementation sequence

1. Add regression coverage for review scope and malformed final verdicts; fix the parser and state gate.
2. Implement a common embedded-session lifecycle and explicit tool capability labels.
3. Prototype the next-action presentation while retaining the building; validate with users.
4. Improve restore coverage visibility and documentation.
5. Profile long-running use, then make targeted performance changes.

The first implementation should be item 1. It is a concrete correctness improvement supported by direct reproduction, and improves trust in every later workflow feature.
