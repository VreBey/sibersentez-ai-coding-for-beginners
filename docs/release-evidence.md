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

## 0.20.0 (2026-10-16)

### Built from

- Tag `v0.20.0`, commit `ad67e0f25e08ad4fbe682ad417a923191ba2b85e`, published 2026-10-16:
  https://github.com/VreBey/sibersentez-ai-coding-for-beginners/releases/tag/v0.20.0

| File | Size | SHA-256 | In SHA256SUMS.txt | Provenance attestations |
|---|---|---|---|---|
| `SiberSentez-0.20.0-x86_64.AppImage` | 135.9 MB | `3cfbeca49ff8174ccaac71c6c5b490a73ed3f3743b889d1830f033afa9ba019c` | same | 1 |
| `SiberSentez-Setup-0.20.0.exe` | 123.1 MB | `11362eae353f4679a9d959cbf38fd81110eabe427eb3a51a8bd197c872471829` | same | 1 |

(GitHub; read 2026-10-17.) Before the upload, the maintainer also ran `sha256sum -c SHA256SUMS.txt` and
`gh attestation verify` on both files; both passed.

### Checked on GitHub at that commit

| Workflow | What it runs | Result | Run (started) |
|---|---|---|---|
| Release build | As for 0.19.0: tests, type check, lint, the installer or AppImage and the packaged app's hidden checks on Windows and Ubuntu; then `SHA256SUMS.txt` and the attestations | build, build-linux, release: success | [38966159538](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38966159538) (2026-10-16, the tag) |
| Tests | Windows, Ubuntu and macOS, as for 0.19.0 | test, test-linux, test-macos: success | [38966159505](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38966159505) (2026-10-16, the tag) |
| Packaged QA | The packaged app's hidden checks on a clean Windows and Ubuntu runner, started by hand before the tag | qa, qa-linux: success | [38965786782](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38965786782) (2026-10-16, before the tag) |
| CodeQL | GitHub's code scanning (JavaScript and the workflows) | success | [38965777226](https://github.com/VreBey/sibersentez-ai-coding-for-beginners/actions/runs/38965777226) (2026-10-16, the push) |

### Checked by the maintainer before the release

- Windows 11: the whole test suite (1,505 passed, 0 failed, 14 skipped), the type check, lint (308 files, no
  findings), and the packaged app's hidden checks (43 of 43).
- Linux: Ubuntu in WSL 2, the whole suite (1,401 passed, 0 failed, 118 skipped) and the AppImage's hidden checks
  (10 of 10).
- Windows Sandbox: install 0.19.0 (the released file), upgrade to 0.20.0, start, uninstall. All steps passed.
- The AI tools' command-line options SiberSentez uses: 7 of 7. Claude Code 2.1.301 is the newest checked.
- `npm audit --omit=dev`: no advisories. Electron 44.8.0, the latest stable release then.
- Start-up on the maintainer's computer: the server ready in 0.55–0.57 s; the first scan of 462 log files (1.37 GB)
  in 4.2–4.4 s.
- Contrast: no text below the WCAG 2.2 threshold in either theme; the lowest ratio 5.2:1 dark, 4.85:1 light.
- A separate reviewer agent read the changes since 0.19.0 that came from the outside review's open points: the first
  round asked for changes (what is not known was only under Details; a click before the hub's record was read could
  overwrite the marks it keeps), the second approved.

### Not tested, or known gaps

- Everything listed for 0.19.0 below still holds: unsigned, no macOS release, other AI tools not used for a whole
  signed-in job, no real Linux desktop, the release assembled by hand, no session with beginners or a screen reader.
- **The result card's Details fold** was looked at in a headless browser with the app's styles; opening and closing it
  by keyboard in the running app was not tried.
- **Codex** keeps the kit's roles' limits only in part. The app says so before Start; it does not stop the job.

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
