---
name: dependency-update
description: "Brings out-of-date packages up to date safely: lists what is old, updates one package at a time with the tests run after each, commits each step so it can be undone, reads release notes before big jumps and runs a vulnerability scan. Use when packages are old, a scan reports a known weakness, or the user wants updates."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "security, devops"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "paketleri güncelle*, eski paket*, bağımlılık*, paket güncelle*, güncel değil, kütüphaneleri güncelle*, güvenlik taraması"
---

# Dependency update

Packages are code written by other people. Old ones collect known security holes; updating everything at once breaks
things and hides which update caused it. Go slowly: one package, one test run, one commit, so any step can be undone.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote. Updating a package downloads code: each update needs a yes.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never run the commands that update everything at once or fix a scan's findings automatically. They jump major
  versions without telling you.

## 1. Start from a clean, green state

1. `git status` shows nothing uncommitted (or the user agrees to commit it first: `git-basics`).
2. Run the tests and the build now. If they fail, stop: fix that first (`fix-build-errors`). You cannot judge an
   update against a project that is already broken.
3. Find the package files: `package.json` with its lock file, `requirements.txt`, `*.csproj`, and so on. The lock
   file is committed: it is the way back.

## 2. List what is old and what is risky

| Ecosystem | Old packages | Known weaknesses |
|---|---|---|
| npm | `npm outdated` | `npm audit` |
| Python | `pip list --outdated` | `pip-audit` (installing it needs a yes) |
| .NET | `dotnet list package --outdated` | `dotnet list package --vulnerable` |

Put the result in a table: package, now, wanted, latest, jump (patch, minor or major), and what the scan said. Explain
in plain words: patch is a small fix, minor adds things, major may break things.

## 3. Choose the order

1. Packages with a **security finding** first, smallest safe jump that fixes it.
2. Then patch and minor updates, one by one.
3. Major updates last, each alone. Read the package's official release notes or upgrade guide first and tell the
   user what changes for the project. Skip a major update that needs a big rewrite and note it as a later task.

## 4. One package at a time

For each package, after a yes:

1. Update only that package (and its direct partners that must move together, for example a framework and its
   plugin), using the ecosystem's own command for a single package.
2. Run the tests, the build, and start the app once. Show the results.
3. Green: commit with a clear message such as `chore: update <package> from <old> to <new>`.
4. Red: read the first error. One honest attempt to adapt the code is fine. If it is not simple, go back to the last
   commit (ask before changing git state), and write the package, versions and the reason into a short
   `DEPENDENCIES.md` so nobody retries it blindly.

## 5. Scan again and report

Run the vulnerability scan again. Show a short table: the scan before and after, what was updated, what was skipped
and why. Remaining findings with no fix yet: say so, and what the options are (a different package, a workaround,
waiting).

## 6. The way back

Explain: every update is its own commit, so `git revert <commit>` undoes one of them, and the committed lock file
brings back the exact versions. Never rewrite history to hide a bad update.

## Do not use for

- A whole-project security review: use `security-check`.
- A build that fails for another reason: use `fix-build-errors`.
- Choosing a new package or a different tool: use `tech-stack-chooser`.

## Done when

- The tests and build were green before the first update (shown) and after each kept update (shown).
- Each update is its own commit; skipped ones are written down with the reason.
- The scan ran before and after, and both results are in the table.
- You told the user in one sentence what changed, what was skipped and what to look at next.
