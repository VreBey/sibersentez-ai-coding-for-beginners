---
name: browser-extension-starter
description: "Builds a first browser extension in JavaScript with Manifest V3: the fewest permissions, a content script that changes a page, a small popup, loading it unpacked, finding errors and packaging it. Use when the idea is a browser extension, a Chrome or Edge add-on, or a tool that reads or changes web pages the user visits."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Chrome or Edge (Chromium based) and git. No Node.js or build step is needed. Written for Windows; macOS and Linux work the same."
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-01"
  sibersentez-tags: "javascript, extension"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "tarayıcı eklentisi, chrome eklentisi, tarayıcı uzantısı, eklenti*, uzantı*, chrome uzantı*, edge eklentisi, siteyi değiştiren eklenti"
---

# Browser extension starter

Goal: an extension loaded in the user's own browser that does one visible thing on a chosen site, with only the
permissions it needs, saved in git. The files, the code and the error table are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- An extension runs inside the user's real browser, next to their logins. Test it on harmless pages first, never put
  secrets in it, and never load code from the internet into it.

## 1. Decide the one thing

Ask: "What should it do, and on which site?" Write one sentence ("on news pages, make links open in a new tab" or
"a popup with a button that copies the page title"). One thing first. Does it need to read the page, change it, run
on a click, or all three?

## 2. Choose the permissions (fewest first)

Explain in plain words that permissions are what the browser warns users about, and that fewer permissions mean more
trust and an easier review. Fill the manifest with the table in mind:

| Need | Ask for | Avoid |
|---|---|---|
| Run only when the user clicks the extension | `activeTab` | `tabs`, broad host access |
| Run on one site | a narrow `content_scripts` match such as `https://example.com/*` | `<all_urls>` |
| Remember a setting | `storage` | `cookies`, `history` |
| Anything else | name it and say why | permissions "just in case" |

## 3. Create the files (in a subfolder, after a yes)

In a new folder `extension/`: `manifest.json`, `content.js`, `popup.html`, `popup.js` and an icon if wanted. Write
them from the reference. Read `manifest.json` to the user line by line: the name, version, the Manifest V3 marker,
the permissions, which script runs where. Manifest version 3 does not allow code from outside the package, inline
scripts in pages, or `eval`.

## 4. Load it, unpacked (user)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on Developer mode, press Load unpacked, choose the `extension/` folder.
3. The extension appears. Pin it from the puzzle icon to see its button. Open the target site.
4. After every edit press the reload arrow on the extension's card, then reload the page.

## 5. Verify

- The change happens on the target site, and does **not** happen on another site.
- The popup opens and its button works.
- The extension's card shows no red Errors button; the page's console has no red lines from the script.
- Open the permission details of the card and compare with step 2: nothing extra.

## 6. Find errors

| Where the code runs | How to see its errors |
|---|---|
| The content script (inside the page) | the page's developer tools, Console; choose the extension's context in the dropdown if needed |
| The popup | right click inside the popup, Inspect |
| The background service worker (if any) | the "service worker" link on the extension's card |
| Loading problems | the Errors button on the card |

## 7. Package and share

- For a friend: zip the `extension/` folder (not the whole project, no `.git`); they unzip and Load unpacked.
- For the browser's web store: a developer account (a small one-time fee for Chrome's store; check the current page),
  a zip, icons, screenshots, a plain explanation of each permission, and a privacy statement if any data is handled.
  Review takes days and may ask for changes. This is a separate step with its own yes.

## 8. Save

README: what it does, how to load it, what each permission is for. `git status`, then commit after a yes:
`git commit -m "feat: first browser extension"`.

## Do not use for

- A website: use `web-app-starter`.
- A window application on the computer: use `desktop-app-starter`.
- A leaked key or a security review: use `secrets-cleanup` and `security-check`.

## Done when

- The user loaded it unpacked and saw the change on the target site, and nowhere else.
- The Errors button and the consoles show nothing red (say what you looked at).
- Each permission in the manifest was explained, and none is unused.
- The commit exists after a yes, and you told the user in one sentence how to reload it after an edit.
