# App shell

SiberSentez used to be one long page: header, the scene with its rail, the numbers, the usage strip, four tabs and a
footer, all at once. New users did not know where to look. The shell (decided 2026-09-29) shows one screen at a time
behind a menu on the left, the pattern of Linear, Raycast, Cursor and the Claude and Codex desktop apps.

## Layout

```
┌────────────┬───────────────────────────────────────────────┐
│ ◉ SiberSentez │ [waiting chip] [Search… Ctrl K]   [New project] [Actions] 🔔 │
│            ├───────────────────────────────────────────────┤
│ ⌂ Building 1│ <screen title>                                │
│ ▢ Projects 2│ <screen>                                      │
│ ADVANCED   │                                               │
│ ☆ Skills & │                                               │
│   agents 3 │                                               │
│ ≡ Feed   4 │                                               │
│ ────────── │                                               │
│ ✦ AI tools │                                               │
│ ? Guide    │                                               │
│ ⚙ Settings 5│                                              │
│ ● Live     │                                               │
└────────────┴───────────────────────────────────────────────┘
```

- **Menu** (`nav.side`, 220 px; 60 px of icons below 980 px): the Building and Projects, then under a small "Advanced" label
  Skills & agents and Feed, then at its foot the AI tools panel, the guide, Settings and the connection state. Keys
  `1`-`5` open Building, Projects, Skills & agents, Feed, Settings (docs/simplify.md).
- **Top bar** (sticky): who waits for you (the attention chip), search (Ctrl+K), New project, the actions mode, the
  notification bell. The clock and the status chips hide on narrow windows as before.
- **Screens** (`section#tab-<key>`, `TAB_KEYS` in `public/js/main.js`): `today`, `workshop`, `projects`, `roster`,
  `feed`, `timeline`, `settings`. Feed and Timeline share one menu item (`data-tab-also`); a switch at the top of the Feed
  screen goes between them. The views render into `#<key>Body`, under the screen's own title.

## Building (the main screen; key `today`)

In this order (the research of 2026-09-29: what needs you first, then what runs, then what you can pick up):

0. **First 10 minutes** (`#todayChecklist`, `views/checklist.js`): four steps that tick themselves (an AI tool
   found, actions on, a project, a first session), each one button away; the session step's button appears once a
   project exists. Hidden when all four are done or when the person hides it (`sibersentez.checklist`).
1. **The building** (`#workshopBody`, `views/workshop.js`, docs/hq.md): the project, its team at work, "Give a job",
   the plan and the result, waiting for you, "What happened?". The screen is called Building (its key stays `today`);
   the orchestra scene and its rail (Now, the last events) moved to the Feed screen as an advanced view. Its "waiting for you" list replaced the old block above it (2026-10-01: the two showed the same sessions); the chip in the top bar stays.
2. **Pick up where you left off** (`#todayRecent`, `views/today.js`): the three most urgent or recent projects (never a
   folder that is not a project), each opening its detail; "All projects". Empty: how to start.
3. **The numbers of the last 24 hours** (`#kpis`: zero counts stay hidden) and **the usage strip** (one line).

## Settings

`views/settings.js`: Actions (the mode in words, "Change" opens the actions panel in the desktop app), AI tools (the
setup check), Usage and cost (the dollar switch), General (the language: SiberSentez follows Windows), Help (the guide, the diagnostic info).
The old footer (data sources, shortcuts, the hub folder) sits under it.

### Diagnostics

"Diagnostic info · Copy" (`public/js/diagnostics.js`) puts a few plain lines on the clipboard for a problem report:
SiberSentez's version, Windows and the runtimes (`GET /api/about`: package.json's version, `os.release()`, the
architecture, Electron's and Node's versions; read-only, the usual API rules), the language and the actions mode,
Node.js and Git, whether `ANTHROPIC_API_KEY` is set, each AI tool with its version, install kind and sign-in state
(from `/api/tools`, checked only when there is no answer yet), and the setup check's findings by id. No folder path,
user name, project name, session or account: a value from the server that does not look like a version is left out.
The labels are English, like a log. The toast shows what was copied.

**The page's own errors and the log folder (2026-10-09, plan A4).** An exception nobody caught or a promise nobody
waited for (`public/js/pageErrors.js`, installed before the rest of `main.js` runs; an error while its imports are
first read is not caught) goes to the desktop app's `main.log` as one line: its name and message, where, the first
stack lines (each different one once, at most 20 per run from the page and 50 in the shell, from the main window's top
frame only; keys and passwords are masked as everywhere, and the log masks the home folder). An
object thrown without a message is written as "unknown error", never by its contents. Diagnostics adds only the
count ("Page errors this run: N"). Settings → Help → "Log files · Open the folder" (desktop app only) opens the log
folder in File Explorer; the shell always opens its own folder, never a path from the page. Nothing is sent anywhere:
the person attaches the logs to a report if they want. Tests: `test/page-errors.test.mjs`.

## Look

The shell sets the layout only. Every colour comes from `public/css/theme.css` (docs/theme.md); the look is designed
separately.

## Tests

`test/shell.test.mjs`: the menu's items and order, one screen per item, what Today holds, the old tab row gone, the
screen keys; Settings in both languages (the mode button only in the desktop app); Today's recent projects (order,
count, never another folder, the empty text, escaping).
