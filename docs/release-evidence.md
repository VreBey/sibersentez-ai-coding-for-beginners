# Release evidence

What each published release was built from, how it was checked, how you can check your download, and what was not
tested. One section per release, newest first; only the latest release's files stay on GitHub (older tags remain).

Each fact says who saw it:

- **GitHub** — a GitHub Actions run or GitHub's own record (a file's digest, an attestation), linked so anyone can open it.
- **Maintainer** — run by the maintainer on their own computer or in Windows Sandbox. Not reproduced by anyone else
  unless the section says so.
- **Outside review** — an independent review of the source at a named commit.

The release facts (commit, files, digests, attestations, workflow runs) come from `node tools/release-evidence.mjs
<tag>`, which asks GitHub and changes nothing. The rest is written by the maintainer.

## How to check a download

1. Download `SHA256SUMS.txt` from the same release.
2. Compare your file's SHA-256 with the line for it:
   - Windows (PowerShell): `Get-FileHash .\SiberSentez-Setup-0.20.0.exe -Algorithm SHA256`
   - Linux: `sha256sum -c SHA256SUMS.txt --ignore-missing`
3. Optionally, check where it was built (needs the GitHub CLI):
   `gh attestation verify <file> --repo VreBey/sibersentez-ai-coding-for-beginners`.
   This says which workflow, commit and GitHub runner built the file.

An attestation is not code signing. The installer and the AppImage are **unsigned**, so Windows SmartScreen still
warns on first start, and the attestation does not change that.

## 0.19.0 (2026-10-10)

### Built from

- Tag `v0.19.0`, commit `027ac1de9ae1ed20829192a245fd5b192c44be19`, published 2026-10-10:
  https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.19.0

| File | Size | SHA-256 | In SHA256SUMS.txt | Provenance attestations |
|---|---|---|---|---|
| `SiberSentez-0.19.0-x86_64.AppImage` | 135.5 MB | `dc54210ba198187e50596f4bb62651b928a88e69964196accc488f95ab00fbc7` | same | 1 |
| `SiberSentez-Setup-0.19.0.exe` | 123.0 MB | `fc14c25f0492afc8f74a460b576d9451e0e3504d1f64fcfe1df1fe3e58ae8b8f` | same | 1 |

(GitHub; read 2026-10-16.) Before the upload, the maintainer also ran `gh attestation verify` on both files; it passed
for both.

### Checked on GitHub at that commit

| Workflow | What it runs | Result | Run (started) |
|---|---|---|---|
| Release build | Windows: tests, type check, lint, the installer, hidden checks of the packaged app (`tools/electron-qa.ps1`). Ubuntu: the same with the AppImage (`tools/linux-qa.sh` under xvfb). Then `SHA256SUMS.txt` and one provenance attestation per file. | build, build-linux, release: success | [38055827960](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38055827960) (2026-10-10, the tag) |
| Tests | Windows and Ubuntu: tests, type check, lint, coverage with its floors; on Windows also `npm audit --omit=dev`. macOS: tests (a failure is allowed there). | test, test-linux, test-macos: success | [38055827948](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38055827948) (2026-10-10, the tag) |
| Packaged QA | The packaged app's hidden checks on a clean Windows and Ubuntu runner, started by hand before the tag | qa, qa-linux: success | [38055609604](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38055609604) (2026-10-10, before the tag) |
| CodeQL | GitHub's code scanning (JavaScript and the workflows) | success | [38219386174](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38219386174) (2026-10-12, a scheduled scan after the release) |

The first Packaged QA run, on the commit before (`ef184a0`), failed in two places: a check that expected the next-step
strip on a fresh install (the clean runner showed it hidden by design), and the Linux build in `qa.yml` missing
`--publish never`. Both were fixed in `027ac1d`, the released commit, before the tag.

### Checked by the maintainer before the release

- Windows 11: the whole test suite, the type check, lint, and the packaged app's hidden checks (43 of 43).
- Linux: Ubuntu in WSL 2, the whole suite (1,373 passed, 0 failed) and the AppImage's hidden checks (10 of 10).
- Windows Sandbox (a clean Windows with nothing installed): install 0.18.0, upgrade to 0.19.0, start, uninstall. All
  steps passed.
- The AI tools' command-line options SiberSentez uses, as each installed tool's `--help` names them: 7 of 7.
- `npm audit --omit=dev` (what ships in the app): no advisories. Electron 44.7.0, the latest stable release then.
- Start-up on the maintainer's computer: the server ready in 0.55 s; the first scan of 639 log files in 5.7 s.
- Contrast: no text below the WCAG 2.2 threshold in either theme (`tools/contrast-scan.js`).

### Outside review of this commit (2026-10-11)

The review was sent to the maintainer and is not published here; what follows is what it reported. An independent review of `027ac1d` (Linux x64, Node 24.19.0) ran the suite: 1,492 tests, 1,374 passed, 118 skipped,
0 failed. It measured coverage at 84.70% lines, 87.22% branches and 84.40% functions, against floors of 80%, 86% and
84%. It confirmed the five defects of the previous review fixed and found three new ones:

- going back could delete files in a folder the restore point could not read;
- a fingerprint that failed whole was never tried again;
- the support bundle could cut a log line in the middle of a quoted secret before masking it.

All three are fixed in 0.20.0.

### Not tested, or known gaps

- **Unsigned.** No code signing yet; SmartScreen warns. A provenance attestation is not a signature.
- **macOS** is not released. CI runs the tests there, and a failure is allowed.
- **Other AI tools.** Only Claude Code was used for a whole job end to end with a signed-in account. Codex, Gemini CLI,
  Qwen Code, OpenCode, Copilot and Cursor are found and their logs read. Their agent files were checked with the
  installed CLI, but a signed-in job with each was not recorded.
- **Linux desktop.** The tray, notifications and start at login were not tried on a real Linux desktop (WSLg has none).
- **The release is assembled by hand.** The maintainer checks the workflow's files (`sha256sum -c`,
  `gh attestation verify`) and uploads them. The coverage floors run in the Tests workflow, not in Release build;
  both passed at this commit.
- **Build tools.** `npm audit` for the build tools lists eight moderate advisories, all in electron-builder's chain
  (sprintf-js). That code runs only while the installer is built and is not in the app.
- **Beginners and screen readers.** There was no observed session with beginners. The automated accessibility pass
  (axe-core and a keyboard walk) found nothing left, but an NVDA pass by ear has not been done.
- **Platform details** are in [docs/platforms.md](platforms.md).
