# Simplify: you say it, the app does it

Status: decided 2026-10-01 by the owner (the plan's version 2,
"building-centred"). The person manages; the app does the work in the background. Three decisions are left to the
person, and all three happen in the building: give the job, approve the plan, accept or undo the result.

## Why

An audit of 0.11.0 (every screen in Preview mode, every visible control counted) found one project drawer with 122
controls, 13 sections and 1,870 words, three different ways to start an AI tool, two boxes asking for the same
intent, the "Actions: Off / Preview / On" term in the header and twice in the drawer, set-up steps before a job
(install the team, preview and install skills), and an AI that asked at every tool call. Competitors (Claude Code
desktop, Codex, Cursor, Copilot, Jules, Devin, Replit, Conductor) make a list of jobs the main screen, ask for
approval at the plan and the result instead of each step, notify when done, and take a checkpoint before each job.

## Owner decisions (2026-10-01)

| Question | Decision |
|---|---|
| The plan's "Approve" button | SiberSentez never answers the AI's question. Jobs start Claude Code in plan mode; the building shows the plan; "Approve" takes the person to Claude's own plan prompt in the terminal (it offers "approve and accept edits") |
| Autonomy after the plan | Claude's own choice at its plan prompt ("accept edits") |
| Set-up | Start sets up the team and the helpers the server chose for the job's words, in one request (live mode) |
| Today and the Workshop | one "Building" screen (phase 3) |
| Default tool | Claude Code unless another is chosen in the Settings |
| Street view of all projects | later |

## Phase 1: one box, one Start (done 2026-10-01)

- The project drawer: the question "What should be done in this project?" with one box and one Start, the restore
  points, then everything else folded under "Details" (skill suggestions, other ways to start, the team and its
  update, how to run it, what changed, usage, sessions, agents, events). A flow asked for (skills, install) opens the
  fold by itself; the fold remembers its state per project while the page lives.
- Start (`views/job.js giveJob`): in live mode the fit for the job's words is read, the team and the chosen helpers
  (selected, installable, not installed; at most 25 keys) go in one `skills-apply`, then `start-ai` with the job
  (restore point first, as every start). Preview mode only shows what the start would do.
- The Workshop has the same box ("Give a job"; under the building until 2026-10-02, now first in its header row, beside the project it goes to, so it shows without scrolling on a laptop); its card rides the lift from the lobby to the
  main room's desk.
- The tool: the Settings' "AI tool" choice (`sibersentez.aiTool`), else Claude Code, else the first one found.
- The "Actions" indicator shows only while actions are off or in Preview (or while its panel is open); On is the
  normal state. The Settings keep the mode and its "Change".

## Phase 2: managing in the building (done 2026-10-01)

- A job starts the tool in its own plan mode when it has one (`server/tools.mjs` `plan`, `server/launch.mjs jobArgs`:
  Claude Code `--permission-mode plan`; Gemini CLI `--approval-mode plan`, whose exit_plan_mode asks "Ready to start
  implementation?", added 2026-10-07; only for a job, never a resume; tools without a known plan mode start as usual). The job's first message says the plan is approved in the tool's own prompt.
- The plan Claude shows for approval (its ExitPlanMode call) is kept on the session (`ingest.mjs`, at most `PLAN_MAX` from `ingestText.mjs`
  characters, the newest one, a lead's only) and sent with it (`plan`). It waits while the session waits and its last
  action is that call (`hq-live.js` `planPending`).
- The job's step comes from the team's hand-off files (`/api/projects/<id>/team`, `TeamCache`), asked again every 8
  seconds for the shown project.
- The building: four lamps under the sign (Plan, Build, Check, Finish: done green, now yellow); the sign says "Your
  approval of the plan is waiting" or "The result is ready"; a glowing sheet beside the lead (yellow: plan, green:
  result). A click on the sign or the lead opens its card: the plan's text with "Approve in the terminal", or the
  result (the step's sentence, the independent check) with "Answer in the terminal", "What changed" and "Undo".
- "… in the terminal" brings that project's running AI tab forward in SiberSentez's terminal and gives it the keyboard
  (`terminalDock.js showProject`); nothing is typed. A session outside it opens its drawer and says where to answer.
- "Waiting for you" above the team: every project's waiting sessions (plan, result, or a question); a click shows that
  building with its lead's card.
- The example (Play) shows the plan waiting, the lamps going through the steps and the result ready.

## Phase 3: one screen, the Building (done 2026-10-01)

- The menu: Building (key 1), Projects (2), then under a small "Advanced" label Skills & agents (3) and Feed (4), with
  AI tools, Guide and Settings (5) at its foot. The Workshop is no longer a screen of its own: the Building is.
- The Building screen (`#tab-today`, its key stays `today`): the first-10-minutes list while it lasts, who waits, the
  workshop (`#workshopBody`: project choice, counts, the building with its sign and lamps, "Give a job", the room
  tabs, "What happened?", waiting for you, the team), then "Pick up where you left off" and the usage strip.
- Today's old building (`hq-today.js`) and its fold are removed; the orchestra scene with its rail moved to the Feed
  screen as an advanced view (`.hero.adv-only`), so the scene switch is gone.

## First real job (2026-10-01, a novel project)

What happened, in order: Start wrote the first message and opened Claude Code with `--permission-mode plan`; the AI
read the chapters, asked one question (approach), wrote the plan to its plan file and called `ExitPlanMode` with the
plan in `input.plan` (and `planFilePath`), which SiberSentez captured (3,941 characters after redaction). The person
approved it in the terminal; the team wrote `.sibersentez/PLAN.md` and `TASKS.md` (5 tasks), the lamps went to Build
and a research helper appeared in the dev room.

What it changed:

- **The job box** beside the building (`renderJobBox`): the plan's title, the four steps named (the lamps alone said
  nothing to a newcomer) and one sentence on where the job stands (the drawer's `stepsHtml`, now shared).
- **The team's plan step knows plan mode** (kit `orchestrate-plan` 0.1.5): the plan tool is the approval; the plan
  files are written after it.
- **Two projects with one name** say where they are in the Building's list (`projectNames`): a project moved to
  another drive left its old folder behind.
- A screenshot of a window in the background shows a stale frame: the page is hidden and draws nothing until it is
  shown (not a fault; check with a visible page or a headless browser on the same server).

## A closed terminal (2026-10-01)

The person closed the terminal tab of the running job. Closing a tab ends what runs in it, so the AI ended half-way,
but a background agent stayed "running" for ten minutes (its session's process could no longer say it stopped) and
the Building and the top bar said the job went on; a click on the lead found no terminal to come back to.

- **Agents end with their session**: when a session's live record goes, its running agents are stopped at once
  (`parentClosedAt`); a line written later (a resumed session) makes one run again.
- **The job box says the job stopped** when no session of the project runs and the job is not finished: where it
  stopped ("4 of 5 tasks were done") instead of "working on …", and **Go on where it stopped**, which resumes the last
  session in the terminal below (`start-ai` with `resume`, the session menu's own item; the actions mode decides).
  The plan and result buttons resume a closed session the same way.
- **Closing a running AI asks once**: the tab's first close turns red and says a second click stops the AI
  (`CLOSE_CONFIRM_MS`, 4 s); a plain shell or an ended AI closes at once.
- **An AI that ended by itself** (`/exit`, a crash) leaves a bar at the foot of its tab: "Go on where it stopped",
  when a Claude Code session of that project acted in the last two minutes (`recentSession`); a tab that ran another
  tool offers nothing, so nothing else is resumed by mistake.

## A job started in a moved project's old folder (2026-10-01, real use)

The owner gave the game project a job from `C:\Users\…\Desktop\arena game`, the folder the game had moved away from
(only `.claude` was left in it). The AI noticed and worked in `D:\Work\arena game`, where the team's files
went too; SiberSentez kept the session under the old folder (its restore point held 0 files) and the job under the new
one, and "Go on" on the new one would have resumed an unrelated session of the morning.

- **Told apart** (`toolsOnly`, server/fsutil.mjs): a folder whose every entry is an AI tool's own setup (`.claude`,
  `.agents`, `.codex`, `.sibersentez`, `CLAUDE.md`, ...) is marked; a `.git` folder or any other file makes it a
  project. The card says "Only AI settings: moved?"; the drawer says the folder has no project files and offers the
  project with the same name that holds real files ("Open that project", `realTwin`); its first Start only says so
  (a second one starts there anyway); the Building never picks it by itself and its job box opens the drawer instead.
- **The right session to go on with**: the team endpoint gives when the job last changed (`updatedAt`, the newest of
  its files); `stoppedSession` offers only a session that was at work then (15 minutes of slack).
- **Only a folder found in the logs** (2026-10-02, a new user's walk): a project the user registered or added in
  SiberSentez is never marked. Its first job puts only `.claude` and `.sibersentez` in a new, empty folder, and the red
  "no project files" box then stood in front of its second Start. The mark is worked out after the discovery pass
  (catalog.mjs `load`), so a folder first remembered in that pass already carries the tools that saw it.

## A new user's first job (2026-10-02, walk with an empty home)

The app was walked with an empty home folder and hub (headless, CDP; the AI start request was dropped). Fixed:

- **The Building's box said nothing without an AI tool**: `giveJob` returned `tool-missing` and the box ignored it.
  Now it says so and opens the AI tools panel.
- **Actions off was a second trip**: the box went to the drawer, whose Start was greyed out, and the person had to
  find the header switch. Now, in the desktop app, Start stays pressable while actions are off and asks once, in the
  drawer, "Turn actions on?" with what On means for this job; "Yes, turn on and start" turns them on through the
  switch's own bridge call (`turnOnLive`, the path of "Turn actions on and install") and starts. The box sends the job
  there (`drawer.askStart`) with the text already in it. A plain browser keeps the old note.
- **A team whose folder was deleted was never set up again**: the fit counted the install record as installed even
  when the person had deleted `.claude`, so Start installed nothing. A record counts only while its folder is there.
- Smaller: "Pick up where you left off" said "No project yet" next to a project (now: no job yet, use the box), and
  the first-ten-minutes card still named "Install and start".

## Examples under the job box (2026-10-02)

Bolt and v0 offer suggestions under their input. Inside the Building's job box card, under the input: "Fix a problem",
"What is the next step?", "Make it look better", and first, while the project has no job yet and has an idea, "Start
with my idea". Each fills the box with a sentence that reaches a kit skill by its Turkish keywords (debug-helper,
next-step, ui-polish; test/kit.test.mjs IDEAS) and never starts anything.

## One primary start on the first screen (2026-10-07, review B4)

An outside review counted three "New project" calls on the empty first screen (the header, the "Got an idea?" card,
the next-step strip) and a job box under them with no project to give a job to; the Building's own guide opened over
all of it. Now `public/js/firstScreen.js` decides from two questions:

- **A project of the person's own** (`checklist.js hasOwnProject`): without one, the card is the start. The strip,
  whose step would only repeat it, steps back; the card has the one primary button (New project), a quiet "Watch the
  example" (the Building's own example plays; its play button is quiet meanwhile, the same action) and the tour link.
- **A project the Building shows** (`hq-live.js projectsInOrder`: registered, or found and active in the last days):
  without one, the job row (job box, project picker, help) steps back. Folders other tools found long ago count as
  the person's (no card), so the strip's "create a project" is the start then.
- The header's New project is a quiet shortcut while either holds (`.new-proj.quiet`, also in the theme).
- "What happens in the building?" waits until the Building shows something (a project, or the example).

Checked in a window at 1366 x 768, Turkish and English, on an empty home and on one where only old folders of other
tools were found: on the empty home the one visible primary is "Create a new project", the first control the
keyboard reaches; nothing scrolls sideways; "Watch the example" starts the example and the strip says it is one.
Tests: `test/start-card.test.mjs`. Not yet validated with people (review package 5).
