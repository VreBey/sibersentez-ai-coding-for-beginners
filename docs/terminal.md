# Open terminal

The context menu opens a plain terminal in a project or session folder. SiberSentez runs no AI command in it: the user
types the tool they want (`claude`, `codex`, `gemini`, …). This replaces the menu's "new Claude session" item
(backlog: "AI-agnostic actions").

The same change fixes the installed app, where no launch action worked at all (see
[Installed app: working directory](#installed-app-working-directory)).

## Menu

In the SiberSentez window (the desktop program) the first item opens the terminal inside the window, in the dock at the
bottom (`docs/embedded-terminal.md`), and "Open in Windows Terminal" follows it; the table below is that second item,
and the only one in a plain browser.

| Menu | Item | Sends |
|---|---|---|
| Project | **Open terminal** (tr: *Terminal aç*), hint "In this folder; start any AI tool you like" | `{ action: 'terminal', projectId }` |
| Session | **Open a terminal in this folder** (tr: *Bu klasörde terminal aç*) | `{ action: 'terminal', sessionId }` |
| Project, session, agent | **Resume Claude Code session** / **Open a copy of the Claude Code session** (parent session for an agent) | `resume` / `fork` (unchanged) |

- The project menu lists "Open terminal" first, then the Claude Code item when the project has a session.
- The resume and fork items stay: they only work with Claude Code sessions, so their labels now name Claude Code.
- The menu never sends `new` any more. The server keeps `new`: the skill trial starts a Claude Code session with it.
- Texts live in `public/js/strings/terminal.js` (en and tr, same keys). The labels of the resume and fork items moved
  there too.

## Server action `terminal`

Body: `projectId` or `sessionId` (one is required), nothing else. The folder is the project's folder from the catalog
or the session's working folder from the logs; no path or command comes from the browser.

Every check of the other launch actions applies: token, mode, field allow list, id patterns, broad-folder refusal,
the folder must exist, `UNSAFE_RE` on the folder, the tab title (project name or folder name) and every argument that
reaches Windows Terminal, a title that starts with `-` is refused, rate limit (same target within 3 s: 429),
`shell: false` with an argument array.

### Windows Terminal (first choice)

```
wt.exe -w sibersentez new-tab -d <folder> --title <project name>
```

A new tab in the "sibersentez" window with the user's default profile. No command follows, so the default shell opens
in the folder. The program is looked up from the app folder (see below), never from the project folder.

### Windows PowerShell (fallback)

When `wt.exe` cannot be started from a valid app folder (not installed, or it fails to start):

```
%SystemRoot%\System32\cmd.exe /d /c start "" %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoExit
```

started with the folder as its working directory.

- Nothing from the request is on this command line: both programs are called by absolute path, and the folder
  reaches the shell only as the working directory. `/d` skips cmd's AutoRun commands; `""` is start's window title.
- Why `start`: PowerShell must get its own console window. libuv starts a `detached` child with `DETACHED_PROCESS`,
  so a console program gets no console at all (it would run invisibly); a child that is not detached shares the
  server's console (or none, in the desktop app) and is killed with the server (libuv puts it in a job object with
  `KILL_ON_JOB_CLOSE`). `start` opens a new console window for PowerShell; on Windows 11 that window may open in the
  default terminal application.
- Both programs are checked to exist before the fallback runs.

### Replies

| Case | Status | Body |
|---|---|---|
| Dry mode | 200 | `argv` (Windows Terminal), `fallbackArgv` (PowerShell); nothing starts |
| Windows Terminal opened | 200 | `terminal: 'wt'`, `argv` |
| Fallback opened | 200 | `terminal: 'powershell'`, `argv` (the PowerShell command), `fallbackReason: 'terminal-missing'` or `'terminal-failed'` |
| App folder cannot be used | 500 | `error: 'app-folder-missing'` (no fallback: Windows Terminal was never the problem) |
| No terminal at all | 501 | `error: 'no-terminal'` |
| Folder gone before PowerShell started | 404 | `error: 'folder-missing'` |
| PowerShell failed to start | 500 | `error: 'launch-failed'` |

Validation errors are the same texts as the other launch actions. The page maps the English codes above to
localized text (`termErr_*`). The notice after a success reads "Terminal opened · <project>" and says what to do next,
or that Windows Terminal was not found and PowerShell opens instead.

Log notes: `dry`, `live`, `fallback`, `workdir`, `missing`, `folder`, `launch`.

## Installed app: working directory

**Symptom.** In the installed app every launch action (terminal, resume, fork, new, Explorer, VS Code, skill trial)
answered `501 terminal-missing` / "wt.exe not found", although Windows Terminal was installed.

**Cause.** The server runs from `...\resources\app.asar`. Started processes get the app folder as their working
directory, so that a bare program name (`wt.exe`) is never looked up in a project folder (libuv searches the working
directory before `PATH`; a cloned repository could hold its own `wt.exe`). Electron's patched `fs` shows `app.asar`
as a folder, so the "app folder exists" check passed, but the operating system cannot enter an archive: CreateProcess
failed, libuv reported `ENOENT`, and the server read that as "program not found".

**Fix** (`server/actions.mjs`):

- `realWorkDir(dir)` (pure): a path with an `.asar` segment becomes the folder that holds the archive (the app's
  `resources` folder, a real folder that belongs to the installed app); other paths are unchanged
  (`app.asar.unpacked` is a real folder and stays). `createActions` applies it once to `workDir`;
  `server/index.mjs` is unchanged.
- `launch` refuses any working directory with an `.asar` segment before calling `spawn`, so no process is ever
  started inside an archive.
- `ENOENT` means "program not found" only when the working directory is a real folder; otherwise the reply is "app
  folder not found" (`uygulama klasörü bulunamadı` for the older launch actions, `app-folder-missing` for the
  terminal and the skill trial).

The trust rule is unchanged: bare program names are resolved from the app's own folder, never from a project folder.
Only the terminal fallback runs with the project folder as working directory, and it calls both programs by
absolute path.

What runs once the shell is open is outside SiberSentez: the terminal opens in the project folder, and a git prompt
module in the user's shell profile (for example posh-git, or a prompt theme that shows the branch) runs git in that
folder as soon as the prompt is drawn. An untrusted repository's `.git/config` (for example `core.fsmonitor`) can run
a command at that moment, so be careful when opening a terminal in a repository from someone you do not trust.

## Tests

`test/actions.test.mjs`: argv of both commands, dry and live replies, the fallback (missing and failing Windows
Terminal), no terminal at all, a folder that vanishes, the argument checks, `realWorkDir`, and the installed-app
regression (an `app.asar` working directory with a spawn that fails like Windows does). `test/contextmenu.test.mjs`:
menu items and order in both languages, no `new` in any menu, notices and error texts. No test starts a real program:
`spawn` is always a fake.

Not covered by automated tests: a real Windows Terminal tab and a real PowerShell window. Check by hand in the
installed app: right-click a project, "Open terminal"; then again with Windows Terminal's app execution alias
switched off (Settings, Apps, Advanced app settings, App execution aliases) to see the PowerShell fallback.
