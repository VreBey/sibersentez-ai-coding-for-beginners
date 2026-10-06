# The workshop building

The building is where SiberSentez shows how the AI works: one project's team in a three-floor house, a person for each
open Claude Code session (the lead) and a robot for each agent it started, each in the room that fits its work. It is
the "SiberSentez Bina Onayli" design of 2026-10-01: an interactive prototype the user made with ChatGPT from the
prompt in `qa/chatgpt-tasarim/6-bina-etkilesim/PROMPT.md`, approved and brought into the app whole (the user's words:
"leave nothing of the design out"). It replaced the six-floor Modern HQ drawing and the Studio Pro building, which were
removed with their code (they stay in the git history).

It is the main screen, **Building** (menu item 1, `views/workshop.js` in `#tab-today`; docs/simplify.md): the counts
(agents working, waiting for you, tasks completed), the toolbar (Play, Step, speed, a room, Overview), the building
with its sign and the four lamps of the job, "Give a job", the room tabs, "What happened?" (the rewind), waiting for
you, the team, the shared work, the recent activity, the quota, and the card of whatever is chosen. Until 2026-10-01
Today had a smaller copy of the house and the Workshop was a screen of its own; both became this one screen.

## What the building shows

| What happens | What you see |
|---|---|
| A lead starts an agent | a task card leaves the lead's desk; the robot comes up by the lift and takes a seat in its room; a line from the lead (dashed for a background agent; from the agent that started it for a nested one) |
| A tool call | a pixel icon over the actor for 0.8 s (book, pencil, `>_`, globe, card, star, cog, plug, dot), with ×N for several in 0.6 s; a computer's screen lights |
| An agent finishes | it stands up, its result card travels back along the line, the lead's screen lights, the robot leaves |
| A workflow runs | its robots carry its name; the team panel says how many run and how many finished (which phase runs is not in the data, so it is not guessed) |
| A session waits for you | the lead walks to the meeting room and raises a hand under a "!" ring; the sign turns yellow and opens the session |
| A session is idle a while | it rests in the lounge |
| A session closes | it stands up and walks off to the lift |
| Another tool (Codex, Gemini, Copilot, Cursor, Antigravity) left a trace | a figure with the tool's name: in the main room for 3 minutes, then in the lounge until 45 minutes |

Where each one sits (`hq-scene.js`): the project's kind picks its main room (from its tags, asked once per shown
project and kept five minutes: a game or ordinary code in the software office, AI or data in the server room, design
with no code in the design studio, documents with no code in the library); an agent goes by its type (exploring,
research, fetching → library; planning → meeting room; tests, reviews, audits → server room, standing at the racks;
design → design studio, at the easels; anything else → the main room); a waiting session to the meeting room, an idle
one to the lounge. Each room has three seats; the rest of a full room shows as "+N" and stays reachable from the team
list and the room card. Seats are kept over time: an actor keeps its seat while it stays in the same kind of room.

## The data

`hq-live.js` turns one project of the store into the scene's snapshot: its open sessions (title, short model name,
state, since, last action, tool counts), its running agents and the ones that finished a moment ago (with `toolUseId`,
which the server now sends, so the scene finds who started each agent: the actor of the `agent_start` event with the
same id; without it, its session's lead), its workflows, the other tools, and its feed and tool calls. The quota is
always null: Claude Code's logs do not say how much of the 5-hour or weekly limit is used, so the quota section and
its colours (yellow at 80 %, red at 95 %) stay hidden until a source exists.

The rewind keeps the project's snapshots while the app runs (`LiveHistory`, `recordHistory`: a new entry only when
someone came, went or changed state, 15 minutes back, at most about 400). The Workshop records every project with
something open about once a second, so "What happened?" has a past when it is opened.

The minutes before the app started are rebuilt from the logs once, when the Building first shows a project
(`pastSnapshots`, `LiveHistory.seed`; 2026-10-01): one moment every 5 s of the last 15 minutes from the project's tool
calls, prompts and agents. A session works while it acts (an act within 45 s), rests after that and is gone after 5
quiet minutes; an agent runs from its start to its last line. What the logs cannot tell is left out: nobody is shown
waiting for the person, and tools and workflows are not in it. The rebuilt moments go before the recorded ones, never
after them.

## The example

"Play" runs a three-minute example in the same data shape (`createDemo`): a workflow, four agents (one started by
another, two in the background), tool calls of every kind, another tool, a second lead, waiting, resting, closing, the
quota at 64 %, 82 % and 96 %. The card's actions only say that live data is needed there. "Back to live" or choosing a
project leaves it.

## Input

Mouse: hover for a tooltip, click an actor, a room, a seat, a door (it opens and closes) or the lift (it picks a floor),
double-click a floor to zoom into it. Keyboard (Workshop): hidden buttons over the drawing in Tab order (the actors,
then the rooms, the furniture, the doors, the lift); Enter opens the card, the arrows go to the next actor on the
same floor, Esc closes the guide, then the card, then the zoom. Today's canvas keeps its own ring (the arrows walk the
actors, Enter opens, Shift+F10 the context menu). The card's buttons send a `hq-action` window event (`{ action:
'open-session' | 'open-terminal' | 'open-project', sessionId, agentId, projectId, x, y }`) that main.js carries out:
the session's or the project's drawer, or the session's context menu at the button (continue, fork, terminal, as the
actions mode allows; nothing runs by itself).

The short guide ("What is this?") opens by itself the first time the Workshop is shown and never again after it is
closed (`sibersentez.hq.guide`); not on QA pages unless `?wsguide=1`.

Motion: 12 frames a second while something moves, one a second otherwise; reduced motion (and Today's pause button,
`sibersentez.hq.pause`) keeps every actor at its seat in one pose, without flying cards or walks.

## Files

| File | What |
|---|---|
| `public/js/hq-scene.js` | pure: the drawing's floors, rooms, lift and doors; the room rules; the poses; `sceneFrom`; the history; the example |
| `public/js/hq-render.js` | the canvas: the drawing, the furniture drawn in code, the actors from the sheets, links, cards, icons, rings |
| `public/js/hq-live.js` | the store as the snapshot, the project order, each project's kind, the history kept while the app runs |
| `public/js/views/workshop.js` | the Building screen (the workshop) |
| `public/css/workshop.css` | the Workshop's look; `hq.css` Today's stage |
| `public/css/theme.css` | the `--hq-*` colours (the canvas reads them by name) |
| `public/js/strings/workshop.js` | the `ws*` words, English and Turkish |
| `public/img/building/` | `hq-tower.png`, `hq-rear.png`, `hq-activity.png` (the design), `hq-actors.png`, `hq-move-*.png`, `hq-chair.png`; `SOURCE.md` |
| `test/hq.test.mjs` | the rooms, the room rules, the scene's orchestration, the poses, the history, the example, the live data, the theme and the words |

QA: `?qa=1&tab=today` (live), `&wsdemo=<ms>` the example at that moment, `&wsproject=<id>` that project.
