# Language rules — SiberSentez product repository

This file overrides the user's global language rule for this repository (decided by the user on 2026-09-28).

| Area | Language |
|---|---|
| Text shown to end users in the app | Localized: Turkish and English at minimum, selectable in the app; strings live in i18n files, never hard-coded in one language |
| Code identifiers, file and folder names, JSON keys, config files | English |
| Code comments | English |
| Log lines and API error codes | English (the UI maps error codes to localized text) |
| Repository documents (`README.md`, `docs/`) | English (a translated README may be added) |
| Commit messages | English, with a type prefix: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` |
| Test names | English |
| Conversation with the user, and subagent reports to the lead session | Turkish (unchanged) |

## Why

- Non-ASCII names broke tooling before (cmd scripts, paths such as a Turkish-named hub folder).
- The product is sold internationally; only the UI layer should vary by language.

## Notes

- Launch scripts (`.cmd`, WSH `.js`) stay ASCII-only.
- The hub the app creates uses English names: `settings.json`, `registry/projects.json`, `library/`.
- Existing Turkish comments and documents are translated in one dedicated pass, not piecemeal while other work is in flight.
