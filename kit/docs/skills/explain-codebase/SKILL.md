---
name: explain-codebase
description: "Maps an unfamiliar codebase for a newcomer: what it does, how folders are organized, where it starts, how a typical action flows, how to run and test it, and where common changes go, with file paths. Use when the user opens a project they did not write, returns to an old one, joins a team, or asks where something lives."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-tags: "docs"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "anlamadım, nasıl çalışıyor, kod tabanı, kodu açıkla*, projeyi anla*, yabancı proje, devral*, eski proje*, bu kod ne"
---

# Explain a codebase

Give the user a map of an unfamiliar project: enough to find their way, run it, and make a first change safely.
Every statement points to a real file.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Ask why

One question: "Do you want a general overview, or do you need to fix or add something specific?" Also ask how
familiar they are with the language. The answer decides how deep to go and which parts to follow first.

## 2. Survey without running anything

- `README`, `docs/`, and any notes for AI tools (`AGENTS.md`, `CLAUDE.md`).
- Manifests: `package.json`, `pyproject.toml`, `requirements.txt`, `*.csproj`, `go.mod`, `Cargo.toml`,
  Unity's `ProjectSettings/ProjectVersion.txt`, `app.json`. They name the stack, versions and scripts.
- The folder tree two levels deep, skipping dependencies and build output (`node_modules`, `.venv`, `Library`,
  `dist`, `.next`, `bin`, `obj`).
- Configuration, CI files and tests: they show how the project is meant to be built and checked.
- Recent history: `git log --oneline -20` shows what is being worked on.

## 3. Find the entry points and follow one flow

- Entry points: `main`, `index`, `app`, `server`, `Program.cs`, the first Unity scene and its bootstrap scripts, the
  bot's start file, the routes or pages folder.
- Pick one real action (a click, a request, a command, a game tick) and follow it through the code: where it
  starts, which files it passes through, where data is read or saved, what comes back.

## 4. Run it (optional, with consent)

Ask before installing dependencies. Then find the run and test commands, try them, and note what works and what
fails. A failing start is useful information for the map, not something to fix now.

## 5. Write the map

Show it in the conversation first. Save it (for example as `docs/CODEBASE.md`) only if the user wants a file.
Write it in the user's language and keep it to one or two screens:

```markdown
# How <project> works
<One paragraph: what it does and for whom.>

## Stack
<Languages, frameworks, versions.>

## Folder map
| Folder | What is inside | Touch it when |

## Entry points
## One flow, step by step
1. <file path>: <what happens>

## Data
<Where it is stored, main models or tables.>

## Run and test
<Exact commands, and what worked when you tried.>

## Conventions
<Naming, patterns, where tests live.>

## Where to change common things
<"Add a page: app/<name>/page.tsx", "Add a bot command: bot/commands.py".>

## Rough edges
<Parts without tests, TODOs, duplicated logic, anything surprising.>

## Questions for the original author
```

## Rules

- Cite file paths for every claim. Mark guesses as guesses.
- Do not refactor or "fix" anything while exploring. Note it under rough edges instead.
- Use simple comparisons for beginners ("the router is like a reception desk that sends each visitor to a room").
- If the project is large, map the part the user needs first and offer to continue.
