---
name: landing-page-starter
description: "Creates a one-page promo site in plain HTML, CSS and a little JavaScript, mobile friendly, with a clear headline and one call to action, and shows it in the browser, ready to publish. Use when the user wants a page for their product, event or service, a simple one-page site, a waiting list page or a link page, and needs no sign-in or database."
license: "MIT (see LICENSE.md)"
compatibility: "Needs only a web browser and a text editor. Node.js is optional, for a local preview server. Commands are written for Windows PowerShell and also work on macOS and Linux."
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-09-30"
  sibersentez-tags: "javascript, web"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "açılış sayfası, tek sayfalık, tek sayfa, tanıtım sitesi, bekleme listesi, kartvizit sitesi, ürün tanıtım*, etkinlik sayfası"
---

# Landing page starter

Goal: one page that says what the thing is, why someone should care and what to do next, working on this computer
and on a phone, with no build step. The page skeleton and the checks are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Collect the content

Read `PLAN.md` if it exists. Ask one question at a time, and mark anything unknown as a placeholder (in the user's
language, clearly marked so it cannot be published by accident):

1. What is it, in one sentence? Who is it for?
2. What are the three best reasons to choose it?
3. What should a visitor do (sign up, write an e-mail, call, buy elsewhere)? This is the single main button.
4. Name, logo, two colors, contact details or a link, if they exist.

## 2. Create the files

Ask for the folder name (default `site`). Create it as a new subfolder and never overwrite existing files:
`index.html`, `style.css` and an empty `assets/` folder for images. Add `script.js` only if the page needs it (for
example a menu button). Start from the skeleton in the reference and fill in the user's words.

## 3. Structure of the page

From top to bottom, each part short:

1. **Top**: name, and the headline (what the visitor gets), one sentence under it, the main button.
2. **Three benefits**: a short title and one line each.
3. **How it works or proof**: three steps, or a quote, a number, a picture. Only real ones; never invent reviews.
4. **Second call to action**: the same button and words as at the top.
5. **Footer**: contact or link, year, the owner's name.

Page rules: one `h1`; every image has `alt` text; a `title` and a `description` in the head; text at least 16px;
styles that work on a narrow phone first and widen on larger screens.

## 4. Look at it

Opening `index.html` in the browser (double-click) is enough. For a preview that reloads and behaves like a real
site, run `npx serve site` after a yes (it downloads a small helper) and open the address it prints. It keeps
running until Ctrl+C; if your tool cannot keep a process running, ask the user to run it in their own terminal.

## 5. Check

- Narrow the browser window to phone width: nothing overflows sideways, the button is easy to tap.
- Press Tab: the button and links can be reached and show where the focus is.
- Every link works, no placeholder is left, no e-mail or phone number is one the user did not give you.
- A form needs a service to receive it (a static page cannot store data): the reference says what to check. Never
  build a sign-up form that goes nowhere.

## 6. Save the work

If the folder is a git repository, commit after a yes: `git add -A`, `git commit -m "feat: first landing page"`.
Add two lines to the README: what the page is and how to view it.

## What comes next

- Wording and looks: change the words with the user; use `ui-polish` for spacing and colors.
- Going online: the `deploy-web` skill (preview link first).

## Do not use for

- A site with several pages, sign-in, a database or a shop: use `web-app-starter`.
- Publishing the page: use `deploy-web`.
- Making an existing page prettier: use `ui-polish`.
- A backend or an API: use `api-service-starter`.

## Done when

- The page opens in the browser with every part from step 3, and the user saw it (say how they opened it).
- Phone width, keyboard and links were checked (say what you saw).
- If a preview server ran, its address was printed and opened; the files are saved (`git status` or the folder list).
- You told the user in one sentence what the page says and what the next step is.
