# Kit evaluation in a real session (2026-10-01)

The kit's unit tests check its form (names, metadata, catalog, originality). This page records whether it **works**:
Claude Code was run with the kit installed, on what a beginner would type, and the result was used like a user would.

## Method

- Claude Code 2.1.286, `claude -p --model sonnet`, in a temporary project folder with the kit copied into
  `.claude/skills` and `.claude/agents` (40 skills, 9 agents). `--setting-sources project,local --strict-mcp-config`
  keeps the owner's plugins, hooks and MCP servers out. Allowed: file edits and `npm`, `node`, `git`; nothing that
  publishes or leaves the folder. Several turns with `--resume` when the flow asks the user.
- A copied login in a separate `CLAUDE_CONFIG_DIR` was tried and dropped: its token could not be refreshed, and a
  refresh from a copy could invalidate the real login.
- Every result that is an app was used in a hidden Electron window (add, check, delete, reload, a script tag as a
  task name); the other results were read.

## Scenarios and results

| # | What the user types | Skills and agents used | Result |
|---|---|---|---|
| 1 | "I want a simple to-do list app, I know no code" (Turkish) | none | One `index.html`; everything works, XSS-safe; says it was not opened in a browser |
| 2 | "npm start crashes" on a project with two faults | none | Crash fixed; the second fault (the page asks `/api/note`) missed, "it opens now" |
| 2b | same, with SiberSentez's `CLAUDE.md` starter block | `debug-helper` | Same miss |
| 2c | same, kit 0.3.4 | `debug-helper` | **Both faults fixed**, the page's route called and its data seen |
| 3 | "check my changes before I push" (a live key, `.env` not ignored, `innerHTML`) | `review-changes` | Every planted fault found plus three real ones; the key not printed; nothing changed without a yes |
| 4 | "a website for my restaurant, where do I start" | none | Sensible plan, but three questions at once |
| 5 | SiberSentez's idea message (shared expenses app) | `idea-to-plan` | One question at a time, numbered choices with a recommendation, no code before the plan |
| 6 | SiberSentez's job message: "a clear-completed button" | `orchestrate`, `planner`, `task-slicer`, `builder`, `reviewer` | Plan approved, built, reviewed, wrapped up; all six manual checks pass. The builder's report file was **refused** by Claude Code |
| 7 | job message, kit 0.3.4: due dates, overdue in red, sorted | `orchestrate`, `frontend-builder`, `reviewer` | `REPORT-T1.md` written; order, red, delete-after-sort and reload all correct |

About 3 USD of API-equivalent usage for all runs.

## What changed because of it (kit 0.3.4)

- Report files: roles return the report as their answer; the conductor saves it (scenario 6 → 7).
- `debug-helper` tries the program the way the user uses it after a fix (scenario 2b → 2c).
- A missing package in a team job: one question, then the conductor installs after a yes.
- `api-service-starter`: `--env-file-if-exists`, so a host without `.env` does not crash (checked on Node 24).
- Secrets are named by kind or prefix and file:line, never by their characters.

## Still open

- **Skills are seldom picked when the user types straight into the tool** (scenarios 1, 2, 4). They are picked
  through SiberSentez's own messages and its `CLAUDE.md` starter block (5, 6, 7, 2b, 2c), which is the way the app
  starts a tool. The results without a skill were still good in 1 and 4.
- **Nobody opens a browser.** Claude Code has no browser tool by default, so how a page looks is left to the user as a
  short list of steps. The team says so plainly; logic is checked with small node scripts.
- From the text audit, not acted on: `orchestrate` looks broad on paper but sized both jobs right in practice; the
  archive move is an explained exception; `create-vite --no-interactive` exists (checked); the Vite template now
  lints with Oxlint and the kit only calls `npm run lint`.

Run it again before a release that changes the kit: the scenario folders and the runner are simple to rebuild from
this page.
