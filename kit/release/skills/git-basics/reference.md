# Git basics: reference

Checked 2026-09-30 against the official documentation (revisit every six months): https://git-scm.com/docs
(command reference), https://git-scm.com/book (free book) and https://docs.github.com/en/get-started (GitHub).
If a command behaves differently on the user's version, check the page of that command.

## Everyday commands

| Goal | Command |
|---|---|
| See the state of the folder | `git status` (short form: `git status -sb`) |
| See unsaved changes | `git diff`; staged ones: `git diff --staged` |
| Stage files | `git add <file>` |
| Save a commit | `git commit -m "message"` |
| List recent commits | `git log --oneline -10` |
| Show one commit | `git show <id>` |
| List branches | `git branch` |
| Make a branch and move to it | `git switch -c <name>` |
| Move to an existing branch | `git switch <name>` |
| Bring a branch into the current one | `git merge <name>` (ask first) |
| Delete a merged branch | `git branch -d <name>` (ask first) |
| Send commits online | `git push` |
| Get new commits from online | `git pull` |
| Copy an online project | `git clone <address>` |

## Undo

| Goal | Command |
|---|---|
| Unstage a file, keep the edits | `git restore --staged <file>` |
| Throw away edits in a file | `git restore <file>` (loses them) |
| Cancel a commit with a new commit | `git revert <id>` |
| Change the message of the last commit (not shared) | `git commit --amend` |
| Put unfinished work aside | `git stash`, bring it back with `git stash pop` |

## First upload to GitHub

```
git remote add origin <address of the empty repository>
git branch -M main
git push -u origin main
```

Signing in happens in the browser or in the credential window of git. On Windows, Git for Windows ships a
credential manager; on other systems follow GitHub's guide for caching credentials. Do not paste tokens into
commands or into the chat.

## Messages that confuse beginners

| Message | Meaning and what to do |
|---|---|
| `not a git repository` | the folder has no git yet, or you are in the wrong folder: check the path, or `git init` after a yes |
| `Please tell me who you are` | set `user.name` and `user.email` for this project (ask the user) |
| `nothing to commit, working tree clean` | everything is saved already |
| `Your branch is ahead of 'origin/main' by 2 commits` | two commits are not pushed yet |
| `rejected ... fetch first` or `non-fast-forward` | the online copy has commits you do not: `git pull`, look at the result, push again; do not overwrite it |
| `CONFLICT` during merge or pull | two changes touch the same lines: open the marked file, choose the final text, remove the marker lines, `git add`, commit; ask the user before choosing for them |
| `detached HEAD` | you are looking at an old commit: `git switch main` returns to normal |
| `Permission denied` or `Authentication failed` | sign-in problem: the user signs in again through the browser window; never share a password with the AI |

## What should not be committed

`.env` and other key files, `node_modules/`, build output, big videos or datasets, personal files. They go into
`.gitignore`; already committed keys are a job for `secrets-cleanup`.
