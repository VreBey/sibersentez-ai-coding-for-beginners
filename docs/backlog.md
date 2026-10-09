# Backlog

Open items that are known but not scheduled yet. Newest first. Each item names where it was found.

## The workshop building (docs/hq.md)

Until 2026-10-09 the look was designed by the user with ChatGPT/Codex; since then it is designed here (docs/theme.md).

- **Working in the same folder** (hq, 2026-09-30). ChatGPT/Codex changed the repository folder itself while this side
  was committing, and its files went into an unrelated commit. From then until 2026-10-09 the designs came as a package
  (qa/chatgpt-tasarim/<step>/), merged here and brought to the project's rules (theme tokens, string table, readable
  code, tests); the workshop of 2026-10-01 came that way. Another tool may still work in the same folder: check
  `git status` before a commit.
- **The seats follow the drawing** (hq, 2026-10-01). FLOORS, ROOMS, LIFT_BOX and DOOR_XS in hq-scene.js hold pixel
  positions in hq-tower.png; a new drawing needs new numbers.
- **No quota source** (hq, 2026-10-01). The design has a 5-hour and weekly quota panel; Claude Code's logs do not carry
  it, so the snapshot's quota is always null and the panel stays hidden. A source would be a small read-only probe
  (asking Claude Code for its usage); not tried.
- **The rewind before the app started is rebuilt, roughly** (hq, 2026-10-01, done the same day). `pastSnapshots`
  (hq-live.js) rebuilds a project's last 15 minutes from its tool calls, prompts and agents when the Building first
  shows it. What the logs cannot say stays out: nobody is shown waiting for the person, tools and workflows are left
  out, a session at rest after 45 s without an act and gone after 5 minutes.

## Long-running load (audit and soak test, 2026-09-30)

Fixed in the same round: the tools/checklist recursion (five minutes after start), the NaN re-arm of the draw on
Today and Settings, rows of hidden screens kept alive by their CSS animations, a failed tools refresh asked again on
every draw, the renderer reloading without end after a crash, a frozen SSE client growing the server's buffer, a
throwing timer ending the server, late output of closed terminal tabs, snapshot retries twice a second.

Fixed on 2026-09-30 (direction §3.5): the terminal batches pty output per 32 ms window, keeps its buffer as chunks and
pauses the pty above 128 KB waiting (electron/terminals.mjs); PowerShell backs off 10 -> 60 -> 300 s (server/live.mjs);
/fit reads the library's signature at most every 5 s (fit.mjs `LIBRARY_SIG_MS`); the minute's catalog reload reads the
projects only and the roster scan (about 0.5 s of synchronous work on a full machine, measured) runs every fifth
minute, at once after an action (index.mjs `ROSTER_EVERY`); "What changed" keeps one answer per project for 10 s
(changes.mjs `createChangesCache`); a closed live stream is opened again after 1, 2, 5, 10, then 30 s (main.js,
layout.js `reconnectDelay`); the scene caps its effects while hidden (stage.js `capEffects`); store.js no longer
spreads a patch into a call. Still open:

- **(Mostly done 2026-10-06)** The five-minute rescan now runs in steps (`catalog.loadRosterInSteps`, longest pause
  515 ms -> about 60 ms, a tool's plugins read in parts, docs/development-review-2026-10-06.md §5); an action still
  rescans in one piece. Before:
- **The roster scan is still synchronous** (catalog.mjs `loadRoster`): now once in five minutes instead of every
  minute. A worker thread or an async scan would take it off the loop for good. Measured 2026-10-01 on the owner's machine (2,447 items):
  the projects reload 0.4 s a minute, the roster scan 0.5 s (1.1 s cold) every five minutes; left as it is for now,
  since a worker would split the catalog's state in two for a half-second pause.
- **Smaller**: ended terminal tabs stay until closed, 5000 lines each; ad-hoc folder projects are never forgotten
  (catalog.mjs `adhoc`).

## Usage and cost

- **A moved project folder splits its history into two projects** (usage, 2026-09-29, real machine). A project's id
  follows its folder, so a project moved to another folder (seen: a Unity project moved from the Desktop to another
  drive) is listed twice under the same name: the old folder keeps the usage, sessions and memory from before the
  move, the new one starts empty, and each drawer shows only its part of the 30 days. Decide how to join them: follow
  a move automatically (same git remote, same name and tool records), or let the person merge two projects (the
  ledger would then book the old id's hours under the new one).
- **Rolling periods have hour precision** (usage, 2026-09-29). The ledger's unit is one UTC hour, so "24 hours" is the
  current hour and the 23 before it (23 to 24 hours of data depending on the minute), "7 days" and "30 days" alike;
  in a time zone with a half-hour offset a local day boundary falls inside an hour, which is booked on the day it
  starts in (`docs/usage.md` §3). Decide whether the label should say so ("since 14:00 yesterday") or the ledger
  should keep finer buckets for the last day.

## Start with AI

- **Sign-in state unknown for five tools** (ai-start, 2026-09-29). Gemini CLI, GitHub Copilot CLI, Cursor CLI, Qwen
  Code and OpenCode have no documented status command whose exit code says "signed in"; the panel says "Sign-in not
  known" and the tool asks when it opens. Find a safe check per tool (a command with an exit code, never a credential
  file) or keep "not known".
- **Relative mode and a project folder outside ASCII** (ai-start, 2026-09-29). When neither launcher folder can go on
  Windows Terminal's command line as it is (a user folder with a space or a Turkish letter), the launcher changes into
  the project folder itself, and that path must be expressible in ASCII: `D:\Oyun Çalışması` is refused
  (`folder-path-unsafe`; the plain terminal still works). Since 2026-10-01 SiberSentez's own terminal (the default)
  starts such a folder directly (docs/ai-start.md); only Windows Terminal still refuses it. Options there: a launcher
  folder outside the user folder, or a UTF-8 launcher (`chcp 65001`) tested on real consoles.
- **Check by hand on the user's machine** (ai-start, 2026-09-29). Not covered by the automated tests: a real start in
  Windows Terminal (Claude Code, Gemini CLI with `-i`), the trust and sign-in questions of a first run, the shell that
  stays open after the tool ends, the Command Prompt fallback with Windows Terminal's alias off, a user folder with a
  space or a Turkish letter (relative mode), an edited `.sibersentez/ilk-mesaj.md` (then `ilk-mesaj-2.md`), a tool
  installed while SiberSentez runs ("Check again"). Steps: `docs/ai-start.md`, "Check by hand".

## GitHub import

- **Git fallback measures the folder once a second** (review round 2, advisory). While git downloads, the folder
  size is measured every second (`TIMEOUTS.watchMs`), so one very compressible blob can write far past the limit before
  the process tree is ended, and a repository could steer the download to git with a broken archive (`tar-corrupt` is
  in `TAR_FALLBACK`). Clone with `--no-checkout`, check `git ls-tree -r -l HEAD` sizes against the limits, then check
  out. `tar-corrupt` was dropped from the fallback list on 2026-10-01, so a broken archive no longer steers the
  download to git; a network failure still does. The measuring (`measureTree`) also holds the event loop.
- **Private repositories** (github-import, 2026-09-29). Only public repositories can be fetched; a private one answers
  `not-public` and no credential is asked for, stored or sent. Supporting them needs a token kept by Windows (Credential
  Manager, or the `gh` CLI's login) and a decision on what SiberSentez may keep.
- **A branch with `/` in its name** (github-import, 2026-09-29). A link `/tree/<a>/<b>` is read as branch `a`, folder
  `b`, so `feature/x` cannot be named in a link. Resolve it with `git ls-remote` or the API (longest branch name that
  exists first).
- **No proxy on the archive path** (github-import, 2026-09-29). Without git, the download uses Node's `https.get`
  without an agent: `HTTPS_PROXY` and the Windows proxy settings are not used, and behind a proxy the fetch fails with
  `network`. git uses its own settings. The error text names the proxy since 2026-10-01; proxy support itself is still open.

## Discovery and projects

- **Same-named plugins of different tools merge** (adapters wave 1). The roster key is `kind:name`, so a Claude
  Code plugin and a Codex plugin with the same name become one item that carries the Claude plugin id.
- **Second wave of tools**: Cline, Antigravity CLI conversations, OpenCode, Crush, Qwen Code, Goose, Kiro (SQLite
  readers opened read-only on a copy), Windsurf and Amp when their local traces are documented. Research copy:
  `qa/ai-tool-research.md` (local only). (Start with AI already finds and starts Qwen Code and OpenCode; their
  projects and skills are still not read.)
- **Ambiguous log folder names are dropped silently** (round 2, nit). When a Claude Code log folder name resolves
  to two existing folders (`a b` and `a-b`), no project is listed and nothing tells the user. Surface it (for
  example a diagnostics list) instead of dropping it.
- **Claude Code built-in skills show as "other"** (round 2, nit). Skills seen in session logs that are neither in
  the roster nor in a plugin get the source `other`; Claude Code's own built-in skills should be `builtin`, like
  its built-in agent types.

## Actions

- ~~**Folders that are not projects / broad folders as project cards.**~~ Done 2026-09-29: `place` (broad, temp,
  chat) from the server; such folders sit in a folded "Other folders" group, out of the count and the scenes' places
  unless something is open in them (`docs/folders.md`). `AppData\Local\Programs` was already broad.
- ~~**Tool detection and Off's promise.**~~ Done 2026-09-29: Off now reads "SiberSentez only watches and runs no action (it still spots installed AI tools)."; tool detection stays in every mode.
- ~~**Import date in the roster's origin.**~~ Done 2026-09-29: `originOf` sends `importedAt`, the drawer shows the day.
- ~~**AI-agnostic actions.**~~ Done 2026-09-29: the context menu opens a plain terminal in the project or session
  folder ("Open terminal", `docs/terminal.md`) and the user starts the AI tool of their choice; resume and fork say
  "Claude Code" in their labels. Since then "Start with AI" (`docs/ai-start.md`) also starts the chosen tool itself,
  with the project's idea as its first message.

## Skills and the kit

- **YAML comment lines in kit agents** (kit, 2026-09-29). Each kit agent carries its license notice as two comment
  lines at the top of its frontmatter. SiberSentez's reader and Claude Code skip them; confirm that GitHub Copilot and
  Cursor read such an agent (and ignore `license` / `metadata`) before release.
- **The same name in two library categories** (kit and roster folders, 2026-09-29). The roster keys items by
  `kind:name`, so a skill with the same name in two library categories is one row with one category, and installs go
  by name. Decide: refuse the second on import, or show both with their folder.
- **The kit waits for the log scan** (packaged QA, 2026-10-09). The roster (kit included) is read only after the first
  log scan (`server/index.mjs`, since 2026-10-02 for a faster first answer). On a computer with many logs that took
  12 s, and the Helpers screen showed no kit until then; the QA probe now waits for it. The kit is static: it could be
  in the first snapshot.

## Localization and text

- Done 2026-09-30: the fixed texts the server writes in English (events, project notes, the home folder's name, the
  built-in agents' descriptions) are shown in the page's language (format.js, store.js `localProject`);
  `test/i18n-server.test.mjs` fails when the server writes a text the page does not know.

## Business

- **Confirmed 2026-10-08: the GPL stays.** The owner: "stay on GPL 3". A move back to the SiberSentez License 1.0
  made the same morning on a misread answer was reverted the same day; nothing of it was published.
- **Decided 2026-10-06: open source, free app, donations.** From the next version the app is under the GNU GPL
  version 3 or later (`LICENSE`) and the kit under the MIT License (`kit/LICENSE.md`); the name and the logo are kept by
  the project (`TRADEMARKS.md`). The source goes to the public GitHub repository. Why: donations go mostly to open
  source projects, the open source funds (Open Source Collective, FLOSS/fund) need an OSI license, and a beginner can trust a program whose source anyone can read.
  Development is supported by GitHub Sponsors (Settings → Help, `sibersentez.com/destek`). Replaces the closed source
  decision below.
- **(Replaced) Decided 2026-10-05: closed source, free app.** From 0.14.0 SiberSentez and its kit are under the SiberSentez
  License 1.0 (`LICENSE`, Turkish binding text with an English translation): free to install and use for any work;
  copying, changing, distributing, selling and reverse engineering are not allowed; kit items copied into a project
  may be used and changed there. The source stays with the owner; the public GitHub repository holds only the README,
  screenshots, the licence, the security policy, issue forms and the releases. The site source (`site/`) is kept on the
  owner's computer only. Replaces the PolyForm Shield decision below for new versions.
- **Decided 2026-10-01: free for everyone, no subscription.** SiberSentez and its kit are licensed under the PolyForm
  Shield License 1.0.0 (free to use, change and share; nobody may sell it or offer it as their own product), and
  development is supported by donations on GitHub Sponsors (Settings → Help, `sibersentez.com/destek`). The earlier
  subscription plan (Paddle or Polar with Keygen) is dropped. Open: the website on `sibersentez.com` (introduction,
  `/destek` forwarding to GitHub Sponsors, download, licence and contact), after the Sponsors profile is approved.

## Installer

- ~~**Installer not executed end to end for a current version**~~ (round 2, B1). **Done 2026-10-08:** in Windows
  Sandbox, 0.16.0 installed and opened, 0.17.0 installed over it and opened, then uninstalled with the hub kept
  (docs/evidence-2026-10-08.md, "A clean Windows"). It is now step 5 of every release (docs/release.md).
- **Update from 0.2.0 to the next version, by hand** (usage, GitHub and Start with AI round, 2026-09-29). The next
  installer run over an installed 0.2.0: the old version moved aside and removed, the hub kept (with the new
  `usage\`, `incoming\`, `launch\` and `registry\sources.json` appearing next to the old files), the actions mode and
  **Start at login** kept, the first start counting the usage of the last 32 days. Only build-level evidence so far;
  needs a manual run on the user's machine.

- **Uninstaller limits** (uninstaller fix `65b7b21`). Fixed after security review round 1: the running app is
  closed only after the folder is pinned (the installer checks it again, together with `InstallLocation`), only
  processes whose exe lies inside the program folder are closed (the folder reaches PowerShell through an
  environment variable; nothing is closed by name), and removal never enters a junction or symbolic link (a program
  folder that is itself a link is refused). Fixed after round 2: the installer also checks `UninstallString`, which
  electron-builder uses for the old uninstaller's `_?=` when `InstallLocation` is empty; during an update the old
  version is first moved into a staging folder inside the program folder and put back if anything is in use, so a
  file in use no longer leaves it half removed; a failed old uninstaller stops a silent update without a message box
  waiting for a click; every PowerShell starts with `-NoProfile -NonInteractive`. Still open:
  - When the program folder has no uninstaller or the install location key is gone, the uninstaller refuses and the
    "Apps" entry must be removed by hand.
  - Installer and uninstaller accept only `%LOCALAPPDATA%\Programs\SiberSentez`; machines with a redirected
    `FOLDERID_UserProgramFiles` cannot install (accept `UserProgramFiles\SiberSentez` on both sides if this shows up).
  - An uninstaller built before this fix still runs electron-builder's own check when a newer installer updates it.
    The newer installer runs it only when `InstallLocation` (if set) is the program folder and `UninstallString` (if
    set) starts with the program folder's `Uninstall SiberSentez.exe` in quotes, so the old uninstaller that runs is
    that file and its `_?=` is always the program folder, whichever of the two values electron-builder takes it from.
  - A file that can be moved but not deleted during an update (an exe still running from the folder) stays in
    `~sibersentez-old-<process id>` inside the program folder until the next update or the uninstall; the update goes on.
  - `--delete-app-data` still removes `%APPDATA%\SiberSentez` with electron-builder's `RMDir /r`.
  - Without a working Windows PowerShell the app is not closed automatically: the user is asked to close it.
- **Adversarial uninstaller check on a real install**: steps kept locally in `qa/kaldirici-elle-test.md`.

## QA

- **Hidden QA run needs a screenshot trick** (shell QA, 2026-09-29). A window that is never shown paints its first
  page by itself (`paintWhenInitiallyHidden`), but after later navigations `capturePage` returned an old frame; the
  QA capture now takes a first capture (which makes the page visible to its renderer), waits and takes a second one.
  If a future Electron changes the capturer count, the panel screenshot of `tools\electron-qa.ps1` may go stale again
  (the probes themselves read the DOM and are not affected).

## Localization (Phase 0.5)

- Done (part B, 2026-09-29): the page shell (`index.html`, `main.js`, the drawer, the context menu) reads its texts
  from `public/js/strings/shell.js`; the action layer and the read routes send English error codes
  (`server/actions.mjs`, `server/app.mjs`), which the page turns into text with `err_<code>` (unknown code: a general
  text with the code in it); comments in those files are English.
- Still open: the server-made data texts listed above; the views outside the two passes (feed, timeline, project
  cards, roster rows) print server texts as they are; rename the Turkish-named test files and `docs/phase0-contract.md`.

## Before publishing

- Fresh git history and a noreply author: the current history carries personal data.
