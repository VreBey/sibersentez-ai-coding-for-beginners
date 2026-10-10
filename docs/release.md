# Release checklist

One release at a time, when the owner says "güncelle" (update). Since 2026-10-08: no in-between releases; 0.17 comes out
once the whole roadmap (F1–F5) is done. The version number changes only at this point.

## Before

1. `node tools/check-tool-flags.mjs`: every installed AI tool's `--help` still names the options SiberSentez starts it
   with (prompt, plan mode, resume, sign-in check). A "MISSING" line means `server/tools.mjs` must follow the tool first.
   An "ok" line that says "newer than checked" moves that tool's `TOOL_CHECKED` range (`server/tools.mjs`) to the
   version and today's date: the tools panel tells the person which versions SiberSentez was checked with.
1b. `node tools/kit-freshness.mjs`: no kit item checked more than six months ago (exit 1 names them); check those
   against the official pages, fix what moved and set their `sibersentez-checked` date. "unchecked" items are a list
   to work through, not a stop.
2. `npm test`: every test passes; `npm run typecheck` and `npm run lint` find nothing.
3. A last independent review of everything since the last release.
4. The packaged app: `npx electron-builder --win --dir`, then `pwsh -NoProfile -File tools\electron-qa.ps1` (hidden; every
   check passes).
4b. Linux (plan G2): on Linux itself (WSL's Ubuntu on the owner's computer): `npm ci`, `npm test`,
   `npx electron-builder --linux AppImage`, then `bash tools/linux-qa.sh` (hidden; every check passes; WSLg or
   `xvfb-run` gives it a display). GitHub's Packaged QA workflow runs the same on Ubuntu.
5. A clean Windows (Windows Sandbox, or another computer, never the owner's own, where SiberSentez is installed): install
   the new installer, upgrade from the last release over it, uninstall. Each step written down.
6. `tools/perf-baseline.mjs` and `tools/contrast-scan.js` again; the numbers next to the last ones
   (`docs/internal/evidence-*.md`).
7. Dependencies (plan A5): `npm audit --omit=dev` finds nothing (the CI runs it on every push; it covers what ships in
   the app, node-pty). `npm audit` for the build tools: on 2026-10-09 eight moderate findings, all in electron-builder's
   chain (sprintf-js, a denial of service through a format string), which runs only while the installer is built and
   is not in the app; npm's "fix" was a downgrade, so it waits for electron-builder. Dependabot's open pull requests
   are looked at (weekly for npm, monthly for the GitHub Actions; nothing merges by itself).
8. Electron is inside its support window: Electron supports its latest three major versions, a new one about every
   eight weeks (releases.electronjs.org). A version that has left the window gets no more security fixes: the release
   moves to a supported one first.

## The release

1. The version: a patch or a minor one, by what changed since the last release (`package.json`).
2. The release notes (`site/build.mjs` RELEASES, Turkish and English): what changed for the person, in plain words.
3. `npm run dist`; the installer's SHA-256.
4. GitHub: the public tree is `git archive HEAD`, which leaves out what `.gitattributes` marks `export-ignore`
   (`docs/internal/`, `.claude/`: working notes kept in the local repository only); never a copy of the working folder
   or a diff applied by hand. The version tag starts the Release build workflow (`.github/workflows/release.yml`): it
   builds the installer on Windows and the AppImage on Ubuntu, each behind the tests, the type check, lint and the
   hidden checks of the packaged app, then writes `SHA256SUMS.txt` for both and a build provenance attestation for each
   (signed by GitHub: which workflow, commit and runner built the file). Its `SiberSentez-release` artifact holds the
   three files. Check them before the upload: `sha256sum -c SHA256SUMS.txt` (or `Get-FileHash`) and
   `gh attestation verify <file> --repo VreBey/sibersentez-ai-coding-for-beginners` for each file. Then the release
   with the installer, the AppImage and `SHA256SUMS.txt`; the site (`node site/build.mjs`, then the upload).
   Not run on GitHub yet (2026-10-10): the first tagged build is its first try; until it passes, the site does not
   speak of attestations.
5. Code signing waits for its own decision (roadmap F3b): until then the installer is unsigned, as before.
