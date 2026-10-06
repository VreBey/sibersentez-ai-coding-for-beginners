# Theme

Every colour, font, radius and shadow of SiberSentez is a variable in `public/css/theme.css`, loaded before every other
stylesheet. The rest of the CSS only uses those variables, so a new look is a new version of that one file: change
the values, keep the names. The look is designed outside this repository (with ChatGPT, decided 2026-09-29), the
same way as the building's drawings (docs/hq.md).

## Variables

| Group | Variables | Used for |
|---|---|---|
| Surfaces | `--bg`, `--bg-2`, `--panel`, `--panel-solid`, `--panel-2`, `--line`, `--line-2` | page, cards, menus, borders |
| Text | `--text`, `--text-2`, `--muted` | main, secondary and quiet text |
| Meaning | `--accent`, `--gold`, `--busy`, `--idle`, `--stop`, `--orange`, `--pink`, `--teal` | the chosen item and links; the library and skills; working and success; waiting for you and warnings; errors and danger; running agents; accents |
| Tints | `--accent-rgb`, `--gold-rgb`, `--busy-rgb`, `--idle-rgb`, `--stop-rgb`, `--orange-rgb`, `--teal-rgb`, `--pink-rgb`, `--tint-rgb`, `--shade-rgb` | the same colours as three channels for see-through tints: `rgba(var(--accent-rgb), 0.2)`; `--tint-rgb` lightens a surface (white on dark), `--shade-rgb` darkens (shadows, scrims) |
| Shape and type | `--radius`, `--radius-sm`, `--font`, `--display`, `--mono`, `--shadow` | corners, text, headings, code |

Each `-rgb` variable must be the same colour as its named one (`--accent` and `--accent-rgb`).

About a hundred colours in the other stylesheets are still written by hand (small tints close to a token). A new
theme that changes the palette a lot may leave them looking off; replace them with a token when that happens.

## Rules for a new theme

- Keep every variable name; add new ones only together with the CSS that uses them.
- Dark first (`color-scheme: dark`). A light theme is a second `:root[data-theme="light"]` block later: it swaps
  `--tint-rgb` and `--shade-rgb` as well.
- Contrast: `--text` and `--text-2` on `--bg` and `--panel` at least 4.5:1, `--muted` at least 4.5:1 on `--bg`
  (WCAG AA). The meaning colours on `--panel` at least 3:1.
- The meanings stay: green works, yellow waits for you, red is danger, gold is the library.
- Fonts: system fonts only (the page loads nothing from the internet: CSP `default-src 'self'` covers fonts); an open font (OFL) can
  come later as a file under `public/fonts/`.
- The pixel building (`public/img/building/`, an evening skyline) sits on Today; the palette should suit it.

## The prompt for ChatGPT

Attach `public/css/theme.css` and screenshots of Today, Projects, Skills & agents, Settings and the AI tools panel,
then paste:

```
You are designing the visual theme of "SiberSentez", a Windows desktop app (Electron) that helps beginners use AI
coding tools (Claude Code, Codex, Gemini CLI): it lists their projects, shows running AI sessions live in a pixel-art
"building" at dusk, suggests and installs skills, and tracks usage. The layout is final: a menu on the left (Today,
Projects, Skills & agents, Feed, Settings), a slim top bar, cards. The screenshots show the current look.

Goal: modern, calm and simple; nothing should shout; a beginner must see at once what needs them (yellow), what is
working (green) and what is wrong (red). Dark theme.

Rules:
1. Answer with ONE complete CSS file that replaces the attached theme.css: the same :root block, every variable
   name kept, only the values changed. No other selectors.
2. Every "-rgb" variable is the same colour as its named variable, written as three numbers ("124, 156, 255").
3. Contrast (WCAG AA): --text and --text-2 on --bg and on --panel at least 4.5:1; --muted on --bg at least 4.5:1;
   --accent, --busy, --idle, --stop, --gold on --panel at least 3:1. List the ratios you checked under the file.
4. Keep the meanings: --busy green (working), --idle yellow/amber (waiting for you), --stop red (danger), --gold for
   the library and skills, --accent for the chosen item and links.
5. Fonts: only fonts every Windows 10/11 has (Segoe UI Variable, Segoe UI, Cascadia Mono); nothing downloaded.
6. The palette must suit the pixel building at dusk (purple-orange sky, dark bricks, warm windows).
7. After the CSS, explain in five short lines what you changed and why.
```

Put the answer into `public/css/theme.css`, run `npm test`, look at the screens (a headless screenshot or the app),
and check the contrast ratios it listed.
