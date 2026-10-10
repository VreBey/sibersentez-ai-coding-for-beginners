# Landing page starter: reference

Contents: Folder · index.html skeleton · style.css skeleton (phone first) · Forms · Checks before publishing ·
Problems

Checked 2026-09-30 (revisit every six months): the `serve` preview tool, https://github.com/vercel/serve ; HTML and CSS
basics, https://developer.mozilla.org/en-US/docs/Learn_web_development . If a command fails, read the tool's page.

## Folder

```
site/
  index.html
  style.css
  script.js     only if needed
  assets/       images (compress them: a phone should not download 5 MB)
```

## index.html skeleton

Replace the words in double square brackets with the user's text (in the user's language).

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>[[Name]]: [[what it does]]</title>
  <meta name="description" content="[[One sentence, under 160 characters]]">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="wrap">
    <p class="brand">[[Name]]</p>
  </header>

  <main>
    <section class="hero wrap">
      <h1>[[Headline: what the visitor gets]]</h1>
      <p class="lead">[[One sentence: who it is for and how]]</p>
      <a class="button" href="[[link or mailto:address]]">[[Main action]]</a>
    </section>

    <section class="wrap benefits">
      <article><h2>[[Benefit 1]]</h2><p>[[One line]]</p></article>
      <article><h2>[[Benefit 2]]</h2><p>[[One line]]</p></article>
      <article><h2>[[Benefit 3]]</h2><p>[[One line]]</p></article>
    </section>

    <section class="wrap cta">
      <h2>[[Closing sentence]]</h2>
      <a class="button" href="[[the same link]]">[[The same main action]]</a>
    </section>
  </main>

  <footer class="wrap">
    <p>[[Owner or contact]] &middot; [[Year]]</p>
  </footer>
</body>
</html>
```

Set `lang` to the language of the text (`tr` for Turkish): screen readers and search engines use it.

## style.css skeleton (phone first)

```css
:root {
  --bg: #ffffff;
  --text: #1c1c1e;
  --muted: #5b5b63;
  --accent: #2456d6;
  --accent-text: #ffffff;
  --space: 1rem;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 1rem/1.6 system-ui, sans-serif; }
.wrap { max-width: 60rem; margin: 0 auto; padding: var(--space) calc(var(--space) * 1.25); }
.hero { padding-block: calc(var(--space) * 3); }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 var(--space); }
.lead { color: var(--muted); font-size: 1.125rem; margin: 0 0 calc(var(--space) * 1.5); }
.button { display: inline-block; padding: 0.75rem 1.25rem; border-radius: 0.5rem; background: var(--accent);
  color: var(--accent-text); text-decoration: none; font-weight: 600; }
.button:hover, .button:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
.benefits { display: grid; gap: var(--space); }
@media (min-width: 40rem) {
  h1 { font-size: 3rem; }
  .benefits { grid-template-columns: repeat(3, 1fr); }
}
```

Colors: keep the text/background contrast high (dark text on a light background or the reverse); use one accent
color for the button only. Do not use the accent for body text.

## Forms

A static page cannot receive or store what a visitor types. Options, simplest first:

1. A `mailto:` link on the button (opens the visitor's mail program).
2. A form service that gives you a web address to send the form to. Each has its own steps and limits: check the
   provider's official documentation, and tell the user that visitors' e-mail addresses are personal data.
3. A small API of your own (`api-service-starter`), later.

## Checks before publishing

| Check | How |
|---|---|
| Phone width | make the browser window narrow, or open the browser's device view |
| No sideways scroll | at 320 px wide nothing sticks out |
| One `h1` | search the file for `<h1` |
| Images have `alt` | search for `<img` and read each |
| No placeholder left | search the file for `[[` |
| Links work | click each one |
| Title and description | shown in the browser tab; read the `<head>` |

## Problems

| Symptom | Fix |
|---|---|
| Styles do not apply | the `href` of the stylesheet is wrong, or the file has another name; check case and folder |
| Page looks tiny on a phone | the `viewport` meta line is missing |
| `npx serve` asks to install | that is normal the first time; it needs the user's yes |
| Turkish letters look broken | the file must be saved as UTF-8 and `<meta charset="utf-8">` must be there |
