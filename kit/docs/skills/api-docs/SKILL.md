---
name: api-docs
description: "Writes reference documentation for an API: every endpoint with its purpose, an example request and a real example response, the error codes it can return, and a command to try it, all run against the real program. Use when an API needs documentation, other people or apps will call it, or the user asks what the routes are."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "docs, backend"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "api belge*, api dokümantasyon*, uç nokta belgesi, örnek istek, api kılavuzu, endpoint belge*, swagger, openapi, hangi uç noktalar var"
---

# API docs

Documentation that was never run goes out of date the day it is written. Document what the program really does:
call every endpoint, copy the real answer, and write the page from that.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Examples use made-up data and the placeholder `<TOKEN>`. Never print a real key, token or personal record.

## 1. Find the endpoints

Read the route files and any existing notes; list every endpoint: method, path, who may call it (public, needs a
token, needs a role), what it takes (path parts, query, body) and what it returns. If the code and the old docs
disagree, the code wins; note the difference to tell the user.

## 2. Start the program

Run it locally with fake data (the README tells how; ask the user to start it if your tool cannot keep it running).
Make sure `/health` or the first route answers before you write anything.

## 3. Call every endpoint

For each endpoint make one successful call and one failing call (a missing field, an unknown id, no token). Keep the
exact command and the real response. In PowerShell write `curl.exe`; show the same call for macOS and Linux
once at the top of the page instead of repeating it.

If a call does something different from what the code or the user says it should, that is a bug: report it and ask
whether to fix the code or the description. Never write the documentation to hide it.

## 4. Write `docs/API.md`

```markdown
# <Name> API

Base address: http://localhost:3000   (local)   Format: JSON   Dates: UTC, ISO 8601

## Sign in (if any)
How to get a token and how to send it: `Authorization: Bearer <TOKEN>`.

## Errors
Every error looks like: { "error": { "code": "...", "message": "..." } }

## GET /items
What it does in one line. Who may call it.
Query: `limit` (number, optional, default 20)
Try it:   curl.exe http://localhost:3000/items
Answer 200:  <the real JSON>
Possible errors: 401 no token, 429 too many requests

## POST /items
...
```

Per endpoint: purpose, who may call, inputs with type and whether required, a "Try it" command that works when pasted,
the real success answer, and a table of status codes it can return with the cause of each.

## 5. Common sections

A short "Getting started" with the three commands that prove the API works; the list of status codes used across the
API; rules that hold everywhere (pagination, limits, date format, naming). Keep one page per API unless it is huge.

## 6. Prove the page

Copy each "Try it" command from the finished file and run it again. Fix the file where the output differs. List any
endpoint you could not call and why.

## 7. Keep it true

Ask where the page should be linked from (the README). Suggest one habit: a route change comes with a documentation
change in the same commit. An OpenAPI file is a later step, only when the user wants tools to read it.

## Do not use for

- A README or user guide for the whole project: use `docs-writer`.
- Building or changing the routes: use `backend-builder`.
- Explaining an unfamiliar codebase: use `explain-codebase`.

## Done when

- Every endpoint is in `docs/API.md` with purpose, request, real response and its error codes.
- Each "Try it" command was run again from the finished file, and the result is shown (or marked as not run, with why).
- Differences between the code and the old documentation, and any bug found, were told to the user.
- No real key, token or personal data is in the file.
