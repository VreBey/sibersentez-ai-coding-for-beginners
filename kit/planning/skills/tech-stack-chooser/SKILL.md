---
name: tech-stack-chooser
description: "Compares two or three ways to build the project (language, framework or engine) in plain words, recommends one with the trade-offs, and records the decision. Use when the user asks which language, tool or technology to use, cannot decide between options, or wants to know whether a choice fits their level and their project."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "planning"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "hangi dil*, hangi teknoloji*, hangi framework*, hangi motor*, hangisini kullan*, teknoloji seç*, dil seç*, hangisi daha iyi, programlama dil*, seçmeliyim"
---

# Tech stack chooser

Choosing tools is easy to overthink. Give the user two or three real options, one clear recommendation, and a way to
change their mind later. The goal is a choice they can start with today.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Learn the situation

Read `PLAN.md` if it exists. Ask only what it does not answer, one question at a time:

1. **What is being built**, and where will people use it (browser, phone, computer, game, a chat bot, a server)?
2. **What does the user already know?** A tool they have used is worth a lot.
3. **Hard limits**: must work offline, must be free to run, a deadline, a team that already uses something.

## 2. Pick two or three options

Start from the usual choices in the table, and fit them to the answers. It is a starting point, not a rule.

| Building | Usual options |
|---|---|
| One-page site | Plain HTML and CSS, or a small site generator |
| Website or web app | Next.js, or Vite with React |
| Phone app | Expo (React Native), or a plain web app that works on phones |
| Desktop app | Electron, or Tauri |
| Game | Unity, or Godot (lighter, free, a good fit for small 2D games) |
| Chat bot, scheduled job | Python |
| Looking into a data file (CSV, spreadsheet): counts, comparisons, a chart | Python with pandas |
| An app that talks to an AI model | the stack of the app itself, plus a small server part that keeps the key |
| Extension for a web browser | plain JavaScript with Manifest V3 (no build step needed) |
| Command line tool | Python, or Node.js if the user already knows JavaScript |
| API or server | Node.js with Express, or Python with FastAPI |

Versions and popularity change. If a detail matters for the decision (a price, a limit, a version), read the official
documentation instead of trusting memory, and say so when you cannot check.

## 3. Compare in plain words

Show a short table with only the points that matter here, in words, not scores:

| | Option A | Option B |
|---|---|---|
| Easy for this user to learn | | |
| Help available (documentation, examples, AI tools) | | |
| Runs where the user needs it | | |
| Cost to run later | | |
| Hard to change later? | | |

## 4. Recommend one

Say which one and why, in three lines at most. Add one sentence: "I would pick the other one if ...". Never ask the
user to install anything to compare options; you decide from knowledge and the documents.

## 5. Record it

After the user picks, append to `PLAN.md` (create it if missing, never rewrite what is there without asking):

```markdown
## Tech decision (<date>)
Chosen: <option>. Why: <one or two lines>. Considered: <the others>. Change this if: <one condition>.
```

Then offer the matching skill from this table; do not start it without a yes. Never leave the user at a dead end: if
no skill fits the choice, say so plainly, offer `project-setup` for the folder and git, and work step by step with the
official documentation of the chosen tool.

| Choice | Offer |
|---|---|
| Website, web app | `web-app-starter` (one page: `landing-page-starter`) |
| Phone app | `mobile-app-starter` |
| Desktop app | `desktop-app-starter` |
| Game with Unity | `game-prototype-unity` |
| Game with Godot | `game-prototype-godot` |
| Chat bot, scheduled job | `python-bot-starter` |
| Data file, analysis, chart | `data-analysis-starter` |
| App feature that uses an AI model | the app's own starter first, then `llm-app-basics` |
| Browser extension | `browser-extension-starter` |
| Command line tool | `cli-tool-starter` |
| API or server | `api-service-starter`; tables: `database-schema`; sign-in: `auth-flow` |
| Programs for small devices or hardware (microcontrollers, sensors) | not covered by this kit: say it, then `project-setup` and the board maker's own guides |

## Do not use for

- An idea that is still fuzzy: use `idea-to-plan`.
- Setting up the chosen tool: use the matching starter skill.
- Deciding what goes into the first version: use `scope-guard`.

## Done when

- The user saw two or three options with a comparison and one recommendation.
- The chosen option and the reason are in `PLAN.md` (show the section).
- You told the user in one sentence what was chosen and which skill starts it.
