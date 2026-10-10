---
name: python-bot-starter
description: "Builds a first working Python bot or automation script: a virtual environment, a Telegram or Discord bot or a scheduled job, the token kept in a .env file, then run, test and stop it safely. Use when the idea is a chat bot, a Telegram bot, a Discord bot, a reminder or notification bot, a scraper, or a script that automates a task on a schedule."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Python 3.11 or newer (3.14 is best) and git; a Telegram or Discord account for chat bots. Commands are written for Windows; on macOS and Linux use .venv/bin/python."
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "python, bot, automation, scraping"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "bot*, telegram, discord, otomasyon*, otomatik*, hatırlat*, bildirim*, zamanlanmış, her gün, her sabah, veri çek*, betik, script, python"
---

# Python bot starter

Goal: a bot that answers a message (or a script that does its job once), running from this computer, with the
token safely outside the code and a first commit. Code and common errors are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never ask the user to paste a token or password into the chat. They type it into the `.env` file themselves.

## 1. Check the tools

1. `py --version` (the Python launcher) or `python --version`: 3.11 or newer (3.14 is best; 3.10 no longer gets
   security fixes). If `python` opens the Microsoft Store, Python is not really installed. The user installs it from
   python.org (the Python install manager it offers for Windows, or the classic installer with "Add python.exe to
   PATH" ticked), or you run `winget install Python.Python.3.14` after a yes. Open a new terminal afterwards.
2. `git --version`.

## 2. Choose the kind of bot

Follow `PLAN.md` if it decides:

| Kind | Library | Needs |
|---|---|---|
| Telegram bot | python-telegram-bot | a token from @BotFather in Telegram |
| Discord bot | discord.py | an application and bot in the Discord Developer Portal |
| Scheduled job (no chat) | standard library first | Windows Task Scheduler to run it |

## 3. Files and virtual environment

Python has no project generator, so create only these, in the project root (or in `bot/` if the root is busy):

```
bot.py            the program (job.py for a scheduled job)
requirements.txt  the packages it needs
.env              the token (never committed)
.env.example      the same names with empty values (committed)
.gitignore
```

1. Add `.env`, `.venv/`, `__pycache__/` and `*.log` to `.gitignore` **before** `.env` exists.
2. `py -m venv .venv` creates a private Python for this project. Explain: packages go there, not into the system.
3. No need to "activate" it: call its Python directly, which also avoids PowerShell script errors:
   `.venv\Scripts\python -m pip install -r requirements.txt` (ask first; it downloads packages).
   `requirements.txt` lists the direct packages with a major version range, for example
   `python-telegram-bot>=22,<23` and `python-dotenv>=1,<2`.

## 4. Get the token (user)

- **Telegram**: open @BotFather, send `/newbot`, choose a name and a username ending in `bot`, copy the token.
- **Discord**: Developer Portal > New Application > Bot > Reset Token, copy it. If the bot must read message text,
  switch on "Message Content Intent" on the same page. Then OAuth2 > URL Generator: scope `bot`, permissions
  "Send Messages" and "Read Message History"; open the link and add the bot to a test server.

The user writes `BOT_TOKEN=<token>` into `.env` themselves. `.env.example` gets `BOT_TOKEN=` with no value.

## 5. The first version

Write `bot.py` from the matching example in reference.md. Keep the rules of the bot in plain functions (for example
`make_reply(text)`), so they can be tested without Telegram or Discord.

## 6. Run and check

1. `.venv\Scripts\python bot.py`
2. Telegram: send `/start` to the bot. Discord: type `!ping` in the test server. The bot answers.
3. Stop it with Ctrl+C. If your tool cannot keep a program running, ask the user to run step 1 in their own
   terminal and tell you what happens.
4. Only one copy may run at a time; a second copy causes a "Conflict" error in Telegram.

## 7. Tests

Test the plain functions with pytest (installing it needs a yes): put tests in `tests/test_bot.py` and run
`.venv\Scripts\python -m pytest`.

## 8. Save

README with the run steps and where the token goes (not the token itself). `git status` must not show `.env` or
`.venv`. Commit after a yes: `git add -A`, `git commit -m "feat: first working bot"`.

## Scheduled jobs

Write the work as one function, run it by hand until it works, and log to a file. Then set up Windows Task
Scheduler with the user (it is a system setting: ask). The settings that matter: Program is the full path to
`.venv\Scripts\python.exe`, Arguments is `job.py`, and **Start in** is the project folder.

## Running day and night

A bot on this computer runs only while the computer is on and the program is open. Running it all the time needs
a server or hosting service: discuss costs and where the token will live before choosing one. For scrapers:
respect the site's terms and robots.txt, go slowly, and prefer an official API when there is one.
