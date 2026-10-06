---
name: debug-helper
description: "Finds and fixes a bug step by step: the exact error, a reproduction, the cause with evidence, a root-cause fix, a try-out the way the user uses the program, and a regression test. Use when something crashes, throws an error, gives wrong results, worked before and broke, or the user says it does not work. Build errors: fix-build-errors."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "debugging, testing"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "hata ver*, hatası, çalışmıyor, bozuldu, çöktü, çöküyor, hata ayıkla*, sorunu bul*, düzelt*, açılmıyor"
---

# Debug helper

Evidence first, fix second. Guessing at fixes wastes time and hides the real cause. Keep the user informed: what you
know, what you are checking next, and why.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Collect the facts

Ask for what is missing, one question at a time:

- the **exact** error text, copied in full (a screenshot is fine, but text is better);
- what they did, what they expected, what happened instead;
- since when, and what changed around then. `git log --oneline -10` and `git diff` often answer this.

## 2. Reproduce

Find the shortest reliable way to make the problem happen: a command, a test, or numbered clicks. Write the steps
down. If it cannot be reproduced, say so and add logging around the suspected area so the next occurrence leaves
evidence.

## 3. Read the error

- In a stack trace, the top lines are often inside a library. Find the **first line that points into the project's
  own code**: that is where to start.
- Explain the message in plain words ("the program tried to use something that was empty").

## 4. Narrow down

1. Write 1-3 possible causes. Check the cheapest one first.
2. Add temporary logging or prints of the values that matter; run again; read the output.
3. Halve the search space: disable half of the new code, or compare with the last version that worked. For "it worked
   last week", offer `git bisect` and explain it before running it.
4. Check the surroundings: the right folder and terminal, saved files, environment variables, runtime and package
   versions, configuration, and whether a dev server needs a restart after a config change.

After three disproved guesses, stop and summarize the evidence for the user, then decide the next step together.

## 5. Fix the cause

- Fix where the problem starts, not where it shows up.
- Do not hide it: no empty `catch`, no retry loop or sleep to paper over timing problems, no silenced warnings.
- Keep the fix as small as possible.

## 6. Try it the way the user uses it

The error going away is not the goal; the program working for the user is. After the fix, use the program the way
the user does and look at the result: open the page and check that its content appears, call the route the page
calls, run the command they run, press the button they press. A second fault often hides behind the first one (the
server starts now, but the page asks a wrong address and shows nothing). If you cannot do this yourself (no browser,
no access), say exactly what is untested and give the user two or three steps to check it, with what they should see.

## 7. Keep it fixed

- Add a regression test that fails without the fix and passes with it (the `test-first` skill describes how).
- If a test is not possible, write down the manual check.
- Remove the temporary logging. Run the whole test suite.

## 8. Explain

Tell the user in a few sentences: the cause, the fix, how it was verified, and how to avoid it next time.

## Frequent causes for beginners

- The command ran in the wrong folder, or in a terminal opened before a tool was installed.
- The file was not saved, or the dev server was not restarted after changing configuration or `.env`.
- A package is missing or has a different version than the code expects (run the install command again).
- A name differs in upper or lower case, or a path contains spaces and is not quoted.
- The port is already used by another copy of the program that is still running.
- An old build or cache is used (`.next/`, `dist/`, Unity's `Library/`). Clearing a cache deletes files: ask first.
- Two versions of the same runtime are installed and the wrong one runs (`where.exe node`, `where.exe python` on
  Windows; `which` on macOS and Linux).

## Do not use for

- A build, compile or type error before the program even starts: use `fix-build-errors`.
- Making working code cleaner: use `refactor-safely`.
- A task in a team job that a reviewer sent back: the conductor hands it to the `debugger` agent.

## Done when

- The cause is named with its evidence, and the fix changes the cause, not the symptom.
- The user's own way of using the program was tried after the fix (page, route, command, button) and its result is
  shown, or what is untested is said plainly with the steps for the user.
- A regression test fails without the fix and passes with it, or the manual check is written down; the temporary
  logging is gone.
