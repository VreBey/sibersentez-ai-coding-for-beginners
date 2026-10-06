# Phase 0 · Clean product and installation · Binding contract

> Every agent reads this before starting work. The lead (main session) writes it; if a change is needed, report it to the lead with `BLOCKED`; this file is not edited by hand.
>
> Note: this file was `docs/faz0-sozlesme.md` (Turkish for "phase 0 contract") until 2026-10-01. Legacy Turkish names inside this document (`kutuphane`, `projeler.json`, `ayarlar.json`, ...) are the old hub's file and key names, kept as written; §9 gives the current English names.

## 0. The product and the goal of this phase

SiberSentez is a local panel that watches Claude Code sessions, projects, skills and agents, and runs only on 127.0.0.1.
The product **does not ship ready-made skills/agents** and **is not tied to any AI**; the user connects their own AI in their own project.

Definition of done for Phase 0: any Windows user who downloads the repo runs `kur.cmd`; the installation sets up a
**clean** hub folder and the panel; the panel opens and **lists every skill and agent installed on that computer with the correct
sources**. Not a single path, name or text specific to the developer or to their personal old hub remains in this repo.

NOT in this phase (later phases): import (Phase 2), installing into a project and AI choice (Phase 3), the verification/test screen (Phase 1),
Electron and the embedded terminal (Phase 4), subscription (Phase 5).

## 1. Ownership

| Path | Owner | Others |
|---|---|---|
| `server/**`, `test/core.test.mjs`, `test/actions.test.mjs`, `test/catalog.test.mjs` (new), `test/settings.test.mjs` (new) | **server agent** | read only |
| `public/**`, `test/contextmenu.test.mjs`, `kur.cmd` (new), `kur.ps1` (new), `start.cmd`, `autostart.js`, `autostart.cmd`, `install-autostart.ps1`, `README.md`, `test/kurulum.test.mjs` (new) | **client and installation agent** | read only |
| `docs/**`, `.gitignore`, `.claude/**` | **lead** | read only |

- Only the lead makes git commits. Progress: `qa/<role>-ilerleme.md` (not tracked by git; the lead adds it to `.gitignore`).
- Temporary files go to the system temp folder. Tests and experiments **write only to temporary folders**: the real Desktop,
  Startup, Start menu, `%LOCALAPPDATA%\Programs` and `%USERPROFILE%\SiberSentez` are not used.
- On the development computer the developer's own panel runs on 4545: it, `<personal old hub>` and
  `<experiment folder>` are not touched. Ports for experiments: server agent **4561**, client agent **4562**.

## 2. The structure the installation creates

**Application folder** (default `%LOCALAPPDATA%\Programs\SiberSentez`): the repo's `server\`, `public\`, `start.cmd`,
`autostart.js`, `autostart.cmd`; the `sibersentez.json` written by the installation; the `logs\` created while running.

**Hub folder** (default `%USERPROFILE%\SiberSentez`, the user's data; the installation **never overwrites an existing file**):
```
SiberSentez\
  ayarlar.json            {"surum": 1}
  kayit\projeler.json     {"projeler": []}
  kutuphane\katalog.json  {"guncelleme": null, "adet": 0, "ogeler": []}
  kutuphane\README.md     what the library is (short, Turkish)
```
Library layout later: `kutuphane\<category>\skills\<name>\SKILL.md`, `kutuphane\<category>\agents\<name>.md`.
The project record format is the same as the existing `projeler.json` (`id`, `ad`, `yol`, `aciklama`, `paketler`, ...).

## 3. Settings resolution (`server/config.mjs`)

Priority: **environment variable -> `<app>\sibersentez.json` -> default**.

| Setting | Environment | `sibersentez.json` | Default |
|---|---|---|---|
| Port | `SIBERSENTEZ_PORT` | `port` | 4545 |
| Days | `SIBERSENTEZ_DAYS` | `days` | 14 |
| Hub | `SIBERSENTEZ_HUB` | `hub` | `%USERPROFILE%\SiberSentez` **only if it exists**, otherwise `null` |
| Actions | `SIBERSENTEZ_ACTIONS` | `actions` (`off`/`dry`/`live`) | off |

- The assumption "the app's parent folder is the hub" is **removed**. The hub may be `null`; then the registry and the library count as empty, and the panel still works.
- Registry path: `<hub>\kayit\projeler.json`; if missing, for backward compatibility `<hub>\registry\projeler.json`
  (so the user can point at their own old-layout hub). Library: `<hub>\kutuphane\katalog.json`.
- If `sibersentez.json` is broken or unreadable, fall back to the defaults and write a single line to the log; the server does not crash.
- For tests, the constructor must accept the `Catalog`, `claudeDir`, `homeDir`, `hubDir` options (default: config).

## 4. Discovery: what the panel lists (`server/catalog.mjs`)

- **No fixed hub project is added.** Projects = those in the registry + those found from Claude Code logs (the existing ad-hoc logic).
- Roster sources (`source`) and what they mean:

| `source` | From | Note |
|---|---|---|
| `kutuphane` | `<hub>\kutuphane\katalog.json` | `category` = category |
| `kisisel` | `~/.claude/skills/<name>/SKILL.md` (except `synced`), `~/.claude/agents/**/*.md` | applies in every project |
| `claudeai` | `~/.claude/skills/synced/<name>/SKILL.md` | mapped from claude.ai |
| `proje` | `.claude/skills/*/SKILL.md` and `.claude/agents/**/*.md` of every project whose path exists (registered + from logs) | `installedIn` = project ids. A project whose path is the home folder (`~`) or that is `broad` is not scanned (so it is not double-counted with personal) |
| `eklenti` | the install folder of every plugin in `~/.claude/plugins/installed_plugins.json`: `skills/*/SKILL.md`, `agents/**/*.md` | name `<plugin>:<item>`; `plugin` = plugin id, `enabled` = on/off in the settings. The plugin itself also stays as a `kind: 'plugin'` item |
| `yerlesik` | Claude Code's built-in agent types (the existing list) | |

- The `cekirdek` ("core") concept does **not** exist in the product (it was specific to the personal old hub).
- Item shape: the existing fields + `sources: string[]` (all sources the item is found in; the same name can be in several places).
  The merge key is `kind:name` as before.
- Verify the format of `installed_plugins.json` against the real file on this machine; if fields are missing, silently skip that plugin.
- Scan limits: at most 2 levels per folder, frontmatter first 6000 bytes (the existing `readFrontmatter`).

## 5. View and actions

- The snapshot gets `hub: null | { "path": "...", "projects": <count>, "library": <count> }`.
- Actions: `resume`, `fork`, `new`, `explorer`, `vscode` remain. `skills-preview` and `skills-install` are
  **not in the list** in this phase (paket-kur.ps1 does not exist in the product; installation comes in Phase 3 with the app's own module).
  `packages` (per-session `--plugin-dir`) is accepted only if that category folder exists in the hub.
- Client: all texts belonging to the personal old hub are removed (header subtitle, source labels, the "Add to registry" PowerShell command).
  Source labels: Library, Personal, claude.ai, Project, Plugin, Claude Code built-in. In the Roster tab, filtering by source.
  If there is no hub or the library is empty, a plain empty state: the hub folder's path and "The library is still empty".
  The "Suitable skills" section is hidden in this phase.

## 6A. DECISION CHANGE (2026-09-28, user): an installable program, Electron + Setup.exe

The product is distributed as an **installable Windows program**. §6 below (kur.cmd/kur.ps1) is **cancelled**; in its place:

- **Packaging:** Electron 44.5.1 + electron-builder 26.15.3, a Windows NSIS installer (`dist\SiberSentez-Setup-<version>.exe`).
  Per-user installation (no administrator permission), Desktop and Start menu shortcut, uninstall from the Programs list.
  No Node prerequisite (Electron's own runtime). Code signing in Phase 5.
- **Hub folder:** on first launch the program creates the `%USERPROFILE%\SiberSentez` skeleton (§2), never overwriting an existing file.
  On the server side a pure `initHub(hubPath)` (new `server/hub.mjs`) does this; the Electron main process calls it. Uninstall does **not delete** the hub.
- **Electron shell** (`electron/**`): single-instance lock; the server runs in a separate process (`utilityProcess` or `ELECTRON_RUN_AS_NODE`);
  a **free port** is chosen (it does not clash with the user's other SiberSentez on 4545) and given to the server with `SIBERSENTEZ_PORT`/`SIBERSENTEZ_HUB`;
  the window loads only `http://127.0.0.1:<port>/` (`contextIsolation`, `sandbox`, `nodeIntegration:false`; navigation to any other address is blocked,
  external http(s) links open in the default browser); a system tray (Open, Start at login, Quit); start at login via `app.setLoginItemSettings`.
  Actions are off in this phase (they move to an internal channel in Phase 3).
- **Removed:** `kur.cmd`, `kur.ps1`, `test/kurulum.test.mjs`, `autostart.js`, `autostart.cmd`, `install-autostart.ps1`.
  `start.cmd` may remain only as a developer launcher; the main developer path is `npm start` / `npm run dist`.
- **Ownership additions:** `electron/**`, `build/**` (icon etc.), `package.json`, `package-lock.json`, `test/electron.test.mjs` -> **Electron agent**.
  `server/hub.mjs` and its test -> server agent. The README's installation section, based on Setup.exe -> client agent.

## 6. (CANCELLED, see 6A) Windows installation (`kur.cmd` + `kur.ps1`)

- `kur.cmd`: ASCII only; `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kur.ps1" %*`; `pause` on error.
- `kur.ps1`: **also runs on Windows PowerShell 5.1** (no syntax specific to 7), UTF-8 with BOM. Parameters:
  `-UygulamaKlasoru`, `-MerkezKlasor`, `-KisayolKlasoru` (Desktop), `-BaslatMenusuKlasoru`, `-BaslangicKlasoru`,
  `-Acilista` (start at login), `-Port` (if not given, the first free port starting at 4545), `-Baslatma`,
  `-Kaldir` [`-VeriyiSil`], `-Sessiz` (asks nothing; for tests).
- Steps: Node >= 20 check (if missing, a clear message and a suggestion of `winget install OpenJS.NodeJS.LTS`; **does not install without permission**) ->
  copy the app (cleans old app files, `sibersentez.json` and `logs` are kept) -> hub skeleton (does not overwrite) ->
  write `sibersentez.json` -> shortcuts -> optional start at login -> open the panel unless `-Baslatma` -> summary.
- Uninstall: the app folder and shortcuts are deleted; the hub folder is **kept**, deleted with `-VeriyiSil` after written confirmation (without confirmation with `-Sessiz`).
- `install-autostart.ps1` either redirects to `kur.ps1 -Acilista` or is removed; the old hub description goes away.
- `start.cmd`/`autostart.*`: port and paths from their own folder/settings file; ASCII only.

## 7. Security (hard rules that do not change)

- Only 127.0.0.1; actions are off by default; no `shell:true`; no path/command comes from the browser.
- The installation script does not install packages without asking the user, does not delete hub data, does not ask for administrator permission.
- Secrets, tokens or personal data are not written to the log or to the report.

## 9. Language policy (user decision, 2026-09-28) — overrides §2 and §4 names

Binding rule file: `.claude/rules/language.md`. The app UI is localized (Turkish + English, chosen in the app);
everything else is English: identifiers, comments, file/folder names, JSON keys, logs, docs, commits, test names.

Hub skeleton created by `initHub` (replaces the Turkish names in §2):
```
SiberSentez\
  settings.json            {"version": 1, "language": "auto"}
  registry\projects.json   {"projects": []}          project: id, name, path, description, packages
  library\catalog.json     {"updated": null, "count": 0, "items": []}   item: name, kind, category, description, source
  library\README.md
```
Library layout: `library\<category>\skills\<name>\SKILL.md`, `library\<category>\agents\<name>.md`.
Read order: English paths/keys first; otherwise a compatibility adapter for a legacy hub
(`registry\projeler.json`: projeler/ad/yol/aciklama/paketler; `kutuphane\katalog.json`: ogeler/ad/tur/kategori/aciklama).
Roster `source` values (replaces §4): `library`, `personal`, `claudeai`, `project`, `plugin`, `builtin`.
Phase 0 scope: new and changed code follows this rule; the full i18n (string files, language switch, API error codes)
and translating existing Turkish comments/docs happen in a dedicated Phase 0.5 pass after Phase 0 lands.

## 8. Test commands and definition of done

```
node --test test/core.test.mjs test/actions.test.mjs test/contextmenu.test.mjs test/catalog.test.mjs test/settings.test.mjs test/kurulum.test.mjs
```
1. All tests are green; for every new rule, the test turns red when the related code is broken in a temporary copy.
2. With **no** hub, an **empty hub** and **the user's old-layout hub** (`SIBERSENTEZ_HUB=<old hub path>`, read only),
   the panel opens; the roster shows this machine's personal, project and plugin items with the correct source; no fake projects.
3. `kur.ps1` installs to temporary folders, does not overwrite hub data on a second run, and uninstall keeps the hub.
4. The code, scripts and `README.md` contain no developer user name, no name of the old hub and no person-specific absolute path (except the `docs/` development documents and temporary paths in tests).
5. Last line: `VERDICT: {"status":"DONE|BLOCKED","files":[...],"checks":{...},"blockers":[...]}`
