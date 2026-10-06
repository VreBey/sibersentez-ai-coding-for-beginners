---
name: ui-polish
description: "Improves how a screen looks without changing what it does: spacing, text size, colors and contrast, alignment, buttons, and the loading, empty and error states, one small change at a time with a look after each. Use when the user says it looks ugly or plain, asks to make it prettier or more professional, or finds a screen crowded or confusing."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "design, ui"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "çirkin, sade görünüyor, daha güzel, profesyonel görün*, güzelleştir*, görünüm*, boşluk*, yazı boyutu"
---

# UI polish

Most "ugly" screens have four or five fixable causes: too little space, no clear main thing, too many sizes and
colors, and missing states. Fix them one at a time, look after each change, and never change what the screen does.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Pick one screen and look at it

Ask which screen bothers them most. Run the project (its dev command, see the README) and ask the user to open it, or
to send a screenshot. You cannot judge a screen you have not seen. Note the size of the window too. If the tool
cannot keep a dev server running, ask the user to start it in their own terminal.

## 2. Name the five biggest problems

Read the screen against this list, and write the top five, most damaging first, each in one plain sentence:

| Area | What to look for |
|---|---|
| Main thing | Is there one obvious heading or action? Or ten things of equal weight? |
| Space | Cramped blocks, uneven gaps. Use a small scale of gaps (for example 4, 8, 16, 24, 32 pixels) and only those |
| Text | More than two fonts or many sizes; body text under 16 pixels; long lines over about 75 characters; lines too tight |
| Color | Many colors that mean nothing. Use one accent for actions. Text must stay easy to read: dark on light or the reverse, with a strong difference |
| Alignment | Edges that almost line up. Align to one left edge, or center on purpose |
| Buttons and links | One primary button per screen, labels that say the action ("Save note", not "OK"), visible focus when using the keyboard |
| States | What shows while loading, when a list is empty, when something fails, when it worked? A blank area is a bug |
| Narrow screens | Does it still work at phone width? |

## 3. Change a little, then look

1. Use the project's existing way of styling (its CSS files, its component library, its theme). Adding a design
   library or a font package is an install: ask first.
2. Put repeated values in one place (color and space names), so the next change is one edit.
3. Do a group of related changes (all the spacing, or all the text sizes), save, reload, and look. Tell the user in
   plain words what changed and why it should feel better.
4. Missing states are the biggest gain: add a short message for empty and error, and a loading hint, using the
   project's own wording style.
5. Do not touch logic, data, routes or tests, except to keep them passing.

## 4. Check

- The build, lint and tests still pass (run them and quote the result).
- Look at the screen at phone width and at a wide window.
- Press Tab: focus is visible and the order makes sense.
- Ask the user: better, same or worse? Undo what is worse (with their yes).

## 5. What not to do

- Do not redesign everything in one go, and do not copy another product's exact look.
- Do not use color alone to tell things apart (add a word or an icon).
- Do not invent content: real text only, or plain placeholders that say so.

## Do not use for

- Building a new page from nothing: use a starter skill, such as `landing-page-starter` or `web-app-starter`.
- Something that does not work: use `debug-helper`. Messy code: use `refactor-safely`.
- A deep accessibility audit: ask for it separately; this skill only checks contrast, focus and labels.

## Done when

- The build or lint command ran, and its result is stated.
- Each change group was looked at in the running screen (say how: screenshot, browser, window sizes).
- The user answered better, same or worse, and worse ones were undone.
- You told the user in one sentence what improved, and what you would do next if they want more.
