# Motion

Movement in the panel says something: where a thing came from, that something changed, what needs the person. It is
short, uses one set of values, moves only `transform`/`translate` and `opacity`, and stops entirely for a person who
asked the system for reduced motion.

## 1. Where the idea comes from (2026-09-29)

The owner asked for motion design "where it is needed", after a launch they had seen. Research (one agent, sources in
its report): the likeliest launch is **Figma Motion** (Config 2026, 24 June 2026: timeline, keyframes, easing and
springs in Figma; Dev Mode hands the values over as CSS, JSON or React, and a coding agent can take an animated frame
over MCP); the other is Claude Design's animations (HTML/CSS/JS). Both end as CSS and browser animation. There is no
Figma file for SiberSentez yet, so the same principles are applied by hand; if motion is later designed in Figma, its CSS
values replace the tokens below.

Techniques (Electron's Chromium has them all; no library, nothing from a CDN, CSP unchanged): CSS transitions with
`@starting-style` and `transition-behavior: allow-discrete` (things that appear and disappear), same-document view
transitions (`document.startViewTransition`), CSS keyframes, `prefers-reduced-motion`.

## 2. Tokens (`public/css/motion.css`)

| Token | Value | For |
|---|---|---|
| `--dur-fast` | 140 ms | menus, chips, a crossfade |
| `--dur-med` | 240 ms | panels, cards finding their place |
| `--dur-slow` | 380 ms | a whole scene |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | entering: quick, then settles |
| `--ease-in` | `cubic-bezier(0.3, 0, 1, 1)` | leaving (and leaving is shorter: 100 ms) |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | from one place to another |

Older motion (the drawer's slide, toasts, the context menu, feed rows) keeps its values until it is touched; new
motion uses only the tokens.

## 3. What moves

- **Popovers under the header** (waiting list, notifications, actions panel): fade and drop in from 4 px, fade out
  faster; `hidden` stays the switch.
- **Project cards**: when the list order changes (a project starts waiting or working), the cards glide to their new
  places (a view transition; each card has a stable `view-transition-name` from `transitionName`). Never while the
  pointer or focus is in the list: the order is held then (`docs/attention.md`). A project that just started waiting
  glows once.
- **The waiting counter**: one nudge when a new session starts waiting (not on the first render).
- **Scene switch** (Building | Orchestra): the canvas crossfades into the other scene.
- **The building**: when a room's light turns on or off, a warm wash fades over it in 700 ms (not on a room's first
  sight). Typing, the screen's scroll and the waiting lamp were already there.

## 4. Reduced motion

`app.css` turns every CSS animation and transition off; `motion.css` does the same for view transitions; the scripts ask
`reducedMotion()` (the view transition, the replayed classes) and the building checks it for its own movement.
`test/motion.test.mjs` keeps the tokens, the reduced-motion rules and the "no layout properties" rule.
