# Bringing skills and agents from GitHub — contract

Status: built 2026-09-29. The person asked: when someone wants skills and agents from a GitHub repository, what do we do
with them, how do we tell which project they suit, and how do they get from a shared library into a project without
fuss? The audience is someone who wants to use AI and does not know how: every step is plain and says what it does.

Flow: **paste a link → Fetch → look and choose → add to the library → install into a project**, plus "Check for update"
for items that came from GitHub. Nothing from the repository is ever run.

## 1. Where it lives

- Server: `server/github.mjs` (link rules, download by git or tar.gz, the tar reader, the incoming folder, provenance,
  update diff), `server/review.mjs` (safety and license review), `server/fit.mjs` (`projectsFor`, `fitsForItem`),
  `server/library.mjs` (`scanDir`, `planImport({ scan })`), `server/actions.mjs` (four actions), `server/catalog.mjs`
  (the roster's `origin` field).
- Page: `public/js/views/roster.js` (the GitHub tab), `public/js/rosterModel.js` (pure helpers), `public/js/actions.js`
  (`ACTION_FIELDS`), `public/js/strings/github.js`, `public/css/github.css`.
- Tests: `test/github.test.mjs`, `test/review.test.mjs` (network and git are always fakes).

## 2. The network (SiberSentez's first outgoing request)

Until this feature SiberSentez sent no request anywhere. Now:

- A request goes out **only when the person presses Fetch or Check for update**, and **only with actions On** (live).
  Preview never reaches the network; Off answers 404 as for every action.
- Only `https://github.com`, `https://codeload.github.com` and `https://api.github.com` are contacted (the archive
  path asks api.github.com for the commit id and codeload.github.com for the archive; git, the fallback, talks to
  github.com).
- Refused before anything runs (HTTP 400): another host (`not-github`, also `gist.github.com`,
  `raw.githubusercontent.com`, a port other than 443), a link with a user name or password (`url-credentials`), the ssh
  and git forms (`ssh-url`), anything else (`bad-url`). A redirect is followed at most three times and only to those
  three hosts (`redirect-refused`); git itself follows none (`http.followRedirects=false`).
- Public repositories only. A repository that asks for credentials is answered `not-public`; no credential is asked for,
  stored or sent.
- The User-Agent is `SiberSentez`; nothing about the person, the computer or the projects is sent.

The README should say this in one short paragraph (the main session updates the README).

## 3. Download

### 3.1 The link

`https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<folder>]]`; `/blob/<ref>/<file>` means the file's folder;
`github.com/<owner>/<repo>` without a scheme and `www.github.com` are accepted. Owner and repository follow GitHub's
name rules; the ref must be a valid git ref (no `..`, no leading `-` or `/`, no `@{`); the folder is a relative path
without `.` or `..` parts (dot segments are resolved by the URL rules before anything is read). A `/tree/<a>/<b>` link
is read as ref `a`, folder `b` (a branch with a slash in its name is not supported in a link).

### 3.2 Order: the archive first, git only as a fallback

The archive (§3.4) is always tried first: it streams through the tar reader with every limit checked as the bytes
arrive, and it was the faster path in the real run (1.7 s against 6 s for git, §10). git is used **only when the
archive path fails** with `network`, `timeout`, `fetch-failed`, `redirect-refused`, `rate-limited` or `tar-corrupt`
(codeload blocked by a proxy, for example), when git is on this computer, and when the ref is not a commit id. Not after
`not-public`, `ref-not-found`, a size limit or `tar-unsafe-path`: git would answer the same, or the archive was crafted.
When git then cannot run (`git-failed`, `git-missing`), the archive's failure is the answer. Preview names the order:
`method: 'tar'`, `fallback: 'git' | null`, and the hosts of both.

### 3.3 git (the fallback, when git is on this computer)

- `git.exe` by **absolute path**: the absolute folders of `PATH` in order (a relative entry such as `.` is skipped, so
  git is never looked up in the working folder or a project), then `%ProgramW6432%`/`%ProgramFiles%\Git\cmd` and
  `%LOCALAPPDATA%\Programs\Git\cmd`.
- `git [-c …] clone --depth 1 --single-branch --no-tags --no-recurse-submodules --template= [--branch <ref>] -- <url> <dest>`
  then `git -C <dest> rev-parse HEAD` for the commit id; git's own `.git` folder is deleted afterwards.
- On every command line: `credential.helper=` and `core.askPass=` (no helper, no askpass program),
  `core.symlinks=false`, `core.autocrlf=false`, `core.fsmonitor=false`, `core.hooksPath=<a folder that does not
  exist>`, `core.longpaths=true`, `protocol.allow=never` + `protocol.https.allow=always`, `http.followRedirects=false`,
  `submodule.recurse=false`, LFS filters emptied, `transfer.fsckObjects=true`.
- Environment: the parent's without any `GIT_*`, `GCM_*` or `SSH_ASKPASS` value, then `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` (empty: no askpass), `SSH_ASKPASS=`, `GIT_LFS_SKIP_SMUDGE=1`,
  `GIT_ALLOW_PROTOCOL=https`, `GIT_CEILING_DIRECTORIES=<hub>` (no repository above the incoming folder is read).
- Process: `windowsHide: true`, `shell: false`, no input, output through pipes (64 KB kept), run in `<hub>\incoming`,
  time limit (clone 5 min, ls-remote 1 min).
- **Size while git runs:** the clone's folder (git's own `.git` included: what is on the disk) is measured every second
  against the download limits (§3.5). Past a limit, or past the time limit, the **whole process tree** is ended
  (`%SystemRoot%\System32\taskkill.exe /T /F /PID <pid>`, absolute path, hidden, no shell: `git.exe` alone would leave
  `git-remote-https` downloading), SiberSentez waits up to 5 s for git to close, and the folder is deleted. No partial
  clone (`--filter=blob:limit`): git would fetch the missing objects later, on demand, past every limit.
- A ref that is a full commit id is read from the archive only (a shallow clone takes a branch or a tag).

### 3.4 The archive (first)

The commit id comes from `api.github.com/repos/<o>/<r>/commits/<ref|HEAD>` (`Accept: application/vnd.github.sha`:
404 → not-public, 422 → ref-not-found; 403/429, the hourly limit, falls back to the archive of the ref itself, whose pax
global header names the commit). The archive is `codeload.github.com/<o>/<r>/tar.gz/<commit>`, unpacked as it arrives
with Node's own zlib and the tar reader below (no zip).

**Tar reader** (`createTarExtractor`, `extractTarGz`): ustar with pax (`x` per entry, `g` global: the commit) and GNU
long names (`L`). The first path part (`<repo>-<commit>/`) is stripped. An absolute path, a drive letter, a UNC path or
a `..` part **refuses the whole archive** (`tar-unsafe-path`); a name Windows cannot hold (reserved device names,
`<>:"|?*`, control characters, `COM¹`–`LPT³` with a superscript digit, a trailing dot or space), a path longer than 400
characters or deeper than 40 levels is skipped; links (hard and symbolic), devices and FIFOs are skipped, never created;
every file is created new (`wx`), so a second entry with the same name in another letter case is skipped. Checksums are
verified; a cut archive, data after the end marker, a broken gzip stream or a pax `size` that is not a plain decimal
number within the safe integer range (`1e3`, ` 10`, `0x0a`) is `tar-corrupt`.

### 3.5 Limits

200 MB compressed, 500 MB unpacked, 50,000 files, 20,000 folders (the folders made on the way to a file counted too;
the same number as a folder scan, `library.mjs` `LIMITS.maxDirs`), 100 MB per file (`too-large`, `too-many-files`). The
archive path checks them while it streams and measures the unpacked tree once more; the git path measures its folder
while git runs and again after it (§3.3). The per-item limits of the library (20 MB, 500 files) still apply at import.

### 3.6 The incoming folder

`<hub>\incoming\<owner>-<repo>-<6 hex>@<12 hex>\` holds the download (the 6 hex digits: SHA-256 of `owner/repo` in
lower case, so `a-b/c` and `a/b-c`, or two names that differ after their first 40 characters, never share a folder;
the 12 hex digits: the commit), `<id>.json` next to it the marker (`sibersentez: incoming`, repo, ref, commit, method,
fetchedAt). The older form `<owner>-<repo>@<7 hex>` is still recognized, so such downloads are still cleaned up. A
download in progress is `.tmp-<12 hex>` and is renamed at the end, so a half-done download never looks like one; when
it fails, it is deleted, and one that cannot be deleted at that moment (a file still held) goes with the next cleanup
after an hour: the failure keeps its own code either way. The download is deleted after the import (the page asks for it), on
"Cancel", when an update check needs it no longer, and at the latest seven days later: `cleanupIncoming` runs when the
action layer is created (server start, any mode; `server/index.mjs` is not touched) and before every download. Only
entries named like ours and only real folders and files are removed; a stale `.tmp-` goes after an hour; links and
foreign names are left alone.

## 4. Review: is it safe, what is its license (`server/review.mjs`)

Read-only: nothing is run, no link is followed, at most 500 files, 1 MB per file and 20 MB per item are read.

**What is reviewed is what is copied.** An import into the library (from GitHub and from a local folder alike;
`library.mjs` `executeImport`, `VENDORED_DIRS`) never copies a `.git` or `node_modules` folder, in any letter case and at
any depth of an item; the scan measures an item and compares it with the library copy without them too. The review
does not read those folders either, and names each one: `vendored-folder` (caution, "not copied"). So a
`node_modules/.bin/setup.exe` can neither pass as reviewed nor reach the library. Before this rule the review skipped
those folders while the copy took them along.

Every file's first bytes are read, whatever its name: a program header (MZ/PE, ELF, Mach-O) is a danger under an image
or font name too. A file with a UTF-16 byte order mark is decoded (little and big endian) before it is read; NUL bytes
in another text or script file are dropped first (a shell drops them as well, and UTF-16 without a mark then reads as
its letters).

### 4.1 Safety → `ok` / `caution` / `danger` + reason codes

| Code | Level | What |
|---|---|---|
| `binary-files` | danger | a program or library (`.exe .dll .msi .jar .node …`, or an MZ/ELF/Mach-O header under any name, `.png` and `.woff2` included) |
| `permission-bypass` | danger | `--dangerously-skip-permissions`, `bypassPermissions` (an agent's `permissionMode`), `--allow-all-tools`, `--full-auto`, `--yolo` |
| `pipe-to-shell` | danger | `curl`/`wget` piped into `sh`, `bash`, `python`…; `iwr`/`irm` piped into `iex` |
| `invoke-expression` | danger | `Invoke-Expression`, a pipe into `iex`, `iex (…)` |
| `encoded-exec` | danger | `base64 -d` piped into a shell, `-EncodedCommand`/`-enc`/`-ec`, after `powershell`/`pwsh` any short form (`-e`, `-en`, `/enco` …), `FromBase64String … iex`, `eval(atob(…))` |
| `execution-policy` | danger | `Set-ExecutionPolicy Bypass` or `Unrestricted`, `-ExecutionPolicy Bypass` |
| `lolbin` | danger | Windows tools that fetch or unpack a payload: `certutil -urlcache`/`-decode`, `bitsadmin /transfer`, `mshta http…` |
| `persistence` | danger | something that starts by itself: `schtasks /create`, `Register-ScheduledTask`, `reg add …\Run`/`RunOnce`, `New-ItemProperty`/`Set-ItemProperty …\Run` |
| `settings-hook` | danger | a line that names `~/.claude/settings.json` or `settings.local.json` together with hooks or permissions (`hooks`, `permissions`, `"allow"`, `defaultMode`, `PreToolUse` …) |
| `frontmatter-hooks` | danger | `hooks:` of its own in SKILL.md or the agent file (see below) |
| `delete-everything` | danger | `rm -rf /`, `~`, `$HOME`, `*`; `Remove-Item -Recurse` on a drive or home; `format c:` |
| `skip-hooks`, `force-push` | danger | `--no-verify`; `git push --force`/`-f` (not `--force-with-lease`) |
| `weak-sandbox` | danger | `--no-sandbox`, `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false` |
| `injection` | danger | "ignore/disregard the previous instructions", "do not tell the user about this", "without telling the user", "here is your new system prompt", Turkish forms ("önceki talimatları yok say", "kullanıcıya söyleme") |
| `hidden-comment` | danger | an HTML comment in a document (outside a code block) that instructs the model |
| `hidden-chars` | danger | bidirectional overrides, Unicode tag characters |
| `script-files` | caution | scripts (`.sh .ps1 .bat .cmd .py .js .ts …`, a shebang) |
| `broad-shell` | caution | `allowed-tools`/`tools` grants Bash, PowerShell or a shell without a command pattern (or with `*`, `Bash(*)`) |
| `dynamic-command` | caution | in SKILL.md: `` !`command` `` at the start of a line or after a space, or a ` ```! ` block |
| `mcp-server` | caution | `mcpServers:` of its own in the frontmatter, `claude mcp add` (and codex, gemini, qwen), a `"mcpServers":` block |
| `start-process` | caution | `Start-Process` |
| `network` | caution | curl, wget, Invoke-WebRequest, requests, fetch('https…'), sockets |
| `secret` | caution | AWS, GitHub, Anthropic, OpenAI, Slack, Google key formats, private keys |
| `encoded-blob`, `invisible-chars` | caution | a 200+ character base64 run; zero-width characters (not the joiner of emoji) |
| `recursive-delete`, `force-flag` | caution | other `rm -r`, `rmtree`, `Remove-Item -Recurse`; `--force` |
| `vendored-folder` | caution | a `.git` or `node_modules` folder in the item: not copied, not read |
| `unreviewed-binary` | caution | an archive or disk image (`.zip .7z .rar .gz .tgz .tar .cab .iso …`) or another binary file (NUL bytes) that cannot be read (`.msi` stays a program: danger) |
| `large-file`, `not-reviewed`, `unreadable` | caution | a file read only in part, not read, or unreadable |

**Claude Code's own fields** (checked against code.claude.com/docs/en/skills and /sub-agents, 2026-09-29):
- `hooks` is a field of SKILL.md ("Hooks that Claude Code registers when the skill is invoked and keeps running for the
  rest of the session") and of an agent file ("Lifecycle hooks scoped to this subagent"). A hook runs its command on
  every matching event without any permission prompt, and a skill's hooks stay for the rest of the session; Claude Code
  itself ignores `hooks`, `mcpServers` and `permissionMode` in plugin agents "for security reasons". Hence **danger**:
  the page cannot tick such an item and the server refuses it. A person who wants it copies it by hand after reading it.
- `mcpServers` is a field of an agent file (a server name or an inline definition that starts a program): **caution**.
  SKILL.md has no such field; the key is still reported if it is there.
- `` !`command` `` and ` ```! ` blocks run through Claude Code's shell tool before the model sees the skill (their
  output replaces them); they never ask, they only pass the permission rules and `allowed-tools`, and
  `disableSkillShellExecution` turns them off. Only SKILL.md is rendered that way (not the other files of the folder):
  **caution** on SKILL.md.
- `allowed-tools` grants tools without asking for the turn that invokes the skill, whatever the workspace trust:
  `Bash`, `Bash(*)` and the like stay `broad-shell`.

False alarms kept down (each found on `anthropics/skills`), within strict limits:
- In a document, outside a code block, a danger weighs **caution** only when a word that says not to do it ("never",
  "do not", "avoid", "flag", "asla", …) stands **right before it in the same sentence**: at most 40 characters between
  the end of that word and the danger, and no `.`, `!`, `?` or `;` sentence end between them. A negation after it, far
  before it or in another sentence softens nothing.
- **Never softened**, whatever the words around them: `pipe-to-shell`, `encoded-exec`, `permission-bypass`,
  `persistence`, `settings-hook` (and `frontmatter-hooks`, which is not a line pattern). A warning in prose does not make
  the same command safe to copy along; the line is there all the same.
- An injection phrase weighs caution only inside a real pair of quotation marks (`"…"`, `` `…` ``, `“…”`) that closes
  after it; a single quotation mark at the start of a line quotes nothing.
- Advice such as "do not tell the user they need to …" is not concealment; an HTML comment inside a fenced code block
  is code the reader sees. A script is never softened.

A `danger` item cannot be ticked in the page and the server refuses it at import (`skip: review-danger`); its files
can still be looked at in the download. The reasons carry the first file and line (relative to the item) and a count.

### 4.2 License

The item's frontmatter `license` (an SPDX id or a well-known name; "Proprietary" terms; text that points to a file), a
license file in the item folder (`LICENSE`, `LICENCE`, `COPYING`, `UNLICENSE`, with `.md`/`.txt`), else the
repository's root license file. Texts are recognized by their words: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Zlib,
Unlicense, CC0-1.0, GPL-2.0/3.0, AGPL-3.0, LGPL-2.1/3.0, MPL-2.0, EPL-2.0, CC-BY(-SA/-NC/-ND)-4.0; "All rights
reserved"/"Proprietary" → `proprietary`; anything else → `unknown`. Families: permissive, copyleft, cc, proprietary,
unknown, **none** ("No license — personal use only; do not share it"). No license does not block the import: the
library is the person's own.

## 5. Which project does it fit

`createFit(...).projectsFor(items)` scores every item against every listed project whose folder can be read, with the
same tags, stack conflict rule and bands as the project fit (`scoreItem`), the project's saved idea included
(`project.idea`). Only `high` ("very good fit") and `medium` ("good fit") are listed; `installable` says the project can
take an install (`resolveProject`). An item has no installs or usage yet, so a shared primary stack plus a shared topic
(7 points) is usually "good fit"; "very good" needs more.

**Default selection** (`defaultSelected`): review `ok` (not caution), status `new`, no problem, and at least one
project with a good or very good fit. Items that fit no project are hidden behind "Show the ones that fit no project
too". A caution can be ticked by hand; a danger, an item the library already holds unchanged (`same`) or one with a
problem cannot. A `conflict` (another version in the library) needs "replace" ticked; nothing is written over silently.
Categories come from `proposeCategory`. Other places with the same name are shown: the SiberSentez kit (same content or
another version) and projects that hold an item of that name.

## 6. Actions

Same transport and layers as every action: Host → Origin → Sec-Fetch-Site → Content-Type → 4 KB body → token → field
allow list → validation → 3 s repeat limit → one writing action at a time (every GitHub action takes the writing lock in
live mode, a download included). English error codes; the page has a text for each (`ghErr_*`).

| Action | Body | Preview (dry) | On (live) |
|---|---|---|---|
| `github-fetch` | `{ url }` | `result: { executed: false, repo, ref, path, method (`tar`), fallback (`git` or null), hosts, target }`, no request | download, then `result: { executed: true, fetchId, repo, ref, path, commit, method, license, counts, truncated, items }` |
| `github-import` | `{ fetchId, items: [{ path, category, replace? }] }` (≤ 25) | the plan (from a download already there, else 404 `fetch-missing`) | copies through `planImport`/`executeImport`, rewrites `library/catalog.json`, writes provenance |
| `github-discard` | `{ fetchId }` | the plan (`remove download`) | deletes the download and its marker |
| `github-check-update` | `{ items: [{ kind, name }] }` | `check` or `skip: not-from-github` per item, no request | per item `up-to-date`, `update` (with `fetchId`, `path`, `category`, `changes`, `review`, `localChanged`), `unchanged`, `gone`, `not-from-github`, `not-in-library`, `error` |

Items in a fetch answer: `path` (in the repository), `kind`, `name`, `description`, `category`, `status`
(new/same/conflict), `problems`, `review { level, reasons }`, `license`, `fits`, `kit`, `inProjects`, `selectable`,
`selected`. No answer names a local path.

Status codes of the errors: 404 `not-public`, `ref-not-found`, `path-not-found`, `fetch-missing`; 502 `network`,
`fetch-failed`, `git-failed`, `redirect-refused`; 503 `rate-limited`; 504 `timeout`; 413 `too-large`,
`too-many-files`; 422 `tar-corrupt`, `tar-unsafe-path`; 409 `busy`, `record-broken`, `reparse-point`. Never 403 or
429 (the page reads those as "refused" and "asked again too soon").

## 7. Provenance (`registry/sources.json`)

Decision: **a file of its own**, not `library/catalog.json`. The catalog is generated from the library folders on
every import (name, kind, category, description) and a hand-made change in the folders is picked up without it; a
provenance column there would be lost or would need the generator to carry it. `sources.json` lives next to
`installs.json` and follows its rules: written atomically, rows this version cannot use are kept, a broken file is
never rewritten (`record-broken`).

```json
{ "version": 1, "sources": [ { "kind": "skill", "name": "theme-factory", "category": "design",
  "hash": "<sha-256 of the library copy>", "importedAt": "…",
  "source": { "type": "github", "repo": "anthropics/skills", "ref": null, "commit": "<40 hex>",
    "path": "skills/theme-factory", "license": { "spdx": "Apache-2.0", "family": "permissive" },
    "fetchedAt": "…", "review": { "level": "ok", "reasons": [] } } } ] }
```

A later GitHub import of the same item replaces its row; a local import that replaces it drops the row. The roster
item of a library copy carries `origin: { type, repo, ref, commit (7 hex), license, family, importedAt }` (no path, no hash;
`importedAt` only when the row carries a real date) when the row names the category the copy is in. The roster row shows "Source: owner/repo @ abc1234 · MIT"; the item's
drawer page shows the same line and adds "brought <day>".

## 8. Update check (only when pressed)

For a library item with a provenance row: the latest commit of its repository and ref (`git ls-remote`, or the API).
The same commit → up to date, **nothing downloaded**. Another commit → a download of it (reused by the other items of
the same repository in the same request), then the files of the item's folder compared with the library copy
(`added`, `removed`, `modified`, at most 50 listed). "Apply the update" is `github-import` with `replace: true` — the
existing replace rule, the library copy's hash checked again right before it is replaced — and the row gets the new
commit. `localChanged` says the library copy changed by hand since the import (its hash differs from the recorded one):
the page warns that applying replaces those changes. A download no update needs is deleted at once. There is no
automatic check.

## 9. The page

Roster → "Add to the library": two tabs, **From my computer** (the folder import as before) and **From GitHub**.
Off: each tab says how to turn actions on (the section is shown in every mode now). The GitHub tab has four numbered
steps, each with one plain sentence: paste a link; look and choose (per item: safety badge with the first reason and
all reasons with file and line on hover, license badge with its warning, fitting projects with their fit, status and
category); add to the library ("Add the selected", "Cancel (delete the download)"); install into a project (one
button per project, `skills-install` with the default targets of the project, after which the summary names what was
installed and skipped). Below: "Brought from GitHub" with "Check for update" per item.

**Trust line** (`public/js/githubTrust.js`), under the download's summary, so a beginner sees why the list can be
trusted and how far: the source as a link to `github.com/<owner>/<repo>/tree/<commit>` (the very commit that was read;
the repository name is checked against GitHub's name rules before it becomes a link), the last change ("Not changed
for a long time" past 365 days; "unknown" when no time was found), "Nothing was run: the files were only read", and
"Scanned without running" with a "?" that says what the scan looks for and that it cannot catch everything (read the
SKILL.md, above all of the items marked Check first). The commit time is `committedAt` in the fetch result and in the
incoming marker: from the archive, the newest entry time (git archive stamps every entry with the commit's time); from
git, `git show -s --format=%ct HEAD` (a failure leaves it unknown). Only a date between 2005 and a day from now passes.

QA hooks (`qaImportHooks` in `public/js/views/roster.js`): `?qa=1&tab=roster&github=<link>` puts the link in the
field and fetches it **only in Preview** (the plan, no request); `?qa=1&import=<folder>` likewise scans only in Preview.
In live mode and Off a hook sends no action at all: the server lets any page open `/?…` (a document navigation), so a
hook that downloaded in live mode would let another site start a download. `github=demo` and `github=demo-done` fill
the tab with a sample answer (no request, any mode). The other QA hooks of the page (`pick`, `flow`: Preview only;
`newproject`, `actpanel`: stand-ins; `aitools`: reads `GET /api/tools`) send no live action either
(`test/hardening.test.mjs`).

## 10. Real run (2026-09-29, scratch hub only)

`https://github.com/anthropics/skills` @ `8a1541c`: git 430 files, 11.7 MB in about 6 s; the archive path the same 430
files, byte for byte, in 1.7 s. 20 skills: 9 safe, 11 caution (scripts, network, folder deletes), 0 dangerous after
the false-alarm rules (before them: 2, both false). Licenses per item: Apache-2.0 (most), proprietary (docx, pdf,
pptx, xlsx), none (2); the repository root has no license file. 4 fit the listed projects; 1 was pre-selected. Three
were imported (provenance written, roster origin shown), the update check answered "up to date" without a download.

Again after the first security review round (same commit, archive path, throwaway hub deleted afterwards): 1.7 s, id
`anthropics-skills-f2db84@8a1541c4a3ff`; 9 safe, 11 caution, **0 dangerous** with the stricter rules (negation only
right before, never-soft patterns, closed quotation marks). New: `web-artifacts-builder` ships
`scripts/shadcn-components.tar.gz`, now named (`unreviewed-binary`) instead of passing unread.
