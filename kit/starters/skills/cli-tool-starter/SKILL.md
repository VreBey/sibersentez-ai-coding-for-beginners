---
name: cli-tool-starter
description: "Turns a script into a command line tool: arguments and options, a built-in help text, clear errors and exit codes, a version flag, tests, and a way to run it from any folder. Uses Python or Node.js. Use when the user has a script they run by editing it, wants a command to type in the terminal, or asks for a command line tool."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Python 3.11 or newer (3.14 is best), or Node.js 22 or newer (24 LTS is best), and git. Commands are written for Windows PowerShell; on macOS and Linux use .venv/bin/python and the same npm commands."
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "python, javascript, cli"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "komut satırı*, terminal aracı, cli, argüman*, komut yaz*, terminalde çalış*, her klasörden çalış*, yardım metni"
---

# Command line tool starter

Goal: a script becomes a command others can type: `mytool --help` explains it, bad input gets a clear message, and it
works from any folder. The full examples (Python and Node.js), the install steps and the problem table are in
[reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Putting a command on the system path or installing a tool globally changes the computer: say so and ask first.

## 1. Know the script

Read the script and `PLAN.md`. Ask: "What do you type or edit each time you run it?" Those values (a file name, a
folder, a number, a switch) become the arguments. Ask for the command name: short, lower case, no spaces
(`wordcount`, `renamer`).

## 2. Choose the language

Keep the language the script is already in. For a new tool: Python when the job is about files, text or data;
Node.js when the user knows JavaScript or the project already uses it. Check `py --version` or `node --version`.

## 3. Design the command line first

Write the usage on paper, show it to the user and agree on it before coding:

```
mytool <input-file> [--output FILE] [--verbose]
mytool --help
mytool --version
```

- Things the tool must have go first as positional arguments; everything optional is a named option with a default.
- Short, plain option names; long names with two dashes (`--output`).
- A tool that asks questions while it runs blocks scripts: take the answer as an option instead.

## 4. Build it

Follow the example in the reference for the chosen language:

1. The work lives in a function that takes its inputs as parameters and returns a result. The command line part only
   reads the arguments and calls it. This keeps the tool testable.
2. The argument library of the language (`argparse` in Python, `util.parseArgs` in Node.js) writes `--help` from the
   descriptions you give: write one clear sentence per argument and an example in the help text.
3. Errors: a message on the error stream saying what went wrong and what to do ("File not found: x.txt. Check the
   name."), never a raw stack trace for a normal mistake. Exit code 0 for success, 1 for a failure, 2 for wrong usage.
4. File names the user types are relative to the folder they are in, not to the folder where the script lives.
5. `--version` prints the version from one place.

## 5. Try it by hand

Run it as a user would: with correct input, with no arguments, with a missing file, with a wrong option and with
`--help`. Show each result and the exit code (`$LASTEXITCODE` in PowerShell).

## 6. Tests

Test the work function, and the command line part through its entry function with a list of arguments (no
subprocess needed). Cover: normal input, a missing file, a wrong option (exit code 2), `--help` text mentions every
option. Run them (`test-first`).

## 7. Run it from any folder

Explain the options and let the user pick; each one changes the computer, so ask first:

| Option | What it does | Fits |
|---|---|---|
| Install the project in editable form (`pip install -e .` into the project's own environment, or `npm link`) | the command works while that environment or link exists; edits show at once | the author's own use |
| Install it with a tool made for command line programs (`pipx`, `npm install -g`) | a global command | sharing with others |
| A tiny `.cmd` file in a folder already on the path that calls the script | one file, easy to remove | Windows, no packaging |

After the install, open a **new** terminal, go to another folder (for example your documents) and run `mytool --help`.
That is the real test.

## 8. Save

README: what it does, three usage examples, how to install. Commit after a yes (`.venv`, `node_modules` ignored):
`git commit -m "feat: first command line tool"`.

## Do not use for

- A chat bot or a scheduled job: use `python-bot-starter`.
- A window application: use `desktop-app-starter`.
- A script that crashes: use `debug-helper`.

## Done when

- `mytool --help` printed a clear help text, and the user agreed to the usage in step 3 (show it).
- The tries of step 5 were run, with their output and exit codes shown.
- The tests pass (show the summary) and the command ran from a different folder in a new terminal.
- You told the user in one sentence how to run it and how to remove it again.
