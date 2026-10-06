# Desktop app starter: reference

Paths are inside the app folder (for example `desktop/`) created from the Electron Forge `vite-typescript`
template.

## The bridge pattern (read a note file)

`src/main.ts` (add near the other imports and before the window is created):
```ts
import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const NOTE_NAME = /^[a-z0-9-]{1,40}$/;

// Everything that comes from the page is checked before the disk is touched
ipcMain.handle('note:read', async (_event, name: unknown) => {
  if (typeof name !== 'string' || !NOTE_NAME.test(name)) throw new Error('Invalid note name');
  const file = path.join(app.getPath('userData'), 'notes', `${name}.txt`);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
});
```

`src/preload.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';

// Only these functions reach the page
contextBridge.exposeInMainWorld('appApi', {
  readNote: (name: string): Promise<string> => ipcRenderer.invoke('note:read', name),
});
```

`src/renderer.ts`:
```ts
declare global {
  interface Window {
    appApi: { readNote(name: string): Promise<string> };
  }
}

async function showNote(): Promise<void> {
  const text = await window.appApi.readNote('today');
  const target = document.querySelector('#note');
  if (target) target.textContent = text || 'No note yet.';
}

void showNote();
export {};
```

Add `<p id="note"></p>` to `index.html`. Saving works the same way: a `note:save` handler in main that checks the
name and the text length, and a `saveNote` function in the preload.

## Verification commands

| Check | Command |
|---|---|
| Run in development | `npm start` (type `rs` to restart after main-process changes) |
| Types | `npx tsc --noEmit` |
| Lint | `npm run lint` (if the script exists) |
| Packaged app, no installer | `npm run package`, then start the `.exe` under `out/` |
| Installer | `npm run make`, output under `out/make/` |

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `require is not defined` or `process is not defined` in the page | The page has no Node.js access by design. Move that code to main and call it through the bridge. |
| `window.appApi` is undefined | The preload failed or is not loaded. Open developer tools (Ctrl+Shift+I) and read the console; check that the window's `webPreferences.preload` still points to the preload file. |
| White or empty window | Open developer tools and read the first red error. |
| Works with `npm start` but not after packaging | A file path built from the current folder, or a file not included in the package. Build paths from `__dirname` or `app.getAppPath()`, and check the Forge configuration. |
| `Cannot find module` for a native package after packaging | The native module was not rebuilt for Electron. Check the Forge output for rebuild errors before trying anything else; ask before running extra rebuild tools. |
| The installer is blocked or warned about | It is not code signed. For a test build: "More info" then "Run anyway". For the public: a signing certificate. |
| The app starts twice or makes shortcuts during install | Keep the template's `electron-squirrel-startup` check at the top of `src/main.ts`. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | PowerShell policy. Use `npm.cmd` / `npx.cmd`, or Command Prompt. Changing the policy needs the user's yes. |

## Safety checklist

- `contextIsolation`, `sandbox` on; `nodeIntegration` off (the template's defaults).
- The preload exposes named functions only; main validates every argument.
- Remote websites never get the bridge; open external links in the user's browser with `shell.openExternal` after
  checking the address starts with `https://`.
- Keep the Content-Security-Policy in `index.html`.
- User data under `app.getPath('userData')`.
