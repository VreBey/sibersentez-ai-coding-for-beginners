---
name: agent-rules
description: "Creates or updates the project's instruction file for AI coding tools: AGENTS.md, and CLAUDE.md or Copilot instructions only if those tools are used. It holds what the project is, run and test commands, folder map, rules and files not to touch. Use when the user asks for AGENTS.md, project rules for the AI, or an instruction file."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.3"
  sibersentez-tags: "docs, workflow"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "agents md, claude md, talimat dosyası, kural dosyası, yapay zekâ kuralları, proje kuralları, copilot talimat*, yapay zekâ talimat*"
---

# Agent rules

AI tools read one short instruction file at the start of every session. This skill writes it, so the AI knows the
project without being told again. It is different from `project-memory`: memory is decisions and facts
(`.sibersentez/MEMORY.md`); agent rules are the instructions the tools read every time (`AGENTS.md` and friends).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Which files

Look at what exists and what the user uses (ask if unclear). Write only for tools that are really used:

| File | For |
|---|---|
| `AGENTS.md` | Most AI coding tools read it. Always the main file |
| `CLAUDE.md` | Only if Claude Code is used. Keep it short and point to `AGENTS.md` |
| `.github/copilot-instructions.md` | Only if GitHub Copilot is used |

Never copy the same long text into three files: `AGENTS.md` holds the content, the others point to it.

## 2. Read the project, then try the commands

Read the README, `package.json` or the project's equivalent, the folder list, `PLAN.md` and `.sibersentez/MEMORY.md`.
Find the commands to run, test and build. Run each one that is safe (a test, a lint, a type check) and write only
what worked. A command you could not try goes in as "not tried yet". Never write a key, token or personal data.

## 3. If a file already exists

Never overwrite it silently. Read it, then show the user a short plain summary of the difference: lines you would
add, lines you would change, lines you would leave. Wait for a yes. Add or update sections, keep every line the user
wrote themselves, and remove nothing without asking about that line.

## 4. What goes in

Keep it short, under about 80 lines, in the user's language (commands stay as they are):

```markdown
# <Project name>
<One or two sentences: what the project is and who it is for.>

## Commands
- run: `...`   test: `...`   build: `...`

## Folders
- `src/` - ...   `tests/` - ...

## Rules
- Reply and write documents in <language>.
- Ask before deleting, installing, or pushing. No push without a yes.
- <Style rules the project really has.>

## Do not touch
- <files and folders: generated files, `.env`, vendor code, the old folder>

## SiberSentez starter
When one of the skills in this project fits the request, use it before answering from memory: its steps are
checked and current. For a job bigger than one small change, use the orchestrate skill. Before saying something
is done, run the verify-before-done check. When something does not work, use debug-helper. When unsure what to do
next, use next-step.
```

Add the "SiberSentez starter" block only after the user agrees to it. Leave sections out when they would be guesses.

## 5. Check it together

Show the finished text (or the difference), ask "Is anything wrong or missing?", change it, then write with a yes.
Showing means printing the whole text in your message, in a code block, before the question. Saying "the text is
ready" and asking for a yes is not showing it: the user cannot approve what they have not read.
Tell the user where the file is and that AI tools will read it in their next session.

## Do not use for

- Saving a decision or a working command for later: use `project-memory`.
- Writing the README for people: use `docs-writer`.
- A map of an unfamiliar codebase: use `explain-codebase`.
- Ending a session with notes: use `handoff-notes`.

## Done when

- The file exists (show its path), and every command in it was tried or marked "not tried yet".
- An existing file was never overwritten without the user's yes, and the user's own lines are still there.
- Only files for tools that are really used were written, and no secret is in them.
- You told the user in one sentence what was written and where.
