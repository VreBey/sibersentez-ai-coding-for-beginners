---
name: scope-guard
description: "Sorts a growing list of wishes into Now, Later and No, cuts the project down to a first version that can really be finished, and records the decision. Use when a project has grown too big, the user keeps adding features, asks what the MVP should be, says it will never be finished, or wants to know what to cut."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-tags: "planning"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "çok büyüdü, kapsam*, ilk sürüm, mvp, işi küçült*, kesmem gereken, neyi keseyim, bitiremiyorum, çok fazla özellik, şişti"
---

# Scope guard

Most projects die from too many wishes, not too few. This skill picks the smallest version that is worth using, and
parks the rest without losing it.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Collect every wish

Read `PLAN.md` and `TASKS.md` if they exist and ask: "Is there anything else in your head?" Put everything in one
flat list, without judging. Do not remove anything yet.

## 2. Ask two things first

- **The promise**: "In one sentence, why would someone use this?"
- **The time**: "How many hours a week do you have, and when do you want the first version in someone's hands?"

## 3. Sort each wish

For every wish, ask one question: **"Would the first user still get the promise if this were missing?"**

| Answer | Bucket |
|---|---|
| No, the promise breaks without it | **Now** (aim for 3 to 5 items) |
| Yes, but it is clearly useful after people used the first version | **Later** |
| Yes, and it is a nice idea more than a need, or it needs skills or money the user does not have | **No** (say why in a few words) |

Then check dependencies: if a "Now" item needs a "Later" item, move that one up or simplify the "Now" item. Check the
time: if "Now" does not fit the hours the user has, move the least important "Now" item down.

## 4. Show the table and get a decision

Show three short lists: Now, Later, No. Ask: "Do you agree? Anything you would move?" The user decides; you only
argue with one sentence per item. A wish moved to "No" is not deleted from the world, only from this version.

## 5. Record it

After a yes, append a section, in the user's language, to `PLAN.md` (create the file if missing; never rewrite what
is there without asking):

```markdown
## Scope decision (<date>)
Promise: <one sentence>
Now: ...
Later: ...
No (for this version): ... (reason)
```

Move "Later" items into the `Later` list of `TASKS.md` if the file exists, with the user's yes.

## 6. Keep the line

For any new wish that comes up later, ask the same question from step 3 and answer with "Now, Later or No?". Never
add it to "Now" silently. If "Now" grows, something else leaves it.

## Do not use for

- A new idea without a plan: use `idea-to-plan`.
- Detailing one feature: use `feature-spec`.
- Splitting "Now" into tasks: use `task-breakdown`.
- Choosing tools: use `tech-stack-chooser`.

## Done when

- `PLAN.md` holds a dated scope decision with Now, Later and No, and the user agreed to it (show the section).
- "Now" has at most about five items and fits the user's time.
- You told the user in one sentence what the first version is and what happens to the rest.
