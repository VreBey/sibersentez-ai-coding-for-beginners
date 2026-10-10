---
name: performance-check
description: "Makes something faster without guessing: states what feels slow, measures it, finds the single biggest bottleneck, changes one thing, measures again and keeps the change only if the numbers improved. Use when a page, command, query or app is slow, uses too much memory, or the user asks to speed it up or optimize it."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-tags: "performance"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "yavaş*, çok yavaş, performans*, hızlandır*, geç açılıyor, takılıyor, donuyor, optimizasyon*, bellek şişiyor"
---

# Performance check

Guessing which part is slow wastes hours and often makes code worse. Measure first, change one thing, measure again.
If the numbers did not improve, the change was not an improvement.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never trade correctness for speed: the tests must pass after every change.

## 1. Say what "slow" means

Ask, one question at a time: "Which action is slow? How long does it take now? How long would feel fine?" Write one
sentence: "Opening the list page takes about 6 seconds; the goal is under 1 second." Without a goal there is no end.
Note where it is slow: on this computer only, with a lot of data, on a phone, after some time running.

## 2. Measure before touching anything

Pick a way to measure and use the same one every time. Run the action five times and write down the middle value:

| What is slow | Ways to measure |
|---|---|
| A web page | browser developer tools: the Network list (what loads, how big, how long) and the Performance panel |
| A command or script | `Measure-Command { <command> }` in PowerShell, `time <command>` on macOS and Linux, or timing lines printed by the program itself |
| A database query | the database's own explain output, and the time of the call in code |
| An API route | time of the call (`curl.exe -w` with timing variables, or the route's own log) |
| Memory growth | the task manager (or `top` on macOS and Linux) or the language's profiler, watched while repeating the action |
| A game | the engine's profiler and the frames per second counter |

Write the table of baseline numbers down in the conversation (and in a notes file if the user wants). Use a realistic
amount of data: an empty database proves nothing.

## 3. Find the biggest bottleneck

Find where the time goes. Do not guess: use the numbers (the longest request, the slowest function, the largest file).
Look at the biggest item first; fixing a part that takes 2 percent of the time cannot help.

| Often the cause | Sign |
|---|---|
| A query inside a loop (one request per row) | many near-identical queries in the log |
| A missing index | one query dominates; the explain output says it reads the whole table |
| Huge images or files | the Network list shows megabytes |
| Everything loads at once | one giant script or page when little is needed on the first screen |
| Requests one after another that could run together | a staircase in the Network list |
| The same work repeated | the same value computed on every call or every redraw |
| Memory never freed | the number rises with every repeat of the action |

Say in plain words what you think the cause is and what evidence shows it.

## 4. Change one thing

Choose the single change that targets the biggest item. Say what it is and what number you expect. Make only that
change (no cleanups on the side). Keep the change small and easy to undo.

## 5. Measure again, the same way

Repeat step 2 exactly. Compare with the baseline in one line: "Median 6.1 s, now 1.2 s." Run the tests and, if
relevant, try the feature by hand.

- Clearly better and the tests pass: keep it and commit after a yes.
- Not clearly better (under about a fifth), or it broke something: undo your own change (ask before touching git state)
  and say what the measurement taught you.

## 6. Repeat, then stop

Go back to step 3 with the new numbers. Stop when the goal is met, or after three rounds, or when the next gain is
small: say what is left and what it would cost. Do not chase tiny gains.

## Do not use for

- Something that is broken rather than slow: use `debug-helper`.
- Making code cleaner: use `refactor-safely`.
- Deciding what to build: use `scope-guard`.

## Done when

- A goal was written down, and a baseline table with the middle values exists.
- Every kept change has its before and after numbers in one table (show it).
- The tests pass after the last change (show the summary).
- You told the user in one sentence what was slow, what changed and what the numbers are now.
