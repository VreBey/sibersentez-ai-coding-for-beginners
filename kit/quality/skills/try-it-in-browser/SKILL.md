---
name: try-it-in-browser
description: "Uses a web feature the way a real person does: runs the app, walks through one flow step by step in a browser, watches for errors and blank states, reports what breaks with the exact steps, and adds one end-to-end test that repeats the flow. Use when a web page or form was just built or changed and nobody has clicked through it yet."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "testing, web"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "tarayıcıda dene*, kullanıcı gibi dene*, uçtan uca test, e2e, tıklayıp dene*, sayfayı dene*, akışı dene*, tarayıcı testi"
---

# Try it in the browser

Tests passing does not mean the page works: a button can be hidden, a request can fail quietly, a page can stay blank.
Use the feature like the person it was built for, write down what happened, then keep one automatic test of that
walk-through so it stays working.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Use made-up data only. Never enter real passwords, payment details or other people's data, and never try the flow
  against a live site that real people use.
- **A separate test browser, never the person's own.** Use the project's browser-test tool or a fresh browser you
  start yourself with an empty profile. Do not drive the person's everyday browser through an extension or remote
  control: it carries their sign-ins and open tabs. If nothing else is available, ask first and say what it could see.
  A plain page with no build can often be checked by opening its file once and reading it.

## 1. Pick one flow

Read `PLAN.md` and ask: "What is the one thing a person does here most?" (sign up, add an item, check out).
Write it as numbered actions with what should be seen after each:

```
1. Open the start page            -> the title and the "Add" button are visible
2. Type "Milk" and press Add      -> "Milk" appears in the list
3. Reload the page                -> "Milk" is still there
```

Ask the user to correct the list. One flow at a time; more flows come after this one is done.

## 2. Start the app

Find the run command in the README or the manifest and start it (if your tool cannot keep a program running, the
user starts it in their own terminal). Open the address it prints. If it will not start, stop and use
`fix-build-errors`: this skill needs a running app.

## 3. Walk through it

If your tool has a browser it can drive, use it. If not, ask the user to follow the numbered list in their own browser
and describe what they see (a screenshot helps), one step at a time. At each step look at the page **and** at:

- the browser's console: red errors or warnings (developer tools, F12, Console);
- the network list: requests that failed or took long;
- the result: is the content really there, or only the frame?

Then do what a careless person does: leave a field empty, type something absurdly long, press the button twice, go
back and forward, reload in the middle, and view the page at phone width (the device toolbar in developer tools).

## 4. Report what you found

Keep a short table, in the user's language:

| Step | Expected | Saw | Status |
|---|---|---|---|
| 2 | "Milk" in the list | the list stayed empty; console says the request failed | broken |

For each break: the exact steps, what you expected, what happened, and the first red console line. Do not fix
anything yet. Ask whether to fix them now (`debug-helper`) and in which order.

## 5. Add one end-to-end test

After the flow works, turn the same list into one automatic test:

- Use the browser-test tool the project already has. If there is none, suggest one (Playwright is the usual choice),
  explain what installing it downloads and ask first.
- One test, one flow. Find things the way a person does (by visible text, label or role), not by position or by
  fragile selectors. Wait for a thing to appear instead of waiting a fixed time.
- The test uses fake data and starts from a clean state. It never talks to live services.
- Run it twice in a row. A test that passes once and fails once is not finished.

## Do not use for

- A page that does not even start or build: use `fix-build-errors`.
- Finding the cause of a known bug: use `debug-helper`.
- Looks, spacing and phone layout in depth: use `ui-check`.
- Unit tests for plain functions: use `test-first`.

## Done when

- The flow was walked step by step, and the table shows each step as fine or broken, with evidence for each break.
- The console and the network list were looked at, and the phone width and one wrong input were tried.
- One end-to-end test of the flow exists and passed twice in a row (show the command and output), or you said plainly
  why no test was added.
- You told the user in one sentence what works, what does not, and what you suggest next.
