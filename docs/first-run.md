# First-run guide

A short tour for a person who has never used an AI coding tool with SiberSentez: five steps (it had seven; a new user
found that too long; the fifth came with the help while the AI works, version 2), each pointing at the part of the page it talks about.

## Steps

| # | id | Says | Button | Points at |
|---|----|------|--------|-----------|
| 0 | `welcome` | What SiberSentez shows: every project's own building, each AI session in the room that fits its work, the waiting counter; it runs on this computer | — | — |
| 1 | `tools` | Get your AI tool ready (Claude Code, Codex, Gemini CLI…) | Open AI tools | — |
| 2 | `idea` | What a skill is; New project, write the idea, the skills that fit are marked; Install and start | New project | `#newProjectBtn` |
| 3 | `modes` | Actions start Off; Preview and On, and the current mode | Change the mode (desktop app only) | `#actMode` |
| 4 | `work` | While the AI works: the note beside the terminal (what it asks, the safe answer, known errors); "How to run it" and "What changed" in the project's details | — | — |

GitHub fetching and the usage strip are left out of the tour; the ? hints and the Skills & agents tab explain them
where they are.

Strings: `public/js/strings/guide.js` (`guide_<id>_title`, `guide_<id>_body`, `guide_<id>_go`).

## When it opens

- By itself once, on the first page load after install: `localStorage['sibersentez.guide']` holds the seen
  `GUIDE_VERSION`. Raise the version when the tour changes enough to be shown again.
- Closing it in any way (Start, Skip, Esc, the X, a click outside, a step button) counts as seen.
- Again from the header's **?** button, the **?** key, or the command palette (Ctrl+K, "guide" / "rehber").
- A blocked storage never breaks the page; the guide then shows once per load.
- The value lives in the page's origin (`127.0.0.1:<port>`), like the other page preferences (scene, tab, notices).
  The desktop app normally gets the same port (the first free one in 47700–47799), so it stays seen.

## Behaviour

- Modal dialog (`role="dialog"`, `aria-modal`), focus moves into it and returns to where it was on close.
- Keys stay inside it: ←/→ step, Tab cycles its buttons, Esc closes. The page shortcuts and Ctrl+K wait.
- The step's target gets a ring (`.guide-spot`) while the step is shown.
- A step button closes the guide, then does its action (open the AI tools panel, start a new project, switch tab,
  open the actions panel).

## QA

`?qa=1&guide=1` opens it at the first step; `?qa=1&guide=step:<n>` at step n. A QA page never opens it otherwise.

## The full tour on an example (2026-10-05)

The guide's first step has **Watch the full tour (simulation)**; the command palette has **Full tour** too
(`public/js/tour.js`). Twelve steps walk from the AI tool to the result on the real screen: a box at the bottom middle
explains one step (no dim layer, the page stays alive), the element in question gets the guide's ring, the job box gets
an example job typed into it, and the Building plays its own example (`hq-scene.js createDemo`) held at the step's
moment: the plan waiting (2.5 s, the lead's card open on the plan), the team building (30 s), the check (75 s), the
result (101 s, the card with Open / run it, What changed, Undo), then "waiting for you", going back and the next step.

It is a simulation: nothing is pressed, nothing runs, no request reaches the server (checked: no POST during a walk
through all steps) and no project is touched. The Building's own first-time note is closed while it runs (the tour
explains the Building itself). Ending the tour in any way (End, the X, Esc) puts the Building back to live and the job
box back to its own text. → ← move, Esc ends.
