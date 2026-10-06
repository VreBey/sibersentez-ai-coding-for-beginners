# How to run it

After the AI built something, a beginner does not know how to start it. The project drawer's "How to run it" section
(below "Then: start with AI") says it in numbered steps, each command with a copy button. SiberSentez runs none of them:
the person pastes them into the project's terminal.

## Server (`server/runhint.mjs`, `GET /api/projects/<id>/run`)

Read-only, no action mode needed, the usual API access rules. It reads the names in the project folder and a few
small files (at most 256 KB each, as server/suggest.mjs does: `package.json`, `requirements.txt`, `pyproject.toml`),
never follows a link below the folder, and never reads a folder that is missing, broad, temporary or on a network
path (`state: 'unreadable'`, and the section is not shown).

Answer: `{ project, state: 'ok' | 'empty' | 'unknown' | 'unreadable', plans: [{ kind, steps: [{ id, cmd?, file? }] }] }`,
at most two plans, the most likely first:

| Folder holds | Steps |
|---|---|
| `Assets/` + `ProjectSettings/` | open in Unity Hub, press Play |
| `project.godot` | import in Godot, F5 |
| `*.uproject` | double-click it |
| `package.json` with a `dev`, `start`, `serve` or `preview` script | `<pm> install` when `node_modules` is missing (pm from `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, else npm), then the script, then "open the address it prints" (or "its window opens" with Electron) |
| `package.json` without such a script, with `index.js`/`server.js`/`app.js`/`main.js` | `node <file>` |
| Python (`requirements.txt`, `pyproject.toml` or `.py` files) | `uv sync` (with `uv.lock`) or `python -m pip install -r requirements.txt`, then `python manage.py runserver` (Django), `streamlit run <main>` (Streamlit) or `python <main>`; main is `main.py`, `app.py`, `bot.py`, `run.py`, `server.py`, or the only `.py` file |
| `pubspec.yaml` / `go.mod` / `Cargo.toml` / `*.csproj`, `*.sln` | `flutter pub get` + `flutter run` / `go run .` / `cargo run` / `dotnet run` |
| only `index.html` | double-click it |

Commands are built from fixed words; a script is used only by one of the four fixed names, and a file name only when
it matches a plain pattern. `empty`: the folder holds nothing but SiberSentez's first message, git, a plan, a readme or
an AI tool's own file; the section says to start the AI first. `unknown`: the section offers a question to copy for the
AI ("How do I run this project on Windows?").

## Page (`public/js/runHint.js`)

The answer is kept per project and asked again after 20 s, so what the AI just built shows up the next time the drawer
draws. The page shows only known kinds and steps and only a command that looks like one the server builds.

## Type in terminal (desktop app)

With the embedded terminal dock, each command also gets "Type in terminal": the dock opens a plain terminal of the
project (or reuses the one it opened for this before, only while it waits at an empty PowerShell or Command Prompt
prompt: not while a program started there runs, an AI tool started there by hand, or a typed command not run yet;
two quick clicks wait for each other), waits until the shell printed its prompt
and was quiet for 400 ms (at most 6 s), shows it and writes the command there. It never sends Enter: the person reads
the command and presses Enter. A tab an AI tool runs in is never used (the command would reach the AI as a message),
and the question for the AI ("unknown") has no such button. The text is one line of printable ASCII, at most 200.
Opening the terminal follows the terminal's own rules (actions on, the folder checks); a refusal shows its toast.
QA: `?qa=1&dock=demo&runtype=1` types `npm run dev` into the first project's stand-in terminal.

## Seeing the result (2026-10-02)

The competitors' strongest point for a beginner is seeing what was built (a live preview, a browser panel). Here:

- **Under the job once it is built**: when the job is being checked or is done (`.sibersentez` step `check` or
  `done`), the drawer shows "How to run it" right under the job instead of inside Details (one section, never two).
- **The Building's result card** has "Open / run it" beside "Answer in the terminal", "What changed" and "Undo"; a
  finished job's box has it too. It opens the drawer at this section.
- **Open in the browser** (a plain web page only): the `open` step of `index.html` gets one button. It is the explorer
  action with `open: 'index.html'` (server/actions.mjs): the literal name only, a plain file at the project's own root
  (never a link, never with a session), refused otherwise (400, 404 `file-missing`); explorer opens it with the
  program Windows has for web pages. It runs on the person's click under the actions mode, like "Open folder".
  Commands still go into the terminal without Enter, as above; the note on pasting commands shows only where there is
  a command.

## The dev server's address (2026-10-02, later)

Claude Code Desktop starts the dev server and shows the page beside its chat. Here the person types the command into
the terminal (Type in terminal, then Enter); once its output settles, the dock looks at the last lines for a local
address (`previewUrlIn`, public/js/promptHelp.js: Vite's "Local: http://localhost:5173/", Next's "- Local:", Python's
"http://0.0.0.0:8000/") and shows "Open in the browser · localhost:5173" at the terminal's bottom right. Only this
computer (localhost, 127.0.0.1, 0.0.0.0 and [::1], the last two opened as localhost), a 2-5 digit port other than
SiberSentez's own, a plain path; the address goes in as text and href only and opens in the default browser through
the shell's link rule (http only, never inside SiberSentez's window). It is gone once the terminal ended. An AI tool
that starts a dev server in its own tab gets the same link.
