# Code signing

Status: the build runs on GitHub Actions; signing waits for SignPath Foundation to accept the project (applied
2026-10-06). Until then the installer is published unsigned, as before.

## Why SignPath Foundation

An unsigned installer makes Windows SmartScreen warn ("Windows protected your PC"), and a beginner may stop there.
SignPath Foundation signs open source projects free of charge with its own certificate; the publisher shown is
"SignPath Foundation". Its terms (signpath.org/terms) ask for:

- an OSI license for everything the project ships: the app is GPL-3.0-or-later, the kit MIT, the bundled components
  MIT (`THIRD_PARTY_NOTICES.md`);
- a verifiable build from the public repository: `.github/workflows/release.yml`;
- a manual approval of every release before it is signed: the SignPath signing policy `release-signing`;
- a code signing policy page on the homepage, with the sentence "Free code signing provided by SignPath.io,
  certificate by SignPath Foundation", the team roles and the privacy statement:
  [sibersentez.com/en/code-signing-policy](https://sibersentez.com/en/code-signing-policy/) (Turkish:
  `/imza-politikasi/`, from `site/build.mjs`);
- multi-factor authentication for everyone with access to the repository and to SignPath.

Only our own binary is signed: the installer. The components inside it keep their publishers' files.

## The release workflow

`release.yml` runs by hand (`workflow_dispatch`) or on a `v*` tag: `npm ci`, `npm test`, `npm run dist` with no
certificate, the SHA-256 in the log, the unsigned installer as the artifact `SiberSentez-Setup-unsigned`. When the
repository has the variable `SIGNPATH_ORGANIZATION_ID` and the secret `SIGNPATH_API_TOKEN`, it also submits that
artifact to SignPath (project `sibersentez`, signing policy `release-signing`, artifact configuration `installer`),
waits up to an hour for the approval and keeps the signed installer as `SiberSentez-Setup-signed`. The release itself
is still made by hand from that artifact, with its SHA-256 in the notes.

## SignPath artifact configuration (`installer`)

The GitHub artifact is a ZIP holding the installer:

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="SiberSentez-Setup-*.exe" product-name="SiberSentez">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```
