---
name: git-basics
description: "Explains and runs everyday git steps one at a time: see what changed, save a commit, make a branch, undo a change safely, and put the project on GitHub. Use when the user asks about git or GitHub, wants to save or upload their work, made a mistake and wants to go back, or does not know what a commit or a branch is."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "git"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "git nedir, github nedir, github a nasıl yükle*, github hesabı, commit*, branch*, dal aç*, geri al*, değişiklikleri kaydet*, sürüm kontrol*, git kullan*"
---

# Git basics

Git is a save-point system for a project folder. This skill teaches it while doing it: say what a command does
before you run it, and show what changed after. Command list and links: [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## The idea in four lines

- The **working folder** holds the files you edit.
- The **staging area** holds what goes into the next save point.
- A **commit** is a save point with a message. You can always come back to it.
- A **remote** (for example GitHub) is a copy online. **Push** sends commits there, **pull** brings them back.

## Start: is this a git project?

Run `git status`. If it says "not a git repository", explain and offer `git init` (a yes first). Then check
`git config user.name` and `git config user.email`: git needs both to sign commits. Ask the user what to use and set
them for this project only (`git config user.name "..."`); an e-mail address is personal data, so do not guess one.

## What does the user want?

| The user says | Do this |
|---|---|
| "What did I change?" | `git status`, then `git diff` (unsaved changes) |
| "Save my work" | Commit, see below |
| "Try something risky" | Make a branch: `git switch -c try-something`; go back with `git switch main` |
| "I broke a file" | Undo one file, see below |
| "Go back to how it was" | Ask how far. One file: `git restore`. A saved step: `git revert` |
| "Put it on GitHub" | Upload the first time, see below |
| "What happened before?" | `git log --oneline -10`, and `git show <id>` for one commit |

## Commit (a yes each time)

1. `git status` and show the list of changed files. Look for files that must not be saved: `.env`, keys, `node_modules`,
   big or personal files. If one is there, stop and fix `.gitignore` first (the `env-and-secrets` skill).
2. Add the files: `git add <file names>`. Adding everything (`git add -A`) is fine only after step 1.
3. `git commit -m "feat: add the note list"`. The message says what and why in one short line. A prefix such as
   `feat:`, `fix:` or `docs:` helps; the rest may be in the user's language.
4. Show the result with `git log --oneline -3`.

## Undo, from safest to riskiest

| Situation | Command | Note |
|---|---|---|
| Wrong file added, not yet committed | `git restore --staged <file>` | keeps the edits |
| Edits in a file are unwanted | `git restore <file>` | **loses** those edits: show `git diff <file>` and get a yes first |
| A commit was wrong, already shared | `git revert <id>` | adds a new commit that cancels it; safe |
| Last commit has a wrong message, not shared | `git commit --amend` | rewrites that commit: ask first |

Commands that throw work away or rewrite shared history (a hard reset, cleaning untracked files, rewriting pushed
commits) are not part of this skill. If the user needs one, explain what would be lost, name the backup they can
make first (copy the folder), and ask for a yes; a leaked key is a different job (`secrets-cleanup`).

## Put it on GitHub (first time, yes for each step)

1. The user creates an empty repository on github.com (no README, no license) and sends you its address.
2. `git remote add origin <address>`, then `git branch -M main`.
3. `git push -u origin main`. A browser window may ask the user to sign in: they do that themselves. Never ask for
   a password or token in the chat, and never put one in a command.
4. Check with `git status -sb` and by opening the repository page.

**Before the first public push** (a public repository is copied and indexed within minutes):

- Search the tracked files (`git ls-files`) and the history for keys, `.env` files, personal email addresses, local
  paths with the user's name, and names of their other private projects. Ask the user which names are private.
- Commit as GitHub's private address (GitHub, Settings, Emails, "Keep my email addresses private"):
  `git config user.email <id>+<user>@users.noreply.github.com` in this repository.
- If the history holds something that must not be public, publish a fresh copy with one first commit instead of the
  history (needs a yes; the private history stays on the user's computer).
- GitHub may refuse a push that contains something shaped like a key, even a fake one in a test. Change the test so the
  value is built from parts; never turn the protection off.
- A `.gitattributes` with `* text=auto eol=lf` keeps line endings the same for everyone who clones it.

Later pushes are `git push`. Before pushing, say what will be sent (`git log origin/main..HEAD --oneline`).

## Pull requests

A pull request is a request on GitHub to bring the commits of one branch into another, usually `main`. It gives
people (or you, later) a page to read the changes before they are merged. Use one when others work on the project,
when you want a second look, or when the project asks for it; working alone, a plain merge is fine. Opening one
needs the branch pushed first (a yes). The full checked flow, with `gh` or in the browser, is the `finish-branch`
skill.

## Do not use for

- Closing finished work on a branch (merge, pull request): use `finish-branch`.
- Publishing a version with a changelog: use `release-prep`.
- A key or password that was committed: use `secrets-cleanup`.
- Running tests on every push: use `github-actions-setup`.
- Setting up a new project from scratch: use `project-setup`.

## Done when

- The commands you ran and their output are shown (for example `git status` clean, `git log --oneline -3`).
- Nothing risky was saved (`.env`, keys), and every push or undo had a yes.
- You told the user in one sentence what state the project is in now and how to get back to it.
