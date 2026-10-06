---
name: test-first
description: "Writes a failing automated test before changing code, watches it fail, makes the smallest change that passes it, then runs the whole suite again (red, green, clean up). Use when adding a feature or fixing a bug in code that has or can have tests, when the user asks for tests or safer changes, or before a risky refactor."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "testing"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "test*, birim test*, sına*, önce test, bozulmasın, güvenli değişiklik"
---

# Test first

A test is a small program that checks your program. Writing it **before** the change proves the change works and
keeps it working later. Explain this to the user in one sentence the first time.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Find the test setup

- Look for existing tests (folders such as `test/`, `tests/`, `__tests__/`, files ending in `.test.ts` or
  `_test.py`, Unity `Tests` assemblies) and for the command that runs them (the scripts in the manifest, a README
  section, CI files).
- No tests yet? Propose the usual tool for the stack and ask before installing it:

  | Stack | Usual test tool | Run command |
  |---|---|---|
  | Vite, React, plain TypeScript or JavaScript | Vitest | `npx vitest run` |
  | Next.js | Vitest (logic), Playwright (pages) | `npx vitest run` |
  | Node.js without a bundler | the built-in `node:test` | `node --test` |
  | Python | pytest | `python -m pytest` |
  | C# / .NET | xUnit | `dotnet test` |
  | Unity | Unity Test Framework (Edit Mode) | Test Runner window |
  | Go | built in | `go test ./...` |

- Run the existing tests **once before changing anything** and note what already fails, so old failures are not
  blamed on the new change.

## 2. Red: a test that fails for the right reason

1. Describe the behavior in one sentence and check it with the user when unclear, for example: "An empty title is
   rejected with the message Title is required."
2. Write one test for exactly that. The test name states the behavior. Arrange the input, act once, assert the
   result. Test through the public function or entry point, not private details.
3. Run it. It must **fail**, and the failure must be the assertion, not a typo, an import error or a missing file.
   If it passes already, the behavior exists or the test is wrong: stop and look before going on.

## 3. Green: the smallest change

1. Change the code as little as possible to make this test pass. No extra features "while you are there".
2. Run the new test: it passes.
3. Run the **whole** suite: everything passes except failures that were there before step 1.

## 4. Clean up

Tidy names and duplicated code in what you just wrote, then run the suite again. Stop when it is clear enough.

## 5. Report

Tell the user in a few lines: the test name, what it checks, the command, and the result before and after
("failed: expected error message, got nothing" then "passed"). Show the fresh output of the last run
(`verify-before-done`).

## Fixing a bug

First write a test that reproduces the bug and fails. Then fix. The test stays, so the bug cannot come back
unnoticed.

## When testing is hard

- Logic mixed with screens, network or files: move the logic into a plain function and test that.
- Network calls: replace them with a small fake in the test. Tests never call real services or use real keys.
- Time and randomness: pass the clock or the random seed in, so tests give the same result every run.
- Pure visual changes, a Unity scene, a flow tried by hand: no automated test fits, so write a short manual check
  instead ("open /notes, the list is sorted by date") and put it in the task's `acceptance` when there is one. Say in
  the report what was opened and what was seen, and ask the user to try it when only a person can see the result.

## Never

- Delete, skip or weaken a failing test to get a green run without asking the user.
- Change a test's expected value just to match what the code happens to return, without understanding why.
- Leave tests that depend on each other's order, on the internet or on files outside the project.
