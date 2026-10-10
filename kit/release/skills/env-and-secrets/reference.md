# Env and secrets: reference

Checked 2026-09-30 (revisit every six months). Official pages:

- Node.js, `--env-file` and `process.env`: https://nodejs.org/docs/latest/api/cli.html and
  https://nodejs.org/docs/latest/api/process.html#processenv
- Vite, env variables and modes: https://vite.dev/guide/env-and-mode
- Next.js, environment variables: https://nextjs.org/docs/app/guides/environment-variables
- Python `python-dotenv`: https://pypi.org/project/python-dotenv/
- Each host and CI service documents its own settings page: check it (see `deploy-web`, `github-actions-setup`).

## Reading a value, by kind of project

| Project | How the code reads `NAME` | How the file is loaded |
|---|---|---|
| Node.js (22 LTS or newer) | `process.env.NAME` | start with `node --env-file=.env server.js` |
| Node.js, older | `process.env.NAME` | a loader package such as `dotenv` (installing needs a yes) |
| Vite | `import.meta.env.VITE_NAME` (only names starting with `VITE_` reach the browser code) | Vite reads `.env` by itself |
| Next.js | `process.env.NAME` on the server; `NEXT_PUBLIC_NAME` for the browser | Next.js reads `.env` by itself |
| Python | `os.environ["NAME"]` | `python-dotenv` (`load_dotenv()`), installing needs a yes; or set the variable in the shell |
| Unity, mobile, desktop apps | there is no safe place inside the app | keep secrets on a server the app calls |

## A start-up check (Node.js example)

```js
// Stop early, with a message a beginner can act on.
const required = ['PAYMENT_SECRET_KEY'];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}
```

## Setting a variable for one run

| Shell | Command |
|---|---|
| Windows PowerShell | `$env:NAME = "value"` then run the program in the same window |
| macOS, Linux | `NAME=value command` |

Values set this way are gone when the window closes. Do not type real secrets into a shared or recorded terminal.

## Search hints for hard-coded values

Look for these words near an equals sign or a string, then read the match: `key`, `secret`, `token`, `password`,
`passwd`, `apikey`, `api_key`, `auth`, `bearer`, `client_secret`, connection strings (`://user:password@`), and long
random-looking strings. Also check config files, notebooks, test files and old comments. Skip `node_modules` and build
folders. Report names and places, never full values.

## .gitignore for env files

```
.env
.env.*
!.env.example
```

The last line keeps the example file committable. `git check-ignore -v .env` prints the matching rule; no output
means the file is not ignored yet.

## Problems

| Symptom | Cause |
|---|---|
| The value is `undefined` | the file is not loaded (wrong start command), the name is misspelled, or the terminal was opened before the change |
| Works here, missing online | the host or CI has its own settings: the user must add the name there |
| A change in `.env` has no effect | the program must be restarted (and a framework dev server too) |
| Quotes appear inside the value | write `NAME=value` without extra quotes unless the value has spaces |
| A key works in the browser code of a web app | it is public to every visitor: move the call to a server, and revoke that key |
