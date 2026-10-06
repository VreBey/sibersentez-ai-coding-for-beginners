---
name: project-setup
description: "Sets up a new project folder from the plan: folder layout, git repository, README, .gitignore and one clear command to run the project, explaining each step. Use when the plan is ready and the folder is empty or nearly empty, when the user asks for the project skeleton, to initialize git, or to make the project run for the first time."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "planning, docs"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "kurulum, iskelet, klasör yapısı, proje kur*, projeyi kur*, projeyi oluştur*, başlangıç, git"
  sibersentez-offer: "empty-folder"
---

# Project setup

After this skill the folder has a working skeleton, a README that says how to run it, and a first git commit, and
the user knows what each piece is for.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Read the situation

- Read `PLAN.md` if it exists: the stack, where it runs and the first milestone. Without a plan, ask three quick
  questions (what it is, where it runs, which language or stack) or suggest the `idea-to-plan` skill first.
- List what is already in the folder. Leave tool folders (`.claude/`, `.agents/`, `.github/`) and the user's files
  alone. Never delete or move anything without asking.
- Check the tools the stack needs, one command each: `git --version`, and the runtime (`node --version`,
  `py --version`, `dotnet --version`, Unity Hub). If one is missing, say what it is, why it is needed and where it
  comes from. Install only after a yes, or let the user install it and open a new terminal afterwards.

## 2. Agree on the layout first

Show a short tree and wait for a yes before creating anything. For example:

```
my-project/
  PLAN.md       the plan (already here)
  README.md     what this is and how to run it
  .gitignore    files git must not track
  app/          the application, made by the stack's own generator
```

- If the stack has an official generator (create-next-app, create-vite, create-expo-app, Electron Forge, Unity Hub),
  use it. Do not hand-write what a generator makes.
- Run the generator **into a new subfolder** such as `app/`, not into the project root. The root already holds the
  plan and the AI tool's own folder; many generators refuse a folder that is not empty, and some offer to delete
  its contents. Never accept an option that removes existing files.
- If a starter skill for the stack is installed (`web-app-starter`, `mobile-app-starter`, `desktop-app-starter`,
  `game-prototype-unity`, `python-bot-starter`), follow it for the generator step and come back here for the rest.
- Stacks without a generator (a Python script, a static page): create only the few files the first milestone needs.

## 3. Git

1. If the folder has no `.git`, explain in one line ("git keeps snapshots of your work so you can always go back"),
   then run `git init -b main`.
2. If `git config user.name` or `git config user.email` is empty, ask the user what to use. Never invent them. Set
   them for this repository only unless the user asks for a global setting.

## 4. .gitignore

Write one that fits the stack, at the root. Always include:

- secrets: `.env`, `.env.*` (but keep `.env.example`, which holds names without values);
- dependency and build folders of the stack (`node_modules/`, `dist/`, `.next/`, `.venv/`, `__pycache__/`,
  Unity's `Library/`, `Temp/`, `Logs/`, `UserSettings/`);
- editor and system clutter: `.vs/`, `.idea/`, `Thumbs.db`, `.DS_Store`, `*.log`.

A generator's own `.gitignore` inside the subfolder stays as it is.

## 5. README

Short, in the user's language:

1. Name and one sentence: what it is, for whom.
2. Requirements with versions (for example "Node.js 22 LTS").
3. How to run: exact, copy-ready commands from the project root (`cd app`, then the start command).
4. How to test, if there are tests.
5. Folder guide: 3-6 lines.
6. Status: "early prototype" is fine.

## 6. One command that runs it

There must be one obvious command that starts the project, and it must work now. Run it and check the result
yourself where you can: the page opens, the window appears, the bot answers, Play mode starts. For a server that
keeps running, tell the user how to stop it (Ctrl+C in its terminal). If your tool cannot keep a process running,
ask the user to run the command in their own terminal and tell you what they see.

## 7. First commit

1. Run `git status` and read the list with the user: nothing secret, no dependency folders, nothing huge.
2. Ask, then commit: `git add -A` and `git commit -m "chore: project skeleton"`.
3. Do not create a remote or push. If the user wants the project on GitHub or similar, explain what that means
   (public or private, who can see it) and ask before each step.

## Done when

- [ ] The run command in the README works on this computer.
- [ ] `.gitignore` covers secrets, dependencies and build output.
- [ ] The first commit exists and `git status` is clean.

Next: split the first milestone into tasks with `task-breakdown`, if it is installed.
