---
name: ui-check
description: "Checks a screen for the basics that make it usable by everyone: phone width, tap size, keyboard use, visible focus, color contrast, labels and alt text, text zoom. Shows a pass or fail table and fixes what fails. Use when a page or screen is built and must work on phones and for people using keyboards or screen readers."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "design, ui, web"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "telefonda düzgün görün*, mobil uyum*, responsive, erişilebilir*, kontrast*, klavye ile, odak sırası, küçük ekran, ekran okuyucu"
---

# UI check

A screen can look fine on the developer's big monitor and fail on a phone, for someone who cannot use a mouse, or for
someone who sees low contrast. Check the basics screen by screen, show the result as a table, and fix what fails.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Fix with the smallest change. Do not redesign a screen: that is `ui-polish`.

## 1. List the screens

Make a list of the screens or pages (from `PLAN.md` or the code) and agree on which to check first: the one most
people see. Run the app and open it in a browser (if your tool cannot, ask the user to open it and report).

## 2. Check each screen

Work through these in order and record pass or fail with a note:

| Check | How | Passes when |
|---|---|---|
| Phone width | developer tools, device toolbar, 360 px wide | no sideways scrolling, nothing cut off or overlapping |
| Text size | same view | body text about 16 px or more, readable without zooming |
| Tap size | same view | buttons and links at least about 44 px high and wide, with space between |
| Keyboard | Tab through the whole screen | every button, link and field is reachable, in a sensible order, with no trap |
| Focus | same | the focused item is clearly visible (an outline), never removed without a replacement |
| Keyboard actions | Enter and Space on buttons, Escape on dialogs | they do what a click does; a dialog closes and returns focus |
| Contrast | developer tools color picker or a contrast checker | text 4.5 to 1 against its background (3 to 1 for large text and for icons or borders that carry meaning) |
| Color alone | look at errors, status, charts | meaning is also in words or icons, not only red against green |
| Labels | click a label; read the form | each field has a visible label tied to it; no field with only a placeholder |
| Names | read buttons and links | a button says what it does ("Save note"), an icon button has a text label for tools that read the screen |
| Images | read the code | meaningful images have alt text; decorations have an empty alt |
| Structure | read the headings | one main heading, no skipped levels; the page has a title and a language set |
| Zoom | browser zoom 200 percent | still usable, nothing hidden |
| Errors | submit a wrong form | the message is text, near the field, says how to fix it |

A browser's built-in accessibility audit is a useful second opinion; a good score is not proof, and a bad one is
a list to read.

## 3. Show the table

Show the user the table for each screen, with only the failed rows described: what, where (file and line when
you know it), why it matters to a real person, and the fix.

## 4. Fix, one at a time

For each failed row, after the user agrees: change as little as possible, reload, repeat that one check, and mark
it fixed only when you saw it pass. Typical fixes: a viewport tag and flexible widths, larger tap areas, a real
`button` instead of a clickable box, `label` tied to `input`, a darker text color, an outline on `:focus-visible`.
Do not turn off focus outlines or zoom (never lock the page scale).

## 5. Try it once as the other person

Spend a minute with only the keyboard on the main flow, and a minute on a phone-sized window. Say what you noticed.

## Do not use for

- Making a screen prettier: use `ui-polish`.
- Walking a whole flow and testing it: use `try-it-in-browser`.
- Building the screen: use the `frontend-builder` agent.

## Done when

- The table exists for each checked screen, with pass or fail for every row.
- Every failed row was fixed and re-checked, or is listed as open with a reason (show the table again).
- The keyboard-only and phone-width tries of step 5 were done and their result stated.
- You told the user in one sentence what was fixed and what is still open.
