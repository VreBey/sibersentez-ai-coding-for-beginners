# The kit in the app: "Do a job"

Status: built 2026-09-30 (first step of `docs/direction.md` §3). The kit's team flow (`docs/kit-v2.md` §3) reaches the
person through one section of the project drawer.

## 1. What the person sees

Under "Then: start with AI" in the project drawer, **Do a job**:

1. When the team has files in the project, a four-step bar (**Plan → Build → Check → Finish**) with the current step
   marked and one plain sentence: the plan waits for your approval; working on T2, 1 of 3 tasks done; T2 is stuck;
   the check found 2 problems, fixing them; the check approved the job. Once the person accepted the result every
   step is ticked: the job is finished, write the next one.
2. When the team skills are not in the project (the fit says `skill:orchestrate` is not installed): one line and
   **Install the team**. In live mode it asks once ("Yes, install the team" / "Cancel"); in Preview it only shows
   what would be installed. It uses the fit's own install request (`skills-apply` with the team keys); the server
   skips what is installed already. When the team is installed: **Update the team**. It first asks for a preview of
   the team items (`skills-preview`, writes nothing); items the kit has a newer copy of (`kit-changed`) are named in
   one question ("Yes, update" / "Cancel") and only those go to `skills-install`. Files the person changed are
   skipped by the install plan (`modified`). Without this an improved kit never reached a project that had the team.
3. A one-line box for the job (at most 300 characters) and one button per installed AI tool: **Start the job with
   Claude Code**, … Off: the buttons open the actions chooser. No tool: the tools panel. A job started live leaves
   the box empty for the next one.

## 2. How the job reaches the AI

`start-ai` takes `job` (docs/ai-start.md): a string, cleaned like an idea (controls and invisible marks out, spaces
collapsed, at most 300 characters), never together with `withIdea` or `resume`, never empty. The server writes it into
the first-message file (`.sibersentez/job-<id>.md`, created exclusively with a fresh app-issued job id; existing
different contents are never replaced) with `jobMessageText`: the job quoted, then: use the orchestrate skill if
it is installed, otherwise follow the same steps; the person approves the plan and the result; ask before deleting,
installing, pushing, publishing or paying; plain words, one question at a time; offer the agent-rules starter lines
once and add them only after a yes; talk in the job's language. The command line only ever carries the fixed prompt
that names the file.

SiberSentez itself writes nothing into the project's own files: the starter lines in AGENTS.md or CLAUDE.md are added
by the AI tool, through the `agent-rules` skill, after the person says yes.

Every new job start gets an id of `J` followed by 32 random lowercase hex digits, even for identical job text.
After the restore point and immutable message are written, the app atomically saves `.sibersentez/current-job.json`
(`version: 1`, `jobId`) before handing the job to a terminal. A failed launch can leave this new job pending;
it never revives the previous job's completed state. Preview writes nothing; resume keeps the original id.
The marker rejects links, directories, unreadable or unknown contents; a write failure prevents launch.
The model must never edit this app-owned marker. The original nine-name limit remains for idea messages only.

## 3. How the progress is read

`GET /api/projects/<id>/team` (`server/team.mjs`), read-only, no action mode needed:

- only `<project>/.sibersentez/` when it is a real folder (a link or a junction is never followed), and only files up to
  the manifest limit (256 KB);
- `PLAN.md`: title, size, `Approved: yes`, `Result: accepted` (written by the wrap-up after the person's yes);
  `TASKS.md`: every `## T<n>: title` block with its owner and status
  (`todo`, `doing`, `done`, `blocked`; anything else counts as todo); `REVIEW.md`: the last `VERDICT:` line in the
  latest review section. The answer includes its `scope` (`tasks`, `whole`, or `unknown`). Task verdicts refer only
  to their own `## Review T1, T2` heading. A whole-job verdict must be under `## Review: whole job` (also accepts
  `## Review of the whole job`, optionally followed by a parenthesized round). Its task ids come from earlier
  task-review headings when present; every current task must be among them before Finish. A standalone explicit
  whole-job review is supported. A review with named task ids but no overlap with the current tasks counts as no review;
- a new review heading without a verdict, or an invalid final verdict, invalidates any older approval. The verdict
  must name `APPROVE` or `REVISE` and contain `blockers` and `nits` arrays. Fenced Markdown examples are ignored;
- step: `none` (no team files), `plan` (no approved plan or no tasks), `build` (tasks left), `check` (all done, no
  valid whole-job approval), `finish` (all done and the whole-job review approved without blockers), `done` (the same
  checks plus the result accepted). Task approvals, including a single-task job, never replace the whole-job pass.

Identity: PLAN.md and TASKS.md carry one `Job-ID:` line below the title and before sections. Every review section
carries its own `Job-ID:` below its heading; it never inherits a preceding review's id. All must match the active
marker when it exists. A missing, invalid or repeated id is not evidence. While a new job still has old plan/task
files, the endpoint shows Plan and hides the stale counts and approval. A wrong-job review is not displayed.

Compatibility: old files remain readable and archived acceptance stays historical data. An active job with no id
cannot reach Finish/Done: its plan/task association and whole-job review must be freshly verified with one shared
id. Never relabel an old review to make it pass. The UI explains this in both languages. Kit 0.6.1 propagates ids
through the conductor, planner, task-slicer, reviewer and wrap-up; new app messages carry these rules even when an
older team kit is installed. The archive-on-next-job rule still preserves old work. This is a consistency check,
not proof of who reviewed: an AI or local process that rewrites matching ids and approval text can still misreport.
Kit 0.6.2: a job started outside the app writes its own marker, so the app follows it.

A finished job's files are moved to `.sibersentez/archive/<date>-<name>/` by the orchestrate skill when the next job
starts (the kit's own hand-off files, no question needed); the ledger, memory and handoff notes stay.

The drawer asks again every 8 seconds while it is open (`createJob`), so the bar follows the AI's work.

## 4. Tests

`test/team.test.mjs` (parsers, step, junction and size refusals, the route body), `test/team-review-gate.test.mjs`
(whole-job scope, malformed/incomplete latest reviews, task coverage, Markdown examples and file-to-endpoint regressions),
`test/job.test.mjs` (the section,
the team confirmation, the bar and its sentence, the cache, every team key is a kit item, the drawer wiring),
`test/ai-start.test.mjs` (the first message of a job, the field rules, the preview).

## 5. Next

- A "Review in a new session" button (docs/kit-v2.md §3.3).
- Codex agent files (TOML) at install (docs/kit-v2.md §8).
- The idea box offers the team for projects that already have code.

## What a finished job leads to (2026-10-02)

Lovable and Replit offer the next step after a result. A job that is done (`Result: accepted`) shows "What next?" in
the drawer under its steps: "Change something" for every project, and for a web project ("How to run it" found a
plain page or a Node project that prints an address) "Try it like a user" and "Put it online". Each only fills the job
box with a sentence (`jobNextText_*`) that reaches the right kit skill by its Turkish keywords: `try-it-in-browser`
and `deploy-web` (test/kit.test.mjs IDEAS); Start stays the person's. "yayınla" belongs to `release-prep` (a version)
and is not used for a website.

## Earlier jobs (2026-10-02)

Competitors keep the requests behind a project. The team moves a finished job's files to
`.sibersentez/archive/<date>-<short name>/` (orchestrate §1); the team answer now carries `history` (server/team.mjs
`jobHistory`: newest first by the date prefix, at most 10, real folders only, any letter in the name, each read like the
current job: plan title or the folder's words, date, task count, accepted, last verdict). The drawer folds them under
the job box as "Earlier jobs (N)". Read only.

## Try it before you accept (2026-10-10)

When the job is finished, the result card adds "Try it yourself" (`public/js/acceptGuide.js`): the plan's "Done when"
points (`PLAN.md`; a Turkish heading is read too), or one general point ("Open the result and try what you asked
for") when the plan lists none. The person marks each one "Works" or "Not as asked" after trying it; the marks are kept
in this browser only (per project and job), never sent and never written into the project, and the app does not check
them. "Ask for a change about these" puts the points marked "Not as asked" into a change request (cut to the AI tab's
draft limit) in the AI's terminal tab, or in the job box when no tab takes it; the person reads it and sends it.
Tests: `test/accept-guide.test.mjs`.

## The app's own record of a result (2026-10-09, independent review §7.1)

What the steps above read is what the AI writes. Next to it the app keeps what it saw itself
(`server/jobResults.mjs`, plan: `docs/internal/evidence-card-plan.md`):

- In the hub, `restore/<project key>/job-results.json` (never in the project): `{ version: 1, jobs }`, per Job-ID,
  newest first, at most 20, written whole and renamed, only known fields of this version read back. A record: the
  whole-job verdict of the plan's job (`APPROVE` or `REVISE`, blockers, nits), when REVIEW.md was last written
  (`reviewAt`) and when the app first saw the verdict (`seenAt`); the project's files at that moment (`tree`: count,
  bytes, scope, a quick fingerprint of paths, sizes, write and change times, a content fingerprint, and
  `writtenAfterReview`: files written after REVIEW.md, so before the app looked; or why no fingerprint could be taken);
  the reviewer agents the app's log reading saw then (`reviewers`, below); and when the app first saw the job accepted
  (`acceptedSeenAt`).
- Taken after a `/team` answer is sent (the drawer and the building ask every 8 s per project), and only when the
  answer holds the plan's job's whole verdict or its acceptance and the team's files changed since the last look (an
  in-memory signature with `updatedAt`): no disk work on the other polls. A new verdict is another value or count, or
  REVIEW.md written again (a new round with the same counts). A look that could not finish (the record not written,
  a file locked) is tried again after a minute. "Seen" is when the app looked, not when the AI wrote: with no window
  open the app sees it later, which `writtenAfterReview` covers.
- The fingerprint covers the files a restore point would hold (same skips and limits, lean over them) without the
  team's notes (`.sibersentez/`, `.orkestra/`): skipped folders such as `node_modules` and build output at the top, a
  lean scan's big files and logs, links and unreadable folders are not compared (`restore.mjs treeFingerprint`).
- "Written since" counts files whose write or change time is later (a copy keeping its old write time, a renamed file)
  and every folder the scan entered whose time is later, an emptied one too (a deletion or a rename away). It is
  cautious: a new top-level folder such as `node_modules`, or a cache a test run leaves (`__pycache__`), moves a
  folder's time too, which makes the answer unknown, never a wrong "same". REVIEW.md's write time
  stands for the moment of the review, so a REVIEW.md saved again without a new review moves it. On FAT32 and exFAT
  there is no change time and write times have a 2 s grain, so these checks are weaker there.
- `GET /api/projects/<id>/job-result?job=<Job-ID>` (read-only): the record and `fresh`: `same` (nothing written; no
  file read), `same-content` (written since, same content), `changed` (`writtenSince`) or `unknown` with a `reason`
  (`no-record`, `written-before-seen`, `no-review-time`, `unreadable`, `folder`, or the scan's problem such as
  `too-large`). The change time is in the quick fingerprint, so a file rewritten with its size and write time set back
  is caught without reading every file; the content decides whenever the quick one differs, and a `changed` or
  `same-content` answer is kept with the quick fingerprint it was found with, so nothing is read again until more is
  written. The comparison is kept 15 s per record; the record in the answer is always read fresh.
- The same answer carries two things read from the AI's own log, in memory, never stored as text (the job's sessions are
  the ones whose first prompt names its Job-ID, with their sub-agents):
  - `commands` (`server/jobCommands.mjs`): the Bash and PowerShell calls of the job's Claude Code sessions and how each
    ended, read from its tool result (Claude Code 2.1.283-2.1.296): `ok` (no error, an exit code Claude Code reads as
    fine included), `failed` with its code ("Exit code N"), `notRun` (refused, blocked, could not start), `noEnd`
    (stopped, or run in the background with no end seen; a background end comes in a `<task-notification>` with the
    same tool-use id), and up to five failed command lines, newest first. A line is named by its program and, for a few
    well-known programs, a plain sub-command (`npm test`, `git push`; no argument, no path, no environment value); "a
    later run ended without an error" is said only of the very same line in the same folder (a hash kept in memory) and
    never of a line joined by `;`, `||`, `|` or `&`. A call copied into a resumed or forked session counts once.
  - `reviewers` (`server/jobReviewers.mjs`): the job's sub-agents whose type reviews (`reviewer`, `*-reviewer`,
    `security-auditor`), and the verdict the newest of their own answers gave on the whole job (only under a
    `## Review: whole job` heading, read as REVIEW.md is, and not one naming another Job-ID) before REVIEW.md was
    written. It is kept in the record when the verdict is seen (not while the app's first log scan still runs; a later
    look fills it), so it still shows once the log is out of the app's window (14 days by default).
  Other tools' logs are not read for these: the answer says which tools are not known (never "0 commands").
- The drawer's result card (`public/js/jobResult.js`) shows, under "Checks", the reviewer's own words first (declared),
  then what the app observed: when it saw the verdict and whether the compared files are still those (`changed`: a
  warning and "Ask for a new review", a draft into the AI's tab), whether a separate reviewer agent was seen and what
  its own last answer said (in bold when it differs from the review file), and the commands with how they ended (at
  most three failed lines named, the others counted; "an exit code says how a command ended, not what it checked").
  Nothing there is called proof; when no reviewer agent was seen, the card says a review done in another session is not
  seen.
- Tests: `test/job-results.test.mjs`, `test/job-commands.test.mjs`, `test/job-reviewers.test.mjs`,
  `test/journey.test.mjs` (the record after the review and the acceptance, then a file changed after the verdict:
  `changed`).
