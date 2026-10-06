---
name: mobile-app-starter
description: "Creates a first working phone app with Expo and React Native in TypeScript: checks tools, generates the app in a subfolder, opens it on a real phone with Expo Go, sets up type and health checks. Use when the idea is a mobile app, an Android or iPhone app, or an Expo or React Native project needs its first version."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Node.js (20.19 or newer, an LTS release is best), npm, git and a phone with the Expo Go app on the same Wi-Fi. iPhone simulators need a Mac; on Windows use a real iPhone or an Android emulator."
metadata:
  author: "SiberSentez"
  version: "0.2.1"
  sibersentez-tags: "expo, react-native, typescript, mobile"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "mobil*, telefon*, cep telefonu, akıllı telefon, android, ios, iphone, uygulama mağazası, play store, app store, expo, react native"
---

# Mobile app starter

Goal: the user sees their own app running on their own phone, can change it and see the change within seconds, and
the work is committed. Common problems are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check the tools

1. `node --version` (20.19 or newer; 22 LTS or later is best) and `npm --version`. If Node.js is missing, the user
   installs the LTS version from nodejs.org, or you run `winget install OpenJS.NodeJS.LTS` after a yes. Open a new
   terminal afterwards.
2. `git --version`.
3. The phone: install **Expo Go** from Google Play or the App Store. The phone and the computer must be on the same
   Wi-Fi network.
4. Tell the user early: building an iPhone app for the App Store needs an Apple developer account (paid yearly), and
   Google Play needs a one-time fee. Neither is needed to try the app with Expo Go.

## 2. Create the app in a subfolder

Ask for the folder name (default `mobile`), then, after a yes (it downloads packages):

```
npx create-expo-app@latest mobile --yes
```

The default template uses **Expo Router** (every file in `src/app/`, or `app/` in older templates, is a screen) and TypeScript. Create it in a new
subfolder, never in the project root, and never accept an option that deletes existing files. A short path without
spaces or non-English letters (for example `C:\dev\my-app`) avoids trouble with Android tools later.

## 3. Run it on the phone

```
cd mobile
npx expo start
```

- A QR code appears in the terminal. Android: scan it in Expo Go. iPhone: scan it with the Camera app.
- Windows may ask whether Node.js may use the network: allow it for **private** networks.
- In the terminal: `r` reloads the app, Ctrl+C stops the server.
- If your tool cannot keep the server running, ask the user to run these lines in their own terminal.
- Phone cannot connect? See reference.md (same Wi-Fi, VPN, firewall, tunnel mode).

## 4. First visible change

Find the home screen file: `src/app/index.tsx` in the current default template (older templates: `app/(tabs)/index.tsx`; check with a folder listing). Put the project name and the
one-sentence goal from `PLAN.md` on it. Save: the phone updates within seconds.

## 5. Adding packages

Always use `npx expo install <package>` instead of `npm install`: it picks versions that match the project's Expo
SDK. Ask before each install and say what the package is for.

## 6. Checks

Run from the app folder and report the results:

- `npx expo-doctor` checks the project's health and package versions.
- `npx tsc --noEmit` checks the TypeScript types.
- `npm run lint` if the project has the script (the first run may offer to set up the linter: ask first).

## 7. Save the work

- The template's `.gitignore` covers `node_modules/`, `.expo/` and build output; make sure the root `.gitignore` also
  ignores `.env` files.
- In the root README: how to run (`cd mobile`, `npm install`, `npx expo start`, scan with Expo Go).
- Commit after a yes: `git add -A`, `git commit -m "feat: first running mobile app"`.

## 8. Moving between screens

Every file in the `app` folder (`src/app/` in the current template) is a screen. Link with `Link href="/about"` or `router.push('/about')`; a file in the `(tabs)`
folder is a bottom tab; a file named `[id].tsx` takes a parameter (`useLocalSearchParams`). Add one screen, open it from
the first, go back. Code and the layout files are in reference.md.

## 9. Keeping data on the phone

Pick by what is stored: a few settings or a short list: AsyncStorage; many records you search: `expo-sqlite`; tokens or
anything private: `expo-secure-store`. Install each with `npx expo install` after a yes. Test it: save, close the app
completely, open it again and check the data is still there. The sample is in reference.md.

## 10. Permissions

Ask for a phone permission (camera, location, notifications) only when the feature needs it, at the moment it is used,
with one plain sentence on why. Handle "no": the app must still work, or say what is missing. Never ask for several at
startup. Texts shown to users in the permission dialog are set in `app.json`. Details in reference.md.

## 11. Publishing with EAS

A test build you can install on your own phone first, a store build later. It needs a free Expo account, the user
signing in themselves, and for the stores a paid developer account (Apple yearly, Google once). Check the current
commands and prices on docs.expo.dev before promising anything. The steps are in reference.md; do each only after a yes.

## What comes next

- **Secrets**: everything inside the app can be read by anyone who has the app. Keep secret keys on a server.
- **A server for shared data**: `api-service-starter`, then sign-in with `auth-flow`.
- **Versions and notes for a release**: the `release-prep` skill.
