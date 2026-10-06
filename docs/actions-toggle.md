# Actions on/off in the installed app — contract

Status: agreed 2026-09-28 (user decision: the actions built in the earlier experiment ship in the product, off by
default, and the user can switch them on in the app; the personal panel on port 4545 is not touched). Updated
2026-09-29: the mode is switched in a panel inside the window, without a native chooser (§3b).

## 1. Today

- The action layer (`server/actions.mjs`, `public/js/actions.js`, `public/js/contextmenu.js`) has three modes:
  `off`, `dry` (the command is only shown), `live` (it runs: new/resume/fork Claude session, open folder, open in
  VS Code, preview and install skills from the library into a project).
- The mode is read once at server start (`config.mjs`: env `SIBERSENTEZ_ACTIONS` > `sibersentez.json` `actions` > off).
- The installed app strips `SIBERSENTEZ_ACTIONS` from the environment (`electron/helpers.mjs`, `STRIPPED_ENV`), so the
  mode is always `off` there and nothing in the app can change it.

## 2. Goal

The user can choose Off / Preview / On in the installed app. The choice survives restarts. A web page open in the
user's browser can never change it.

Scope of the guarantee (security review round 1): the confirmation for On protects the user from a slip, it is not
a security boundary. Any program running as the same user can edit `settings.json` or point `SIBERSENTEZ_HUB` at
another hub. The shell therefore checks on every server start whether actions are On without having been set by
itself, and warns once per such change (tray balloon and window dialog; the tray is refreshed at the same time).

## 3. Design

1. **Storage.** `<hub>/settings.json` gains `"actions": "off" | "dry" | "live"`. Missing or unknown value → `off`.
   The key is not added to the skeleton written by `initHub` (absent means off).
2. **Server.** `config.mjs` order becomes: env `SIBERSENTEZ_ACTIONS` > `sibersentez.json` `actions` > hub `settings.json`
   `actions` > `off`. The installed app keeps stripping `SIBERSENTEZ_ACTIONS`, so there only `settings.json` counts.
   The server never writes `settings.json` and gets **no new HTTP endpoint** for the mode.
3. **Who changes it: the app shell only.**
   - Tray menu: a submenu with three radio items (Off / Preview: commands are only shown / On).
   - Choosing On asks for a confirmation that says what On does (opens a terminal in the project folder, resumes
     Claude Code sessions, opens folders in Explorer and VS Code, installs skills and agents into project folders).
     Cancel keeps the previous mode. Since §3b the question is asked inside the window's panel whenever the window can
     show it; the native dialog is left for a tray click while no window shows the panel.
   - The shell writes `settings.json` atomically (temporary file + rename) and keeps every other key. If the file
     cannot be parsed, it is not overwritten: it is kept aside, byte for byte, as `settings.json.broken` (then
     `.broken-2` ...) and a new `settings.json` is written, the way the hub's other broken files are kept aside. A file
     that cannot be read at all (a folder, no access) is left alone: the shell shows an error and the mode stays.
   - Then the server takes the new mode in place (§3.5). Only when it cannot does the shell restart the server
     process; a restart asked for by the shell does not count as a failure in the supervisor's backoff, and the window
     reloads once the new server is ready.
3a. **Discoverability (user feedback 2026-09-28: "I could not find where to switch actions on"; Windows 11 hides
   new tray icons).** *The native chooser of this section is superseded by §3b (2026-09-29); the window menu stays.*
   The same chooser is also reachable from inside the window, still owned by the shell:
   - The window menu (shown with Alt) gets an **Actions** submenu with the same three radio items and the same
     confirmation for On.
   - Clicking the header indicator opens a **native chooser dialog** (Off / Preview / On / Cancel), then the same
     confirmation for On. No preload or IPC: the page navigates its own window to a fixed same-origin path
     (`/__shell/actions-mode`); the shell's navigation guard recognises exactly that path on the main window while it
     shows the server origin, cancels the navigation and opens the dialog. The page never learns or sets the mode
     this way; it keeps reading `/api/actions`. Any other page, window or origin cannot trigger it; the server
     answers the path with 404 when it is requested directly (outside the app window).
   - The indicator's tooltip and the context-menu hint mention both places (the indicator and the tray).
3b. **In-app switch (user feedback 2026-09-29: "the actions part should open and close inside the app; an extra
   screen opens and we choose there").** In trials the native chooser was dismissed again and again: a separate
   dialog with four buttons and a paragraph of text did not read as "pick one of three". It is removed; the header
   indicator opens a panel inside the page instead.
   - **What the user sees.** Clicking the indicator (mouse, Enter or Space) opens a small panel right under it: the
     title "Actions", one line "What may SiberSentez do on this computer?", and three options, each with one plain line:
     Off "SiberSentez only watches and runs no action (it still spots installed AI tools).", Preview "Shows what each action would do, and
     runs nothing.", On "Actions really happen: opening terminals, installing skills and the like." The stored mode is
     marked "current". The names are the same words as the indicator and the tray (`actionsModeOff|Dry|Live`). Off and
     Preview apply at once. On opens a question under the options (what On does, "Turn on" / "Cancel", Cancel first
     and focused); Off or Preview can still be picked from there. While the shell answers the panel shows "Saving…",
     then "Saved: <mode>. The panel restarts with it in a few seconds." A refused or failed change is shown in the
     panel (busy, `settings.json` invalid, unreadable, not saved, no hub) and the mode stays as it was. A footnote says
     that a change restarts the panel and that the tray has the same choice. The drawer's "Change actions" button
     opens the same panel (`openActionsChooser` still clicks `#actMode`).
   - **"Turn actions on and install" (2026-09-30, docs/direction.md §3.2).** Off in the app, the skills section's
     primary button asks one question in the drawer: the switch's own title and text for On
     (`actionsSwitchConfirmTitle`, `actionsSwitchConfirmBody`) followed by what will be installed. "Yes, turn on and
     install" calls the switch's `turnOn()`: the switch goes from its question straight to saving On through its one
     `bridge.setActionsMode` call, shows it like any change and answers the shell's reply; the drawer waits until the
     page runs in On (the new token), then installs the selection the question named. The drawer never touches the
     bridge (a test pins it), a plain browser and QA get no such button, and a refused write installs nothing and is
     shown. The guarantee stays the same: page code under the same CSP asks the question, as the panel does.
   - **Keyboard and assistive technology.** The panel is a non-modal `role="dialog"` labelled by its title, next to
     the indicator (`aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`). The options are `role="radio"` in a
     `role="radiogroup"`; `aria-checked` marks the stored mode, one option is the tab stop (roving `tabindex`), each
     option is described by its line. Arrow keys, Home and End move the focus between the options and apply nothing;
     Enter, Space or a click applies. (This deviates from the plain radio-group pattern on purpose: applying restarts
     the panel server, so moving must never apply.) Esc goes from the question back to the options, otherwise closes
     the panel and gives the focus back to where it was (the indicator, or the drawer's button). A click outside
     closes it and that click does nothing else; Tab out of the panel closes it. While it is open no key inside it
     reaches the page's shortcuts (tabs 1-4, R, the drawer's Esc). Reduced motion and forced colours are respected.
   - **The bridge: a preload with one function (chosen over extending the reserved path).** `electron/preload.cjs`
     runs sandboxed and context-isolated in the window's top frame only (`nodeIntegrationInSubFrames: false`,
     `window.open` stays denied) and exposes `window.sibersentezShell.setActionsMode(mode)`, nothing else: no listener,
     no send, no way to read the mode. Anything but exactly `off`, `dry`, `live` is refused in the preload. The call
     invokes one IPC channel (`sibersentez:set-actions-mode`); the shell registers one `ipcMain.handle` and honours it only
     when `panelRequest` accepts the sender: the main window's own webContents, its top frame (`senderFrame.parent ===
     null`), and that frame showing the server origin right now (not an error page, nothing while no server is ready).
     Then it takes `chooseActionsMode(mode, 'panel')`, the menus' path. The answer (`panelReply`) is `{ changed, mode,
     reason, code? }` and never carries a path. Why not `/__shell/actions-mode/off|dry|live`: (1) a navigation can be
     started by any link the page shows (session titles, log text and git data are rendered into it); with On no
     longer confirmed natively, one click on such a link would switch actions on, while the IPC function can only be
     called by script running in our own top frame; (2) a navigation carries no answer, so a failed write would need a
     native dialog again; (3) the page no longer guesses from the user agent that it runs in the app: the bridge being
     there is the signal.
   - **The retired path.** `/__shell/actions-mode` opens nothing any more. The navigation guard still cancels exactly
     that navigation (so a stale caller never replaces the panel with the server's 404), and the server still has no
     route for it. The page's old helpers for it (`requestActionsChooser`, `inDesktopShell`, `ACTIONS_CHOOSER_PATH` in
     `public/js/contextmenu.js`) were removed on 2026-09-29.
   - **More functions on the same bridge (2026-09-29, docs/start-flow.md step 2).** The preload now exposes three
     functions, each on its own channel: `setActionsMode(mode)` (`sibersentez:set-actions-mode`), `pickProjectFolder()`
     (`sibersentez:pick-project-folder`, no arguments) and `saveProjectIdea(projectId, text)`
     (`sibersentez:save-project-idea`; a project id and a string of at most 1200 characters, anything else refused in the
     preload). The shell has one `ipcMain.handle` per channel and every one checks the sender first with the same rule,
     `bridgeSender` (main window, top frame, server origin; `panelRequest` is `bridgeSender` plus the mode). Still no
     listener, no send, no way to read the mode or a folder: the new functions answer `{ ok, reason, projectId?,
     existed?, saved? }` (`projectReply`), never a path. They do not depend on the actions mode: they write only the
     program's own project memory (`<hub>/registry/discovered.json`), through the server process's message channel,
     never over HTTP. The tray's **New project…** hands one fixed script to the page (`NEW_PROJECT_SCRIPT`, like
     `PANEL_CONFIRM_LIVE_SCRIPT`), which starts the page's own flow through the bridge.
   - **On from the tray or the window menu.** When the window shows the panel, the shell brings the window up
     (restores, shows and focuses it, also when it was hidden to the tray) and runs one fixed script in the page
     (`PANEL_CONFIRM_LIVE_SCRIPT`): the page's switch opens on the question and answers true. Nothing is written then;
     the mode changes only when the user presses "Turn on" in the panel, through the bridge. When there is no window
     that shows the panel (none yet, an error page), or the page does not answer true within 1.5 s, the native
     confirmation asks as before. The routing is one tested helper (`requestActionsMode`, `liveConfirmation`). QA mode
     never turns actions on on any path.
   - **Errors.** A failed write asked for by the panel is shown in the panel; the native error dialog is left for the
     tray and the window menu.
   - **Scope of the guarantee.** The question for On is now page code: a script running in our own page could call
     `setActionsMode('live')` without showing it. Before, the native dialog was outside the page. This is accepted: the
     confirmation guards against slips (§2), the page comes only from our own origin under `script-src 'self'`, and a
     page in a browser (or any other window or origin) cannot reach the bridge at all. Frames: the preload never runs
     in a subframe (`nodeIntegrationInSubFrames: false`), so a frame has no `sibersentezShell` of its own; the real vector
     would be a child frame of our own origin calling `parent.sibersentezShell.setActionsMode('live')` (same-origin frames
     can reach the parent's globals). That is closed because none of our responses can be framed at all, not even by
     our own page (`X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response), and the shell's navigation
     guard keeps the window on the server origin (`window.open` denied, other navigations cancelled). The shell's
     sender check (`bridgeSender`: top frame only) is a second line behind that. A plain browser (the server started
     with `node server/index.mjs`) has no preload: the indicator explains where the mode is changed, as before, and
     nothing on the page can change it.
   - **The guard of the in-page confirmation is pinned by a test.** Since the question for On is page code, its only
     guards are the page's Content Security Policy and the framing ban. `test/csp.test.mjs` asserts them exactly on the
     page (`/`), a static script and a stylesheet: `script-src 'self'` with no `'unsafe-inline'`, `'unsafe-eval'` or
     `script-src-elem`/`-attr` override, `default-src 'self'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and
     that the page has no inline script or event-handler attribute. Loosening any of these (source:
     `server/app.mjs` `SECURITY_HEADERS`) turns that test red.
   - **After a change.** The server takes the mode in place (§3.5) and the page stays as it is: the panel shows
     "Saved: <mode>. Taking effect…" until the page learns the new mode, then closes. When the shell had to restart
     the server instead, the tab and the open drawer are kept: when the page goes away after a restart (a change from
     the panel, or a live connection that dropped: a change from the tray, a crash), it writes `{ tab, drawer }` to
     this window's `sessionStorage` (`sibersentez.resume`); the next load puts the tab back at once and reopens the drawer
     after the first snapshot, then deletes the record. A manual reload of a healthy page starts fresh.
   - **QA.** `?qa=1&actpanel=choose|confirm|error|saved` opens the panel at that step with a stand-in bridge that
     never reaches the shell or the server.
3.5 **Switching without a restart (2026-09-29).** After the write, the shell asks the running server over the
   server's own message channel (the one `project-add` uses: `process.parentPort` or the fork's ipc, never HTTP) with
   `actions-reload`, a message that names no mode. The server reads the mode again from the same sources as at start
   (`resolveActionModeNow`: environment > `sibersentez.json` > the hub's `settings.json`, the hub it started with) and
   applies it (`actions.setMode`): a new token (the old one is refused with 403, so nothing asked under the old mode
   runs under the new one; the page never re-sends after a 403), the repeat guard starts over, and a live action
   already running finishes under the mode it was accepted in. It answers with the mode it now runs in and sends the
   page an `actions` event that carries only the mode; the page asks `GET /api/actions` again for the mode and the
   token (`initActions`), which redraws the indicator, the menus and an open drawer. The shell counts the change as
   applied only when the answer names the mode it saved (`applyActionsModeLive`); no ready server (none, starting, or
   the window not on it), an older server, a timeout or another mode falls back to the restart above.
4. **In the page (optional, only if it keeps the rules above).** *Superseded by §3b: the page does get a preload, with
   one function that sets the mode after the in-app question.* A small mode indicator in the header. Clicking it
   may ask the shell to open the same native chooser through a preload bridge that exposes exactly one function
   (`requestActionsMode()`, no arguments, returns nothing). The shell honours it only for the main window while it
   shows the server origin. The page never learns or sets the mode through the bridge; it keeps reading
   `/api/actions`.
5. **Context menu when actions are off.** Action items are shown disabled with one line that says how to switch
   actions on (tray menu). Copy and open-detail items keep working as today.
6. **Strings.** New user-facing strings (tray items, dialog, indicator, hint) come from a small string table with
   Turkish and English entries keyed by English ids. The language is `settings.json` `language` when it is `tr` or
   `en`, else the system language (`app.getLocale()` in the shell, `navigator.language` in the page), falling back to
   English. Existing strings are left for Phase 0.5.

## 4. Also in this step

- `test/core.test.mjs` builds `new Catalog()` with defaults in two places. Once the app is installed, the default
  hub (`%USERPROFILE%\SiberSentez`) exists, and a test run could read or rename its `registry/discovered.json`. Make
  them `new Catalog({ hubDir: null, env: {} })`.
- Remove the "actions stay off in this phase" wording in `electron/` comments.

## 5. Tests

- Config order (env > sibersentez.json > settings.json > off), unknown values → off, missing hub → off.
- The shell's settings writer: keeps other keys, atomic, refuses a broken file, never writes when the dialog is
  cancelled.
- The user's environment `SIBERSENTEZ_ACTIONS` still never reaches the server in the installed app.
- The mode is applied in place when the server answers with it (`test/actions-live.test.mjs`: new token, old one
  refused, the channel cannot name a mode, the fallback cases, the panel closing in either order); otherwise after the
  shell-requested restart, and that restart does not count toward the backoff.
- Bridge (if built): ignored from any other window or origin.
- Mutation evidence for every rule above.
- In-app switch (§3b, `test/actions-in-app.test.mjs`): the preload exposes one function and refuses anything but the
  three modes; the shell refuses another window, a subframe, a gone frame, another origin, no ready server and any
  other mode, and its answer carries no path; On from the panel is written without a dialog, On from a menu goes to
  the panel (nothing written) or, without one, to the native dialog; from every reachable state of the panel only
  "Turn on" on the question sends On; keyboard, Esc and outside clicks; a page without the bridge cannot change the
  mode; the resume record.
- The in-page confirmation's guard (`test/csp.test.mjs`): the exact page CSP and framing ban on `/`, a script and a
  stylesheet (see §3b "Scope of the guarantee").
- A real run of the app (`--qa`, isolated hub in `%TEMP%`): switch Off → Preview through the same code path the
  tray uses, show that `/api/actions` reports `dry` and a context-menu action returns the command without running
  it. Screenshots of the tray submenu (or its template) and the page indicator.

## 6. Boundaries

- Owned: `server/config.mjs`, `server/hub.mjs` (read helper only), `server/actions.mjs` (only if needed),
  `electron/main.mjs`, `electron/helpers.mjs`, a new `electron/preload.cjs` or `.mjs` (if the bridge is built), a
  new `electron/strings.mjs`, `public/js/actions.js`, `public/js/contextmenu.js`, `public/js/main.js`,
  `public/index.html`, `public/css/app.css`, a new `public/js/i18n.js`, `test/core.test.mjs` (the two lines above),
  a new `test/actions-toggle.test.mjs`, `package.json` (`scripts.test` only), `README.md` (a short "Actions"
  section).
- Not touched: `build/`, `test/electron.test.mjs`, `server/adapters/**`, `server/catalog.mjs`, `server/views.mjs`,
  `server/memory.mjs`, `docs/`. Existing tests must stay green without edits; if one cannot, stop and report.
- Out of scope: making the actions AI-agnostic (they start Claude Code today), the tool badges in the UI, Phase 0.5.
