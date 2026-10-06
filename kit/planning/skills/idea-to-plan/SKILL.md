---
name: idea-to-plan
description: "Turns a rough idea into a short project plan saved as PLAN.md, asking one question at a time about the goal, users, must-have features, tech choice and what is out of scope. Use when starting a new project from an idea or an empty folder, when the user wants to build something but does not know where to begin."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "planning"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "fikrim, fikir var, aklımda, yapmak istiyorum, nereden başla*, nasıl başla*, proje planı, boş klasör, yeni proje, proje fikri"
  sibersentez-offer: "empty-folder"
---

# Idea to plan

Help the user go from "I have an idea" to a one-page plan they understand and agree with. Assume they may be new to
programming: be friendly, concrete and brief. No code is written in this skill.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Look before you ask

1. Check the folder. If `PLAN.md` already exists, read it and ask: "Shall I update this plan or start a new one?"
   Never overwrite it without a yes.
2. If there is code already, glance at the manifest files and top folders so you do not ask what the folder already
   answers (for example, a `package.json` with `next` means the stack is decided).
3. Tell the user what happens next: "I will ask about six short questions, one at a time. Then I will write a
   one-page PLAN.md for you to check."

## 2. The interview

Ask **one question per message** and wait for the answer. Where you can, offer 2-4 numbered choices plus "something
else", and say which one you would pick for a beginner in a few words. If the user answers "I don't know", pick a
sensible default, say so, and record it as an assumption.

Cover these topics in order. Skip any the user has already answered.

1. **Goal**: what should the finished thing let someone do? Ask for one sentence.
2. **Users**: who uses it (just me, friends, customers, players) and roughly how many?
3. **Where it runs**: browser, phone, Windows program, game, chat bot, or a script that runs on a schedule.
4. **Must-haves**: the three to five features the first version cannot do without. If the list is long, ask:
   "Which of these could wait for version two?"
5. **Not now**: what the first version will deliberately not do (payments, user accounts, multiplayer, admin panel).
6. **Tech choice**: propose one stack that fits the answers and the user's experience, name one alternative and why
   you did not pick it. Prefer well-documented, widely used tools for beginners.
7. **Limits**: deadline, budget (free tools only?), private data, anything the user already knows or owns.

Then sum up in 5-7 bullets and ask: "Did I get this right?" Fix what they correct before you write anything.

## 3. Stack defaults for beginners

Suggest, do not decide. The user has the last word.

| Runs on | Default suggestion | Consider instead when |
|---|---|---|
| Browser, several pages, sign-in or data later | Next.js (React, TypeScript) | a single simple page: Vite + React |
| Phone (Android and iPhone) | Expo (React Native, TypeScript) | only Android and the user knows Kotlin |
| Windows program with its own window | Electron (TypeScript) | the user knows C#: WPF or WinUI |
| Game | Unity (C#) | a small 2D game and a lighter engine is wanted: Godot (GDScript) |
| Chat bot, reminders, scheduled jobs | Python | the team only knows JavaScript: Node.js |
| A data file to understand (CSV, spreadsheet) | Python with pandas | the user only wants a quick look: the spreadsheet program itself |
| Extension for a web browser | plain JavaScript, Manifest V3 | |
| A command to type in the terminal | Python | the user knows JavaScript: Node.js |
| An AI model inside an app | the stack of the app, with the key kept on a server | |

## 4. Write PLAN.md

Ask before creating the file. Write it in the user's language and keep it to about one screen.

```markdown
# <Project name>

<One sentence: what it is and who it is for.>

## Goal
## Users
## First version (must have)
- [ ] <feature>
## Later (nice to have)
## Not in this version
## Tech choice
- Stack: <stack> (why: <one line>)
- Runs on: <where>
## First milestone
<The smallest thing that proves the idea works, for example "a page that lists my notes".>
## Assumptions and open questions
```

A good first milestone can be shown to someone within a few days of work and needs no design polish.

## 5. Finish

- Show where the file is and give a three-line summary.
- Suggest the next step in plain words:
  1. set up the project folder with the `project-setup` skill, or with the starter for the chosen stack when it is
     installed (`web-app-starter`, `landing-page-starter`, `mobile-app-starter`, `desktop-app-starter`,
     `game-prototype-unity`, `game-prototype-godot`, `python-bot-starter`, `data-analysis-starter`,
     `cli-tool-starter`, `browser-extension-starter`, `api-service-starter`);
  2. split the first milestone into small tasks with `task-breakdown`;
  3. when the plan has them: `database-schema` for saved data, `auth-flow` for accounts, `llm-app-basics` for an AI
     model, `docker-basics` and `deploy-web` for going online.
- If those skills are not available, say what the step would do and offer to do it directly.
- If the idea needs something no skill covers (programs for small devices or hardware, for example), say so honestly,
  still write the plan, and use `project-setup` and the maker's own guides for the rest. Never end with "not possible".

## Avoid

- Several questions in one message, or a long questionnaire up front.
- Writing code or installing anything before the plan is agreed.
- Process jargon (epics, story points, sprints). Plain words only.
- Hiding costs. Mention them early (for example, publishing in the Apple App Store needs a paid developer account,
  and a bot that runs day and night needs a server).
