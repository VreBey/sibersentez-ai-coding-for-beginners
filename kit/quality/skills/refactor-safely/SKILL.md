---
name: refactor-safely
description: "Cleans up messy code without changing what it does: one goal at a time, tests as a safety net, small steps, and a check after every step. Use when the user says the code is messy, too long, repeated or hard to read, wants it reorganized or simplified, or wants to tidy up before adding something new."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "refactoring, testing"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "yeniden düzenle*, kodu temizle*, dağınık kod, karmaşık kod, sadeleştir*, tekrar eden kod, refactor*"
---

# Refactor safely

Refactoring means changing how code is written, not what it does. The rule: behavior stays exactly the same, and
something proves it after every small step.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Pick one goal

Ask what bothers the user, and turn it into one goal: "split the 400-line `App` file", "remove the copy-pasted
price calculation", "give the unclear names better ones". Refuse a goal like "clean everything": pick the worst
spot first. Say which files are in scope and which stay untouched.

## 2. Make sure there is a safety net

1. Run the project's tests and note the result ("42 passed"). Failing tests before you start must be fixed or
   noted first, otherwise you cannot tell what you broke.
2. No tests around the code you will change? Write a few tests that pin down what the code does today, even when
   it is odd (the `test-first` skill shows the method). If that is not possible, write a short manual check list
   the user can run, and do it before and after.
3. Check `git status`. Uncommitted work should be committed or set aside first; ask the user which.

## 3. Work in small steps

One kind of change per step, in this order of safety:

1. Rename a name that misleads (all uses together).
2. Extract a repeated block into one function, then use it.
3. Split a long function or file into parts with clear names.
4. Simplify a condition or remove a needless variable.
5. Remove code nothing uses. Prove it first by searching for its uses; deleting needs a yes.

After **each** step: run the tests (and the build or lint if the project has them). Green means go on. Then offer a
commit (ask first): one step, one commit, so any step can be undone alone.

## 4. If something turns red

Stop. Do not fix forward. Show the failing test, undo the last step (restoring files discards work, so ask first),
and try a smaller step. If a test fails for a reason the old code also had, tell the user; that is a bug for the
`debug-helper` skill, not for this one.

## 5. Keep it pure

- No new features and no bug fixes inside a refactoring step. Write them down for later.
- No new libraries. No formatting sweeps over files you do not otherwise touch.
- Keep public names, file locations and data formats unless the goal says to change them and the user agreed.

## 6. Show the result

Say in a few lines: what got simpler, using numbers where you can ("the file went from 400 to 3 files of about 120
lines"), and confirm that tests before and after show the same passing count.

## Do not use for

- Something is broken or gives wrong results: use `debug-helper`.
- The build does not pass: use `fix-build-errors`.
- A new feature: use `feature-spec`, then `task-breakdown`.
- Understanding unfamiliar code first: use `explain-codebase`.
- A review of the finished change: use `review-changes`.

## Done when

- The tests (and build or lint) ran before the first step and after the last one, with the same or a higher passing
  count (quote both results).
- `git diff --stat` or the commits show only files that were in scope.
- No new feature or fix is mixed in, and every removal was approved.
- You told the user in one sentence what is cleaner now and that behavior did not change.
