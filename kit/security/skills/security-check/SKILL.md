---
name: security-check
description: "Checks a project for common security problems: secrets or API keys in code and git history, missing input validation, weak access checks, risky dependencies and broad permissions, then lists fixes by priority. Use when a project is about to be published or shared, after adding sign-in, payments or uploads, or when asked if it is safe."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.3.0"
  sibersentez-tags: "security"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "güvenli*, şifre*, parola*, anahtar*, token, sızıntı, zafiyet*, yetki*, saldırı*"
---

# Security check

A practical hygiene check that finds the most common mistakes. Say clearly that it is not a professional audit; for
money, health or many users' personal data, recommend an expert review as well.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- When you show a secret you found, name its kind or public prefix (`sk-`, `ghp_`) and its file:line, never its
  characters.

## 1. Map what is exposed

In a few lines: what can outsiders reach (web pages, an API, a bot, an installed app), what data is handled (personal
data, payments, files), and where secrets are kept. This decides which checks below matter most.

## 2. Secrets

- Search the code and config for keys, tokens and passwords. Useful search terms are in [reference.md](reference.md).
- `.gitignore` must list `.env` and similar files; `.env.example` holds names only.
- Check the git history too: `git log --all --oneline -- .env` and `git log --all -p -S "<first characters>"`.
- A real secret that was ever committed or shared is **compromised**. Tell the user to revoke it and create a new one
  at the provider first. Cleaning git history comes later, is risky, and needs its own yes.
- Anything shipped to users' devices (web page code, mobile app, desktop app) can be read by them. Keys that must stay
  secret belong on a server.

## 3. Input from outside

Every place data enters: forms, URL parameters, bot messages, uploaded files, API bodies, files the app opens.

- Validated on the server side (type, length, allowed values), not only in the browser.
- Database queries use parameters; no SQL built by joining strings.
- Output inserted into HTML is escaped; no raw HTML from users.
- No shell command built from input. File paths from input are normalized and must stay inside an allowed folder.
- Uploads are limited in size and type and stored outside the code folder.

## 4. Access

- Every protected action checks the user on the server, not only by hiding a button.
- A user can only read and change their own data: try changing an id in a request.
- Admin pages and commands are protected. Sign-in and bot commands have a rate limit.
- Cross-origin settings do not allow every site together with cookies.

## 5. Dependencies

- Run the ecosystem's audit: `npm audit`, `pip-audit` for Python (installing it needs a yes), or
  `dotnet list package --vulnerable`; the table and how to read the result are in the "Dependency vulnerability scan"
  section of [reference.md](reference.md). Explain each high or critical finding in one line, and say "not scanned" if
  the scan could not run.
- Update packages one at a time and run the tests after each (`dependency-update` does this). Avoid automatic bulk fixes
  that jump major versions.
- The lock file is committed. Unused packages are removed. Watch for look-alike package names.

## 6. Settings and permissions

- Debug mode off in production; error pages show no stack traces to users.
- HTTPS for anything online; cookies `Secure`, `HttpOnly`, `SameSite`.
- A live site: read its real response headers (`curl.exe -sI <address>`) for HSTS, `nosniff`, a frame rule and a
  content security policy, on a page and on a static file; again after any move to a new host (`launch-checklist`).
- An app behind a proxy that counts visitors by IP (rate limits, login lockouts) trusts `X-Forwarded-For` only from
  its own proxy.
- Hosting panel, domain registrar and code host accounts have two-step sign-in (the owner switches it on).
- API keys and database users have the least rights they need.
- Desktop apps: the page part has no direct access to the computer (see the checklist in reference.md).
- Bots: the token lives only in an environment variable; commands that change things check who is asking.

## 7. Report

| Priority | Finding | Where | Fix |
|---|---|---|---|
| Critical | ... | file:line | ... |

- **Critical**: a leaked secret, or a hole anyone can use right now.
- **High**: missing access check, injectable input.
- **Medium**: weak settings, outdated package with a known issue.
- **Low**: hardening and good practice.

Offer to fix items one by one, each after a yes. Things only the user can do (revoking keys at a provider, changing
hosting settings) go into a short to-do list for them.
