# Web app starter: reference

Read the part you need. Run commands from the app folder (for example `web/`) unless noted.

## What the generators create

**Next.js (App Router)**
```
web/
  app/            pages: app/page.tsx is "/", app/about/page.tsx is "/about"
    layout.tsx    shared frame of every page (html, body, fonts, global CSS)
    globals.css
  public/         files served as they are (images, icons)
  next.config.ts
  package.json    scripts: dev, build, start, lint
  AGENTS.md       notes for AI coding tools (newer versions)
```

**Vite + React**
```
web/
  index.html      the single HTML page
  src/
    main.tsx      starts React
    App.tsx       the first component
  public/
  vite.config.ts
  package.json    scripts: dev, build, preview, lint
```

## Verification commands

| Check | Next.js | Vite |
|---|---|---|
| Dev server | `npm run dev` then http://localhost:3000 | `npm run dev` then http://localhost:5173 |
| Lint | `npm run lint` | `npm run lint` |
| Types | `npx tsc --noEmit` | part of `npm run build` |
| Production build | `npm run build` | `npm run build` |
| Try the build | `npm run start` | `npm run preview` |

## Common problems

| Symptom | Cause and fix |
|---|---|
| `'npm' is not recognized` | Node.js is not installed, or the terminal was opened before installing. Install it and open a new terminal. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | PowerShell policy. Use `npm.cmd` / `npx.cmd`, or use Command Prompt. Changing the policy (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`) is a system setting: only with the user's yes. |
| `EADDRINUSE` or "port 3000 is in use" | Another dev server is still running. Stop it, or start on another port: `npx next dev -p 3001` (Next.js) or `npx vite --port 5174` (Vite). |
| Generator says the folder is not empty | It was pointed at an existing folder. Use a new subfolder name. Never pick "remove existing files". |
| Next.js: "needs useState ... only works in a Client Component" | The file uses state, effects or click handlers. Add `"use client";` as the first line of that component file, and keep it as low in the tree as possible. |
| Next.js: "Hydration failed" / text does not match | The page renders differently on the server and in the browser (dates, random numbers, `window`, browser extensions). Move that code into `useEffect`, or render it only in the browser. |
| Next.js: odd errors mentioning `.next` after a build | The dev server and a build used the same folder. Stop the dev server; deleting `.next` fixes it (ask first; it is only build output). |
| An environment variable is `undefined` in the browser | Missing prefix (`NEXT_PUBLIC_` or `VITE_`), or the dev server was not restarted after editing `.env.local`. Remember: prefixed values are public. |
| `Module not found` after pulling changes | Dependencies changed. Run `npm install`. |
| Blank page | Open the browser's developer tools (F12), read the first red error in the Console tab. |
| Tailwind classes do nothing | The global CSS file is not imported in `app/layout.tsx`, or the class name is built from pieces at runtime (write full class names). |
| CORS error when calling an API | The API does not allow your site. Call it from server code (a Next.js route handler) or ask the API owner to allow your origin. Never disable browser security. |
| Strange path errors | The project path contains spaces or non-English letters. A short path such as `C:\dev\my-app` avoids many tool problems. |

## Keeping it simple

- One new package at a time, each with a reason and a yes. Prefer what the framework already includes.
- Styling: the generator's Tailwind setup or plain CSS modules are enough for a first version.
- Data at first: a JSON file or the browser's storage for a prototype; a real database when the plan needs sharing
  between users.
