# Theme

Every colour, font, radius and shadow of SiberSentez is a variable in `public/css/theme.css`, loaded before every other
stylesheet. The rest of the CSS only uses those variables, so a new look is a new version of that one file: change
the values, keep the names. Since 2026-10-09 the look is designed in this repository (before, with ChatGPT outside it).

## Two looks (plan E4, 2026-10-09)

- **Dark** ("calm turquoise dusk"): the first look and the default. Its values sit in the `:root, .dusk` block.
- **Light** ("calm turquoise daylight"): the same names with daylight values in `:root[data-theme="light"]`.
- **Like the system**: light or dark as Windows (or the desktop) is set, and it follows a change at once.

The person picks it in **Settings → General → Look**. The choice is a page preference (`localStorage`
`sibersentez.theme`, like the other preferences, `public/js/theme.js`). `public/js/theme-boot.js` is a plain script in
the page's head: it sets `data-theme` before the stylesheets apply, so a light choice never shows the dark page first.
In the desktop app the page tells the shell (preload `setTheme`, channel `sibersentez:set-theme`): the window's title
bar follows (`nativeTheme.themeSource`) and so does the window's background. The shell saves nothing; the page tells it
again at every start.

### Always dusk

The building scene (`.ws-stage`), the old stage (`.stage-wrap`) and the terminal dock (`.term-dock`) carry the class
`dusk`: the dark block applies to them in both looks, and `.dusk { color: var(--text) }` gives them their own text
colour (a colour is inherited as the parent's value, so the light page's dark text would otherwise reach them). The pixel building is a skyline at dusk and a terminal keeps its
own colours; in the light look they read as an evening window in a daylight page. The building's canvas reads its
colours from its own element (`hq-render.js readPalette`), so it always gets the dusk values. The figures and
furniture drawn there (`--hq-person-*`, `--hq-skin*`, `--hq-metal*`, `--hq-chair-body`, `--hq-shoe`, `--hq-mark`) have
no light value. A variable that names another one (`--left: var(--quiet)`) is declared in the dark block, so each
element resolves it in its own look; no other stylesheet sets a colour variable on `:root`. A dialog over the whole
page (the building's guide) sits outside the scene, so it takes the page's look.

### Identity hues

A project's colour, a tool's, a kind of step's (`public/js/format.js`, `toolTags.js`, the source hues `--sc` and `--gc`)
are hues, not theme colours: they were chosen for a dark page. Where one is text it goes through
`color-mix(in srgb, <hue> var(--hue-ink), var(--text))`: `--hue-ink` is 100% in dark (the hue as it is) and 35% in
light: every hue the code names keeps 4.5:1 as text on a 14% tint of itself (the test computes all of them; the worst
is 5.2:1). A project's initials use `--mark-ink` the same way. Dots, bars and borders use the
hue as it is.

## Variables

| Group | Variables | Used for |
|---|---|---|
| Surfaces | `--bg`, `--bg-2`, `--panel`, `--panel-solid`, `--panel-2`, `--line`, `--line-2` | page, cards, menus, borders |
| Frame | `--side-bg`, `--topbar-bg`, `--card`, `--card-hover`, `--panel-low`, `--raised`, `--field`, `--field-border`, `--inset`, `--border`, `--border-2`, `--border-hover`, `--scrim`, `--scrim-soft` | the menu, the top bar, a card, a quieter strip (toolbars, the drawer, the rail), menus and toasts, inputs and their edge, a sunken box, borders, the scrim behind a dialog and the lighter one of the guide (its ring must show through) |
| Text | `--text`, `--text-2`, `--muted`, `--text-strong`, `--quiet`, `--left` | main, secondary and quiet text; the chosen item's text; closed and left-open things |
| Meaning | `--accent`, `--gold`, `--busy`, `--idle`, `--stop`, `--orange`, `--pink`, `--teal`, `--waiting`, `--commit` | the chosen item and links; the library and skills; working and success; waiting for you and warnings; errors and danger; running agents; accents; a session that waits; a commit |
| Inks | `--on-accent`, `--accent-ink`, `--stop-ink`, `--busy-ink`, `--idle-ink`, `--warn-ink`, `--prompt-ink` | text on an accent fill; text on a tint of its own colour (a red note, a green result); the person's own words |
| Mixing | `--hue-ink`, `--mark-ink` | how much of an identity hue a text keeps (above) |
| Tints | `--accent-rgb`, `--gold-rgb`, `--busy-rgb`, `--idle-rgb`, `--stop-rgb`, `--orange-rgb`, `--teal-rgb`, `--pink-rgb`, `--tint-rgb`, `--shade-rgb` | the same colours as three channels for see-through tints: `rgba(var(--accent-rgb), 0.2)`; `--tint-rgb` lightens a surface in dark (white) and darkens it in light (navy), `--shade-rgb` makes shadows and scrims |
| Shape and type | `--radius`, `--radius-sm`, `--font`, `--display`, `--mono`, `--shadow` | corners, text, headings, code |
| Mark | `--brand-1`, `--brand-2` | the two strokes of the S |
| Building | `--hq-*` | the workshop's frame (light values) and the scene (dusk only) |

Each `-rgb` variable must be the same colour as its named one (`--accent` and `--accent-rgb`).

## Rules

- Keep every variable name; a new one gets a value in both blocks (or is drawn only in the dusk scene).
- No stylesheet writes a colour by hand (hex, `rgb()`, `hsl()`, `white`, `black`; inside `@media` too), and the page's
  scripts write none into an inline style. The exceptions are the dusk scene's own rules (`.stage-wrap`,
  `.stage-controls`, `.stage-clock`, `.floor-bar`, `.term-dock`, `.td-tab`), the hues `--sc`/`--gc` and a hue mixed
  with `color-mix` (as text with `--hue-ink`, or as a see-through tint of itself). `test/theme.test.mjs` checks every stylesheet.
- Contrast (WCAG AA), computed by the test for both blocks:
  - `--text`, `--text-2` and `--muted` on every surface: at least 4.5:1.
  - The inks and `--text-strong` on `--bg`, `--panel` and `--card`: at least 4.5:1.
  - The meaning colours: at least 3:1 in dark and 4.5:1 in light, where they are often text; in light also 4.5:1 as
    text on the tint of themselves the page puts under them (a chosen item, a waiting chip, a danger note).
  - A field's edge (`--field-border`, every input and select) 3:1 against a card in both looks (WCAG 1.4.11).
  - `--on-accent` on `--accent`: at least 4.5:1.
- The meanings stay: green works, yellow waits for you, red is danger, gold is the library.
- Fonts: system fonts only (the page loads nothing from the internet: CSP `default-src 'self'` covers fonts); an open
  font (OFL) can come later as a file under `public/fonts/`.

## Checking a change

Run `npm test`. Then look at the screens in both looks. Screenshots can be taken offscreen from the desktop shell's
Electron with no window shown: load `http://127.0.0.1:<port>/?qa=1`, set `localStorage['sibersentez.theme']`, reload,
then `webContents.capturePage()` for each tab.
