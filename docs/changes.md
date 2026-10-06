# What changed

After an AI tool worked, a beginner wants to see what it did. The project drawer's "What changed" section (below
"How to run it") lists the files it created or changed, newest first, at most 12 (the server reads at most 30).

## Server (`server/changes.mjs`, `GET /api/projects/<id>/changes`)

Read-only, no action mode needed, the usual API access rules. The same folders as "How to run it" are read (never a
missing, broad, temporary or network folder; `via: null` and the section is not shown).

- **A git repository** (a `.git` in the folder): `git status --porcelain=v1 -z --untracked-files=all`, stopped after
  30 entries: new (`??`, `A`), changed, deleted, renamed or copied (its old path skipped). Each listed file's change
  time sorts them; a deleted file goes last.
- **A folder without git:** the files changed in the last 24 hours by their change time. Links are never followed;
  hidden folders and packages, builds, caches, virtual environments and engines' generated folders (`SKIP_DIRS`) are
  not walked; at most 5000 entries and 6 levels.

Answer: `{ project, via: 'git' | 'time' | null, files: [{ path (relative, backslashes), kind: 'new' | 'changed' |
'deleted' | 'renamed', t? }], more }`.

## Git safety (every git call of the server)

`server/git.mjs` `GIT_SAFE_ARGS`: `--no-optional-locks` (no index refresh, no index.lock) and
`-c core.fsmonitor=false`. A repository's own `.git/config` can name a program as its file system monitor, and a
plain `git status` starts it: a folder received as an archive with such a `.git` would run code just by being
watched (the git watcher reads every project every two minutes). `test/changes.test.mjs` shows that a plain status
runs it with the installed git and that SiberSentez's does not. The GitHub import already set it (docs/github-import.md).

The flags cannot cover everything: the repository names its own filters, text converters and signature programs.
Seen with the installed git: `git status` with the flags above still starts a clean filter (`[filter "x"] clean =
...` with `*.txt filter=x` in .gitattributes) when a file changed without changing its size. So before any git call
`repoConfigSafe(dir)` checks the repository (a real `.git` folder with `HEAD`, `objects` and `refs` of its own and no
`commondir`, which would make git read another folder's config) and reads its `config` and `config.worktree` (at
most 64 KB each) with git's own parser, which runs nothing (`git config --file <f> --no-includes --list --name-only`;
a text pattern missed two section headers written on one line, `[core][filter "a"] clean = ...`, review round 1): a `[filter]`, `[include]`, `[includeIf]`, `[gpg]` or `[diff]` section, or a `fsmonitor`,
`showSignature`, `program`, `textconv`, `command`, `sshCommand`, `clean`, `smudge`, `process`, `hooksPath` or
`worktreeConfig` key, and git is not run there at all: the git watcher marks the project (`git.unsafe`; the drawer says
"not read: this repository's own settings could make git start a program") and "What changed" answers from the change
times (`gitSkipped: true`). A `.git` file (a worktree or a moved git folder) points elsewhere and is not given to git
either. Every call names the repository and its work tree (`--git-dir`, `--work-tree`), so git never looks for one elsewhere
(the project folder as a bare repository, a parent folder) and `core.worktree` cannot move it. Status also skips
submodules (`--ignore-submodules=all`), and `log.showSignature=false` keeps a signed commit
from starting a signature program. Ordinary repositories (remotes, branches, submodules) pass: checked on the
repositories of this machine.

## Page (`public/js/changes.js`)

Kept per project, asked again after 20 s. Each line: the kind (New, Changed, Deleted, Moved), the path (escaped), how
long ago. Empty: "Nothing changed since the last commit" (git) or "No file changed in the last 24 hours".
