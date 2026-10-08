# Release checklist

One release at a time, when the owner says "güncelle" (update). Since 2026-10-08: no in-between releases; 0.17 comes out
once the whole roadmap (F1–F5) is done. The version number changes only at this point.

## Before

1. `node tools/check-tool-flags.mjs`: every installed AI tool's `--help` still names the options SiberSentez starts it
   with (prompt, plan mode, resume, sign-in check). A "MISSING" line means `server/tools.mjs` must follow the tool first.
2. `npm test`: every test passes.
3. A last independent review of everything since the last release.
4. The packaged app: `npx electron-builder --win --dir`, then `pwsh -NoProfile -File qa\electron-qa.ps1` (hidden; every
   check passes).
5. A clean Windows (Windows Sandbox, or another computer, never the owner's own, where SiberSentez is installed): install
   the new installer, upgrade from the last release over it, uninstall. Each step written down.
6. `tools/perf-baseline.mjs` and `tools/contrast-scan.js` again; the numbers next to the last ones
   (`docs/evidence-*.md`).

## The release

1. The version: a patch or a minor one, by what changed since the last release (`package.json`).
2. The release notes (`site/build.mjs` RELEASES, Turkish and English): what changed for the person, in plain words.
3. `npm run dist`; the installer's SHA-256.
4. GitHub: the release with the installer and its SHA-256; the site (`node site/build.mjs`, then the upload).
5. Code signing waits for its own decision (roadmap F3b): until then the installer is unsigned, as before.
