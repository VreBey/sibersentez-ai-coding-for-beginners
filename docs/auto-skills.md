# Automatic skill fit — contract

Status: agreed 2026-09-28. User request: "the system must pick the skills that fit a project by itself, and it must
be easier". Observed in the installed app the same evening: the user ran *Import into the library* for the Unity
project in Preview mode, expected the skills to land in the project, and could not tell whether anything happened
(Preview only planned; import goes to the library, installing is a separate step).

This step replaces "pick items by hand, preview, install" with "SiberSentez proposes a ready selection, one button
applies it". The existing actions, safety rules and install record stay (`docs/skills-flow.md`).

## 1. Candidate pool

For one project, candidates are every skill and agent on this computer that could be installed into it:

| Source | Installable | Note |
|---|---|---|
| Hub library | yes | as today |
| SiberSentez kit (`docs/kit.md`, shipped with the app) | yes | installed straight from the kit folder, never through the library; the record says `source: 'kit'` with `kitVersion`, `itemVersion` and `kitPath` |
| Project items of **other** listed projects (`<q>/.claude/skills`, `<q>/.claude/agents`, `<q>/.agents/skills`) | yes | copied into the library first (category inferred), then installed; `source` in the record names the library copy |
| Personal (`~/.claude/...`), claude.ai synced, enabled plugins, built-in | no | already active in every project; shown as "already active" when they fit, never copied |

- **One row per kind and name** (2026-09-29; before, the same name with other content stayed apart as
  `kind:name@label`, so `unity-specialist` showed three times). The row installs from the best place: the user's
  library, else the kit, else the best project copy (one in a project where the item was used, then the most recently
  changed file, then the project id). `sources` names that place (`['library']`, `['kit']`, `['project:<id>']`),
  `alsoIn` the others, even with other content. Keys are `kind:name`; an older `@label` key is answered
  `not-a-candidate`. Nothing is hashed to build the pool any more.
- Items already in the project (by name, any target) are marked installed and never proposed again.
- Candidate reading follows the existing limits and link rules; only `SKILL.md`/agent frontmatter and sizes are read
  until an item is chosen.

## 2. Fit (matching engine v2)

1. **Project profile** — tags from:
   - the existing manifest signals (`server/suggest.mjs`), and
   - a bounded file census: depth 3, at most 5,000 entries, skipping `node_modules`, `.git`, `Library`, `Temp`,
     `obj`, `bin`, `dist`, `build` and `.venv`. Extensions and marker folders map to tags (`.cs` + `Assets/` →
     `unity`, `csharp`; `.tsx` → `react`, `typescript`; `.uproject` → `unreal`; `.gd` → `godot`; ...).
2. **Item profile** — tags from name, description and category through one shared tag dictionary
   (`server/tags.mjs`, English and Turkish synonyms, e.g. `unity`: unity, monobehaviour, prefab, scriptableobject, urp,
   hdrp, shader graph, netcode; `nextjs`: next.js, nextjs, app router; ...). Tags are either **stack** tags
   (frameworks and engines: unity, unreal, godot, nextjs, react-native, expo, electron, django, fastapi, ...) or
   **topic** tags (testing, security, docs, design, devops, database, ...).
3. **Score** (deterministic):
   - stack tag shared with the project: +5 each;
   - topic tag the project shows (a test folder → testing, a `Dockerfile` → devops, ...): +2 each;
   - the item is installed in another project that shares a stack tag with this one: +3;
   - the item was used (logs) in such a project: +2.
   - **Conflict**: the item's stack tags include a stack the project does not have, and none it has → the item is
     excluded (a React Native skill is never proposed for a Unity project).
4. **Confidence**: `high` (at least one shared stack tag and score ≥ 8), `medium` (score ≥ 4), otherwise `low`.
   Each candidate carries at most two short reasons as codes and tags (for example `stack:unity`,
   `used-in:<project id>`), which the UI localizes.
5. **Automatic selection**: every `high` candidate from the kit or the library (2026-09-30: an item found only in
   another project is never selected unseen, docs/direction.md §3.2), at most 4 skills and 1 agent (highest score first; a newcomer can weigh that many, the rest stay in the list unticked).
   `medium` candidates are listed unselected; `low` candidates are hidden behind "show more".
6. **Project idea** (added 2026-09-29, `docs/start-flow.md`): the person may type what they want to build. Its tags
   join the profile (stack tags join the stacks, so the conflict rule and the primary stack follow the idea), a topic
   the idea *names* weighs +5 instead of +2 (a topic it only implies keeps +2), and the idea's other words ("2D",
   "platform") add +1 each (at most +3) to an item that fits already and has them in its name or description. Reason
   codes: `idea:<named tag>` for a tag only the idea gives, `idea-word:<word>` for such a word.
7. **Kit items** (`docs/kit.md` §6, `scoreKitItem`): their curated `sibersentez-tags`; in a profile without any stack
   (none in the files, none in the idea) nothing is excluded; each word of a Turkish keyword found in the idea +4 (at
   most 4 words, reason `idea-word:<words as typed>`); in an empty folder (no tag at all) the items offered there
   (`sibersentez-offer: empty-folder`: idea-to-plan, project-setup) +8 with the reason `empty-folder`, idea or not. High
   also with 8 points and the offer or keywords matching two words. In a folder with code a `start` item is at most
   `low` (at most `medium` when the idea's keywords asked for it), so never selected by itself.

## 3. One action for the whole thing

- `GET /api/projects/<id>/fit` (read-only, no mode needed): `{ project: {tags}, candidates: [{key, kind, name,
  description, sources: [...], alsoIn: [...], stage? (kit items), installable, confidence, score, reasons,
  selected}], active: [...already active items that fit...] }`. It is cached per project and invalidated when the
  project's folder, the library, the kit or the roster changes.
  - `?idea=<text>` (optional): the fit with the idea's tags (§2.6). The server reads at most 300 characters, turns
    control characters into spaces, drops zero-width and direction marks, and never writes or logs the text. The
    answer adds `project.idea.tags: [{id, type, word}|{id, type, via}]` (named tags with the words that named them,
    implied tags with the tag behind them); `project.tags` stays the folder's. The candidate pool (every item that
    could be installed, with its sources and whether it can be installed) is built once per project and kept; each
    idea only scores it again. Fits of at most 16 ideas are kept (all projects together, least recently used first
    out), and only while their pool is the current one.
  - No `?idea` at all (2026-09-29): the project's saved idea (`project.idea`, kept in the project memory,
    `docs/start-flow.md` step 2) is used, so the card's "N fit" badge (its request has no `?idea`) counts what the
    idea asks for. An explicit empty `?idea=` is the fit without any idea (the drawer sends the box's text that way,
    an empty box included). The cache key is the idea actually used: the saved idea and the same text typed share one
    entry, a changed saved idea is a new key, and saving an idea drops only that project's cached fits.
- `skills-apply {projectId, keys?, targets?}` (action; token and mode gate as every action):
  - Keys are looked up in the whole pool, not only in the candidates of the fit without an idea: a key that an idea
    chose (a Unity skill for an empty folder, which the folder alone leaves out) is planned like any other.
  - `keys` omitted → the automatic selection, of the fit with the project's saved idea when it has one (the same
    fit the badge counts).
  - The plan is `import` (for candidates found only in other projects), then `copy`/`skip` per target, as today; a
    kit candidate has no import step (`install.mjs` finds an item the library lacks in the kit).
  - Dry: returns the full plan and writes nothing.
  - Live: runs the imports, then the install, in one locked operation. A failed import skips only its own item.
- The response always states in plain terms what happened: `applied: false, reason: 'preview-mode'` in Dry, so the
  UI can say "Preview: nothing was copied". This removes the "did it work?" doubt.
- The existing `library-*` and `skills-*` actions stay for manual use.

## 4. UI (built after the server part; the redesign may restyle it)

- Project list: a small badge "N fit" when there are `high` candidates not installed yet.
- Project drawer, top section **Skills for this project**:
  - the project's tags,
  - the list with the automatic selection checked and a reason under each item,
  - "already active" items folded,
  - one primary button **Install the selected** (Dry: **Show what would be installed**),
  - **Try** for Claude Code (the selected library and kit items, copied into a trial folder; items only in other
    projects cannot be tried).
  - After a Dry run, a clear banner: "Preview mode: nothing was copied." with a button that opens the actions
    chooser (`/__shell/actions-mode`).
- The import panel is renamed "Add to the library (does not install into a project)".
- New strings through `public/js/i18n.js` (Turkish and English).
- 2026-09-29 (`docs/start-flow.md`): the section is titled **Skills that fit this project**, starts with the idea
  box, and its texts moved to `public/js/strings/start.js` in plainer words. "Show more" lists only weak fits that
  share something (score above zero).
- 2026-09-30 (docs/direction.md §3.2): the list shows at most five strong or possible fits (`FIT_MAIN_MAX`; a selected
  row always stays, a row that cannot be installed takes no place); the others join "show more". Items found only in
  other projects wait behind "Also from my other projects (N)"; hidden, they leave the selection, and the card badge
  counts only kit and library items. When only other projects fit, the list says so. Off in the desktop app the
  primary button reads "Turn actions on and install": one question (what On does, in the switch's words, and what is
  installed), then the header switch saves On through its one bridge call and the install runs.

## 5. Tests

- Tag dictionary: synonyms in both languages, stack/topic split.
- File census: limits, skipped folders, links not followed.
- Candidate pool: library, kit and other projects, one row per name (library > kit > best project copy, the rest in
  `alsoIn`), the project's own items excluded, personal/plugin items only as "active". Kit rules and installs:
  `test/kit-integration.test.mjs`.
- Scoring: every rule, conflict exclusion, confidence bands, selection caps, determinism.
- `fit` cache invalidation.
- `skills-apply`: automatic selection, import-then-install, dry writes nothing and says so, live applies, one failed
  import does not stop the rest, the lock, and every existing safety rule still holds (reuse the skill-flow tests).
- Hermetic fixtures only.
- Mutation evidence for the conflict exclusion, the caps, the dry guarantee, the dedupe and the census limits.

## 6. Boundaries

- Server part owned: `server/suggest.mjs`, new `server/tags.mjs`, new `server/fit.mjs`, `server/library.mjs`,
  `server/install.mjs`, `server/actions.mjs`, `server/app.mjs` (route), `server/index.mjs` (cache invalidation
  hooks), new `test/fit.test.mjs`, `test/suggest.test.mjs`, `test/install.test.mjs`, `test/library.test.mjs`,
  `package.json` (`scripts.test` only).
- UI part (next step) owned: `public/js/views/drawer.js`, `public/js/views/projects.js`, `public/js/views/roster.js`,
  `public/js/i18n.js`, `public/js/actions.js`, `public/css/app.css`.
- Never run in live mode on a real project. Never open a window on the user's screen during tests.
