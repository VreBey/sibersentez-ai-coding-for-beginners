# Product direction — 2026-09-30

Decisions after two audits of the same day (local, not in git): `qa/kit-v2/rakip-icerik-kiyas.md` (our kit and
orchestration against superpowers, anthropics/skills, wshobson, VoltAgent, BMAD, Spec Kit, Kiro, Cursor, skills.sh) and
`qa/urun-denetim/rapor.md` (the app walked through as a new user, 19 screenshots; features and architecture against
Conductor, Emdash, AgentSpace, Superset, Nimbalyst, Warp, Claude Code Desktop, Cursor 3, Kiro, Wave).

## 1. Where we stand

- **Our lane is empty and we should stay in it.** Idea → fitting skills → start the AI with a first message →
  embedded terminal → setup check: no competitor offers this chain for beginners. The setup check (for example "Claude
  Code is installed twice") is the strongest new piece.
- **Parallel sessions, worktrees, diff review and PRs are table stakes elsewhere** (Claude Code Desktop, Cursor 3,
  Emdash, Superset, Conductor) and of low value to a beginner. We do not race there: `docs/kit-v2.md` §9 moves to
  "later, if ever".
- **Orchestration contract: ahead** (file ownership with automatic REVISE, the NEEDS_CONTEXT/BLOCKED rule, role hats,
  two human decisions, "another agent's approval is not approval"). **Behind:** no starter that makes the AI use the
  skills, no verify-before-done gate, no branch finish, no "what next" guide, no project rules file, no browser try-out.
- **Weight risk:** a small behaviour change runs four agents (tester red, builder, tester green, reviewer). That clashes
  with the owner's token rule.
- **The first 30 seconds are weak:** half the screen is a building nobody works in yet, "New project" is one of five
  equal header items, and the idea box returns 20+ suggestions, many from other projects and in English.

## 2. Decisions — kit

| # | Decision | Why |
|---|---|---|
| K1 | **Wave 1.5 before wave 2:** `verify-before-done` (quality), `next-step` (team), `plan-challenge` (planning), `agent-rules` (docs: writes AGENTS.md / CLAUDE.md with the user's yes), `finish-branch` (release: test, then merge / PR / leave, each step a yes) | the most-installed patterns elsewhere, each under ~90 lines, and exactly where beginners get stuck (what now, is it done, how do I ship) |
| K2 | **Small-job fast path:** one builder task that proves red then green in its own report; only the reviewer is independent. Medium and big jobs keep the tester split | token cost of four agents for a small change |
| K3 | **Test first where a test can exist;** otherwise a manual check in the task's acceptance (Unity scenes, visual changes) | the absolute rule blocks game and UI work |
| K4 | `orchestrate-review`: one final whole-job pass before wrap-up; the reviewer states whether each acceptance check is met. `orchestrate-wrapup`: drift from the plan, what to add to MEMORY, then `finish-branch` | tasks can pass one by one while the whole is broken |
| K5 | Tasks longer than about two hours or touching more than five files are split | error spread, context size |
| K6 | **Smaller target:** about 48 skills and 10 agents instead of 60 + 21. Wave 2 shrinks to about 9 skills + `security-auditor`: `try-it-in-browser` (replaces `e2e-testing`), `skill-writer`, `architecture-notes`, `database-schema`, `auth-flow`, `llm-app-basics` (prompt work folded in), `design-system-lite`, `ui-check` (accessibility + responsive), `api-docs`. Wave 3 is frozen until there is demand | role inflation and choice overload are what make the big sets hard to use; BMAD v6 cut roles too |
| K7 | Dropped or merged (never written): `decision-log`, `presentation-maker`, `report-writer`, `threat-model-lite`, `payments-basics`, `landing-copy` (into `landing-page-starter`), `dependency-audit` (into `security-check`), `api-design-basics`, `prompt-craft`; deferred: `dependency-update`, `performance-check`, `docker-basics`, `cli-tool-starter`, `unity-patterns`, `multiplayer-basics`, `store-release`, all P3 agents and most P2 agents | same |
| K8 | **Kept as is:** the ground-rules block in every skill (each skill must work alone in any tool) | portability beats the small repeated cost |
| K9 | Descriptions at most 350 characters (test); `kit/README.md` counts come from the catalog (test) | tool description budgets; stale counts |
| K10 | Model tier hint for agents (strong for reviewer, mid for builder and tester, small for scout) — later, written by the app per tool profile | token cost; needs the tool profile |

## 3. Decisions — app (in this order)

1. **Connect the kit** (was round 4 of kit-v2): "Do a job" in the project drawer; with the user's yes, `agent-rules`
   adds a short starter block to the project's AGENTS.md / CLAUDE.md ("for a bigger job use orchestrate; run a check
   before saying done"); the drawer reads `.sibersentez/TASKS.md` and `REVIEW.md` read-only and shows
   Plan → Build → Check → Finish with the last verdict in plain words.
2. **Suggestions that help:** the idea box shows 3-5 items from the SiberSentez kit by default, with Turkish summaries;
   items from other projects only behind "also from my other projects". "Turn actions on and install" becomes one step
   with one confirmation. **Done 2026-09-30:** at most five fits from the kit and the library, the rest behind "show
   more"; items only in other projects behind "Also from my other projects (N)" and never selected unseen (server
   selection and card badge alike); a plain web idea is offered "HTML + JavaScript" first; off in the desktop app the
   primary button is "Turn actions on and install", one question in the drawer (the switch's own words for what On
   does, plus what is installed), and the switch's one bridge call turns actions on (`actionsSwitch.js` `turnOn`).
3. **A simpler first screen:** one big "I have an idea / New project" action; the header keeps fewer items;
   KPI boxes, "most used agents/skills" charts and the per-project dollar amount are hidden by default (Usage keeps
   them); the timeline and the Orchestra scene move under an "Advanced" switch in Settings (not deleted); the guide
   balloons and the "First 10 minutes" list stop repeating each other. Building size: owner's call (§5).
   **Done 2026-09-30:** without a project of their own, Today shows one card, "Got an idea?", with one primary
   button (New project) and a link to the one-minute tour, instead of the list; the guide never opens by itself; the
   building is a band while no session is open and whole as soon as one is (a size chosen by hand wins); the header
   drops the "0 open sessions" chip and the clock; dollars are hidden by default; Settings "Advanced views" (off by
   default) holds the Feed numbers, the timeline, the orchestra scene, the drawer tiles and the most used charts
   (`public/js/layout.js`, `test/first-screen.test.mjs`). The look is left for the design pass.
4. **See, try, undo:** after the AI worked — what changed, run or preview it (the run hint exists), and a one-click
   safe restore point (a snapshot before the AI starts, not worktrees).
   **Restore points done 2026-09-30** (docs/restore.md): a copy in the hub before every live AI start, a preview of
   what going back changes, one yes, and the present kept first so going back can be undone.
5. **Maintenance, in between:** async and cached catalog reload and `/fit`, the git watcher and a terminal flow
   control (`docs/backlog.md` "Long-running load"); `npm test` runs every file in `test/` instead of a hand list;
   old installers out of `dist/`.
6. **Last** (owner decision): installer run end to end, code signing, licence and subscription.
   **2026-09-30:** 0.9.0 built (all of §3.1-3.5), hidden QA 39/39, a silent install over 0.8.1 and a smoke test of
   the installed app, old installers out of `dist/`. Code signing (a certificate), the licence text for sale and
   the subscription are the owner's to decide and are not started.

Not now: worktrees, parallel sessions, PR flows, mobile or remote access, issue trackers.

## 4. Measures

- A clean user reaches "the AI is working on my idea" in at most five clicks without learning a new word first.
- The idea box: the expected kit item in the top three for the sample ideas (`test/kit.test.mjs` IDEAS and the UX
  report's list).
- A small job costs one builder run and one reviewer run.

## 5. Open for the owner

- ~~**Building size by default.**~~ Decided 2026-09-30: **by state** — a thin strip while no session is open, large as
  soon as one is; a size the person picks by hand is remembered and wins.
- Order confirmed the same day: wave 1.5, then connecting the kit to the app.
