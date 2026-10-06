---
name: fix-build-errors
description: "Works through build, compile, type and lint errors one at a time starting with the first, explains each in plain words, fixes the cause and runs the build again until it is clean. Use when the project does not compile or build, the terminal shows a wall of red errors, a type or lint error blocks progress, or an update broke the build."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "debugging"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "derle*, build hata*, tip hatası, lint hata*, kırmızı hata*, tsc, paket hatası"
---

# Fix build errors

A long list of errors looks scary but is usually a few real problems. Fix the first one, run again, and the list
often shrinks by itself. Explain every error in plain words as you go. Typical messages are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Find the right command

Do not guess. Look at the project: the `scripts` in `package.json` (`build`, `lint`, `typecheck`), a `.sln` or
`.csproj` file (`dotnet build`), the README. If several exist, ask which one fails for the user. For a game engine
that shows errors in its own window, ask the user to copy the first red message from its console.

## 2. Run it and read the summary

Run the command once. Do not paste the whole output to the user. Say: how many errors, in how many files, and which
one comes first in the output. Note the exact first message and its `file:line`.

## 3. Work from the first error

Later errors are often caused by the first one (a missing name makes every use of it fail). For each error:

1. Quote the message and say what it means in plain words ("the code uses `title`, but the type has no such field").
2. Open the file at that line and read the surrounding code, not only the line.
3. Fix the cause with the smallest change: correct the name, the type, the import or the call. Do not rewrite.
4. Run the build again after each fix, or after a small group of the same kind. Report the new count ("12 errors
   became 5").

## 4. Fixes that are not allowed

The goal is a build that is clean for the right reason.

- No silencing: no `any` to skip a type, no "ignore this line" comment, no turning a lint rule off, no lowering the
  strictness setting, no deleting a failing test.
- If a suppression is truly right (a known wrong warning), explain why, ask, and leave a comment saying why.
- A missing or wrong package version: say which one, and ask before installing or updating anything.
- Errors inside downloaded packages (`node_modules`, `Library/`) mean a version or cache problem, not code to edit.

## 5. Know when to stop

- The same error survives three different fixes: stop, show the evidence (message, what you tried) and decide the
  next step with the user.
- The fix needs a design decision (change a public function, a data shape): describe the two choices and ask.
- A clean build with failing behavior is a different job: use `debug-helper`.

## 6. Final check

Run the build command once more, then the tests if the project has them (`test-first` explains tests). Both must
pass. If lint and type checks are separate commands, run each.

## Do not use for

- The program builds but gives wrong results or crashes when running: use `debug-helper`.
- The code works but is messy: use `refactor-safely`.
- Reviewing a change before committing: use `review-changes`.
- A test that fails on purpose (red first): use `test-first`.

## Done when

- The build command finished with no errors (name the command and quote its last lines).
- Lint or type check and tests were run too when they exist, and their result is stated.
- No error was hidden: `git diff` shows no new ignore comments or loosened settings (say you checked).
- You told the user in one sentence what was wrong, how many errors there were, and what you changed.
