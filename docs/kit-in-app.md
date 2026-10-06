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
the first-message file (`.sibersentez/ilk-mesaj.md`, same overwrite rules as the idea: an existing different file is
never replaced, the next free name is used) with `jobMessageText`: the job quoted, then: use the orchestrate skill if
it is installed, otherwise follow the same steps; the person approves the plan and the result; ask before deleting,
installing, pushing, publishing or paying; plain words, one question at a time; offer the agent-rules starter lines
once and add them only after a yes; talk in the job's language. The command line only ever carries the fixed prompt
that names the file.

SiberSentez itself writes nothing into the project's own files: the starter lines in AGENTS.md or CLAUDE.md are added
by the AI tool, through the `agent-rules` skill, after the person says yes.

## 3. How the progress is read

`GET /api/projects/<id>/team` (`server/team.mjs`), read-only, no action mode needed:

- only `<project>/.sibersentez/` when it is a real folder (a link or a junction is never followed), and only files up to
  the manifest limit (256 KB);
- `PLAN.md`: title, size, `Approved: yes`, `Result: accepted` (written by the wrap-up after the person's yes);
  `TASKS.md`: every `## T<n>: title` block with its owner and status
  (`todo`, `doing`, `done`, `blocked`; anything else counts as todo); `REVIEW.md`: the last `VERDICT:` line and the task ids in the
  `## Review T1, T2` headings of the file. A review file that names none of the current tasks belongs to an earlier job left
  in the folder and counts as no review (the bar jumped to Finish before a second job was checked);
- step: `none` (no team files), `plan` (no approved plan or no tasks), `build` (tasks left), `check` (all done, no
  approving verdict), `finish` (all done and approved), `done` (the result accepted).

A finished job's files are moved to `.sibersentez/archive/<date>-<name>/` by the orchestrate skill when the next job
starts (the kit's own hand-off files, no question needed); the ledger, memory and handoff notes stay.

The drawer asks again every 8 seconds while it is open (`createJob`), so the bar follows the AI's work.

## 4. Tests

`test/team.test.mjs` (parsers, step, junction and size refusals, the route body), `test/job.test.mjs` (the section,
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
