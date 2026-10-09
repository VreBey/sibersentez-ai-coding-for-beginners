// @ts-check
// The shell's own state file in its data folder (plan D8: from helpers.mjs, which re-exports it). Pure, no Electron.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../server/atomic.mjs';
import { normalizeActionsMode, tempSuffix } from './actions-mode.mjs';
import { samePath } from './shell-paths.mjs';

// ---------------------------------------------------------------- the shell's own state (its data folder)

// <data folder>\shell.json: { trayHintShown, actionsModeSeen: { hub, mode } }. Not the hub: the user's data stays
// apart from the shell's bookkeeping.
export const SHELL_STATE_FILE = 'shell.json';

// The file as an object; a missing, unreadable or invalid file is {}
export function readShellState(file, fsImpl = fs) {
  try {
    const v = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Sets the keys of patch and keeps every other key. Returns true when saved. Atomic like writeHubActionsSetting: the
// full new text goes to a new temporary file next to shell.json ('wx', never an existing file), which then replaces
// shell.json in a single rename; shell.json itself is never opened for writing, so a crash or a full disk leaves either
// the old or the new text, never a cut one (a cut file would read as {} and bring back the actions warning and the
// tray hint). fsImpl and suffix are injectable for tests.
/** @param {string} file @param {object} patch @param {{ fsImpl?: typeof fs, suffix?: () => string, wait?: any }} [options] */
export function updateShellState(file, patch, { fsImpl = fs, suffix = tempSuffix, wait } = {}) {
  const text = JSON.stringify({ ...readShellState(file, fsImpl), ...patch }) + '\n';
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${suffix()}.tmp`);
  try {
    writeFileAtomic(file, text, { fsImpl, tmp, wait });
    return true;
  } catch {
    return false;
  }
}

// Actions are on, but this shell neither switched them on for this hub nor warned about it yet: settings.json was
// changed outside SiberSentez (by hand or by another program). seen is shell.json's actionsModeSeen, the last mode the
// shell wrote or warned about. The shell warns once and then records the mode as seen.
export function unexpectedLiveMode({ mode, seen, hubPath }) {
  if (normalizeActionsMode(mode) !== 'live') return false;
  const known = seen && seen.mode === 'live' && typeof seen.hub === 'string' && typeof hubPath === 'string' && samePath(seen.hub, hubPath);
  return !known;
}

// What the shell does about the actions mode each time a server becomes ready (the first start, a crash restart, a
// requested restart). The server has just read settings.json, which may have changed while the previous one ran, so:
//   1. refreshTray()  the tray is rebuilt from the stored mode, so its radio items show what the server now uses;
//   2. actions found On that this shell did not switch on (unexpectedLiveMode) are reported: remember(mode) records
//      them in shell.json first, then warn() shows the warning. There is no once-per-run limit: that record is what
//      keeps the same change from being reported again, across restarts and app runs alike.
// QA mode only logs (no dialog, nothing recorded). read() returns the stored mode, seen() shell.json's actionsModeSeen.
// Returns 'warned' | 'logged' | 'none'.
export function checkActionsOnReady({ hubPath, qa = false, read, seen, remember, warn, refreshTray, log = (_line) => {} }) {
  refreshTray();
  const mode = read();
  if (!unexpectedLiveMode({ mode, seen: seen(), hubPath })) return 'none';
  log('actions are on, but not switched on from this tray: settings.json was changed outside SiberSentez');
  if (qa) return 'logged';
  remember(mode);
  warn(mode);
  return 'warned';
}
