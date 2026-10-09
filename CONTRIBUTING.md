# Contributing

Thank you for looking at SiberSentez. Bug reports, ideas and fixes are welcome.

## Before you start

- **Licence.** SiberSentez is under the [GNU GPL version 3 or later](LICENSE) and its kit (`kit/`) under the
  [MIT License](kit/LICENSE.md). By sending a change you agree that it is released under the license of the files it
  touches. The name and the logo stay with the project ([TRADEMARKS.md](TRADEMARKS.md)).
- **Talk first about bigger changes.** Open an issue describing what you want to change and why, so the work fits the
  product's direction ([docs/direction.md](docs/direction.md)): a beginner's path from an idea to a working result,
  with the AI tool they already have.
- **Security problems** go to the private report described in [SECURITY.md](SECURITY.md), not to an issue.

## Running it from source

Windows 10 or 11, Node.js 22.12 or later (tested with Node 24).

```
npm install
npm test        # every test file in test/, no window is opened
npm run typecheck  # the files that start with // @ts-check (TypeScript, the check only)
npm run lint    # unused imports, a left-in debugger, a narrowed test, a source file without // @ts-check
npm start       # the desktop app (Electron)
npm run dist    # the installer, dist\SiberSentez-Setup-<version>.exe (unsigned)
```

Electron downloads its own program (about 100 MB) the first time `npm start` runs. If that download fails (a proxy,
no network), run `npx install-electron` and start again. The embedded terminal (`node-pty`) comes prebuilt for
Windows x64 and arm64; no compiler is needed.

## How the code is written

- **Languages.** Code, comments, file names, commit messages and documents in `docs/` are in English. Every text the
  page shows comes from a string table (`public/js/strings/*.js` or `public/js/i18n.js`) in **English and Turkish**,
  same keys in both; `test/strings-dupes.test.mjs` refuses a key written twice.
- **No build step, few dependencies.** The page is plain ES modules (`public/js`), the server plain Node (`server/`),
  the shell Electron (`electron/`). The only runtime dependency is `node-pty`.
- **Safety rules that tests check:** the server never runs a shell; nothing runs or installs without the person's
  click and the actions mode; the page never sends a path or a command (only ids and fixed choices); SiberSentez never
  answers a question of an AI tool and never presses Enter for the person; no network request except the GitHub
  import the person starts.
- **Tests first.** A change comes with a test in `test/` (`node --test`), and `npm test`, `npm run typecheck` and `npm run lint` pass. A new source file starts with `// @ts-check`; one that
  needs more than a few JSDoc notes goes on `UNCHECKED` in `tools/lint.mjs` for now. A test never opens a
  window on the screen and never touches the real hub or the real projects (use a temporary folder).
- **Commits:** a type prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) and a body that says why.

## Pull requests

Keep a pull request to one change, say what it changes for the person using the app, and include the test that shows
it. Screenshots help for anything on screen (the page has `?qa=1` hooks for headless screenshots, see the README).
