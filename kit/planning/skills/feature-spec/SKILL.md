---
name: feature-spec
description: "Turns one feature idea into a short spec file: who it is for, what they can do step by step, what is left out, what can go wrong, and a checklist that says when it is done. Use when the user says let's add a feature, wants something new in a project that already runs, asks how a feature should work, or gives a feature request that is still vague."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-tags: "planning"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "yeni özellik, özellik ekle*, özellik tarif*, özellik iste*, nasıl çalışsın, kullanıcı hikayesi, gereksinim*, şartname*, ne yapmalı"
---

# Feature spec

Write down one feature before building it. A half-page spec saves hours: the user and the AI agree on what "done"
looks like, so nobody builds the wrong thing.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Look at what exists

Read `PLAN.md`, `TASKS.md` and the README if they exist, and skim the folders. Tell the user in one or two sentences
what the project does today. The feature must fit that, not a project you imagined.

## 2. Ask, one question at a time

Stop after five questions at most; write "unknown" for anything the user cannot answer yet.

1. **Who** uses it, and why do they want it? (one sentence)
2. **What do they do**, step by step? ("They open the page, type a title, press Save.")
3. **What do they see** when it works?
4. **What can go wrong?** Empty input, no internet, no permission, a very long text, two people at once.
5. **What is not part of it** for now? Name at least one thing on purpose.

## 3. Write the spec

Save it as `docs/specs/<feature-name>.md` (create the folders if missing). If that file exists, ask before changing
it. Write it in the user's language, in this shape:

```markdown
# Feature: <name>
Date: <today>

## Goal
<One sentence: who can do what, and why.>

## Steps the user takes
1. ...

## Rules
- <Limits and choices, e.g. "a title has 1 to 80 characters".>

## When something goes wrong
| Situation | What the user sees |
|---|---|

## Not now
- ...

## Open questions
- ...

## Done when
- [ ] <Something the user can open or run, and what they see.>
```

## 4. Check it together

Read the spec back in plain words. Ask: "Is anything missing or wrong?" Change it, then ask for a yes.

- Every "Done when" line must be something a person can check by looking or running a command, not "works well".
- More than about a dozen steps or checks means the feature is two features. Offer to write two specs.

## 5. What comes next

Offer the next step, and do not start it without a yes: the `task-breakdown` skill turns the spec into small tasks.
Building starts only after the user approves the spec.

## Weak and better lines

| Weak | Better |
|---|---|
| Users can manage notes | A user can add a note, see it in a list and delete it |
| It should be fast | The list shows within 2 seconds with 100 notes |
| Handle errors | An empty title shows "Title is required" and saves nothing |

## Do not use for

- A brand new project idea: use `idea-to-plan`.
- Splitting a spec into work items: use `task-breakdown`.
- A plan that keeps growing: use `scope-guard`.
- Something that broke: use `debug-helper`.

## Done when

- The spec file exists (show its path and its "Done when" list), and the user said it reads right.
- Every "Done when" line is checkable, and "Not now" has at least one entry.
- You told the user in one sentence what the feature is and what the next step is.
