---
name: api-service-starter
description: "Creates a first working API service with Node.js and Express, or Python with FastAPI: list, add and read routes, a health check, SQLite or a data file, tests and a .env file, then runs and calls it. Use when the user wants an API, a server or a backend, or needs to save data for an app, bot or website."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Node.js 22.9 or newer (an LTS release is best), npm and git; for the Python route Python 3.10 or newer instead of Node.js. Commands are written for Windows PowerShell and also work on macOS and Linux."
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "node-server, fastapi, javascript, python, backend"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "rest api, api servisi, api yaz*, arka uç, sunucu yaz*, uç nokta*, servis yaz*, veri kaydet*, fastapi, python api"
---

# API service starter

Goal: from an empty folder to a small service that runs on this computer, answers three requests, has passing tests
and keeps its settings in `.env`. The full code and the common problems are in [reference.md](reference.md) (Node.js
and Express). The Python route with FastAPI, and the step that moves the data into SQLite, are in
[fastapi-and-sqlite.md](fastapi-and-sqlite.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Agree on what it stores

Follow `PLAN.md` if it names the data. Otherwise ask one question: "What is one thing this service keeps?" (a note,
a task, a customer). Call it the item; the reference code uses `items` and a `title`. Rename it to the user's word.

## 2. Check the tools

Choose the language first, following `PLAN.md`: **Node.js with Express** (this file and reference.md) when the rest of
the project is JavaScript or the user has no preference; **Python with FastAPI** when the rest is Python, the API sits
next to a bot or a data script, or the user knows Python (then follow fastapi-and-sqlite.md for steps 2 to 6).

1. `node --version`: 22.9 or newer. If it is missing or older, the user installs the LTS version from nodejs.org, or
   you run the installer after a yes. Then open a new terminal.
2. `npm --version` and `git --version`. If PowerShell refuses to run `npm`, use `npm.cmd` instead; changing the
   execution policy is a system setting and needs a yes.

## 3. Create the project

Ask for the folder name (default `api`). Work in that new subfolder, never over existing files. Then, after a yes for
the download:

1. Create `package.json` from the reference (`"type": "module"`, scripts `start`, `dev` and `test`).
2. `npm install express` (this downloads a package).
3. Create `store.js`, `app.js`, `server.js` and `test/api.test.js` from the reference. Read each file to the user in
   one sentence: `store.js` keeps data, `app.js` has the routes, `server.js` starts it, the test checks it.

## 4. Settings in `.env`

1. Create `.env.example` with the setting names and fake values (`PORT=3000`, `API_TOKEN=token_EXAMPLE_change_me`).
2. Copy it to `.env` and let the user change values later. Never write a real key into a file or into the chat.
3. Make sure `.gitignore` lists `.env` and `data/`, then check with `git check-ignore -v .env` (it prints the rule).
4. The `start` script loads it when it is there: `node --env-file-if-exists=.env server.js` (a host that has no
   `.env` gives the values as environment variables, and the service still starts). More on keys: the `env-and-secrets` skill.

## 5. Run and call it

Run `npm start`. The terminal prints `API listening on http://localhost:3000`. It keeps running until Ctrl+C in that
terminal; if your tool cannot keep a process running, ask the user to run it in their own terminal. In a second
terminal (in PowerShell use `curl.exe`, not `curl`):

- `curl.exe http://localhost:3000/health` prints `{"ok":true}`
- `curl.exe -X POST -H "Content-Type: application/json" -d "{\"title\":\"First\"}" http://localhost:3000/items`
- `curl.exe http://localhost:3000/items` prints the list

On macOS and Linux the quotes need no backslashes; the reference shows both.

## 6. Tests

Stop the server, then `npm test`. The tests use a temporary data file, so they never touch real data. Show that all
tests pass. Break one on purpose only if the user wants to see a test fail.

## 7. Save the work

Add a short README (how to run: `npm install`, copy `.env.example` to `.env`, `npm start`). Commit after a yes:
`git add -A`, `git commit -m "feat: first running API"`. Check `git status` first: `.env` and `data/` must not be
listed.

## 8. Saving data in a real database (when the JSON file is not enough)

The data file is fine for a first version. When the service must keep more, search it, or survive two requests at
once, move to SQLite: one local file, no server to install. Plan the tables with `database-schema`, write the change
as a numbered migration with an undo, back the file up first and try it on a copy. The steps and code for both routes
are in fastapi-and-sqlite.md; ask before installing a package.

## What comes next

Sign-in and going online are separate steps: add them when the plan needs them, one at a time (`auth-flow`; a container
with `docker-basics`). To put it online use `deploy-web` for hosts that run this kind of app (check the host's
documentation); for the rest of the release use `release-prep`.

## Do not use for

- A website with pages or a React app: use `web-app-starter`.
- A chat bot or scheduled job: use `python-bot-starter`.
- Storing keys safely in an existing project: use `env-and-secrets`.
- An API that is broken: use `debug-helper`.

## Done when

- `npm start` printed the listening line, and `/health` answered `{"ok":true}` (show the command and the output).
- A POST created an item and `GET /items` returned it.
- `npm test` ran and all tests passed (show the summary lines).
- `git status` does not list `.env`. You told the user in one sentence what runs and how to start it again.
