---
name: web-app-starter
description: "Creates a first working web app: plain HTML and JavaScript for a one-page tool (nothing installed), or Next.js or Vite with React in TypeScript for more; checks tools, runs it in the browser, sets up checks. Use when the idea is a website, web app, small browser tool, dashboard, shop or blog, or a React or Next.js project needs its first version."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Node.js (20.19 or newer, an LTS release is best), npm and git. Commands are written for Windows PowerShell and also work on macOS and Linux."
metadata:
  author: "SiberSentez"
  version: "0.1.4"
  sibersentez-tags: "nextjs, react, typescript, web"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "web sitesi, site yap*, site kur*, sitesi, web uygulama*, internet sitesi, sayfa yap*, web sayfası, panel*, blog*, mağaza*, online mağaza, online satış, e ticaret, randevu*, rezervasyon*, portfolyo, tanıtım sayfası, tarayıcı*, next js, react"
---

# Web app starter

Goal: from an empty project folder to a page running on this computer, with a passing build and a first commit.
Common problems and their fixes are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check the tools

1. `node --version`: Node.js 20.19 or newer (22 LTS or later is best). If it is missing, the user installs the LTS
   version from nodejs.org, or you run `winget install OpenJS.NodeJS.LTS` after a yes. Then open a new terminal.
2. `npm --version`. If PowerShell refuses to run `npm` because running scripts is disabled, use `npm.cmd` and
   `npx.cmd` instead; changing the execution policy is a system setting and needs the user's yes.
3. `git --version`.

## 2. Choose the framework

Follow `PLAN.md` if it decides. Otherwise suggest, and let the user choose:

| The user wants | Pick |
|---|---|
| Several pages, good search visibility, server code later (forms, database, sign-in) | Next.js |
| One screen or a small tool, a dashboard for an existing API, the simplest setup | Vite + React |
| A small tool in one page (a to-do list, a calculator, a quiz) and the user wants nothing installed | Plain files |

**Plain files**: no framework, no packages and no subfolder generator: `index.html`, `style.css` and `app.js` in a
new subfolder (default `web`), opened with a double-click. Node.js is not needed: skip the Node.js and npm checks
of step 1 and steps 3, 4 and 6; make the first visible change (step 5) and check the page in the browser, with its
console free of errors. Keep data in `localStorage` when it must stay after a reload. Move to Vite + React when the
tool grows several screens.

## 3. Create the app in a subfolder

Ask for the folder name (default `web`). Create the app in that **new subfolder**, never in the project root: the
root already holds the plan and the AI tool's folder, and generators refuse or offer to delete a non-empty folder.
Never choose an option that removes existing files. Creating the app downloads packages, so ask first.

- **Next.js**: `npx create-next-app@latest web --yes`
  `--yes` takes the recommended defaults: TypeScript, ESLint, Tailwind CSS, App Router. Tell the user this. If they
  want other choices, run it without `--yes` in their own terminal and let them answer the questions.
- **Vite + React**: `npx create-vite@latest web --template react-ts --no-interactive`, then `cd web` and
  `npm install`. (The same as `npm create vite@latest`, written without the extra `--`, which some PowerShell setups drop.)

This takes one to three minutes.

## 4. Run it

```
cd web
npm run dev
```

Next.js opens on http://localhost:3000, Vite on http://localhost:5173. Ask the user to open the address. The dev
server keeps running until Ctrl+C in its terminal. If your tool cannot keep a server running, ask the user to run
these two lines in their own terminal.

## 5. First visible change

Put the project name and the one-sentence goal from `PLAN.md` on the start page:

- Next.js: `app/page.tsx` (or `src/app/page.tsx`)
- Vite: `src/App.tsx`

Save. The browser updates by itself. This proves the edit, save and see loop works.

## 6. Checks

Run these from the app folder and report the results:

- `npm run lint`
- Type check: `npx tsc --noEmit` for Next.js. For Vite, `npm run build` already runs it (`tsc -b`).
- `npm run build`. For Next.js, stop the dev server first to be safe: in some versions both use the `.next` folder
  and get in each other's way. Then try the built version: `npm run start` (Next.js) or `npm run preview` (Vite).

## 7. Save the work

- The generator made a `.gitignore` in the app folder; make sure the root `.gitignore` also ignores `.env` files.
- In the root README: how to run (`cd web`, `npm install`, `npm run dev`).
- Commit after a yes: `git add -A`, `git commit -m "feat: first running web app"`.

## What comes next

- **More pages**: Next.js uses folders (`app/about/page.tsx` becomes `/about`). For Vite, add a router package only
  when a second screen is really needed (ask before installing).
- **Settings and secrets**: in Next.js only variables starting with `NEXT_PUBLIC_` reach the browser, in Vite only
  those starting with `VITE_`. Anything that reaches the browser is public: never put secret keys there.
- **Database and sign-in**: add them only when the milestone needs them, one at a time.
- **Going online**: later, with the `release-prep` skill.
