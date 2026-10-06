---
name: orchestrate-wrapup
description: "Finish step of a team job: checks the plan's done-when list item by item with fresh proof, notes drift from the plan, writes the summary into .sibersentez/LEDGER.md, suggests what to remember, gets the user's yes on the result and points to finish-branch. Use when the user says wrap it up, is the job finished, or what was done."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.3"
  sibersentez-tags: "workflow, docs"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "işi kapat, özet çıkar, bitirdik mi, son kontrol, sonucu onayla, işi topla"
---

# Orchestrate: wrap-up

Step 4 of 4 (Finish) of `orchestrate`. You close the job honestly: what was promised, what was really done, what is
left. You write no application code.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check the promise

PLAN.md, TASKS.md and the latest whole-job review must carry the current `Job-ID`. Missing/different ids mean
the evidence cannot close this job: return to planning/checking. Never relabel an old review to make it pass.

1. Read `.sibersentez/PLAN.md`. Take its **Done when** list.
2. For each item, find the proof: a report file, a command result in `REVIEW.md`, or something you can run now. When
   the proof is old, run the read-only check again now and show its output (see `verify-before-done`): "it passed
   earlier" is not proof. Tick the item only with proof. An item without proof stays open.
3. Read `.sibersentez/TASKS.md`: every task should be `done`. List any `blocked` or `todo` task by name.
4. Collect the concerns from `DONE_WITH_CONCERNS` reports and the nits of the last review.
5. **Drift from the plan.** Compare what was built with the plan's goal, scope and out-of-scope list. Name anything
   added that the plan did not ask for, anything the plan asked for that is missing, and any approach that changed on
   the way. Write "no drift" when there is none.

## 2. Write the summary

Append to `.sibersentez/LEDGER.md`, dated:

- what was done, in three to six short lines;
- which "done when" items are met and which are not;
- open concerns and nits, each with where to find it;
- drift from the plan, or "no drift";
- next steps: what the user (or a later job) should do, in order;
- how many fix rounds the check took.

Then think about what a later session would want to know and does not yet: a command that worked, a decision and its
reason, a trap that cost time. Suggest at most three short lines for `.sibersentez/MEMORY.md` (`project-memory`) and show
them to the user; write them **only with the user's yes**.

Write no key, token, `.env` content or personal data anywhere in it.

## 3. Ask for the result

Tell the user in plain words what is finished, what is not, and what you suggest next. Then ask one question: "Do you
accept this result?"

- Yes: mark the plan finished in the ledger, and change `Result: open` to `Result: accepted` in the `## Approval`
  part of `PLAN.md` (add the line if it is missing; the only edit you make to the plan). The last step is `finish-branch`: suggest it in one sentence (test,
  then merge, open a pull request or leave the work as it is, each step with its own yes). If the user wants to
  publish a release instead, `release-prep` fits.
- No: ask what is missing, add it as new tasks through `orchestrate-plan`, and go on from there.

Never commit, push, publish, delete or send anything as part of finishing. If the user wants it, ask again for that
action on its own.

## 4. Leave a trail

If the user is about to stop, offer to write `.sibersentez/HANDOFF.md` with `handoff-notes`, so the next session starts
where this one ended.

## Done when

Every "done when" item is ticked with proof or listed as open, the ledger holds the summary and next steps, and the
user said yes or no to the result. Tell the user in one sentence what was done and what comes next.

Do not use for: a job that has no plan yet (`orchestrate`), or only saving notes for tomorrow (`handoff-notes`).
