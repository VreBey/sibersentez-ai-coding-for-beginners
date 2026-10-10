---
name: finish-branch
description: "Closes finished work on a git branch: runs the tests fresh, then offers three choices, merge into the main branch, open a pull request on GitHub, or leave the branch for now, with a yes for every step. Use when the user says the work is done, let's merge, open a pull request, or what do I do with this branch."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "git, release"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "iş bitti, dalı birleştir*, dalı kapat*, pull request*, pr aç*, birleştirip, ana dala"
---

# Finish branch

The work on a branch is done. This skill checks it and then asks what to do with it. Nothing is merged, pushed or
deleted without a separate yes. For the basics of git, see `git-basics`.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Where are we?

Run `git status` and `git branch --show-current`, and find the main branch (`main` or `master`). Tell the user the
branch name in one sentence. If `git status` lists changes, show them and ask: save them in a commit first
(`git-basics`), or stop.

If it is already the main branch (a common start for beginners), there is no branch to merge. Say so, and offer
two ways forward, each step with its own yes:

- Open a new branch for the next piece of work (`git-basics`); or
- save the changes straight into the main branch with a commit, and push only if the user wants it (a separate yes,
  after saying what will be sent).

If the folder is not a git repository at all, say "no git here" and offer to start with `git-basics`.

## 2. Check it fresh

Follow `verify-before-done`: run the project's tests and checks now, in this step, and show their output. Old results
do not count. If anything fails, stop and say what failed; do not offer the choices below until it is fixed (use
`debug-helper`). A project with no tests: say so, and run a build or the app's start command instead.

## 3. Three choices

Show what would go in: `git log <main>..HEAD --oneline` and `git diff <main> --stat`. Then ask:

1. **Merge into the main branch** here, on this computer. Choosing it is the yes for the merge itself; the steps
   after it ask again.
2. **Open a pull request** on GitHub, so it can be looked at first.
3. **Leave it on the branch** for now. Nothing changes.

Recommend one in a sentence (a pull request when other people work on the project), but the user chooses. Each
action below needs its own yes.

### Merge

1. `git status` must be clean. If not, stop.
2. `git switch <main>`, then `git merge <branch>`. If the remote is ahead, `git pull` first (a yes).
3. If git reports a conflict, stop. Say in plain words which files clash and what that means, and offer
   `git merge --abort` to go back to how it was. Never pick a side for the user.
4. Run the tests again on the merged result and show the output. If they are red, stop: do not push. Say in plain
   words what broke and that the merge is the likely cause. Offer to undo it with a new commit that reverses the
   merge (`git revert`, with `-m 1` for a merge commit, only after a yes), and never a command that erases
   history. Or offer to look for the cause first (`debug-helper`). The user chooses.
5. Pushing the main branch is a separate yes: say what will be sent (`git log origin/<main>..HEAD --oneline`).

### Pull request

1. Push the branch: say what will go, get a yes, then `git push -u origin <branch>`. Never ask for a password or
   token in the chat.
2. If `gh` is installed (`gh --version`): with a yes, `gh pr create --title "..." --body "..."`. Write the title and
   a short body (what changed, how it was checked) in the user's language and show them first.
3. If `gh` is not there: tell the user the steps on the website. Open the repository on github.com, press "Compare &
   pull request" for the branch, fill the title and description you drafted, press "Create pull request".

### Leave it

Say the branch name and how to come back: `git switch <branch>`. Mention that unpushed work exists only on this
computer.

## 4. Tidy up (its own yes)

After a merge or once the pull request is merged, ask separately: "Delete the branch <name>?" Only after a yes, use
`git branch -d <name>`. If git refuses because the branch is not merged, stop and explain; never use a stronger
delete. Deleting the copy on GitHub is the user's choice: offer it, do not do it unasked.

## Do not use for

- Saving a commit or making a branch: use `git-basics`.
- Version number, changelog, release notes: use `release-prep`.
- Putting the site online: use `deploy-web`.
- Checking the code before it is done: use `review-changes`.

## Done when

- Fresh test or check output was shown before any choice was offered.
- The user chose one of the three, and each step (merge, push, pull request, delete) had its own yes.
- The result is shown: `git status`, `git log --oneline -3`, or the pull request address.
- You told the user in one sentence where the work is now.
