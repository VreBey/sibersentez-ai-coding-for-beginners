---
name: release-prep
description: "Prepares a release step by step: finds what changed, proposes the next version number, updates the changelog, runs tests and a clean build, tries the result and drafts release notes, asking before tagging, pushing or publishing. Use when the user wants to publish, ship or release a new version or write release notes."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "release, docs"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "sürüm*, yayınla*, yayın*, yeni versiyon, değişiklik günlüğü, sürüm notu, mağazaya yükle*, kurulum dosyası hazırla*, dağıt*"
---

# Release prep

A release is a promise that this version works. Check before you publish, write down what changed, and make it
easy to go back if something is wrong. Nothing becomes public without the user's explicit yes.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Where are we

- Last version: `git tag --list --sort=-v:refname`, the version field in the manifest, the top of `CHANGELOG.md`.
- Changes since then: `git log <last-tag>..HEAD --oneline` (or the whole log for a first release).
- Uncommitted changes (`git status`)? Stop and ask whether they belong in this release.

## 2. Version number

Explain in one line: MAJOR.MINOR.PATCH. Raise MAJOR when something stops working the old way for users, MINOR for new
features, PATCH for fixes only. Versions starting with 0 mean "early, may still change". Propose the next number with
a reason and wait for the user to confirm.

The version usually lives in more than one place. List them before changing: the manifest (`package.json`,
`pyproject.toml`, `*.csproj`), app configuration (Expo `app.json`, Unity Player Settings, Electron's package
metadata), and any "About" screen. Change them all to the same number.

## 3. Changelog

Keep `CHANGELOG.md` with the newest version on top. Create it if missing (ask first).

```markdown
## 1.2.0 - 2026-10-01
### Added
- You can export notes as PDF.
### Fixed
- The app no longer freezes when a note is empty.
```

Use the groups Added, Changed, Fixed, Removed, Security. Write for users, not developers: "You can now export
notes", not "refactor exporter module".

## 4. Quality gate

All of these must pass before publishing. Report each result.

1. Tests pass.
2. Lint and type checks pass, if the project has them.
3. A **clean build**: build from a fresh state, not on top of old output. Deleting an output folder needs a yes.
4. **Try the built result**, not the development mode: open the installer or the packaged app, preview the built
   site, run the built bot, play the built game.
5. A quick secrets check (the `security-check` skill if installed): no keys, passwords or personal data in the
   release files.

If anything fails, stop and fix it first (the `debug-helper` skill helps).

## 5. Release notes

5-10 lines for the people who will use it: a headline, what is new, what is fixed, how to install or update, and
known problems.

## 6. Tag and publish, one yes at a time

1. Commit the version and changelog changes: `git commit -m "chore: release v1.2.0"` (ask).
2. Create an annotated tag: `git tag -a v1.2.0 -m "Release 1.2.0"` (ask).
3. Push commits and the tag only after an explicit yes: `git push` then `git push origin v1.2.0`.
4. Each publishing step is its own question: a store upload, a website deploy, a package registry, a release page
   with the installer. Say exactly what becomes public and where before asking.

## 7. After the release

- Check that the published version really works (download it, open the site, talk to the bot).
- Tell the user how to go back if needed: the previous tag, the previous installer, the previous deploy.
- Add an empty "Unreleased" section on top of the changelog for the next changes.
