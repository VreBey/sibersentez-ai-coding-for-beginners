# Folders that are not projects

AI tools remember every folder they were started in. Some of those are not projects: the home folder, System32, a test
folder under Temp, and the Codex desktop app's chat folders (one per conversation,
`<home>\Documents\Codex\<date>\<slug>`, seen on the real machine with a folder named after a pasted link). As project
cards they filled the list, the count and the scene's places (backlog: "Broad folders as project cards", "Folders that
are not projects", 2026-09-29).

## 1. Where a folder sits

`Catalog.placeOf(p)` (server) sends `place` with every project (`projectView`):

| `place` | When | Example |
|---|---|---|
| `broad` | the project is `broad` (home, Desktop, Documents, Downloads, a temp folder itself, a drive root, AppData), or a system folder (Windows, the program folders, ProgramData, a OneDrive root), or System32 | `C:\Users\u`, `C:\WINDOWS\system32` |
| `temp` | inside a temp folder (`%TEMP%`, `%TMP%`, `<home>\AppData\Local\Temp`) | `...\Temp\ork-plugin-dir-test` |
| `chat` | exactly `<home>\Documents\Codex\<yyyy-mm-dd>\<name>` | `...\Codex\2026-09-29\https-claude-ai-...` |
| `null` | anything else, and every registered project (the person listed it) | |

A folder below a chat folder, or a folder in `Documents\Codex` without a date, is a project. Claude Code's scratchpad
under `Temp\claude` never becomes a project at all (the catalog's scratchpad rule).

## 2. What the page does

`isOtherFolder(p)` (`public/js/attention.js`): an unregistered folder whose `place` is `broad`, `temp` or `chat`.

- **Project list**: such folders leave the normal groups for a last, folded group "Other folders" with one line saying
  what they are; it stays open once opened, while the page is open. Their cards name the place ("chat folder") instead
  of "Unregistered". The count above the list ("21 projects · 1 open") leaves them out.
- **Building**: a floor only while something is open in it (the activity stays visible). **Orchestra**: the same.
- **Now rail, header counter, drawer, palette**: unchanged, their sessions show as before.
