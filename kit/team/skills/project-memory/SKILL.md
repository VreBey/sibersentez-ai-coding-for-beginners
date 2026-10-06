---
name: project-memory
description: "Keeps a short file of the project's lasting decisions, working commands and user preferences in .sibersentez/MEMORY.md, so every new session starts informed. Adds only short bullet points and never secrets. Use when the user says remember this, save this decision for later, or note how we run and test this project."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "workflow, docs"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "bunu hatırla, proje hafızası, kararı kaydet, tercihlerimi not al, unutma, kalıcı not"
---

# Project memory

One short file that keeps what stays true across sessions: `.sibersentez/MEMORY.md`. Every session reads it first. It is
a note pad for facts, not a diary.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## When to write

- The user says "remember this", or states a rule for the project ("we always use tabs", "never touch the old folder").
- A decision was made that a future session would otherwise reopen (why one tool was chosen over another).
- A command was found that works and is not obvious (how to run one test, how to start the app).
- The user corrected you on something they will not want to say twice.

## How to write

1. Read the file if it exists. Create `.sibersentez/` and the file if not (say so in one sentence first).
2. Add **one short line per item** under a fitting heading. Keep the headings:

```markdown
# Project memory

## Decisions
- <decision> (why: <a few words>, <date>)

## Commands
- run: `<command>`   test: `<command>`

## Preferences
- <how the user likes things done>

## Do not
- <things that must not be touched or done>
```

3. Update an item that changed instead of adding a contradicting one. Remove items that are no longer true, after
   telling the user which ones.
4. Keep the whole file under about 60 lines. When it grows, merge or drop the least useful lines.
5. Tell the user in one sentence what you saved.

## What never goes in

- Keys, tokens, passwords, `.env` content, personal data or private addresses. Write where they live, never what
  they are.
- What the code or `git log` already shows, such as file lists or a history of changes.
- Passing state of the current job (`.sibersentez/HANDOFF.md` and `TASKS.md` hold that).
- Long explanations. If it needs a page, it belongs in a document, and the memory line points to it.
- Guesses. Only what the user said or what was tried and worked.

## Reading it

A new session reads this file after `.sibersentez/HANDOFF.md`, treats it as the project's standing rules, and mentions
in one sentence that it did. If a line looks outdated against the code, ask the user before acting on it and fix
the line afterwards.

## Done when

The new lines are in `.sibersentez/MEMORY.md`, each short and free of secrets, the file is still short, and you told the
user what was saved.

Do not use for: notes about where a session stopped (`handoff-notes`), or a document for readers (`docs-writer`).
