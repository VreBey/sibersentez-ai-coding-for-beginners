# Windows, Linux and macOS (plan G, 2026-10-09)

SiberSentez was built on Windows. Plan G made the code ready for Linux and, experimentally, macOS; since 0.18.0 the
Linux AppImage is released next to the Windows installer. This page says what differs, where the rules live, and what has really been tried.

## Status

| | Windows 10/11 | Linux | macOS |
|---|---|---|---|
| Released | yes (installer) | yes, since 0.18.0 (AppImage; tried on Ubuntu in WSL, below) | no: experimental, CI only (the owner has no Mac) |
| Package | NSIS installer | AppImage (x64) | dmg (arm64, x64), unsigned |
| AI tool starts in | SiberSentez's own terminal, or Windows Terminal | SiberSentez's own terminal only | SiberSentez's own terminal only |

## One place for the differences: `server/platform.mjs`

Every module asks `platform.mjs` instead of testing `process.platform` itself, and takes the platform as a parameter,
so the tests try all three on any computer (`test/platform*.test.mjs`).

- Paths: Windows' rules on Windows, POSIX' elsewhere; PATH split by `;` or `:`; letter case ignored on Windows and
  macOS. A local absolute path is a drive letter on Windows, one leading `/` elsewhere (never a network path).
- Folders: the home folder (`USERPROFILE`, `HOME`); where SiberSentez keeps its own files (`%LOCALAPPDATA%`,
  `$XDG_DATA_HOME` or `~/.local/share`, `~/Library/Application Support`); where desktop programs keep their settings
  (VS Code-style editors' workspaces: `%APPDATA%`, `~/.config`, `~/Library/Application Support`).
- The system's own folders are never projects: Windows' System32; on Linux and macOS every top folder and the system
  folders below `/usr`, `/etc`, `/lib`... (`/srv/site`, `/opt/app`, `/var/www` can be projects).
- Commands: where installers put an AI tool (`~/.local/bin`, `~/.npm-global/bin`, Homebrew, `/usr/local/bin`); a
  command is a plain executable file there (no `.exe`, `.cmd`); git by its full path from PATH.

## Starting an AI tool on Linux and macOS

No Windows Terminal: a tool starts in SiberSentez's own terminal only. The server writes a small sh launcher
(`<id>.sh`, `server/launch.mjs shellLauncherText`) and the terminal runs `/bin/sh <launcher>` in the project folder:
every path single-quoted (a quote or a Turkish letter in a folder name stays text), the "tool ended" mark taken before
any `cd`, and after the tool the person's own login shell. A start without SiberSentez's terminal (a plain browser)
answers `no-terminal`; Windows Terminal's actions (continue or copy a Claude Code session there, a plain tab) answer
`windows-terminal-only`, and the menus do not offer them.

The embedded terminal's shell is the person's login shell (`$SHELL` when it is a known shell, else `/bin/bash`).
"Open folder" uses `xdg-open` (Linux) or `open` (macOS); VS Code is looked for in its usual places.

## The desktop shell

- Start at login: Electron's login items on Windows and macOS; on Linux a `.desktop` file in `~/.config/autostart`
  (`electron/autostart.mjs`; an AppImage starts from its own file).
- Waiting sessions: the taskbar's overlay dot on Windows; the app icon's count (`app.setBadgeCount`) elsewhere.
- node-pty: Windows and macOS use its prebuilt binaries; Linux has none, so node-pty is built from source when
  `npm ci` runs on Linux (a compiler, `make` and Python are needed there). Each platform's package keeps only its own
  binary.

## What the person is told to run (plan G4)

The server names its platform in `GET /api/tools`; the tools panel, the setup wizard and the setup check show that
platform's commands. Each tool's Linux and macOS commands come from its own docs (checked 2026-10-09): Claude Code,
Codex CLI, Copilot CLI, Cursor CLI, Qwen Code and OpenCode have an official install script; Homebrew on macOS; npm
where the tool offers it. Git for Windows is a wizard step on Windows only; Node.js comes from nvm on Linux (its
README's line, then `nvm install 24`) and from Homebrew on macOS (`brew install node`: Homebrew's formula, not checked
on a Mac). Texts that name PowerShell or the Start menu have a `_unix` twin (`tOs`).

## Tried on Linux (2026-10-09)

On Ubuntu 26.04 in WSL 2 (WSLg for the window), Node.js 24.18.0, node-pty built from source by `npm ci`:

- The whole test suite: 1361 tests, 1245 pass, 116 skipped (written with Windows' own paths: `test/lib/winonly.mjs`),
  none fails; type check and lint clean. The first run found real faults, fixed: start-ai and the app terminal's plain
  shell refused by Windows Terminal's rule, project folders and the library source taken as drive-letter paths only,
  the temp and program folders of Linux not known, change lists with backslashes, and a set-aside ledger copy pruned out
  of order under a coarse file clock (Windows too, rarely).
- An AI tool started end to end in a real pseudo terminal (`test/platform-e2e.test.mjs`): a folder with a quote and
  Turkish letters, the whole prompt as one argument, the first message written, the "tool ended" mark.
- The packaged AppImage (137 MB) in hidden QA mode (`tools/linux-qa.sh`): server, window, bridge, kit, a project
  added, the actions mode, the keyboard, the embedded terminal: every check passes.
- WSL only: Windows' PATH folders (`/mnt/c/...`) are not searched for tools (a Windows Gemini CLI found there ran on
  Windows when asked its version).
- Used by hand in the visible window, as a person would (WSLg, a fresh hub): the example Building, Turkish, the light
  theme, "Create" a new project, actions On, the setup wizard writing Claude Code's official install command into
  the app terminal, the install run there and the tool found at once in `~/.local/bin` (not in PATH yet: the setup
  check says so and offers the line). It found four faults, fixed: "Create" refused its own folder in a home without
  XDG user folders (Electron answers the home as Documents, and `~/SiberSentez` is the hub: now `~/Documents`); the
  fonts were Windows' only, so DejaVu Sans pushed the side bar's subtitle out (now Ubuntu, Cantarell, Noto Sans,
  system-ui after Segoe UI); the licence paths showed `resources\`; the actions texts and the folder menu said
  Explorer. Then the owner typed `claude` in the app terminal and got "command not found": the native installer
  leaves `~/.local/bin` out of PATH until the next login. The app's terminals now get the installers' folders after
  their PATH (`withToolDirs` in `electron/terminals.mjs`, the same folders the tool search uses), so a tool installed
  from the app runs by name there at once, on Windows too.
- A real job end to end on Linux, signed in (Claude Code 2.1.295, Opus 5.5): Start, the plan asked and approved, a
  builder and a reviewer at work in the Building, APPROVE, the result card, accepted in the terminal. It found three
  more faults, fixed, none of them Linux's own: the agents of Claude Code 2.1.29x end by handing their work back
  (`SubagentHandback`, its result marked `toolEndsTurn`) with no `end_turn`, so finished agents counted as working
  for ten minutes and then as stopped, never done (`server/ingest.mjs`); its "permission prompt" wait reason showed
  in English; and "Open the result" selected the lead's card below the fold, under the terminal, so it seemed to do
  nothing (now scrolled into sight, its first action focused).

Not tried yet: a real Linux desktop (GNOME, KDE) with its tray, notifications and "start at login"; a real AI tool
signed in on Linux.

## Known limits

- Project paths are compared without letter case on Windows and macOS only (`normPath`, `pathKeyOn`; review
  2026-10-09 F01): on Linux `work/App` and `work/app` are two projects. Their ids still come from the lower-cased
  folder name, so every id stored before stays the same; of two such folders the one the project memory saw first
  keeps the plain id, the other gets a short digest after it. A record that merged two such folders before (memory,
  usage, restore points, installs) stays the first folder's and is not split. Not covered: a case-insensitive drive
  mounted on Linux (a USB stick, `/mnt/c`) and a case-sensitive volume on a Mac follow the platform rule, not the
  drive (restore points ask the drive itself, `fsutil.mjs` `caselessAt`); turning a Claude Code log folder's name back
  into a path (`resolveSlug`) still ignores case, so `App` next to `app` is ambiguous there and left to the session's
  own working folder.
- The live-session check compares process start times on Windows only; elsewhere "is the process alive" alone.
- `.deb` and `.rpm` packages are not built (an AppImage needs no install); a maintainer address would be needed.
- macOS: never run on a Mac. Unsigned, so Gatekeeper refuses it unless the person allows it.
