# Start flow — from an idea to the skills that fit

Status: step 1 and step 2 built 2026-09-29. User request (2026-09-29): "research the app, make it simpler to
use and say things more plainly. For example: someone gets the app, creates their folder, and the system must find
which skills to use from their idea."

## The problem

The automatic skill fit (`docs/auto-skills.md`) read a project only from its files. A new, empty folder has none, so
it got no tags and no suggestion: exactly the moment a newcomer needs help most. The texts of the section also
assumed the reader knew what "stack", "preview mode" and "library" mean.

## Step 1 (built): "What do you want to build in this project?"

### What the person sees

The project drawer's section **Skills that fit this project** (TR: *Bu projeye uygun skill'ler*):

1. One sentence on what happens: SiberSentez reads the project's files and the idea, ticks the skills on this computer
   that fit best; nothing is sent to an AI.
2. The idea box: the question, a one-line text box (placeholder "e.g. a 2D platform game in Unity"), the button
   **Find fitting skills**, a hint ("Name the tool and the kind of thing: Unity + game, Next.js + online store,
   Python + Telegram bot"), and three examples while the box is empty (one click fills the box and asks).
3. What the idea gave: **From your idea:** the tags it named as chips (Unity, game development). A tip when it names
   no tool ("also name the tool you will use ... then the best skills are ticked for you"); a plain sentence when it
   names nothing known; "Press Enter ..." while the box differs from the list; "Looking ..." while asking.
4. **Found in the folder:** the folder's tags, or "No files SiberSentez knows in this folder yet."
5. The list, each row with its reason in plain words: "your idea mentions “Unity”", "your idea mentions “2D”",
   "Unity project", "installed in Demo". Bands: strong match / may help / weak match (behind "Also show N weaker
   matches"; an item that shares nothing is not listed at all).
6. The buttons, and under them why they do what they do. Off: nothing can be installed, press "Change actions" and
   choose On. **Preview mode: the button only lists what would be installed and copies no file; to really install,
   press "Change actions" and choose On** ("Change actions" sits next to the buttons in preview mode too). After a
   preview run the banner repeats it: "Preview mode: no file was copied, this is only the plan. To really install:
   ...".

Asking: after typing stops for 0.8 s, at once with Enter, the button or an example; one request at a time (a newer
idea is asked for when the running one ends); a failed idea is not asked again for 30 s. The text is kept per project
in the browser (`localStorage` key `sibersentez.idea.<project id>`, read and written inside try/catch: without storage
the idea lives until a reload). Typing never redraws the drawer; a redraw keeps the caret, and none happens while an
input method composes a word. QA hook: `?qa=1&idea=<text>` fills the box (never stored).

### From the idea to tags (server/tags.mjs, local and deterministic)

- The same dictionary as for files and items; any letter case counts in an idea (people type "unity"), Turkish
  suffixes through stems and listed forms (oyun\*, mağaza\*, botu, sitesi via site\*, sunum\*, yapay zek\*).
- A phrase names its most specific topic only: "online store" / "online mağaza" is `ecommerce`, which implies `web`.
- `ideaTags(text)` → `[{id, type, word}]` for named tags (the words as typed, at most 40 characters) and
  `[{id, type, via}]` for implied ones (`unity` → `csharp`, `gamedev`).
- `ideaKeywords(text)` → the other words (no dictionary entry took them, no stop word, no bare number, at least two
  characters, at most 8). They only order skills that fit anyway.
- New topic tags: `ecommerce`, `bot`, `backend`, `content`, `slides`, `automation`, `scraping`; more words for `web`,
  `mobile`, `desktop`, `data`, `ai`, `gamedev`, `multiplayer`, `devops`, `database`. All new tags are topics: a stack
  tag the file census cannot find would leave its skills out of every project that has no idea.

Examples (named tags; implied in parentheses):

| Idea | Tags |
|---|---|
| Unity ile 2D platform oyunu | unity, gamedev (csharp); words: 2D, platform |
| Next.js ile online mağaza | nextjs, ecommerce (web) |
| Python ile Telegram botu | python, bot |
| yapay zekâ destekli sohbet botu | ai, bot |
| Web scraping ile fiyat takibi otomasyonu | scraping, automation |
| Electron ile masaüstü uygulaması | electron, desktop |
| Şirket sunumu hazırlamak | slides |

### Scoring (server/fit.mjs)

- `withIdea(profile, tags, keywords)`: the idea's stack tags join the stacks, its topics the topics; the primary
  stack is computed again (an empty folder with "Unity" has the primary stack Unity). The conflict rule works with
  them: a React Native skill is left out of a Unity idea.
- A topic the idea names: +5 (`SCORE.idea`, the weight of a stack); implied: +2. Stacks: +5 as before. So "Unity ile
  2D platform oyunu" gives a Unity skill 5 + 5 = 10: high, selected. "Unity" alone gives 7: listed, not selected.
  A topic-only idea ("online mağaza") never reaches high (a shared tool is needed); the tip asks for the tool.
- The idea's other words: +1 each, at most +3, only for an item that already scores (`SCORE.ideaWord`,
  `IDEA_WORDS_CAP`). A whole word, or for five letters or more a word that starts with the other (platform /
  platformu).
- Reasons: a tag the folder shows keeps its code (`stack:unity`); one only the idea gives is `idea:<named tag>`; a
  word is `idea-word:<word>`. The page reads both as "your idea mentions “...”".

### Server contract

`GET /api/projects/<id>/fit?idea=<text>`: see `docs/auto-skills.md` §3. The text: at most 300 characters (code points)
after controls became spaces and zero-width and direction marks went; never written, never logged, never sent back
(only the words that named a tag or matched come back). The pool is built once per project; an idea only scores it
(`stats.scored`); fits of at most 16 ideas are kept. `skills-apply` finds any key of the pool, so the page sends the
keys on screen (it always did) and the ones an idea chose are planned and installed. Without keys, the automatic
selection of the folder alone is applied, never an idea's.

### Tests

`test/idea.test.mjs` (tags of Turkish and English ideas, the normalization, scoring and the conflict rule with an
idea, the words, the cache per idea, the HTTP route, skills-apply with the keys an idea chose in dry and live mode, the
idea box), `test/fit-ui.test.mjs` (the rewritten texts), `test/fit.test.mjs` ("ASP.NET Core APIs" is also
`backend` now).

## Step 2 (built): "New project"

Someone installs SiberSentez and starts a project without knowing any of its words: **choose or create the folder →
write the idea → install what is suggested → open a terminal**.

### What the person sees

1. **Where it starts.** A **New project** button in the header, left of the Actions indicator. In the Projects tab a
   **Getting started** card (TR *Başlarken*) while two or fewer of the person's own projects are listed (a folder that
   exists, not broad, not only a temp folder): "1 Name your project; SiberSentez makes its folder · 2 Write what you want to build;
   SiberSentez picks the skills that fit · 3 Install them and open a terminal; start the AI tool you like there", the same
   button, a note that folders where an AI tool already ran appear by themselves, and **Don't show again**
   (`localStorage` `sibersentez.start.hidden`). The tray menu has **New project…** too.
2. **The "New project" window** (review U05, 2026-10-07; `public/js/views/newIdea.js`). A small window asks for the
   project's **name** and **what to build** (optional), and shows where its folder goes: **Documents › SiberSentez ›
   <name>** (TR *Belgeler › SiberSentez › <ad>*, the owner's choice of default). **Create** (or Ctrl+Enter) makes it
   there; **Create somewhere else…** asks for the folder it goes into ("Choose where the new project's folder goes",
   button "Create it here"); **Cancel** or Esc closes it. A name Windows cannot use as a folder name says so in the
   window; Enter in the name goes on to the idea. The idea takes at most 300 characters, as much as the server keeps
   with the project. A taken name becomes "<name> (2)" … The shell (`electron/helpers.mjs` `createIdeaProject`) checks
   the path before anything is made (`plannedFolderRefusal`), makes the base folder if needed and the project folder
   never recursively (a folder that appeared meanwhile is never taken over: the next name), checks it in full as a
   picked folder is checked, has the server remember it as a **new** project only (`project-add` with `fresh`: a folder
   inside a listed project is refused, `inside-project`, before anything is remembered; the shell also refuses an
   `existed` answer, so an idea never lands on another project) and keeps the idea with it. Refused after it was made:
   the empty folder is removed again, and the base folder when this call made it. The page gets the project id only.
   A try that did not work (refused, or "Somewhere else" cancelled) brings the window back with what was typed and the
   reason in it. While the window is open the rest of the page is inert. The drawer then opens with the idea in
   its job box and **Start** focused: nothing starts until the person presses it. "Project created: <name> · Your idea
   is in its job box. Press Start when you are ready."
   **Already have a project folder? Add it** at the bottom takes the old way: the system folder picker opens, modal to
   the window ("Choose or create the folder of your project", button "Use this folder"); Windows' picker has **New
   folder**, so the folder can be created right there. An older shell without the new call opens the picker at once.
3. **The idea** (a folder added the old way). The project's drawer opens at "Skills that fit this project" with the
   focus in the idea box (step 1).
   A notice says "Project added: <name> · Now write what you want to build in it; SiberSentez picks the skills that fit"
   (or "This folder is already listed: <name>" when it was: that project opens).
4. **Install.** The list and buttons of step 1, unchanged.
5. **Then: open a terminal** (TR *Sonra: terminali aç*), right under the skills, always there for a project whose
   folder exists: **Open terminal** (the context menu's `terminal` action, docs/terminal.md: a plain terminal in the
   folder, the person starts the AI tool they like). On: one line says the terminal opens in the project folder.
   Preview: it only shows the command, and "Change actions" sits next to it. Off: the button is disabled, the line says
   why, "Change actions" opens the Actions panel. After a live install one line: "3 skills installed. Now open a
   terminal and start the AI tool you like."
6. **Refusals** are a notice with the reason in plain words (a network or WSL folder, a whole drive, the home folder,
   Desktop/Documents/Downloads, the hub, the program folder, Claude Code's own settings folder, a link, a folder that
   holds listed projects, a missing folder). Cancel says nothing.
7. **In a browser** (the server started on its own) the button stays and says "New projects are added in the SiberSentez
   app: the folder picker opens only in the desktop app."

The project card shows the stored idea ("Idea: …") in place of its description.

### Where the project is written

Not the person's `registry/projects.json` (SiberSentez never writes it). The program's own project memory,
`<hub>/registry/discovered.json` (`server/memory.mjs`), gets the folder with `via: ["sibersentez"]`, and any remembered
folder may keep an `idea` (at most 300 characters, cleaned like the fit's idea: `server/fit.mjs` `normalizeIdea`;
never logged). The catalog lists such a folder like every remembered folder (an unregistered project, description
"Added in SiberSentez as a new project."), and a project whose remembered folder holds an idea carries it as
`project.idea` (catalog → `projectView` `idea`, `null` when none). The fit reads `project.idea` when it is asked
without `?idea` (the card's badge, skills-apply without keys: `docs/auto-skills.md` §3); the drawer always sends the
text in its box (an empty box as `?idea=`), so what it shows follows the box.

The memory is the program's own record and is written anyway (every folder a tool reports is remembered), so adding a
project and keeping its idea work in **every actions mode**, Off included.

### How the request travels (no HTTP)

page → preload → shell → server process → project memory:

- **Preload** (`electron/preload.cjs`): `window.sibersentezShell.pickProjectFolder()` (no arguments) and
  `window.sibersentezShell.saveProjectIdea(projectId, text)` (a project id `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` and a string
  of at most 1200 characters; anything else is refused in the preload). Channels `sibersentez:pick-project-folder` and
  `sibersentez:save-project-idea`, next to `sibersentez:set-actions-mode` (docs/actions-toggle.md §3b).
- **Shell** (`electron/main.mjs`, rules in `electron/helpers.mjs`): one `ipcMain.handle` per channel. Each checks the
  sender first with `bridgeSender` (the main window's own webContents, its top frame, the server origin right now), the
  same rule `panelRequest` uses. The picker is `dialog.showOpenDialog(win, { properties: ['openDirectory',
  'createDirectory', 'dontAddToRecent'] })`, one at a time. The chosen folder goes through `checkProjectFolder`, then to
  the server. The idea goes through `projectIdeaRequest`. The page gets `projectReply`: `{ ok, reason, projectId?,
  existed?, saved? }`, never a path; the log says what happened, never which folder or idea.
- **Shell → server:** the server process's own message channel (`createServerCalls`): Electron's `utilityProcess`
  (`child.postMessage` / `process.parentPort`), or the ipc channel of the forked development fallback (`child.send` /
  `process.on('message')`). Messages `{ sibersentez: 'shell-call', id, type: 'project-add' | 'project-idea', ... }` and
  back `{ sibersentez: 'shell-reply', id, ok, reason, projectId?, existed?, saved? }`. Only a reply from the process that
  was asked settles a call; a call to no server, a server that exits or no answer in 15 s settles with `no-server` /
  `timeout`. A server started on its own has no such channel and listens to nothing.
- **Server** (`server/index.mjs`, `createProjectChannel` in `server/memory.mjs`): `catalog.addProjectFolder(path)` or
  `catalog.setProjectIdea(id, idea)`. After a change (`shellChangeHandler`): a new project reloads the catalog (the
  page gets the new project list over the live connection before the answer goes back) and drops every cached fit; a
  saved idea is already on the project, so there is no catalog reload: only that project's cached fits are dropped and
  the project goes to the page in the next patch (within half a second). The page waits up to 4 s for a new project
  to appear, loads the list once more if needed, then opens its drawer.

### Which folder can be a project

Refused by the shell (`checkProjectFolder`) and again by the server (`Catalog.checkNewProjectFolder`, which reuses the
catalog's broad-folder rules and `install.mjs` `isBroadFolder`), on the path as written and on its real form:

| Reason | What |
|---|---|
| `network` | `\\server\share`, `\\wsl$`, `\\wsl.localhost`, `\\?\`, `\\.\` (never touched on disk) |
| `not-local`, `invalid` | not a drive-letter path; a `:` after the drive letter, reserved or control characters |
| `drive-root` | `C:\`, `D:\` |
| `home` | the home folder and every folder above it |
| `broad` | Desktop, Documents, Downloads themselves (also where Windows moved them, e.g. OneDrive), the temp folder, AppData and below, System32, Claude's scratchpad; `%SystemRoot%` (`C:\Windows`), `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%ProgramData%` with everything below them; each OneDrive root itself (`%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`; a project folder inside OneDrive is fine). The variable names are read in any letter case (server: `SYSTEM_TREE_VARS`, `ONEDRIVE_ROOT_VARS` in `server/catalog.mjs`; the shell uses the same list) |
| `hub` | the hub, anything inside it, and any folder that holds it |
| `program` | the program folder (`dirname(process.execPath)`, the app folder) and anything inside it or holding it |
| `personal` | Claude Code's own `~/.claude` and anything inside it (server) |
| `link` | the folder itself is a junction or symbolic link (a junction on the way is followed and the real form checked) |
| `missing`, `not-folder` | gone, or a file |
| `holds-projects` | a folder that holds listed projects: as a project it would take their folders over (server) |

A folder that already belongs to a listed project (registered, found by a tool, remembered, or a subfolder of one)
opens that project (`existed: true`).

### The idea kept with the project

The drawer sends the idea to the project 1.2 s after typing stops (only when it changed; failures are quiet). The
browser copy (`sibersentez.idea.<id>`) stays as the fallback. When the drawer opens and the two differ, the stored one
wins, unless the person already typed in this page. An idea never makes a project memory entry: for a project whose
folder the memory does not hold (a registered project no tool has reported yet) the server answers `not-in-memory`.
The drawer then stops sending that project's idea for the rest of the page session and shows one plain line under
the box: "This idea is kept only in this computer's browser storage." (`startIdeaLocalOnly`; `ideaKeptAnswer`,
`ideaStaysLocal` in `public/js/views/drawer.js`). Other failures stay quiet and are tried again with the next change.

### QA

`?qa=1&newproject=pick` runs the flow once (the "New project" window first) with a stand-in bridge that answers with
the first project that can take skills, for a made project and a picked folder alike; `?qa=1&newproject=<reason>` shows that refusal; `?qa=1&newproject=browser` the page without a bridge. Nothing
reaches the shell or the server.

### Tests

`test/new-project.test.mjs`: the preload's functions and their argument checks; the sender rule; the folder rules with
real junctions; the picker flow; the reply; the calls to the server process; the wiring in `main.mjs` and
`index.mjs`; the project memory with the idea; adding a folder and every refusal on the server; the channel; a forked
server end to end (add, list, idea, `discovered.json`, the registry untouched, nothing logged); the page flow, the
start card, the stored idea and "Then: open a terminal". `test/idea-project.test.mjs`: the folder name rule (the
shell's and the page's preview are the same), the request check, a free folder name, the shell's steps with fakes
(the empty folder removed after a refusal), the preload, `main.mjs`'s wiring, the window's flow and texts. Mutation evidence: dropping the top-frame rule, the link
rule, the idea cleaning, the preload's checks or "only the asked process answers" turns tests red.

### Open

- The window menu (Alt) has no "New project" item; the header button and the tray have it.
- A real run of the app (the picker, `utilityProcess` messages) is left to an invisible Electron check.

## Step 3 (built): a vague idea is asked about, never a dead end

A newcomer writes "app development" or "an order site for my restaurant" and knows no tool names. Research
(Lovable, Replit, Firebase Studio, Bolt) showed that no product answers such an idea with "not recognized"; they ask
or propose. So the idea box asks at most two short questions with one-click answers:

1. **Nothing known** ("uygulama geliştirme"): "What kind of thing do you want to make?" with the kinds Website, Phone
   app, Desktop program, Game, Bot or automation, Data or AI (`IDEA_KINDS`), and "Not sure yet". A kind adds its words
   (`startKindAdd_<kind>`, words the dictionary knows) to the idea and asks again. "Not sure yet" asks nothing: a note
   says the `idea-to-plan` skill makes the AI ask the questions instead.
2. **A topic but no tool** ("oyun", "restoranım için sipariş sitesi"): "Which tool will you build it with?" with the
   tools of that topic (`STACK_CHOICES`), the recommended one first and marked, and one line on why (the most used
   engine, the most common choice…). A tool adds "with <tool>" to the idea and asks again; then the starters fit.

Also: everyday words in the dictionary (sipariş, restoran, otomatik, telefon; "geliştirme"/"development" as glue
words), plain-word examples first, and the automatic selection is at most 4 skills and 1 agent, so a newcomer
weighs a short list (the rest stay unticked in the list).

## Step 4 (built): fewer decisions between the idea and a running AI

- **Where to install** is folded under *Advanced: where to install (…)*. The targets already follow the project's
  AI tools (Claude Code's `.claude`, the shared `.agents`); the summary names the chosen ones, and the fold opens by
  itself while none is chosen (the install button then waits for one). Off mode shows no targets at all.
- **Install and start.** In live mode, when an AI tool is found on this computer, the main button reads *Install and
  start*. The confirmation says that the tool starts afterwards and offers *Yes, install and start <tool>*, *Install
  only* and *Cancel*. After a successful live install the drawer presses the first *Start with <tool>* button of
  "Then: start with AI" itself, so the start uses exactly the request and the idea choice that button would use.
  Preview and off never promise a start.
- **Actions off** is said once, at the top of the project drawer, with the one *Turn actions on* button; the skills
  section and "Then: start with AI" only point to it. Preview keeps its *Change actions* buttons.
- Tests: `test/fit-ui.test.mjs` (install and start, the banner), `test/new-project.test.mjs` (the start section).
