---
name: launch-checklist
description: "Checks a website before and right after it goes public: one address with HTTPS, security headers, legal and contact pages, a real 404, sitemap and robots, search and share previews, broken links, the phone view, speed and a way back. Every check is proven with a command or the browser. Use when a site is about to go live or just went live."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-05"
  sibersentez-tags: "web, devops, security"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "yayın öncesi kontrol*, canlıya almadan önce, canlı site kontrol*, site kontrol listesi, yayına hazır mı, seo kontrol*, güvenlik başlık*, yasal sayfa*, kvkk sayfa*, site harita*"
---

# Launch checklist

A site that "opens" is not yet a site that is ready. Strangers, search engines and the law look at things the owner
never clicks on. Go through the list below on the real address, prove each line, and hand the owner a short table.
Commands, snippets and a link checker are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Checking is reading: a few `GET` and `HEAD` requests to the user's own address. Never send forms, sign in, or load
  test a site; never scan addresses that are not the user's.
- You are not a lawyer. For legal pages, give a clear starting text and say a professional should read it when money
  or personal data is involved.

## 1. What and where

Ask for the address (or the preview address) and what the site does: only pages, or also sign-in, a shop, forms or
uploads. Read the project's README and build output. Every check below runs against that address, not the local copy:
hosts add and drop things on their own.

## 2. One address, always HTTPS

Pick the one address the site lives at (with or without `www`). Every other form must answer with one permanent
redirect (`301`) to it: `http://`, `www.` or not, an old domain, a temporary test address. Prove each with
`curl.exe -sI` and read the `Location` line. No chains of several hops, no `302` for permanent moves.

## 3. Security headers

On a page and on a static file, look for: `Strict-Transport-Security` (only after HTTPS works everywhere),
`X-Content-Type-Options: nosniff`, a frame rule (`X-Frame-Options` or `frame-ancestors`), a `Referrer-Policy`, and a
`Content-Security-Policy` when the site is simple enough to have one. Check app pages and plain files separately: the
web server adds headers to one, the app to the other. **After any move to a new host, check again**: the old server may
have added a header the new one does not.

## 4. Pages people and the law expect

- **Privacy policy**: what is collected, why, how long, who else sees it (payment or mail providers), how to ask for
  deletion. Turkey: KVKK; the EU: GDPR. A cookie banner only when the site sets non-essential cookies or analytics.
- **Terms of use** for a shop or a service; delivery and returns for a shop.
- **A contact address at the site's own domain** (`domain-email`), not a personal mailbox.
- **A 404 page** that answers with status `404` (not `200`), links home and looks like the site.
- Every legal page linked from the footer of every page.

## 5. Search and sharing

On every page: a unique `<title>`, a meta description, `<html lang>`, one `<h1>`, a canonical link, and social preview
tags (`og:title`, `og:description`, `og:image` at about 1200×630). Images have `alt` text. At the root: `sitemap.xml`
with the live addresses, `robots.txt` that does not block the site and names the sitemap, a favicon. Optional:
`llms.txt`, a short plain-text summary for AI assistants. Adding the site to a search console needs the owner's sign-in:
they do that; you prepare the verification record or file and the sitemap address.

## 6. Links, look and behavior

Run the link checker from the reference over the sitemap: every internal link answers `200` (or a planned `301`).
Open the site at phone width (`try-it-in-browser` if available): text readable, nothing wider than the screen, buttons
reachable. No errors in the browser console. Images load. If there are forms, the owner sends one real test.

## 7. Speed basics

Text files come compressed (`Content-Encoding: br` or `gzip`). Files that change rarely (styles, images, fonts) have a
long `Cache-Control`; pages have a short one or `no-cache`. Images are sized for the screen (WebP or AVIF). For more,
`performance-check`.

## 8. A safety net

- A copy of the files and the data from the moment of going live, kept off the server (the owner's computer or storage).
- How to go back: the previous deploy, the old server still running, or the backup. Write the steps down.
- Two-step sign-in on the hosting panel, the domain registrar and the code host. Only the owner can switch it on.
- Optional: an uptime monitor that emails the owner when the site stops answering.

## 9. Report

| Check | Result | Proof | Fix |
|---|---|---|---|
| http → https | PASS | `301 Location: https://…` | |
| HSTS | FAIL | header missing on app pages | add it in the server config (yes needed) |

Use PASS, FAIL or SKIPPED (with why). Offer to fix FAIL lines one by one, each after a yes. End with a short to-do list
of what only the owner can do: sign-ins, two-step sign-in, payment or legal decisions, cancelling an old server.

## Do not use for

- Putting the site online the first time: `deploy-web`. Moving a running site to another host: `move-to-new-host`.
- Email at the domain: `domain-email`. A deeper code review for holes: `security-check`.
- Measuring and fixing slowness in depth: `performance-check`.

## Done when

- Every line of sections 2 to 8 has PASS, FAIL or SKIPPED with its proof (a command output or what the browser showed).
- FAIL lines were fixed after a yes and checked again, or are on the owner's list.
- You told the user in one sentence whether the site is ready for strangers, and what is left.
