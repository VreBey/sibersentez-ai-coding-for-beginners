# Start with AI

Many people want to use an AI coding tool but do not know how to start one. "Open terminal" (docs/terminal.md) opens
a plain shell and leaves the rest to them: they have to know to type `claude`. "Start with AI" finds the AI tools on
this computer, shows whether each is ready, and starts the chosen one in the project folder, with the project's idea
(docs/start-flow.md) as its first message.

## Tools

| id | Tool | Command | Starts interactively with a first message | Version | Signed in? |
|---|---|---|---|---|---|
| `claude` | Claude Code | `claude` | `claude "<prompt>"` | `--version` | `claude auth status` (exit 0) |
| `codex` | Codex CLI | `codex` | `codex "<prompt>"` | `--version` | `codex login status` (exit 0) |
| `gemini` | Gemini CLI | `gemini` | `gemini -i "<prompt>"` | `--version` | not known |
| `copilot` | GitHub Copilot CLI | `copilot` | `copilot -i "<prompt>"` | `version` | not known |
| `cursor` | Cursor CLI | `cursor-agent`, then `agent` | `agent "<prompt>"` | `--version` | not known |
| `qwen` | Qwen Code | `qwen` | `qwen "<prompt>"` | `--version` | not known |
| `opencode` | OpenCode | `opencode` | `opencode --prompt "<prompt>"` | `--version` | not known |

One-shot modes (`-p`, `exec`) are never used, and no permission, "yolo" or bypass option is ever added.

Official Windows install commands (shown with a copy button; SiberSentez never runs them):

| Tool | Command | Account |
|---|---|---|
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` or `winget install Anthropic.ClaudeCode` | paid Claude plan or Claude Console |
| Codex CLI | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` or `npm i -g @openai/codex` | ChatGPT plan or OpenAI API key |
| Gemini CLI | `npm install -g @google/gemini-cli` (Node.js 20+) | Google account or Gemini API key |
| GitHub Copilot CLI | `winget install GitHub.Copilot` or `npm install -g @github/copilot` | paid Copilot plan |
| Cursor CLI | `irm 'https://cursor.com/install?win32=true' \| iex` | Cursor account |
| Qwen Code | `npm i -g @qwen-code/qwen-code@latest` | Qwen account or API key |
| OpenCode | `npm i -g opencode-ai` | the chosen provider's account or key |

Sources: code.claude.com/docs/en/setup, github.com/openai/codex, geminicli.com/docs/get-started/installation,
docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli. The panel adds: an npm
command needs Node.js 20 or later (it shows whether this computer has it), and when PowerShell refuses to run scripts
(execution policy) the npm command works in Command Prompt.

## Detection (`server/tools.mjs`)

- **When:** only on first need (the project drawer's section, the tools panel, a project or session context menu),
  never when the server or the page starts. The answer is cached for five minutes; "Check again" (`?refresh=1`) runs
  at most once in ten seconds; one detection runs at a time and every caller shares it.
- **Finding a tool** is a plain file look-up, no process: the folders of `PATH` in order, then the folders the
  official installers use when `PATH` does not list them yet (`%USERPROFILE%\.local\bin`, `%APPDATA%\npm`,
  `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`): a tool installed after SiberSentez started is
  found although this process still has the old `PATH`. Only `.exe`, `.bat` and `.cmd` count (a `.ps1` may be blocked,
  an extensionless file is npm's shell script). One install per folder; the first folder wins, as in a terminal.
  - Why not `where.exe`: it prints in the console code page, so a user name with a Turkish letter comes back
    garbled; it cannot see the installers' folders missing from an old `PATH`; and it costs a process per tool.
- **Processes** run only for the version and the sign-in check, only for files the look-up found, by absolute path,
  with fixed arguments, `windowsHide: true`, `shell: false`, no input, a time limit (8 s version, 10 s sign-in), the
  tool's own folder as working directory (never a project: cmd looks a bare `node` up in the working folder first, and
  from the tool's folder it can only find what the npm shim already trusts), `NoDefaultCurrentDirectoryInExePath=1`
  (that look is skipped altogether), and without `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`. A check past its time limit
  is ended with every process it started (`taskkill /T /F /PID`, see below). A `.cmd` goes through
  `cmd.exe /d /v:off /s /c ""<file>" --version"` (Node refuses to spawn a `.cmd` without a shell); a path with `%` or
  `"` is never put on that line.
- **Signed in:** exit code 0 of `claude auth status` / `codex login status`. Its output is not even read (standard
  output goes to `ignore`): Claude Code prints the account's e-mail there. Other tools: "not known; it asks the first
  time". No credential file is read.
- **Several installs** (for example the native Claude Code and an old npm one) are counted; each gets a version, the
  first on `PATH` is the one started. The Codex desktop app (a `%LOCALAPPDATA%\Packages\OpenAI.Codex_*` folder) is
  reported when the `codex` command is missing: the app is not the CLI.

### `GET /api/tools`

Read-only, in every actions mode (Off included), the usual API access rules. Answer:

```json
{ "ok": true, "at": 1790670574715,
  "tools": [{ "id": "claude", "name": "Claude Code", "installed": true, "version": "2.1.284", "via": "native",
              "ready": "yes", "installs": 2, "others": [{ "via": "npm", "version": "2.1.193" }], "onPath": true, "app": false }],
  "node": { "installed": true, "version": "24.18.0" } }
```

`via` is one of `native`, `npm`, `winget`, `scoop`, `store`, `other`; `ready` is `yes`, `no` or `unknown`. No path,
no file name, no user name and no tool output ever reach the page. A failure answers `500 detection-failed`.

Also in the answer (the setup check below): per tool `pathDir` (`localBin`, `npm`, `winget`, `scoop` or null: the
installer folder the tool was found in while `PATH` lacks it), `git: { installed, onPath }` (a file look-up of
`git.exe` on `PATH`, then `%ProgramFiles%\Git\cmd` and `%LOCALAPPDATA%\Programs\Git\cmd`; no process) and
`env: { anthropicKey }` (whether `ANTHROPIC_API_KEY` is set and not blank in SiberSentez's environment; never the value).

## Setup check (`public/js/setupCheck.js`)

The top of the tools panel says what stands between this computer and a working AI tool, most of it the usual
Windows trouble of a beginner: each problem with a plain reason and, where one
exists, a command to copy. SiberSentez never runs these commands (the panel says so); the user runs them in PowerShell
and presses "Check again".

| id | When | Fix shown |
|---|---|---|
| `noTool` (note) | no AI tool installed | none: the cards below |
| `nodeMissing` / `nodeOld` | a tool installed with npm and no Node.js, or Node.js older than 20 | `winget install --id OpenJS.NodeJS.LTS -e --source winget` |
| `noGit` | Git not found (a warning when Claude Code is installed: it uses Git Bash; a note otherwise) | `winget install --id Git.Git -e --source winget` |
| `gitOffPath` (note) | Git only in its installer folder | open a new terminal, or reinstall with "Git from the command line" |
| `notOnPath` | a tool found only in an installer folder ("is not recognized" in a terminal) | first a new terminal; then a line that appends that folder to the user `PATH` |
| `multiNpm` | several installs of one tool, native and npm mixed | `npm uninstall -g <package>` |
| `apiKey` | `ANTHROPIC_API_KEY` set (a warning with Claude Code) | removes the user variable; a machine-wide one is removed in Windows settings |
| `notSigned` (note) | the sign-in check said no | type the tool's command in a new terminal |

"Got an error in the terminal?" is a text box: a pasted message is matched on the page against the common errors
(execution policy, Git Bash, Node.js, "is not recognized" in English and Turkish Windows, TLS, sign-in or API key,
usage limit, EPERM, network) and answered with what it means and, where one exists, a command. Unknown text gets one
honest answer. The text is read up to 4000 characters, escaped, never sent, never stored; closing the panel drops it.

## The `start-ai` action

Body: `projectId` or `sessionId`, `tool` (an id above), `withIdea` (boolean, optional; absent means false), `job`
(string, optional: "Do a job", docs/kit-in-app.md; cleaned like an idea, never with `withIdea` or `resume`, never empty;
the first message then asks for the kit's team flow). Nothing else is accepted (`unexpected-field`); an unknown tool
is `bad-tool`.

Checks, in order: token, mode, the field allow list, then exactly the terminal action's checks (ids, catalog and
session look-up, broad-folder refusal, the folder must exist, `;` `"` and control characters refused in the folder and
the tab title, a title read as an option), then the rate limit (same project or session and tool within 3 s: 429).
The tool must be installed per detection and its file must still exist (`409 tool-missing`). Preview mode answers
the plan only; nothing is written or started.

### How the tool reaches the terminal

In the SiberSentez window the request carries `inDock: true` (a boolean; the only other new field): the first message
and the launcher are written as below, but the server starts nothing and answers `terminal: 'dock'` with a one-time
`launchId` (96 random bits, two minutes, redeemed once by the desktop shell through the server's own channel; an
unredeemed launcher is removed when it expires). The shell runs the launcher in the dock's pseudo console, the
Command Prompt way (`cmd /d /v:off /k <launcher>`). See `docs/embedded-terminal.md`.

Windows Terminal reads `;` in any argument as a command separator, even inside quotes (microsoft/terminal#13264), and
how it quotes an argument with spaces again for the program it starts is not documented. So wt.exe never gets the
tool's path, the prompt or any user text. SiberSentez writes a **launcher**, a small ASCII `.cmd` file in its own folder,
and wt only starts `cmd.exe` with it:

```
wt.exe -w sibersentez new-tab -d <project folder> --title <project name> --suppressApplicationTitle
       C:\Windows\System32\cmd.exe /d /v:off /k <hub>\launch\<12 hex>.cmd
```

The launcher (every line starts with `@`, so no `echo off` hides the prompt of the shell that stays open after the
tool ends):

```
@set NoDefaultCurrentDirectoryInExePath=1
@rem SiberSentez: starts Claude Code in the project folder (docs/ai-start.md). Removed after 24 hours.
@set "SIBERSENTEZ_ENDED=%~f0.ended"
@"%USERPROFILE%\.local\bin\claude.exe" "Please read .sibersentez/ilk-mesaj.md and follow it. Reply in the user's language."
@type nul>"%SIBERSENTEZ_ENDED%" 2>nul
```

The third and the last line tell SiberSentez's terminal that the tool ended while its shell stays open
(`docs/embedded-terminal.md`, "The tool ended, the shell stays"); the mark lands next to the launcher, never in the
project.

- **The first line, and why.** The shell runs in the project folder, and a project is not always trusted (a cloned
  repository, a download). `cmd.exe` looks a bare program name up in its working folder **before** `PATH`. An npm
  shim such as `%APPDATA%\npm\gemini.cmd` runs a bare `node` when there is no `node.exe` next to it (the usual case),
  so a `node.exe`, `node.bat` or `node.cmd` in the project folder would run instead of Node.js, with the person's
  rights, the moment the tool starts. `NoDefaultCurrentDirectoryInExePath` (any value) tells cmd, and every program
  started from that shell through Windows' own search (`NeedCurrentDirectoryForExePath`), to skip the working folder.
  The variable stays set in the shell that remains open after the tool ends: a program in the project folder is
  started there as `.\name` (as in PowerShell). The detection's version checks run with the same variable
  (`server/tools.mjs` `childEnv`), in the tool's own folder.
- The prompt is a fixed ASCII sentence that only names the first-message file; it has no `; " % ^ & | < > !` and no
  letter outside ASCII. Without an idea the tool starts with no argument.
- The tool is called by its absolute path; a `.cmd` (npm) through `call`. A path that starts with `%LOCALAPPDATA%`,
  `%APPDATA%`, `%USERPROFILE%`, `%ProgramFiles%`, ... is written with that variable, so the file stays ASCII and holds
  no user name even when the user name has a Turkish letter. A path that is still not plain ASCII (or holds `%`, `!`,
  `^`, `&`, `|`, `<`, `>`, `"`) is refused: `tool-path-unsafe`.
- `cmd.exe /d` skips AutoRun commands; `/v:off` turns delayed expansion off even when the registry turns it on; `/k`
  keeps the shell open after the tool ends. `cmd.exe` itself is called by its absolute path.
- **Launcher folder:** `<hub>\launch`, else `%LOCALAPPDATA%\SiberSentez\launch`. When one of them is a path wt can take as
  it is (drive, then only letters, digits, `_ . ~ -`: no space, no Turkish letter) the launcher goes on the command line
  by full path (**absolute mode**, above).
- **Relative mode** (the fallback when neither folder is such a path, e.g. a user folder `C:\Users\Ahmet Yılmaz`): the
  tab opens in the launcher folder (`-d <launcher folder>`: wt takes its own options with spaces fine, the terminal
  action relies on it) and cmd runs the launcher by its bare name, which cmd looks for in its working directory, i.e.
  SiberSentez's own folder, never a project folder. The launcher's first line then changes to the project folder:
  `@cd /d "%USERPROFILE%\Desktop\game" || exit /b 1`. That folder must be expressible in ASCII the same way, otherwise
  `folder-path-unsafe`. A 8.3 short path was the other candidate; it was not used because it needs another process,
  short names can be switched off per volume and may themselves hold OEM letters.
- **In SiberSentez's own terminal** (2026-10-01) relative mode needs no cd line: the pseudo console starts in the
  project folder itself and cmd gets the launcher by its full path (`cmd /d /v:off /k <launcher>`; node-pty hands both
  over as Unicode, no Windows Terminal argument in between). A project folder with Turkish letters (`D:\Oyun Çalışması`)
  therefore starts there even under a user folder with a space or a Turkish letter. A launcher path cmd would expand
  or split (`%`, `!`, `^`, `&`, `|`, `<`, `>`, a quote) keeps the old way (`DOCK_LAUNCHER_RE`). Checked on this
  machine with a hidden cmd: a launcher under `Şükrü Yılmaz\SiberSentez\launch` ran in `Oyun Çalışması`.
- A folder with `;` or `"` in both candidates: `launch-path-unsafe`.
- **Without Windows Terminal** (not found or fails to start): `cmd.exe /d /c start "" cmd.exe /d /v:off /k <launcher>`
  in its own console window, started with the project folder (relative mode: the launcher folder) as working
  directory, as the plain terminal's fallback does. Nothing from the request is on that line either.
- Processes: wt.exe starts from the app folder (`realWorkDir`), `shell: false`, detached, no stdio, exactly like the
  terminal action.
- Launchers are named `<12 hex>.cmd`, created exclusively, removed after a failed start, and every start removes the
  ones older than 24 hours (only names SiberSentez makes).

### What is written into the project

For a job (`job`, rather than `withIdea`), the app issues a fresh id and exclusively creates
`.sibersentez/job-<id>.md`, then atomically replaces its own `.sibersentez/current-job.json` marker. The marker
binds the plan, tasks and each review to this job, so an older approval cannot finish it. Preview writes neither;
resume keeps the existing identity. Unknown marker contents block the start. See [Job identity](kit-in-app.md#2-how-the-job-reaches-the-ai).
The nine-name rule below applies to idea messages, not new job messages.

Only in live mode, only with `withIdea: true` and a saved idea (`project.idea`; a session uses its project's):

- `.sibersentez/ilk-mesaj.md` (UTF-8): the idea as a quote and plain instructions: work out a plan with me step by step
  in plain words, ask one question at a time, offer 2 to 4 numbered choices with a recommendation where it can (a
  beginner answers with a number), write or change no code before I say the plan is right, write PLAN.md at the end
  and name the first step, use the idea-to-plan skill if it is installed, talk in the language of the idea. The instructions are English so that every tool reads them the same way.
- `.sibersentez/.gitignore` with `*`, only when missing (an existing one is kept).

**Overwrite rule (decision):** nothing is ever overwritten without asking, and nobody is asked either. A file with
exactly the same text is used as it is (not touched). A file with another text (the person edited it, or an older
idea) stays; the message goes to the next free name, `ilk-mesaj-2.md` ... `ilk-mesaj-9.md`, and the prompt names that
file. Every file is created exclusively (`wx`), so one that appears meanwhile is compared, never replaced. When all
nine names hold other texts: `first-message-busy`. A `.sibersentez` that is a file, a link or a junction blocks
(`first-message-blocked`): nothing is written through a link. Reasoning: a confirmation step would make the one-click
start two clicks for a case that is rare and harmless to keep, and deleting old files is the person's call.

The reply lists what was written (`result.written`: `.sibersentez/`, `.sibersentez/.gitignore`, `.sibersentez/ilk-mesaj.md`)
and the file the tool reads (`firstMessage: { file, op: 'create' | 'same', gitignore }`); the notice says it.

### Replies

| Case | Status | Body |
|---|---|---|
| Preview | 200 | `argv`, `fallbackArgv`, `launcher: { mode, text }`, `firstMessage` (planned), `about` (tool name, kind, version, sign-in), `result: { executed: false, written: [] }` |
| Started in Windows Terminal | 200 | `terminal: 'wt'`, `argv`, `firstMessage`, `restorePoint`, `result: { executed: true, written }` |
| Started in Command Prompt | 200 | `terminal: 'cmd'`, `fallbackReason: 'terminal-missing' \| 'terminal-failed'` |
| Tool not installed | 409 | `tool-missing` |
| Path cannot be put in the launcher or on wt's line | 409 | `tool-path-unsafe`, `folder-path-unsafe`, `launch-path-unsafe` |
| First message | 409 / 500 | `first-message-blocked`, `first-message-busy`, `first-message-failed` |
| Launcher | 500 | `launcher-failed` |
| Start | 500 / 501 / 404 | `app-folder-missing`, `no-terminal`, `launch-failed`, `folder-missing` (with `written`) |

`restorePoint` (every live start): `{ id, reused }`, `{ problem }` or null, the copy of the project taken before the
tool starts (docs/restore.md); it never stops the start.
| Detection | 500 | `detection-failed` |

Log notes: `dry`, `live`, `fallback`, `tool-missing`, `launch-path`, `launcher`, `first-message`, `detection`,
`workdir`, `missing`, `folder`, `launch`. The log names the project id (or a hash for an unregistered folder), never a
path, a tool path or the idea.

## Page

- **Project drawer**, "Then: start with AI" (replaces "Then: open a terminal"): one button per installed tool ("Start
  with Claude Code", the first one primary), "Start with my idea (first message ready)" when the project has a saved
  idea (on by default, remembered per project in this browser), a note for tools that will ask to sign in, the plain
  terminal, and "Change actions" while Off or Preview. While tools are looked for, a line says so; with none, "Install
  an AI tool" opens the tools panel. "AI tools on this computer" and "Check again" are always there. The buttons send
  through the context menu's model, so the drawer and the menu send the same request.
- **Context menu** (project and session): "Start with <tool>" per installed tool before "Open terminal". The menu
  asks for the tools when it opens; while they are being looked for (or none is installed) one item "Start with AI…"
  opens the project drawer at the section.
- **Tools panel** (`public/js/views/tools.js`, a modal dialog; from the drawer and the start card): installed tools
  first with version, install kind and sign-in state, a warning for several installs, the Codex app note; the others
  with the official commands and a copy button, the account, the Node.js need and the execution-policy tip, and a link
  to the official guide. "The first time a tool opens in a folder, it asks whether you trust the folder and asks you to
  sign in." Esc, the close button or a click outside closes it; Tab stays inside.
- **Getting-started card:** step 3 reads "Pick an AI tool; SiberSentez starts it with your idea"; an "AI tools" button
  opens the panel.
- Texts: `public/js/strings/ai-start.js` (en, tr); styles: `public/css/ai-start.css`.
- QA hooks (`?qa=1`): `&aistart=1` scrolls the open drawer to the section, `&aitools=1` opens the panel;
  `&menu=project:<id>&pick=start-ai:<tool>` runs a start in Preview mode.

## Tests

`test/ai-start.test.mjs`: the search folders, installs and their kind, versions, the `.cmd` command line, the
detector with a fake spawn (several installs, hidden windows, no input, the sign-in exit code with output not read, a
check that never ends, the cache and the throttle), `publicTools` and `GET /api/tools` (no path, no e-mail); the
prompt, the tools' start arguments, launcher paths and text, the launcher folder choice, the command lines; writing the
first message (create, same, never overwrite, a file or a junction in place of `.sibersentez`, nine names taken); old
launchers; `start-ai` over HTTP (preview writes and starts nothing, no idea text on any command line or in the
launcher, live writes and starts, without the idea nothing is written, every refusal, a session, relative mode, the
Command Prompt fallback, Off); the page's state, menu items, notices, error texts, the drawer section, the panel and
the start card. Existing tests follow the new action (`start-ai` in the action lists, the start card's step 3, the
section's texts). No test starts a real program.

Mutations that turn tests red: the idea used without `withIdea`; an existing first message overwritten; the tool's
path in `publicTools`; a launcher folder with a space treated as absolute; the sign-in output captured; any character
allowed in launcher paths; a tool that is not installed accepted; the launcher's first line
(`NoDefaultCurrentDirectoryInExePath`) left out.

## Check by hand (not covered by automated tests)

1. Actions On, a project with a saved idea, "Start with Claude Code": a Windows Terminal tab opens in the project
   folder, Claude Code starts and reads `.sibersentez/ilk-mesaj.md`, answers in Turkish for a Turkish idea, asks one
   question at a time. The tab keeps the project's name.
2. The same with Gemini CLI (npm, `-i`): it starts interactively, not one-shot; the first run asks to sign in.
3. The first run of a tool in a new folder: the trust question and the sign-in appear and can be answered.
4. After the tool ends, the shell stays open in the project folder with a visible prompt.
5. Windows Terminal's app execution alias switched off: a Command Prompt window opens instead and does the same.
6. A Windows account whose user folder has a space or a Turkish letter: relative mode (the launcher changes to the
   project folder first).
7. `.sibersentez/ilk-mesaj.md` edited by hand, start again: the edit stays, `ilk-mesaj-2.md` is written and read.
8. Install a tool while SiberSentez runs, press "Check again": it appears without restarting SiberSentez.

## Open

- Tools whose sign-in cannot be checked show "not known".
- A project folder that is not plain ASCII (for example `D:\Oyun Çalışması`) cannot be started in Windows Terminal in
  relative mode; SiberSentez's own terminal (the default) and absolute mode (the usual case) have no such limit. The
  plain terminal always works.
- The panel lists the seven tools above; a tool added later needs an entry in `server/tools.mjs` and
  `public/js/views/tools.js`.
- Cursor's command is also looked for under the generic name `agent`; another program with that name would be taken
  for Cursor CLI (only its `--version` runs, hidden).
- When a version or sign-in check times out, the whole process tree is ended: `%SystemRoot%\System32\taskkill.exe
  /T /F /PID <pid>` by absolute path, hidden, without a shell (`server/tools.mjs` `killTree`). `child.kill()` alone
  would end only `cmd.exe` and leave the Node.js process of an npm shim running. If taskkill cannot start, the
  process itself is ended as before.

## Resume in the dock

`start-ai` with `resume: true` continues a closed Claude Code session: the same checked launcher, with
`--resume <session id>` as the tool's arguments instead of the first-message prompt (the id is a UUID, quoted like
the prompt). Never with an idea (`bad-field`), never for an open session (`409 session-live`: its copy, fork, still
goes to Windows Terminal). Since 2026-10-07 every tool's session continues with its own tool and its own resume
arguments (`docs/tool-view.md`); only Windows Terminal's continue and the copy stay Claude Code's
(`400 resume-claude-only`). The session menu and the session drawer use it when the desktop app has the terminal
dock and it has room: "Resume Claude Code session" continues in the dock, "Resume in Windows Terminal" is the second
item (the `resume` action as before). Without the dock, or with a full one, nothing changes.

## The setup wizard (roadmap F2, 2026-10-08)

Someone who never used a terminal gets an AI tool ready in four steps, inside the AI tools panel
(`public/js/views/setupWizard.js`, wired in `views/tools.js`): **what it needs** (Git for Windows for Claude Code,
which runs its commands through Git Bash; Node.js for a tool whose only install command is npm's), **install**,
**sign in**, **ready**. It opens by itself while no tool is installed; otherwise "Step by step" in the panel opens it,
"All tools" leaves it. The first screen lists the seven tools with the account each one needs; Claude Code is marked as
the one that works best with SiberSentez, Gemini CLI as one that can start free.

The commands are the tools' own (the panel's install commands; the prerequisites through winget; the sign-in lines
checked on each tool's `--help`: `claude auth login`, `codex login`, `copilot login`, `cursor-agent login` (or
`agent login`, the name found), `opencode auth login`; Gemini CLI and Qwen Code ask how to sign in when they open).
SiberSentez never runs them: with actions On, "Type in terminal" writes one into the setup terminal without Enter;
otherwise the person copies it into PowerShell. While a step waits for an install or a sign-in, the tools are asked
again every 15 s, so the wizard goes on by itself; "Check again" does it at once. "Use it and start a project" makes the
tool the one jobs start with and opens the New project window.

**Sign-in states.** Claude Code and Codex answer with an exit code (`auth status`, `login status`). Cursor's `status`
answers 0 either way, so its words decide ("Logged in as"), and the output is dropped at once. Gemini CLI, Qwen Code and
OpenCode have no such command; `server/tools.mjs` `fileReady` reads their own settings for the sign-in type they chose,
whether their credentials file exists, and whether the variable their key comes from is set. Only names of fields and
whether a file or a variable exists are looked at; no key, token or account name is read into an answer. GitHub
Copilot CLI keeps its sign-in in the Windows credential store: its state stays "not known", and the wizard's last step
offers its sign-in line and "I signed in". The page gets the command's name (`cmd`, no folder) for the sign-in line.
