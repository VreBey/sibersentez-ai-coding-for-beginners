# Python bot starter: reference

Contents: Telegram bot (python-telegram-bot 21 or newer) · Discord bot (discord.py 2) · Scheduled job · A first test ·
Common errors

Commands assume Windows and a virtual environment in `.venv`. On macOS and Linux use `.venv/bin/python`.

## Telegram bot (python-telegram-bot 21 or newer)

`requirements.txt`:
```
python-telegram-bot>=22,<23
python-dotenv>=1,<2
```

`bot.py`:
```python
"""Telegram bot: answers /start and replies to text messages."""
import logging
import os
import sys

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters


def make_reply(text: str) -> str:
    """The bot's rule, kept apart so tests can call it without Telegram."""
    cleaned = text.strip()
    return f"You wrote: {cleaned}" if cleaned else "Send me some text."


async def on_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Hi! Send me a message.")


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(make_reply(update.message.text or ""))


def main() -> None:
    load_dotenv()
    token = os.environ.get("BOT_TOKEN")
    if not token:
        sys.exit("BOT_TOKEN is missing. Put it in the .env file.")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # The HTTP client logs request addresses, and those contain the token
    logging.getLogger("httpx").setLevel(logging.WARNING)
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", on_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.run_polling()


if __name__ == "__main__":
    main()
```

## Discord bot (discord.py 2)

`requirements.txt`:
```
discord.py>=2.4,<3
python-dotenv>=1,<2
```

`bot.py`:
```python
"""Discord bot: answers !ping in any channel it can read."""
import os
import sys

import discord
from discord.ext import commands
from dotenv import load_dotenv

intents = discord.Intents.default()
intents.message_content = True  # also switch it on in the Developer Portal
bot = commands.Bot(command_prefix="!", intents=intents)


@bot.event
async def on_ready() -> None:
    print(f"Ready as {bot.user}")


@bot.command()
async def ping(ctx: commands.Context) -> None:
    await ctx.send("pong")


if __name__ == "__main__":
    load_dotenv()
    token = os.environ.get("BOT_TOKEN")
    if not token:
        sys.exit("BOT_TOKEN is missing. Put it in the .env file.")
    bot.run(token)
```

Slash commands come later: register them on `bot.tree` and sync once in `setup_hook`, not in `on_ready`.

## Scheduled job

`job.py`:
```python
"""Does one job and exits. Windows Task Scheduler starts it on a schedule."""
import logging
from pathlib import Path

LOG_FILE = Path(__file__).with_name("job.log")


def run_job() -> str:
    """Put the real work here and return a short summary."""
    return "nothing to do yet"


def main() -> None:
    logging.basicConfig(filename=LOG_FILE, encoding="utf-8", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        logging.info("done: %s", run_job())
    except Exception:
        logging.exception("job failed")
        raise


if __name__ == "__main__":
    main()
```

## A first test

`tests/test_bot.py`:
```python
from bot import make_reply


def test_empty_message_asks_for_text():
    assert make_reply("   ") == "Send me some text."


def test_text_is_echoed_without_spaces():
    assert make_reply("  hello ") == "You wrote: hello"
```

Run from the project root: `.venv\Scripts\python -m pytest`.

## Common errors

| Message or symptom | Cause and fix |
|---|---|
| `python` opens the Microsoft Store | Only the Store shortcut exists. Install Python, or use `py`. |
| `Activate.ps1 cannot be loaded because running scripts is disabled` | No need to activate: call `.venv\Scripts\python` directly. |
| `ModuleNotFoundError: No module named 'telegram'` (or `discord`, `dotenv`) | The package went into another Python. Install with `.venv\Scripts\python -m pip install -r requirements.txt` and run with the same Python. |
| `BOT_TOKEN is missing` | `.env` is not in the folder the program runs from, or the line is misspelled. |
| `InvalidToken` / `Unauthorized` (Telegram), `LoginFailure` (Discord) | Wrong token, extra spaces or quotes. Create a new token and paste it again. |
| `Conflict: terminated by other getUpdates request` | The Telegram bot runs twice (another terminal or a server). Stop the other copy. |
| Discord bot is online but ignores messages | Message Content Intent is off in the portal, or `intents.message_content = True` is missing. |
| `PrivilegedIntentsRequired` | Switch on the intent in the Developer Portal (Bot page). |
| `SSL: CERTIFICATE_VERIFY_FAILED` | A proxy or antivirus is inspecting traffic. Fix the network or certificates; never switch verification off. |
| Scheduled task runs but does nothing | "Start in" is empty, so relative paths point elsewhere. Set it to the project folder and check `job.log`. |
| Garbled Turkish letters in a log file | Open and write files with `encoding="utf-8"`. |
