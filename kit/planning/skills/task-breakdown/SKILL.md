---
name: task-breakdown
description: "Breaks a plan, milestone or feature into small tasks of an hour or two, each with a concrete check that proves it is done, and saves them in TASKS.md as a checklist. Use when a plan is agreed and work should start, when a feature feels too big to start, or when the user wants a checklist of small steps."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.4"
  sibersentez-tags: "planning"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "görev listesi çıkar*, görevlere ayır*, adım adım, yapılacakları çıkar*, iş listesi, parçala*, kontrol listesi"
---

# Task breakdown

Turn the next piece of work into a short list of small tasks. Each task ends with something the user can see or run,
so progress is visible and mistakes show up early.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## What a good task looks like

- **Small**: 30 minutes to 2 hours of work for this user, touching at most five files. Bigger means split it.
- **One visible result**: a page shows something, a command prints something, a test passes, the game object moves.
- **A "Done when" check** the user can do without reading code.
- **Keeps the project runnable**: after every task the app still starts. Build thin slices through the whole app
  ("save one note and show it") instead of layers ("all database code first").
- **The first task is the smallest end-to-end thing** that runs, even if it is ugly.
- **Risky or unknown things early**: if nobody knows whether the bot can receive messages at all, that is task one.

## Steps

1. Read `PLAN.md` if it exists. Read `TASKS.md` if it exists: continue it rather than replace it, and ask before
   rewriting any part of it.
2. Agree on the scope in one question: "Shall I plan the first milestone, or a specific feature?" Plan only that in
   detail. Everything else goes into a short "Later" list.
3. Look at the code (if any) so tasks name real files and commands.
4. Draft 5-12 tasks in this form:

   ```markdown
   # Tasks: <milestone or feature>
   Updated: <date>

   ## Now
   - [ ] 1. <Short action, starting with a verb>
     - Done when: <what the user runs or opens, and what they see>
   - [ ] 2. ...

   ## Later
   - <idea that is not needed for this milestone>

   ## Needs a decision
   - <question for the user, for example "Which colors?" or "Which payment provider?">
   ```

5. Show the draft. Ask what to change, then write `TASKS.md` (in the user's language) after a yes.

## Working through the list

When the user says "let's start" or "next":

1. Take the **first unchecked task only** and say which one it is.
2. Do it. Then run its "Done when" check yourself where you can, and tell the user how to check the rest.
3. When the check passes, tick the box (`- [x]`) and add today's date after it.
4. Offer a commit for the finished task (ask first). One task, one commit keeps history easy to follow.
5. If the task turns out bigger than expected, stop, split it in `TASKS.md` and tell the user.
6. New ideas that come up while working go to "Later", not into the current task.

## Examples of good and weak tasks

| Weak | Better |
|---|---|
| Build the backend | Save one note to a file and read it back; Done when: `npm test` shows the save test passing |
| Make the game | Player square moves left and right; Done when: press Play, arrow keys move it |
| Improve the bot | Bot answers `/help` with the command list; Done when: sending `/help` in Telegram gets the list |
| Fix bugs | Empty title shows "Title is required"; Done when: submitting an empty form shows that message |

## Avoid

- Tasks without a check ("refactor code", "polish UI").
- Planning months ahead in detail. Plan the next milestone; the rest stays a list of headlines.
- Doing several tasks at once, or ticking a box before its check passed.
