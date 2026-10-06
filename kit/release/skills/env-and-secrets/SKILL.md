---
name: env-and-secrets
description: "Keeps API keys and settings out of the code: a .env file for the real values, a .env.example with names only, the ignore rule, how the code reads them, and where they go when the app is online. Use when the user asks where the API key goes, sees a key in the code, needs a database address or token, or wants different settings here and online."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-tags: "security, devops"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "env, env dosyası, api anahtar*, api key, ortam değişken*, anahtarı nereye, nereye koy*, gizli ayar*"
---

# Env and secrets

Code gets shared, copied and uploaded. Keys must not travel with it. The safe habit: real values live in a `.env` file
that git ignores, the code only reads them by name, and a `.env.example` shows which names exist. Examples for the
common languages are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never write a real key, token or password into a file you create, and never ask the user to paste one into the chat.
  Example values are plainly fake, such as `sk_test_EXAMPLE`.

## 1. Find what is hard-coded

Search the code for values that look like keys, tokens, passwords, connection addresses and private URLs (the
reference lists search hints). Report **names and file:line only**, and at most a value's public prefix (`sk-`, `ghp_`), never its characters.
If a real secret is already in a committed file, stop and switch to `secrets-cleanup`: revoking comes first.

## 2. Decide the setting names

For each value choose an upper-case name with underscores: `PAYMENT_SECRET_KEY`, `DATABASE_URL`, `PORT`. Say what
each one is for. Settings that are not secret (a port, a feature switch) can live there too.

## 3. Create `.env.example`

Write a file with the names, a short comment and fake values:

```
# Copy this file to .env and fill in real values. .env is never committed.
PORT=3000
PAYMENT_SECRET_KEY=sk_test_EXAMPLE
DATABASE_URL=postgres://user:password@localhost:5432/mydb_EXAMPLE
```

This file **is** committed: it tells the next person (or the user in six months) what the project needs.

## 4. Create `.env` (the user fills it in)

Copy the example to `.env` (a yes if `.env` exists: never overwrite it). The user types the real values in an editor
themselves. If the user offers to paste a key in the chat, decline kindly: they put it in the file directly.

## 5. Make git ignore it

Add these lines to `.gitignore` (create the file if missing), then check:

```
.env
.env.*
!.env.example
```

Run `git check-ignore -v .env`: it must print the rule that matches. Run `git status`: `.env` must not appear. If it
was tracked before, `git rm --cached .env` stops tracking it (a yes first) but the old commits still hold it:
that is a `secrets-cleanup` case.

## 6. Read the values in code

Use the way that fits the project (examples in the reference). Two habits: read by name in **one** place, and stop
at start-up with a clear message when a required value is missing ("PAYMENT_SECRET_KEY is not set, copy .env.example
to .env"), so errors are not found later in a strange spot. Never print a value in logs.

## 7. What the browser can see

Anything sent to the browser, a phone app or a desktop app can be read by its users. Values with the public prefix of
a web framework are public by design. A key that must stay secret belongs in server code, and the front end asks the
server. Say this whenever a key is about to be used in front-end code.

## 8. Online and in CI

The host and the CI service have their own place for settings (a dashboard section, repository secrets). The user
enters the values there; you list the names. Use test keys for previews and live keys only for production. Never commit a `.env` for
another environment. See `deploy-web` and `github-actions-setup`.

## Do not use for

- A key that was already committed, pushed or shared: use `secrets-cleanup`.
- A general safety review of the whole project: use `security-check`.
- Publishing the site: use `deploy-web`.
- Making the first API service: use `api-service-starter`.

## Done when

- `.env.example` exists with names and fake values, and is the only env file in `git status` (quote the output).
- `git check-ignore -v .env` printed a rule.
- The project runs and reads the values (name the command and what it printed, without any value), and it stops with
  a clear message when one is removed.
- You told the user in one sentence where the real values live and where they must go when the app is online.
