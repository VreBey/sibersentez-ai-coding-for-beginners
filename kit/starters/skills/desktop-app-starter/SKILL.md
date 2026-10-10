---
name: desktop-app-starter
description: "Creates a first working Windows desktop app with Electron and TypeScript using Electron Forge: generates it in a subfolder, opens its window, adds a safe bridge to the computer and builds an installer. Use when the idea is a desktop app, a Windows program or a tray tool, or an Electron project needs its first version."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Node.js 22.12 or newer (24 LTS is best; Node.js 20 no longer gets security fixes), npm and git. Written for Windows; Electron Forge also builds for macOS and Linux on those systems."
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "electron, typescript, desktop"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "masaüstü*, bilgisayar*, program, programı, windows uygulama*, windows program*, pencere*, exe, kurulum dosyası, sistem tepsi*, tepsi*, çevrimdışı, electron"
---

# Desktop app starter

Goal: the user's own window opens on their computer, shows their project's name, can safely read or save a file
through a small bridge, and an installer can be built. Code for the bridge and common problems are in
[reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check the tools

1. `node --version` (22.12 or newer, which the Vite template needs; 24 LTS is best, 20 no longer gets security fixes)
   and `npm --version`. If Node.js is missing or older, the user installs the LTS version from nodejs.org (on Windows
   you may run `winget install OpenJS.NodeJS.LTS` after a yes; on Linux nodejs.org lists the package manager steps).
   Open a new terminal afterwards.
2. `git --version`.
3. In one sentence, why Electron: the window is a web page (HTML, CSS, TypeScript) with safe access to the computer.
   Alternatives if the plan says so: Tauri (smaller apps, needs Rust) or WPF/WinUI (C#).

## 2. Create the app in a subfolder

Ask for the folder name (default `desktop`), then, after a yes (it downloads packages):

```
npx create-electron-app@latest desktop --template=vite-typescript
```

Create it in a new subfolder, never in the project root, and never accept an option that deletes existing files.
Explain the three parts the user will hear about:

| Part | File | What it may do |
|---|---|---|
| Main process | `src/main.ts` | Node.js: windows, menus, files, the tray |
| Preload | `src/preload.ts` | the bridge: a few named functions the page may call |
| Renderer | `index.html`, `src/renderer.ts` | the page itself; no direct access to the computer |

## 3. Run it

```
cd desktop
npm start
```

The window opens. Changes to the page reload by themselves; after changing `src/main.ts`, type `rs` in the terminal
to restart. Stop with Ctrl+C in the terminal or by closing the window. If your tool cannot keep the app running, ask
the user to run these lines in their own terminal.

## 4. First visible change

Put the project name and the one-sentence goal from `PLAN.md` into `index.html`. Save and look at the window.

## 5. The safe bridge

Every feature that touches the computer (files, dialogs, the tray) follows one pattern, shown in reference.md:

1. `src/main.ts` handles a named request with `ipcMain.handle` and **checks every argument** it receives.
2. `src/preload.ts` exposes one small function per request with `contextBridge.exposeInMainWorld`.
3. The page calls that function.

Keep the template's safe defaults: context isolation on, Node.js integration off, sandbox on. Never turn them off
and never expose a general "run a command" or "read any file" function. Save user data under
`app.getPath('userData')`, never inside the install folder.

## 6. Checks

Run from the app folder and report the results:

- `npx tsc --noEmit` (type check) and `npm run lint` if the script exists.
- `npm run package`: builds the app into `out/` without an installer. Start the `.exe` it made and try it, because
  the packaged app can behave differently from `npm start`.
- `npm run make`: builds the Windows installer into `out/make/`. Explain that an installer without a code signing
  certificate makes Windows show a "Windows protected your PC" warning; that is expected for a test build. Public
  releases need signing, which costs money: mention it, do not buy or set up anything without the user.

## 7. Save the work

- The template's `.gitignore` covers `node_modules/`, `out/` and `.vite/`; make sure the root `.gitignore` also
  ignores `.env` files.
- In the root README: how to run (`cd desktop`, `npm install`, `npm start`) and how to build (`npm run make`).
- Commit after a yes: `git add -A`, `git commit -m "feat: first running desktop app"`.

## What comes next

- One feature at a time through the bridge: open a file dialog, save a note, show a tray icon.
- Settings: a small JSON file in the user data folder.
- Automatic updates and signing belong to release time (`release-prep` skill), not to the first version.
