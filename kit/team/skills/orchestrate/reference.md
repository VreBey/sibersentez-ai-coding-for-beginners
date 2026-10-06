# Orchestrate: file templates

All files live in `.sibersentez/` at the project root. Write them in the user's language. The key words in capitals or
in code style stay English so that every step can find them.

## Status words

Used as the last line of a `REPORT-<id>.md` (builder, frontend-builder, backend-builder, tester, debugger):

- `DONE`: the task is finished, its acceptance check ran and passed, nothing to worry about.
- `DONE_WITH_CONCERNS`: finished and the check passed, but something deserves a second look; the concerns are
  listed in the report.
- `NEEDS_CONTEXT`: cannot continue because a fact or a decision is missing, or because the task needs a file that is
  not in its `files` list; the report names the fact, or the file and why. Nothing outside `files` is touched.
- `BLOCKED`: cannot continue because of the environment, a tool or an outside cause (a program that is not
  installed, a command that does not run, no access); the report says what was tried.

Who writes which file: every role returns its result in its answer and the conductor saves it. A builder's,
tester's or debugger's answer becomes `REPORT-<id>.md`, unchanged; the reviewer's answer is added to `REVIEW.md`,
unchanged, under its own heading. Helpers never write into `.sibersentez/` (some tools refuse report files from
helpers). In hat mode the
conductor writes `REVIEW.md` itself while wearing the reviewer hat.

## Verdict line

The last line of each review in `REVIEW.md` (the reviewer's answer, added by the conductor):

```
VERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}
VERDICT: {"verdict":"REVISE","blockers":[{"file":"src/a.js","line":12,"issue":"...","fix":"..."}],"nits":["..."]}
```

Gate: `APPROVE` with an empty `blockers` list passes. Anything else starts a fix round. After the second fix round a
`REVISE` still stands: stop, explain in one sentence, and offer three choices: one more round, accept it as it is,
or rethink the plan together (`plan-challenge`). The user decides. A changed file that is not in the task's
`files` list makes the verdict `REVISE` by itself, unless it is in the allowed set: the task's `files`, `.sibersentez/**`,
files already changed in the start state written in `LEDGER.md`, and the `files` of tasks that are already `done`.

## PLAN.md

```markdown
# Plan: <short title>

Size: small | medium | big
Goal: <one sentence>

## In scope
- ...
## Out of scope
- ...
## Approach
<a few lines: the way, the order, why>
## Risks
- ... (data loss, money, secrets, packages to install, accounts)
## Done when
- [ ] <something that can be run or seen>
- [ ] ...
## Approval
Approved: no
Date:
Result: open
```

## TASKS.md

```markdown
# Tasks

## T1: Write a failing test for <behavior>
- owner: tester
- files: test/example.test.js
- do not touch: application code
- depends on: none
- acceptance: the new test runs and fails on its assertion; the red output is in `REPORT-T1.md`
- risks: none
- status: todo

## T2: Implement <behavior>
- owner: builder
- files: src/example.js
- do not touch: package.json, anything not listed above
- depends on: T1
- acceptance: `npm test` passes, the T1 test now passes
- risks: none
- status: todo

## T3: Run the tests again after T2
- owner: tester
- files: none
- do not touch: application code and test files
- depends on: T2
- acceptance: the T1 test and the whole suite pass; the green output is in `REPORT-T3.md`
- risks: none
- status: todo
```

Status values: `todo`, `doing`, `done`, `blocked`. Every task fits in about two hours, touches at most five files
and leaves the project working; a longer or wider task is split. Two tasks that could run at the same time share no
file. Test first, where a test can exist: in a medium or big job a task that changes behavior comes after the test
task that shows the red result (as T2 after T1 above), and a green task after the build (T3 above) has the tester run
the same test and the whole suite again and keep the green output in its own report. In the red task `DONE` means the
new test fails on its assertion for the expected reason and the rest of the suite passes; in the green task it means
the whole suite passes.

Small job (one behavior, at most about 3 files, under an hour, no data, account or money involved): one builder task
that carries its own proof.

```markdown
## T1: Reject an empty title in the note form
- owner: builder
- files: src/noteForm.js, test/noteForm.test.js
- do not touch: anything not listed above
- depends on: none
- acceptance: write the test first and copy its red output into `REPORT-T1.md`; make the change; copy the green output
  and the whole-suite result too
- risks: none
- status: todo
```

When a test cannot be written (a Unity scene, how a screen looks, a flow tried by hand), the acceptance holds manual
steps instead: "open the notes page, add a note with no title, you should see the message Title is required". The
report then says what was opened and what was seen.

## REPORT-<id>.md

```markdown
# Report T1

## What was done
<a few lines>
## Files changed
- src/example.js
## Commands run
- `npm test` -> 12 passed, 0 failed
## Red and green (a small job's builder report only)
- red: `node --test test/noteForm.test.js` -> 1 failed: expected the message "Title is required", got nothing
- green: the same command -> 1 passed; whole suite -> 13 passed, 0 failed
## Concerns
<none, or a short list>

DONE
```

The last line is one status word and nothing else.

## REVIEW.md

```markdown
## Review T1

Reviewed in: a separate session | the same session, lower confidence
Round: 1 of 2
Notes: <none, or for example "no git, lower confidence">

## Findings
1. src/example.js:12 - blocker - <problem> - <fix>
2. src/example.js:30 - nit - <small matter>

## Acceptance
- Done when "<item>": met - `npm test` -> passed
- T1 acceptance "<text>": not met - <reason>

## Checks run
- `npm test` -> passed

VERDICT: {"verdict":"REVISE","blockers":[{"file":"src/example.js","line":12,"issue":"<problem>","fix":"<fix>"}],"nits":["<small matter>"]}
```

The "Acceptance" section has one line per acceptance check, "met" with its proof or "not met" with the reason. The
whole-job pass (once, after every task has passed) is headed `## Review: whole job` and covers every "done when" item
and every task; it also runs when the job had a single task. The reviewer returns exactly this text as its answer.
The conductor adds it to `REVIEW.md` unchanged under its own heading; earlier reviews are never overwritten. The last
`VERDICT:` line in the file is the verdict that counts. The same template stands in the `reviewer` agent and in
`orchestrate-review`.

## LEDGER.md

```markdown
# Ledger

- 2026-01-15 Plan approved by the user. Size: medium, 4 tasks.
- 2026-01-15 Start state: HEAD 3f2a9c1 (or "no commit" / "no git"); `git status --short` showed: ` M README.md`.
- 2026-01-15 T1 built (DONE). T2 built (DONE_WITH_CONCERNS: slow test).
- 2026-01-15 Check round 1: REVISE, 1 blocker in src/example.js. Sent to builder.
- 2026-01-16 Check round 2: APPROVE. Finish: 3 of 3 done-when items met. Result approved by the user.
```

One dated line per decision or round. It is the map for picking the job up again after a lost session.
