---
name: docs-writer
description: "Writes or updates a README and user-facing docs in plain language: what the project is and how to install, run, configure, use and troubleshoot it, with every documented command actually tried. Use when the user asks for a README, a setup or user guide or install instructions, or when documentation is missing or out of date."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "docs"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "belge*, dokümantasyon, readme, kılavuz*, kullanım kılavuzu, nasıl kurulur, kurulum talimat*, kullanma talimat*, açıklama yaz*"
---

# Docs writer

Good documentation lets someone else, or the user in six months, install and use the project without asking. Write
only what is true and tested.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Who reads it

Ask one question: who is the reader? The user later, a friend who will install it, customers, or other developers.
Write in the user's language by default. For a public project, mention that an English README reaches more people
and offer both.

## 2. Gather facts, do not invent them

- Take commands from the project itself: manifest scripts, config files, `.env.example`, entry points, CI files.
- Try each command you document. Ask before running anything that installs packages or changes files. If a command
  cannot be tried, mark it "not verified" in your report to the user.
- Note the real versions of runtimes and tools.

## 3. README structure

Keep the sections that apply, in this order:

1. **Name and one sentence**: what it is and who it is for.
2. **What it does**: 3-6 bullet points. A screenshot if the user has one.
3. **Requirements**: runtimes and tools with versions.
4. **Install**: numbered, copy-ready commands.
5. **Run**: the one command that starts it, and what the user should see.
6. **Configuration**: a table of settings and environment variables: name, purpose, example value. Never real
   secret values.
7. **Usage**: the three most common tasks, step by step.
8. **Troubleshooting**: the most likely problems and their fixes.
9. **Project structure**: a few lines on the main folders.
10. **License and credits**: ask the user. Do not choose a license for them; explain the options only if asked.

## 4. User guide for non-developers

When the readers are not programmers, write a separate guide (for example `docs/user-guide.md`):

- organized by task: "Add a note", "Export your notes";
- numbered steps, each with what the reader sees afterwards;
- no jargon, or a one-line explanation the first time a term appears;
- screenshots or placeholders where they help: `[screenshot: the notes list]`.

## 5. Style

- Short sentences, one idea each. Active voice: "Run", "Open", "Click".
- Commands in code blocks, one per line, ready to paste. Show Windows (PowerShell) commands when the user is on
  Windows, and note the difference for macOS or Linux when it matters.
- Paths and names exactly as in the project, including upper and lower case.
- Link to other documents instead of repeating them.

## 6. Existing documents

- Show a summary of the changes (or a diff) before overwriting an existing README, and ask.
- Keep the user's own sections and wording unless they want them rewritten.
- Remove statements that are no longer true, and say which ones you removed.

## 7. Final check

- Every command was tried or is marked "not verified".
- Every link and path exists.
- No secrets, personal paths (like the user's home folder name) or internal notes.
- Headings are consistent and the document reads well from top to bottom.
