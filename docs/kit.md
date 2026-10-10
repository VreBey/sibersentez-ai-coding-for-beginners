# SiberSentez kit — design

Status: first version and wired into the app (§6), 2026-09-29. Owner decision of the same day: "Competing apps ship their own skills and agents"
→ SiberSentez ships **its own set, written from scratch**. No third-party content goes into the package (MIT
included); no text, structure or phrasing is copied from other repositories (superpowers, BMAD, anthropics/skills
and similar may inspire, never be copied). Background: a review of public skill collections: idea to skill,
licenses and the Agent Skills standard.

The user scenario it serves: someone buys SiberSentez, creates a folder, types an idea, and the system finds the
skills that fit.

## 1. Principles

- **Own text only.** Every file was written for SiberSentez. Starter code snippets use the public APIs of the libraries
  they target, written in our own words; generator commands are the tools' documented commands.
- **Small and complete.** 15 skills and 4 agents that cover idea → setup → build → ship.
- **Beginner first.** Every step is announced in one sentence. The AI asks before deleting, moving or overwriting
  files, installing anything, changing system settings or pushing. Nothing suggests switching off a tool's permission
  prompts or safety checks (the test keeps a list of forbidden flags).
- **Any AI tool.** Skills follow the [Agent Skills specification](https://agentskills.io/specification); agents
  use the Claude Code subagent format, which GitHub Copilot and Cursor also read from `.claude/agents`. Bodies do not
  depend on one tool's features (no tool-specific question widgets).
- **The user's language.** Files are English (repository rule); every skill tells the AI to talk in the user's
  language, and to write user documents (`PLAN.md`, `TASKS.md`, README) in it.
- **Progressive disclosure.** `SKILL.md` bodies stay under 150 lines; details (full code, error tables) go to a
  `reference.md` in the same folder, linked from `SKILL.md`, under 250 lines.

## 2. Inventory

| Kind | Name | Category | Stage | Tags | What it does |
|---|---|---|---|---|---|
| skill | `idea-to-plan` | planning | start | planning | Interviews the user one question at a time and writes a one-page `PLAN.md` |
| skill | `task-breakdown` | planning | start | planning | Splits the next milestone into small tasks with a "Done when" check in `TASKS.md` |
| agent | `planner` | planning | any | planning | Returns a plan with tasks, risks and open questions; read-only |
| skill | `project-setup` | starters | start | planning, docs | Layout, git, README, `.gitignore`, one run command, first commit |
| skill | `web-app-starter` | starters | start | nextjs, react, typescript, web | First running Next.js or Vite + React app, lint, type and build checks |
| skill | `mobile-app-starter` | starters | start | expo, react-native, typescript, mobile | First Expo app on the user's phone via Expo Go, doctor and type checks |
| skill | `desktop-app-starter` | starters | start | electron, typescript, desktop | First Electron Forge window, safe preload bridge, packaged app and installer |
| skill | `game-prototype-unity` | starters | start | unity, csharp, gamedev | Unity Hub project, git for Unity, player controller, first playable scene |
| skill | `python-bot-starter` | starters | start | python, bot, automation, scraping | Telegram or Discord bot or a scheduled job, token in `.env`, tests |
| skill | `test-first` | quality | build | testing | Failing test first, smallest change, whole suite again |
| skill | `review-changes` | quality | build | code-review | Checklist review with blocker / should fix / nice to have |
| skill | `debug-helper` | quality | build | debugging, testing | Reproduce, narrow down, fix the cause, regression test |
| agent | `reviewer` | quality | build | code-review, security | Reviews changes and runs read-only checks |
| agent | `tester` | quality | build | testing | Writes and runs tests; reports bugs instead of fixing application code |
| agent | `debugger` | quality | build | debugging, testing | Evidence-based debugging with the smallest fix |
| skill | `security-check` | security | any | security | Secrets (also in git history), input, access, dependencies, settings |
| skill | `docs-writer` | docs | any | docs | README and user guides with tried commands |
| skill | `explain-codebase` | docs | build | docs | A map of an unfamiliar project with file paths |
| skill | `release-prep` | release | ship | release, docs | Version, changelog, quality gate, notes; one yes per publish step |

`idea-to-plan` and `project-setup` also carry `sibersentez-offer: empty-folder` (§4, §6).

Deviations from the requested list, with reasons:

- **`code-review` → `review-changes`.** Claude Code ships a built-in `/code-review` skill. Items with the same name
  shadow each other by location priority, so a kit skill with that name would be hidden or confusing.
- **`project-setup` is in `starters`**: it is the generic starter; the five stack starters cover the generator step.
- **Agents live in their topic's category** (`planning/agents/`, `quality/agents/`) instead of a category named
  `agents`: the hub layout already separates kinds by the `skills/` and `agents/` folders, and `agents/agents/` would
  say nothing.

## 3. File format

```
kit/
  README.md  LICENSE.md  catalog.json
  <category>/skills/<name>/SKILL.md      (+ LICENSE.md, the item's notice; + reference.md for starters and security-check)
  <category>/agents/<name>.md            (the notice as comment lines at the top of the frontmatter)
```

Same layout as a hub library (`library/<category>/skills|agents/`): `listLibrary` and the import scan read it as is.

**SKILL.md frontmatter**

| Key | Rule |
|---|---|
| `name` | spec: 1-64 characters, `a-z0-9` and single hyphens, equals the folder name; no reserved words |
| `description` | what it does and **"Use when …"**; at most 400 characters (spec allows 1024, but the hub reader and the fit engine keep 400); no angle brackets; no stack words in general items (§5) |
| `license` | `MIT (see LICENSE.md)`: the notice bundled in the skill folder (§7) |
| `compatibility` | starters only: runtimes the user needs |
| `metadata` | spec: string → string. `author`, `version` (semver), `sibersentez-tags`, `sibersentez-stage`, `sibersentez-keywords-tr`; optional `sibersentez-offer` |

**Agent frontmatter**: two notice comment lines right after the opening `---` (§7), then `name`, `description`,
`tools` (comma separated, least needed), `license: MIT (see the notice at the top of this
file)` and the same `metadata` keys, so the file describes itself for SiberSentez. Agents cannot ask the user mid-task,
so each one returns open questions in its result instead of guessing.

Values use a small YAML subset (double-quoted strings, one nested map) that the test checks strictly; during
development every frontmatter was also parsed with a full YAML parser and matched the catalog.

**Bodies**: every skill starts with the same `## Ground rules` block (language, announce each step, ask first,
never switch off safety checks).

## 4. Matching metadata

- **`sibersentez-tags`**: tag ids from `server/tags.mjs`. Stack tags must agree with what the fit engine derives from
  name + description (tested).
- **`sibersentez-stage`**: `start` (new or empty project), `build` (project with code), `ship` (release time), `any`.
- **`sibersentez-keywords-tr`**: Turkish words that appear in idea sentences, comma separated, lower case. A trailing
  `*` marks a stem, as in `tags.mjs` (`oyun*` matches oyunu, oyunlar). The reference matcher (`keywordScore` in
  `test/kit.test.mjs`) folds Turkish letters on both sides (ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u, â→a, î→i, û→u), matches
  whole words and phrases, and scores a keyword by its word count. Ten sample ideas route to the expected item with a
  clear winner (for example "Telegram'da her sabah hava durumunu gönderen bir bot" → `python-bot-starter`).
- **`sibersentez-offer`** (optional): `empty-folder` — offered in a folder with nothing in it yet, idea or not.
- **`catalog.json`**: `{ name, version, license, count, items: [{ kind, name, category, description, tags, stage,
  keywordsTr, offer, path, notice, version }], proposedTags }`. The hub's catalog reader accepts it (it reads
  `items[].name`, `kind`, `category`, `description`); the app reads the kit version from it. It mirrors the
  frontmatter one to one; after editing a file run `KIT_WRITE_CATALOG=1 node --test test/kit.test.mjs` to rewrite it
  (and the notices, §7).

### 4.1 Tags (added to `server/tags.mjs`, 2026-09-29)

`proposedTags` is empty now. `automation` and `bot` were already in the dictionary (the idea box added them, `bot`
with the Telegram and Discord words), so `python-bot-starter` lists both. Added:

| Id | Type | Synonyms (English and Turkish) |
|---|---|---|
| `code-review` | topic | code review(s), code reviewer, reviewing code, pull request(s), review changes, kod incele\*, kod gözden geçir\* |
| `debugging` | topic | debug, debugging, debugger, bug(s), bug fix(es), stack trace(s), crash(es), hata ayıkla\*, çöküyor, çöktü (and the ASCII spellings) |
| `release` | topic | release(s), releasing, versioning, semver, semantic versioning, version bump, release notes (also docs), sürüm\*, surum\* |

Their names are in `public/js/strings/kit.js` (`fitTag_*`).

## 5. The kit in the plain fit engine (measured by test/kit.test.mjs)

Scored like any library item (`scoreItem`, name + description tags), before the rules of §6:

- **General items** name no stack, so they are never excluded; they only collect topic points.
- **Stack starters** are excluded from foreign stacks (the web starter never shows for Unity) and listed for their
  own stack.
- **Empty folder**: the profile has no stack, so every starter would be excluded and the general items low. §6
  changes that for kit items.

## 6. The kit in the app (built 2026-09-29)

1. **Where.** `server/kit.mjs` reads the kit read-only. `config.mjs` resolves `KIT_DIR`: `SIBERSENTEZ_KIT` (tests); else,
   when the app folder is inside an archive (`<resources>\app.asar` in the installed app), `kit` next to the archive
   (`<resources>\kit`); else `<app>\kit`. A folder that is not there means no kit, silently. `install.mjs` and
   `fit.mjs` cannot import `config.mjs`: `defaultKitDir()` in `kit.mjs` is the same resolution for them.
2. **Packaging.** `package.json` `build.extraResources: [{ "from": "kit", "to": "kit" }]`: the kit is a plain folder
   beside `app.asar`, never inside it (copying out of the archive is not reliable). `build.files` is unchanged.
   Not checked with a real `npm run dist` in this change (no window may open); the tests check the configuration.
3. **Roster (Kadro).** A source of its own, `kit` ("SiberSentez seti"), after the library in the source order. Kit items
   are never active until installed (chip "SiberSentez setinde"), sit in the folder group "SiberSentez seti" with one
   folder per kit category (`kit:<category>`), and carry `kitCategory`, `kitVersion` and `stage`. The card "In your
   library" still counts the user's library only; one line under it says "SiberSentez seti: 15 skill · 4 ajan, projeye
   kurulmaya hazır" with a link to the kit group. An item in the library and in the kit keeps the library's category
   and description. The contract source table of `public/js/rosterModel.js` (and its tests) stays as it was.
4. **Fit** (`server/fit.mjs`, `scoreKitItem`, `docs/auto-skills.md` §2.7):
   - kit items are candidates with `sources: ['kit']`, installable like library items;
   - their tags are the curated `sibersentez-tags` (a word in a description never adds a topic);
   - in a profile without any stack (none in the files, none in the idea) no kit item is excluded: the keywords
     decide ("Telegram botu" → `python-bot-starter`); an idea that names a tool keeps the conflict rule ("Unity ile 2D
     platform oyunu" → `game-prototype-unity` high, `web-app-starter` excluded);
   - each word of a keyword found in the idea: +4, at most 4 words; the matcher is the reference one (the test checks
     that both give the same score on the sample ideas); reason `idea-word:<the words as typed>`, a reason whose words
     another reason shows is left out;
   - empty folder (no tag at all): `idea-to-plan` and `project-setup` (`sibersentez-offer: empty-folder`) +8, high and
     selected, reason `empty-folder` — with or without an idea;
   - high: a shared primary stack and 8 points, or 8 points with the offer or keywords matching two words;
   - a folder with code: a `start` item is at most `low`, or `medium` when the idea's keywords asked for it, so it is
     never selected by itself (a Next.js project never gets `web-app-starter` ticked); `build` and `ship` items are
     (for example "Yeni sürümü yayınlamak istiyorum" → `release-prep`).
5. **One row per name.** Library > kit > best project copy; the others in `alsoIn` (`docs/auto-skills.md` §1).
6. **Install.** A kit item is copied straight from the kit folder (`install.mjs` `findSourceItem`: the library
   first, then the kit), never through the library. Record: `source: 'kit'`, `kitVersion` (catalog), `itemVersion`,
   `kitPath`; the hash is the tree hash of the copy, which equals the kit folder's (the notice is part of it). A newer
   kit copy of an installed, unchanged item is an update with the reason `kit-changed`; a changed copy is never
   overwritten (`modified`). Remove works as for library items. Trials (`planTrial`) find kit items too.
7. **Categories.** The kit keeps its own categories (`planning`, `starters`, `quality`, `release`, `security`,
   `docs`); names in `public/js/strings/kit.js` (`skCat_*`). Importing a kit item into the hub library is still
   refused for the categories the library does not know (not needed: kit items install from the kit).

## 7. License

The kit is licensed under the **MIT License** (decided by the owner on 2026-10-06, together with the app moving to the
GNU GPL version 3 or later: free to use, change and share, alone or in a project, so the items can travel freely with
the projects they help. Before: the SiberSentez License 1.0 of 2026-10-05, PolyForm Shield 1.0.0 of 2026-10-01 and the
AGPL of 2026-09-29). `kit/LICENSE.md` holds the MIT text with the copyright line, so the license ships with the app's
kit folder.

**Notice with every installed item.** The MIT License asks for its copyright and permission notice in every copy, and a
kit item travels into projects on its own, so a skill folder holds `LICENSE.md` (the same text for all: part of the
SiberSentez Kit, the copyright line of `kit/LICENSE.md` and the MIT permission notice); its `license` line names it, as
the Agent Skills specification intends. An agent is one file and an agents folder must hold agents only, so its notice
is three YAML comment lines at the top of its frontmatter (tools read past them, the model never sees them: the kit
line, the copyright line, `SPDX-License-Identifier: MIT` pointing to the full text) and its `license` line says so.
Both are part of the files, so an installed copy is byte for byte the kit's: the record's SHA-256 and the "unchanged
copy" rule of remove and update hold. Written by `KIT_WRITE_CATALOG=1 node --test test/kit.test.mjs` from the
copyright line of `kit/LICENSE.md`.

## 8. Tests

- `node --test test/kit.test.mjs` (16 tests, hermetic; kit/ is only read, the library tests copy it to a temporary
  fake hub): layout (every skill has its notice); Agent Skills frontmatter of every skill; subagent frontmatter of
  every agent (notice comment, license line); the app's own `readFrontmatter` reads the same values; bodies and
  reference files; no forbidden safety-bypass flag; `catalog.json` equals the files row by row; `listLibrary` and the
  import scan read kit/ as a hub library; stack tags; ten Turkish ideas through the reference matcher; the server's
  matcher and reader agree with the reference and the catalog; every notice matches the copyright line.
- `node --test test/kit-integration.test.mjs` (12 tests): where the kit is (source, next to `app.asar`,
  `SIBERSENTEZ_KIT`, missing); packaging configuration; empty folder without an idea; "Unity ile 2D platform oyunu";
  ideas without a tool; a Next.js project; one row per name; skills-apply preview and live install from the kit with
  the record; a newer kit copy; a library item with a kit name; no kit.
- `test/catalog.test.mjs` (the kit as a roster source and in the roster model), `test/fit.test.mjs` (one row per
  name), `test/install.test.mjs` (the `kit-changed` text).

## 9. Open questions

- Agent names `planner`, `reviewer`, `tester`, `debugger` are common. Installing is by name, so a user's own agent
  with the same name blocks ours. A prefix would avoid it at the cost of friendlier names.
- Extra frontmatter keys in agent files (`license`, `metadata`) are expected to be ignored by Claude Code, Copilot
  and Cursor; confirm in each tool before release.
- Which tools read `.agents/skills` should be confirmed per tool before the UI claims it.
- A small router skill ("which kit skill now?") could help users who work only inside their AI tool.
- The notice comment at the top of an agent's frontmatter is expected to be skipped by every tool's YAML reader
  (SiberSentez's own reader skips it, tested); confirm in Claude Code, Copilot and Cursor before release.
- Done 2026-09-29, the project drawer reads the kit (`public/js/views/drawer.js`): the source text for
  `sources: ['kit']` ("SiberSentez setinden"); a plain reason code reads from `fitReason_<code>` (`fitReason_empty-folder`
  in `public/js/strings/kit.js`) and a code the page has no text for reads as a general line (`fitReason_other`), so a
  raw code never shows; kit rows are not imports (neither the "Items from other projects are added to the library
  first" note nor the import count in the question counts them); and "Try" takes kit items like library items
  (`planTrial` copies them from the kit into the trial folder, notice included; `test/kit-integration.test.mjs`). An
  item found only in other projects still cannot be tried (`fitWhyTryKit`).
- An installed app update brings a newer kit; the drawer could offer the `kit-changed` updates (the record keeps
  `itemVersion`).

## Originality check

Every kit file is written for SiberSentez. `test/kit-originality.test.mjs` fails when a kit file shares a run of 8 or
more words with the material it was studied from (code blocks and inline code aside); it runs when
`KIT_ORIGINALITY_DIRS` names that material. Run on 2026-09-30 against the owner's library (a skill library folder,
about 190 skills and 250 agents from many sources) and the nine repositories cloned for study (among them
claude-code-game-studios, claude-cookbooks, claude-code-studio, open-design, mcp-servers, shadcn-ui): no shared run.
Run it again before every release that changes the kit. Last run: 2026-10-05 (kit 0.5.0), the library and ten study
repositories, no shared run.
