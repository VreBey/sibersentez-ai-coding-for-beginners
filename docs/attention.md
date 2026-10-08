# What needs you

The first question when the panel opens is "is anything waiting for me?". This piece answers it the same way in every
place: the header, the "Now" rail, the project list and (next) the building scene. It comes from the Cutaway concept
the user chose on 2026-09-29 (a studio building cut open, one floor per project, one lit room per session); only the
parts that make the work easier were taken first.

## 1. Four states

`public/js/attention.js` (pure, tested in `test/attention.test.mjs`):

| State | A session | A project | Word (en / tr) | Color |
|---|---|---|---|---|
| `waiting` | open, finished its turn within the last 6 hours (`WAIT_FRESH_MS`) | any session waiting, even while another works | Waiting for you / Seni bekliyor | coral `--waiting` |
| `busy` | its tool runs (`live.status` busy) | a session busy or an agent running | Working / Çalışıyor | green `--busy` |
| `left` | open and quiet for longer than 6 hours | a session open, none waiting or busy | Left open / Açık kaldı | grey `--left` |
| `closed` | no process runs it | nothing open | Closed / Kapalı (the project card shows its last activity instead) | muted |

Claude Code's session file (`~/.claude/sessions/<pid>.json`) says `busy`, `idle`, or `waiting` while it asks the
person something (a permission, a dialog, input needed), with `waitingFor` naming it in a few words ("dialog open",
"input needed"; found in Claude Code 2.x, 2026-09-29). `server/live.mjs` `liveStatus` keeps the three (anything else is
idle) and `waitingFor` (80 printable characters). A `waiting` session waits for the person however long ago it
started; `idle` splits into `waiting` and `left` by the time of the last status change (`live.since`). What it
asks is said in the page's language (`waitWhat`, format.js, 2026-10-01): "approval of its plan" when the tool it called last
is `ExitPlanMode`, "an answer to its question" for `AskUserQuestion`, else Claude Code's words with the known ones
translated ("dialog open", "input needed") and others as they are. What it asks
shows in the header list, the Now rail and the building's tooltip ("It asks: dialog open"), and the notification says
it too. Other tools write no such state; for them only the turn end counts.

## 2. Where it shows

- **Header counter** (`public/js/views/waiting.js`): "N waiting for you", quiet ("Nobody waits for you") at zero. One
  waiting session opens at once; several open a list under the counter, the one that finished last first; a row opens
  its session drawer. Escape and a click outside close the list.
- **Now rail**: waiting first, then working, then left open; each card says its state in words.
- **Project list**: projects sort waiting, working, left, closed, then by the latest activity (`store.sortedProjects`);
  a card and its session rows carry the same words and colors.
- **Held order**: while the pointer is over the project list or the focus is inside it, cards keep their places and
  new ones go to the end (`holdOrder`); leaving the list lets the fresh order in. A live update never moves the card
  under the cursor.

## 3. Strings and styles

`public/js/strings/attention.js` (keys `attn*`, en and tr) and `public/css/attention.css`. The browser tab's counter
("(N) bekliyor") is still the notifier's own count of turns finished while the tab was hidden (`notify.js`).

## 4. On the taskbar (desktop app)

The page reports its waiting count and the header's words for it through the bridge
(`window.sibersentezShell.setAttention(count, text)`, channel `sibersentez:attention`, only on change). The shell checks the
sender and the values like every bridge call (`attentionRequest`: main window, top frame, app origin; count 0..999;
text up to 80 printable characters) and then (`attentionPlan`):

- puts a coral dot over the taskbar button while anyone waits (`setOverlayIcon`, drawn by `attentionBadgeBitmap`), and
  takes it away at zero;
- writes the words into the tray's tooltip ("SiberSentez · 2 waiting for you");
- flashes the taskbar button when the count grows while the window is not focused; the flash stops when the window
  gets the focus.

System notifications: in the desktop app they are on by default (the shell grants the permission to its own page);
they show when the window is hidden, minimized or simply not focused. In a browser they stay off until turned on.

## When the AI stops on an error (2026-10-02)

Claude Code writes some failures in place of an answer: an assistant record with `isApiErrorMessage: true`, an
`error` code and, for a limit, `quotaLimits { rateLimitType, resetsAt }`. The owner's logs held 185 of them: the
session limit (150), the connection (18), "Prompt is too long" (6), the weekly limit (6), not signed in (3) and an
organization that turned subscription use off (2). Until now SiberSentez showed such a session as simply quiet.

- **Server** (`server/apierror.mjs`, ingest `assistant`): the kind (`limit-session`, `limit-week`, `login`, `org`,
  `connection`, `too-long`, `other`), the time, a limit's reset time and, for `other` only, Claude Code's text (short,
  redacted). Kept on the lead session (`apiError` in the session view) until a real answer after it; an `ai_error`
  event is added once as it happens, never for the logs read at start. `quotaLimits` is written only on a rejected
  turn and carries no percentages, so it is no source for the Building's quota panel.
- **Page** (`public/js/apiError.js`): an error counts for a day, a limit until an hour after it opened again (the card
  then says it opened). Each kind has a title and what to do in the page's language ("type /login in the AI's
  terminal", "type /compact", "type go on when it opens again: 14:30"). Shown in the project and session drawers, in
  the Building's job box (even without a team job) and as a notice (`notify.js`, always, with a desktop notification
  while the window is in the background). A dropped connection and a limit that opened again are warnings, the rest
  stops.

## How freely the AI acts (2026-10-02)

Claude Code Desktop shows its permission mode beside the send button; Cursor and Devin show theirs on the command
card. Claude Code writes the mode on every line the person writes (`permissionMode`; the owner's logs: `auto` 7,742,
`default` 44, `plan` 34, `acceptEdits` 33). The newest one is kept on the lead session (ingest `user`, an older line
never replaces it, only a plain word is taken) and `public/js/permMode.js` says it in plain words with what it lets
the AI do: Plan only / Asks every step / Only what is allowed (calm), Edits files itself / Automatic (gold), Asks
nothing (`bypassPermissions`, the stop colour). Shown as a chip on the lead's card in the Building and in a session's
drawer, and as one line in a project's drawer for its newest open session. It is the mode at the person's last line:
a change made in the terminal with Shift+Tab shows at the next line. SiberSentez never changes the mode.
- **In the Building's inbox and when a limit opens (2026-10-02, later):** a session stopped on an error is listed
  in "Waiting for you" over every project, with the error's title (the inbox is asked on every draw now: before, a
  session of another project showed only once something changed in the shown one). When a usage limit's reset time
  comes, a notice says it opened and how to go on (`notify.js checkLimits`, every 30 s, once per session and reset
  time; a limit that opened before the page looked, or more than ten minutes ago, is only remembered).

## Every AI tool (2026-10-07)

Before this, only Claude Code's sessions were read from its logs, so another tool (Codex, Gemini CLI and the rest) had
no "waiting" state at all. An AI tab in SiberSentez's terminal whose screen asks the person something now waits too: the dock
keeps what its screen asks (`terminalDock.js` `asking()`, the same `promptHelp.detectPrompt` the tab's note uses) until
the person types in that tab; hiding the note is not an answer, the question is still on the screen. A tool that ended
or a closed tab asks nothing. `attention.js dockWaiting` turns these into waiting rows: the header's counter and menu,
Today's block, the taskbar count, and the project's state in the Building, the project list and Today. Its row brings
the tab forward. A Claude Code tab is left out: its own session already says it waits. A question the note does not
recognize is not counted; a tool run outside SiberSentez's terminal is not seen. Tests: `test/dock-waiting.test.mjs`.
