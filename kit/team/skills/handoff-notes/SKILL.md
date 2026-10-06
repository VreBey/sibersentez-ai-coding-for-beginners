---
name: handoff-notes
description: "Before a session ends, writes what was done, what comes next and the open questions into .sibersentez/HANDOFF.md, so a new session (or another AI tool) can continue without the old conversation. Use when the user says let's continue tomorrow, I am closing this session, or write notes so we can pick this up later."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "workflow, docs"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "yarın devam, kaldığımız yerden, oturumu kapat, devir notu, yeni oturum, nerede kalmıştık"
---

# Handoff notes

A short letter from this session to the next one. The next session knows nothing about this chat, so everything it
needs must be in one file: `.sibersentez/HANDOFF.md`.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## Writing the notes

1. Collect the facts from the files, not from memory: `git status`, `git log` for the last few commits,
   `.sibersentez/TASKS.md`, `.sibersentez/LEDGER.md` and `PLAN.md` when they exist.
2. If `.sibersentez/HANDOFF.md` already exists, tell the user it will be replaced by the new notes, and keep the old text
   in the ledger only if it holds something still open. Ask before overwriting.
3. Write the file in the user's language, at most one screen, with these headings:

```markdown
# Handoff

Date: <date>
Project state: <one or two sentences: what works now, what does not>

## Done in this session
- <short, concrete, with file paths where useful>

## Next, in order
1. <the very next action, precise enough to start without asking>
2. ...

## Open questions
- <a question that needs the user's answer, with the options you saw>

## Watch out
- <traps: a test that is slow, a file that must not change, a command that needs a yes>

## How to run and check
- <the exact commands that were tried and worked>
```

4. Read it back once as if you were a stranger: could someone continue from it alone? Fix what is unclear.

## What to leave out

- Keys, tokens, passwords, `.env` content and personal data. Say "the key is in `.env`", never the value.
- The whole story of the session. Only results and decisions matter.
- Things any reader can see in the code or in `git log`.
- Guesses written as facts. Mark a guess as a guess.

## Starting the next session

The first thing a new session does is read `.sibersentez/HANDOFF.md`, then `.sibersentez/MEMORY.md` when it exists. It says to
the user in one sentence where the last session stopped, and asks whether to continue with "Next, in order", item 1.
After the work has moved on, it updates or replaces the file, so the notes never describe an old state.

## Done when

`.sibersentez/HANDOFF.md` exists, fits on one screen, holds no secret, and you told the user its path and the first
"next" step in one sentence.

Do not use for: long-term decisions and commands that stay true (`project-memory`), or closing a team job
(`orchestrate-wrapup`).
