# Before it goes online (plan E1, 2026-10-09)

A finished web job offers **Put it online**. Before anything is written into the job box, SiberSentez looks through the
project for what should not go online, shows it, and only then writes the AI's steps for GitHub Pages. It publishes
nothing itself and connects to no account: the person presses **Start**, and the AI asks before each step.

## What is looked for

`GET /api/projects/<id>/publish-check` (read-only, no action mode needed; `server/publishCheck.mjs`):

| Kind | Level | What |
|---|---|---|
| `key` | danger | An API key or a private key block (AWS, GitHub, OpenAI, Anthropic, Slack, Google; the shapes of the skill review, `review.mjs SECRET_RE`) |
| `env-file` | danger | A `.env` file (`.env.example`, `.sample`, `.template`, `.dist`, `.defaults` are fine) |
| `key-file` | danger | A private key file: `.pem`, `.key`, `.p12`, `.pfx`, `id_rsa`, `id_ed25519` (a `.pub` is fine) |
| `password` | warn | A password, token or secret written into the code as a value; placeholders (`changeme`, `your_…`, `${…}`, `<…>`) and environment reads are fine |
| `tc-id` | warn | A Turkish identity number: eleven digits whose check digits hold |
| `phone` | info | A Turkish mobile number |
| `email` | info | An e-mail address (often meant to be public; example and noreply addresses are skipped) |

- The walk: every folder except version control, `node_modules`, Python environments and `.sibersentez`; links are
  never followed; files over 1 MB and binary files are not read; at most 4,000 files and 12 folders deep (a bigger
  project says only part of it was read).
- A finding carries the file, the line and a masked sample (its first characters and its length), never the value.
  The 40 most serious are sent, the rest are counted.

## What the person sees

In the project drawer, under the job's result: "N things should not go online" with the list, or "nothing found", and
one line saying SiberSentez only read the files. **Write the publishing steps** fills the job box with the steps
(list the files that would be published and keep secret ones out with `.gitignore`; tell the person how to create a
GitHub repository, never signing in to their account; push, turn on GitHub Pages, give the address) and, when
something serious was found, the files to clean first. **Look again** asks once more.

## What it does not see

- The repository's history: a key deleted from the files but committed before is still in `.git` and goes online
  with a push. GitHub's own secret scanning helps; the steps do not check the history.
- Whether a `.env` file is already left out by `.gitignore`: it is listed anyway, and the steps say to keep such
  files out with `.gitignore`, never to delete them.

## Not done here (plan E2, on demand)

A guided publish with the person's own GitHub account, step by step in the app, and warnings for sites that take
passwords or payments.

## Tests

`test/publish-check.test.mjs` (the patterns, the identity number check, file names, the walk, the endpoint, the page's
text and states) and `test/dom-drawer.test.mjs` (the drawer: Put it online, the check, the steps in the job box,
nothing started).
