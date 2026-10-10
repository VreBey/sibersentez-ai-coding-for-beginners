---
name: review-changes
description: "Reviews the current changes (uncommitted work, a branch or a pull request) against a checklist for correctness, tests, security, data safety and readability, and reports findings as blocker, should fix or nice to have. Use when the user is about to commit or merge, asks for a code review or second look, or asks if a change is safe."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "code-review"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "incele*, kod inceleme, gözden geçir*, değişiklik*, ikinci göz, birleştirmeden önce, kontrol et*"
---

# Review changes

Look at what changed with fresh eyes and tell the user, in plain words, what must be fixed, what should be fixed and
what is fine. A review reads and runs checks; it does not rewrite the code unless the user asks.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Find what changed

- Uncommitted work: `git status`, `git diff` and `git diff --staged`.
- A branch: `git diff main...HEAD` (use the project's main branch name) and `git log main..HEAD --oneline`.
- Not a git project: ask which files to review.

Read each changed file around the change, not only the changed lines, and the tests that cover it.

## 2. Understand the intent

Find out what the change is meant to do from the commit message, `TASKS.md`, or the user. If it is still unclear,
ask one question before reviewing. A change can only be judged against its goal.

## 3. Go through the checklist

- **Correctness**: does it do what was intended? Edge cases: empty, missing, zero, negative, very long, duplicate,
  two at the same time. Error paths handled? Every asynchronous call awaited? Off-by-one in loops and ranges?
- **Tests**: is the new behavior tested? Run the test command and report the result. Was any test deleted,
  skipped or weakened?
- **Security**: secrets in code, config or logs? Outside input validated on the server side? Queries built with
  parameters, HTML escaped, no shell command or file path built from user input? New dependencies well known and
  maintained?
- **Data**: can this lose or corrupt user data? Is a data or schema change reversible? Are deletes intended?
- **Readability**: clear names, no dead or commented-out code, no function doing five jobs, no copy-pasted blocks.
- **Consistency**: follows the project's existing style, structure and patterns.
- **Scope**: every changed line serves the intent of step 2. Working code rewritten in another style, options
  added "for later" or checks for cases that cannot happen are a should fix, and a blocker when they hide the real
  change or put it at risk.
- **User side**: error messages a person can understand, texts translated if the app is multilingual, keyboard
  and screen reader basics for UI.
- **Performance**, only when obvious: network or database calls inside loops, loading everything into memory,
  work repeated on every frame or render.

Also run the project's fast checks if they exist (lint, type check, tests) and include the results.

## 4. Report

Use this shape. At most about ten items; group similar ones.

```
Review: <what was reviewed>
Verdict: ready | ready after fixes | not ready

Blocker (fix before merging)
1. path/to/file.ts:42 - <problem> - <why it matters> - <suggested fix>

Should fix
Nice to have
Good (1-3 things done well)
Checks run: <command> -> <result>
```

- **Blocker**: wrong result, crash, data loss, security hole, failing tests.
- **Should fix**: likely bug in an edge case, missing test for new behavior, confusing code others will trip over.
- **Nice to have**: naming, small cleanups, style.

If nothing is wrong, say so plainly, and say what you checked (the checklist areas and the commands with their
result): "nothing found" is only worth something next to what was looked at. Do not invent findings to fill the
list.

## 5. After the review

Offer to fix the blockers one by one, each after a yes, re-running the checks after every fix.

## Avoid

- Vague remarks ("this could be better") without a file, a line and a reason.
- Burying the one serious problem under twenty style notes.
- Changing code, committing or switching branches during the review.
