# Embedded terminal (built 2026-09-29; the owner's decisions in §5)

Today "Open terminal" and "Start with AI" open Windows Terminal (or PowerShell) outside the app (`docs/terminal.md`,
`docs/ai-start.md`). The goal: the same terminal inside the SiberSentez window, so a beginner never leaves the app: pick
a project, start the AI tool, watch it work, all in one place.

## 1. Constraints

- An AI tool (Claude Code, Codex, Gemini CLI) is an interactive full-screen program: it needs a real terminal (a
  pseudo console), not pipes. On Windows that is ConPTY.
- The web page must never get a shell. The server's HTTP API is reachable from anything on this computer that can
  send a request to 127.0.0.1; a shell behind it would be the biggest hole the app could have. So the terminal does
  **not** go through the server: it lives in the desktop shell's main process and reaches the page only through the
  preload bridge of the SiberSentez window. A plain browser on the panel's address has no terminal at all.
- Same rules as the terminal action: the folder comes from the catalog by project id, never from the page; broad and
  missing folders are refused; only in **On** (in Preview the dock shows what would open, nothing runs; in Off the
  item explains how to turn actions on).
- No third-party content in the kit is unaffected: the two new dependencies are libraries (MIT), shipped inside the
  program, never loaded from the network (CSP stays `script-src 'self'`).

## 2. Parts

| Part | What | Where |
|---|---|---|
| Pseudo console | `node-pty` 1.1.0 (MIT, Microsoft). Ships prebuilt Windows x64 binaries (N-API, ConPTY), so no compiler on the user's machine | main process |
| Terminal manager | open (project id → folder from the catalog), write, resize, close; at most 8 at a time; output never logged or stored; the child's environment without `ELECTRON_RUN_AS_NODE` and SiberSentez's own variables | `electron/terminals.mjs` (pure parts tested with a fake pty) |
| Bridge | five functions only: `termOpen(projectId, { tool? })`, `termWrite(id, data)`, `termResize(id, cols, rows)`, `termClose(id)`, `onTermData(cb)`; ids are the manager's, the page sends no path, no command line | `electron/preload.cjs` |
| Screen | `@xterm/xterm` 6 + fit add-on (MIT), copied into `public/vendor/` at build time | page |
| Dock | a panel at the bottom of the window, one tab per terminal (project color, name, state), resizable, can be collapsed; the tab shows a dot when output arrived while it was hidden | `public/js/terminalDock.js` |

## 3. Where it is used

1. Project drawer and context menu: **Open terminal** opens a tab in the dock (Windows Terminal stays as "Open in
   Windows Terminal").
2. **Start with AI**: the chosen tool starts in a dock tab with the first message, the same launcher as today.
3. The building scene: a room whose session was started in the dock opens that tab on click.

## 4. Steps

1. **Spike (small, first):** `node-pty` in Electron 44's main process on this machine: `cmd`, PowerShell and Claude
   Code in a pty, resize, Turkish characters, packaged build (the binaries must be unpacked from `app.asar`:
   `asarUnpack`). If the prebuilt binaries do not load in the packaged app, stop and report before anything else.
2. Terminal manager + bridge + tests (fake pty; the bridge's allow list; a closed window closes its terminals).
3. Dock + xterm + tabs; the drawer, menu and Start with AI entries.
4. Docs, hidden QA probe (a pty running `cmd /c echo` in the packaged app), one review round (security).

## 5. The owner's decisions (2026-09-29)

- "Open terminal" opens in the dock by default; "Open in Windows Terminal" is the second item.
- "Start with AI" starts the tool in the dock by default; Windows Terminal stays as the second choice.
- Closing the window to the tray keeps the terminals running (the tabs are there when it opens again); quitting the
  program while a terminal runs asks first.
- Size: the setup grows by about 10 MB (pty binaries + xterm).

## 6. What was built

- **Step 1 (spike):** node-pty 1.1.0 loads in Electron 44's main process; cmd, PowerShell and `claude --version` run in
  a pseudo console, Turkish letters intact. Packaging: `asarUnpack: node_modules/node-pty/**`, `npmRebuild: false`
  (no compiler needed), only the Windows x64 binaries go in. The packaged app's hidden QA has a probe
  (`qaTerminalProbe`: node-pty from `app.asar.unpacked` runs `cmd /c echo`).
- **Manager** `electron/terminals.mjs` (tested with a fake pty, `test/terminal.test.mjs`): Windows PowerShell by its
  full path, or the launcher program the server answered for a start-ai; at most 8; 64 KB per write; sizes 2-500 x
  2-200; the environment without `ELECTRON_*`, `SIBERSENTEZ_*` and `NODE_OPTIONS`; a 256 KB buffer per terminal for a
  reloaded page; output never logged or stored.
- **Bridge** `window.sibersentezTerminal` in `electron/preload.cjs`: `open(target, cols, rows)` with `{ projectId }`,
  `{ sessionId }` or `{ launchId }`, `write`, `resize`, `close`, `list`, `onData`, `onExit`. Every IPC call passes
  `bridgeSender`. The only send from the shell into the page is the terminals' output, while the window shows the app.
- **Server** `actions.terminalTarget` over the shell channel (`terminal-target`): the terminal action's checks, live
  mode only; or a start-ai's one-time `launchId` (96 random bits; `docs/ai-start.md`).
- **Page** `public/js/terminalDock.js`: xterm.js 6 vendored in `public/vendor/xterm` (`tools/vendor-xterm.mjs`), tabs
  (project color, unread dot, arrows, Delete), a resizable, foldable dock; the menus' "Open terminal" and "Start with
  AI" use it (`contextmenu.js setDockOpener`). CSP: `style-src-elem` allows inline `<style>` (xterm's font and
  colors); scripts stay `'self'`. QA: `?qa=1&dock=demo` (a stand-in bridge that echoes).
- **Quit:** closing the window keeps terminals running; quitting asks when some run (`confirmQuitWithTerminals`,
  never in QA).
- **Actions mode:** a terminal opens only in On. One already open keeps running when the mode changes to Preview or
  Off, as a Windows Terminal opened from the menu would: the mode governs what SiberSentez starts, not what the person
  runs in a terminal they opened. Closing its tab (or quitting) ends it.
- **Review (2026-09-29, APPROVED):** output arriving before its tab exists is queued and written first; every way
  out of the app closes the terminals (`will-quit`); with eight terminals open, Start with AI goes to Windows Terminal
  (no launcher waits for a terminal that cannot open); the QA dock opens by itself only with its stand-in. Left: a
  terminal that fails to spawn after a start-ai leaves its launcher unrun until the launcher cleanup removes it.

## What runs where (lifecycle, 2026-10-06)

A terminal opened by a start-ai keeps the tool (the tools list's id) and the app job (`Job-ID`) the server gave its
launch record (`terminal-target`); a plain shell keeps neither. After every open, exit and close the shell sends the
whole list to the server (`terminal-state` over its own channel; again to a restarted server), so a restore is refused
while any AI start of the app runs in the project's terminal, whatever the tool (`actions.aiActiveIn`). The page knows
its own tabs: the building shows such a tool as "open in the terminal", never as working (what it does is not known);
a tab that ends offers to resume only a Claude Code session. Not seen: a tool typed into a plain shell, or started in
Windows Terminal.

## What the AI asks (`public/js/promptHelp.js`)

When an AI tool in an embedded terminal asks the person for something, a note appears over the terminal's top right
and says in plain words what it asks and which answer is the safe one. It only explains: it never answers and never
types into the terminal.

- The dock keeps the plain text of each terminal's last 4000 characters (`stripAnsi`: colours, cursor moves, OSC
  titles and lone carriage returns removed) and, 250 ms after the output settles, looks at the last 2500 for a
  question (`detectPrompt`).
- Kinds, most specific first: `trust` (a folder), `login`, `edit`, `command`, `fetch`, `plan`, `confirm`. The texts are
  the tools' own as of 2026: Claude Code ("Do you want to make this edit to …?", "Bash command … Do you want to
  proceed?", "Do you want to allow Claude to fetch this content?", "Do you trust the files in this folder?", "Select
  login method", plan mode's "keep planning"), Codex CLI ("Would you like to run the following command?", "Would you
  like to make the following edits?", "Do you trust the contents of this directory?"), Gemini CLI ("Allow execution
  of: '…'?", "Trust folder"), GitHub Copilot CLI ("… approve … for the rest of the running session", "Confirm folder
  trust"). A command question is checked before the network one: Codex asks to run a command "Reason: Need network
  access".
- The note shows the command or file the question names (escaped: it is terminal output), a warning when the command
  can delete files, rewrite history or run something from the internet (`rm`, `del`, `Remove-Item`, `git push`,
  `git reset --hard`, `curl … | sh`, `irm … | iex`, `--force` …), and a warning when an answer on offer gives a lasting
  or wide permission ("don't ask again", "allow always", "allow all edits", "remember this folder", "auto-accept").
- Typing in the terminal (the person answered) or the note's × hides it, and the same question (kind and subject) is
  not explained again; an unknown question shows nothing. QA: `?qa=1&dock=ask` prints a Claude Code command question in
  the stand-in terminal.

### Known errors

When no question is on screen, the same note explains a known error in the terminal's last 800 characters, with the
setup check's explanation and fix command (`setupCheck.matchError`, docs/ai-start.md) and a copy button. SiberSentez
never runs the command and never types it. Only the exact sentences are looked for (`TERM_ERRORS`): PowerShell's
"running scripts is disabled on this system" and its Turkish text, "is not recognized as …" in PowerShell and cmd
(English and Turkish) and "command not found", Claude Code's "requires git-bash", npm's EBADENGINE, "invalid api key",
"please run /login", `authentication_error`, "usage limit reached", `rate_limit_error`, certificate chain errors,
EPERM/EACCES and ENOTFOUND/ECONNREFUSED. An AI tool's screen shows code and talk that merely mention "certificate",
"401" or "rate limit", so the broad patterns of the pasted-error box are used only to explain what these found. A
question on screen comes first; an error stays explained after the terminal's program ended. QA: `?qa=1&dock=err`.

### A sentence in the plain shell

Seen on the owner's screen (2026-09-30): "nasıl çalıştırılır" typed into a project's plain PowerShell tab, as if it
were the AI. The shell takes the first word for a command, and the PATH advice of "is not recognized" would mislead.
When the word it names is not a known tool's command and has a non-ASCII letter, ends with "?" or is a question or
greeting word (`QUESTION_WORDS`), the explanation is `errNotACommand`: a plain terminal, nothing ran, start the AI
with the project's "Start with …" button. No command to copy, so no copy line. Besides, the shell tells the page which
terminals run an AI tool (`ai` in `open` and `list`), and the bar says "Plain terminal (PowerShell): for commands, not
the AI" while a plain one is shown. QA: `?qa=1&dock=shell`.

## Setup terminal

The tools panel's commands (the install commands of a tool that is not installed, the setup check's fixes) get "Type
in terminal" in the desktop app with the dock (`views/tools.js` `setSetupTyper`, `addTypeButtons`). The dock
(`typeSetup`) opens a plain terminal of the user's home folder, or reuses the one it opened for this while it waits at
an empty prompt, and writes the command there without Enter; the panel closes so the terminal is seen. The person
reads it and presses Enter. The same rules as "How to run it" (docs/run-hint.md): one line of printable ASCII, at most
200 characters, one call at a time.

The request is its own shape, `{ setup: true }` and nothing else (`electron/terminals.mjs` `termOpenRequest`); the
server's `terminalTarget` answers it only in On, with `USERPROFILE` when it is a local drive path of a real folder,
the title `Setup`, no project and no program (a plain shell: no AI tool starts). Actions Off or Preview: the dock's
own notice says why, and the command can still be copied.

When the person pressed Enter in the setup terminal and its shell is back at an empty prompt, the dock calls
`onSetupDone` and main.js checks the tools again (`loadTools({ refresh: true })`, throttled by the server): a tool
just installed shows up without "Check again". Only the setup terminal is watched this way.
