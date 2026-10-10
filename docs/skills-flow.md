# Skill flow: import, suggest, try, install, remove — contract

Status: agreed 2026-09-28. The user chose to build the skill flow now (Phase 2 import and Phase 3 install, pulled
forward) and the UI redesign after it. This step is the server side plus a minimal wiring of the existing (hidden)
drawer sections, so the flow works end to end; the look comes with the redesign.

Product rule, unchanged: SiberSentez ships no skills or agents. The user brings them; SiberSentez keeps them in the
hub library, suggests the fitting ones for a project, lets the user try them without installing, installs them into
the project and removes them again.

## 1. Words

- **Library item**: a skill (a folder with `SKILL.md`, copied whole: `scripts/`, `references/`, `assets/` included)
  or an agent (one `.md` file with optional frontmatter). Name = frontmatter `name`, else folder or file name.
- **Target**: where an installed item lives in a project, per tool family:
  - `claude`: `<p>/.claude/skills/<name>/`, `<p>/.claude/agents/<name>.md` (Claude Code; Copilot and Cursor also
    read `.claude/skills`).
  - `agents`: `<p>/.agents/skills/<name>/` (the shared Agent Skills folder read by Codex, Gemini CLI, Copilot,
    Cursor, Antigravity and others). Skills only.
- **Plan**: the list of operations an action would do (`copy`, `update`, `skip`, `remove`) with a reason each.
  Computing a plan never writes.

## 2. Library (Phase 2)

1. **Source of truth is the folders.** The server scans `<hub>/library/<category>/skills/*/SKILL.md` and
   `<hub>/library/<category>/agents/*.md` itself (cached by mtime like the roster). `library/catalog.json` becomes
   a generated file the server rewrites after an import; a hand-made change in the folders is picked up without it.
2. **Categories** have English ids: `web`, `mobile`, `desktop`, `game`, `data`, `ai`, `devops`, `testing`,
   `security`, `design`, `docs`, `general`. Labels are localized in the UI later. A folder under `library/` with
   another name is still read as a category (the user may add their own).
3. **Import** (`library-scan`, then `library-import`):
   - `library-scan {source}`: `source` is an absolute local folder (drive letter; no UNC, not a drive root, not the
     home folder itself, not inside the hub). Finds skills (folders with `SKILL.md`, at any depth up to 6) and agents
     (`*.md` inside a folder named `agents`, at any depth up to 6; since 2026-10-09 also in a topic folder such as
     `engineering/`, when a file's frontmatter has a name, a description and an agent key such as `tools`, `model`
     or `color`, which notes and slash commands do not carry; README-like files and the `commands`, `rules`
     and `prompts` folders never count). An agent's display name ("Minimal Change Engineer") becomes a slug
     (`minimal-change-engineer`) in the scan and in the library alike; a skill's name stays its identity. It follows
     no junction or symlink, and returns each
     candidate with name, kind, description (first 400 chars), size, file count, a proposed category with its
     reason, and a status: `new`, `same` (identical content already in the library), `conflict` (same kind and
     name, different content). Reads `SKILL.md`/agent frontmatter and file sizes; to tell `same` from `conflict` it
     hashes the candidate and the library item of the same name, both only after their size and file count passed the
     limits. (Review round 1, advisories 4 and 8.)
   - Every user-supplied path is refused when it contains `:` after the drive letter (alternate data streams such as
     `::$INDEX_ALLOCATION`), and the root, home and hub rules compare real paths (`realpathSync.native`), which also
     covers 8.3 short names. (Review round 1, advisory 1.)
   - `library-import {source, items: [{path, category}]}`: plans and, in live mode, copies the chosen candidates into
     `library/<category>/...`. A `conflict` is skipped unless the item says `replace: true`; `same` is skipped.
   - Limits: an item larger than 20 MB or with more than 500 files is refused; files that are reparse points are
     skipped; names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
   - Proposed category: a keyword table over name + description (English and Turkish keywords), default
     `general`. Deterministic and tested.
4. **Legacy hub**: a hub that uses the old layout (`kutuphane/`, `registry/projeler.json`) is read as today but
   **never written**: every write action refuses with `legacy-hub`.

## 3. Suggest, try, install, remove (Phase 3)

1. **Suggest** (read-only, no action mode needed): `GET /api/projects/<id>/suggestions` returns library items
   ranked for the project with a short reason each. Signals, all from file names and small manifest files only:
   `package.json` dependencies (react, next, vue, svelte, expo, react-native, electron, express, prisma, ...),
   `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, `*.csproj`/`*.sln`, Unity (`Assets/` +
   `ProjectSettings/`), Unreal (`*.uproject`), Godot (`project.godot`), Flutter (`pubspec.yaml`), `Dockerfile`,
   `.github/workflows`, plus the registry `packages` of a registered project. Items already installed in the
   project are marked, not dropped. Deterministic and tested.
2. **Try without installing** (`skills-trial {projectId, items}`): builds a session-only plugin folder
   `<hub>/trials/<timestamp>-<slug>/` with `skills/<name>/` and `agents/<name>.md` copies and a marker file, and
   starts a new Claude Code session in the project with `--plugin-dir <that folder>` through the same terminal path
   as the `new` action. Claude Code only in this step (other tools: the plan says so). Trial folders older than 7
   days that carry the marker are removed at server start; nothing else in `trials/` is touched.
3. **Install** (`skills-preview` = plan only in any mode except off; `skills-install` = execute in live, plan
   in dry): `{projectId, items: [{kind, name}], targets: ['claude'|'agents']}`.
   - Default targets from the project's tools (`via`): `claude` when Claude Code is among them or none is known;
     `agents` when Codex, Gemini CLI or Antigravity is among them. Agents always go to `claude` only.
   - Never overwrite what SiberSentez did not install (project-owned) → `skip: project-owned`. Installed by SiberSentez
     but changed since → `skip: modified`. Same content → `skip: up-to-date`. Library item changed since install →
     `update`.
4. **Remove** (`skills-remove {projectId, items, targets}`; `plan: true` → plan only): removes only what the
   install record lists and only when unchanged; a modified item → `skip: modified`.
5. **Install record**: `<hub>/registry/installs.json`, written atomically:
   `{"version":1,"installs":[{"project","target","kind","name","path","hash","source","installedAt"}]}`. `hash`
   is a SHA-256 over the installed tree (relative paths + contents). Nothing is written into the project except the
   installed items themselves.
6. **Safety**: the project must be a listed project on a local drive, not broad, existing. Every destination path
   is resolved and must stay inside `<p>/.claude` or `<p>/.agents`; a destination whose parent is a reparse point
   is refused. Copies never follow junctions or symlinks. After an install or remove the catalog reloads so the
   counts change at once.
7. **Staging and leftovers** (review round 1, advisory 3): the temporary copy and the set-aside old copy live next
   to the target folder's parent (`<p>/.claude/.sibersentez-tmp-*`, never inside `skills/` or `agents/`, so no tool
   loads them as an item). When the new copy is in place, failing to delete the old copy is not an error: the
   record gets the new hash and the leftover is swept later. At server start, leftovers named `.sibersentez-(tmp|old)-*`
   are removed from the recorded project targets and from `library/`.
8. **Limits before work** (advisory 4): size, file count, folder count and depth are checked before any hash or
   copy; a tree over the limits is never read whole.
9. **Logs carry no path** (advisory 5): errors are logged by code only. The install record keeps rows it cannot
   use when it is rewritten (advisory 6). Suggestions never offer an item whose name fails the name rule
   (advisory 7).

## 4. Action surface

- New action names: `library-scan`, `library-import`, `skills-preview`, `skills-install`, `skills-remove`,
  `skills-trial`. Same transport and protections as today (`POST /api/action`, per-process token from
  `GET /api/actions`, Host/Origin/Sec-Fetch checks, mode gate). Off → 404 as today. Dry → nothing is written or
  started; the response carries the plan (or the command for `skills-trial`). Live → executed.
- `library-scan` and `skills-preview` never write in any mode; they still need the token (they read user folders
  or plan writes).
- Responses: `{ ok, mode, action, plan: [{op, kind, name, target?, path?, reason}], result?: {...} }`. Error codes
  in English (`legacy-hub`, `not-a-project`, `bad-name`, `too-large`, ...); the UI maps them to text.

## 5. Minimal wiring (UI polish comes with the redesign)

- Project drawer, "Suggested skills": list from the suggestions endpoint; select; buttons Preview / Try / Install.
- Roster drawer of a library item, "Install into project": pick a project and targets; Preview / Install; and
  Remove where installed. No project is preselected; registered projects come first. Folders under
  `<home>\AppData` are never projects.
- Right-click menu (added after the first review): "Suggested skills…" on a project and "Install into project…"
  on a library item while actions are on; both only open the drawer section, they send nothing themselves.
- The page sends every action through one sender (`public/js/actions.js`) with a per-action field list that matches
  the server.
- Library view: "Add to the library" (a folded section at the top of the Skills & agents tab): "Choose a folder…"
  (the desktop app's system picker, `window.sibersentezShell.pickLibraryFolder()`, answers only the chosen folder's
  path; the page puts it in the field and scans at once) or a typed path → scan → table with checkboxes and category
  selects → Import → "Next: …" with "Show them in the list". The library card carries a primary "Add to the library"
  button that unfolds the section and scrolls to it; Ctrl+K has the same command.
- New strings go through `public/js/i18n.js` (Turkish and English).

### 5.1 A listed item into the library (`library-adopt`)

The tools already see many skills and agents (personal, project, plugin, claude.ai) that are not in the library.
The roster drawer of such an item has "Add to the library": one click copies it in, the original stays where it is.

- The catalog keeps, server side only, where each skill or agent lives (`itemFiles`, from the adapters' item paths);
  `catalog.itemOrigin(kind, name)` answers `{ source, pick }`: a skill's own folder with pick `.`, or an agent file
  right inside a folder named `agents` with its file name. Personal first (`SOURCE_ORDER`), never the library or the
  kit, at most 260 characters.
- The roster item gets `adoptable: true` when there is such an origin that `checkSource` accepts (no junction, not
  inside the hub, not the home folder or a drive root, still there) and the library does not hold the item; the
  answer is cached until the roster is built again. The item's original place never goes to the page; the plan
  names the library target as a folder import's plan does.
- `POST /api/action { action: 'library-adopt', items: [{ kind, name }] }` (at most 25): unknown → `404
  item-not-found`; a page cannot name a folder (`bad-items`). Each item goes through the library's own
  `scanSource` + `planImport` + `executeImport` (the same checks, limits, category proposal and copy as a folder
  import); the scan must find the item by kind, name and place. An item that cannot be taken is a `skip` with its
  reason (an error code) in the plan and the others go on, so what was copied is always reported and `catalog.json`
  is always regenerated; a single item that cannot be taken answers its reason as an error (`404 item-not-found`,
  `409 reparse-point`...). Preview answers the plan and writes nothing; On copies. Again: `skip:same`.

## 6. Tests

- Library scan: layouts, depth limit, junction not followed, limits, names, statuses `new/same/conflict`,
  category proposal table.
- Import: plan vs live, conflict/replace, same, legacy hub refused, catalog regenerated, folder scan picks up a
  manual add.
- Suggest: each signal, ranking, installed items marked, registry packages.
- Install/remove: default targets from `via`, every skip reason, update, record written atomically, hash, remove
  only unchanged, destinations stay inside, reparse parent refused, catalog counts change.
- Trial: folder layout and marker, argv (`--plugin-dir`), cleanup only of marked folders older than 7 days.
- Actions: mode gate for every new action (off 404, dry writes nothing), token and origin checks unchanged.
- Hermetic: fake hub, fake home, fake projects under the temp folder. Mutation evidence for every safety rule.
- Real run (isolated hub in `%TEMP%`, fixture projects in `%TEMP%`): import from a fixture folder, suggest, preview,
  install and remove in live mode **on fixture projects only**, trial argv in dry mode. Screenshots.

## 7. Boundaries

- Owned: new `server/library.mjs`, `server/install.mjs`, `server/suggest.mjs`, `server/actions.mjs`,
  `server/app.mjs` (suggestions route), `server/hub.mjs`, `server/catalog.mjs` (library reading only),
  `server/index.mjs` (reload after install), `server/views.mjs` (only if the drawer needs a field),
  `public/js/views/drawer.js`, `public/js/contextmenu.js`, `public/js/views/roster.js`, `public/js/i18n.js`,
  `public/js/main.js` (only wiring), new `test/library.test.mjs`, `test/install.test.mjs`, `test/suggest.test.mjs`,
  `test/actions.test.mjs`, `package.json` (`scripts.test` only), `README.md` (a "Skills" section).
- Not touched: `build/`, `electron/`, `test/electron.test.mjs`, `test/actions-toggle.test.mjs`,
  `server/adapters/**`, `server/memory.mjs`, `public/css/app.css` beyond a few rules for the new rows, `docs/`.
- Never in live mode on a real project; never on the personal hub; the user's own `~/.claude` is only read.
