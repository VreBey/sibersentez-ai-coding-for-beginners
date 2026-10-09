// @ts-check
// "Start at login" on Linux (plan G2): Electron's login item settings work on Windows and macOS only. On a Linux desktop
// the freedesktop way is a .desktop file in ~/.config/autostart (or $XDG_CONFIG_HOME/autostart); its presence is the
// setting. Pure apart from the small file helpers (fs injectable).
import fs from 'node:fs';
import path from 'node:path';

export const AUTOSTART_FILE = 'sibersentez.desktop';

// The autostart folder, or '' when the environment gives no absolute home
/** @param {Record<string, string | undefined>} env */
export function autostartDir(env) {
  const xdg = String(env.XDG_CONFIG_HOME || '').trim();
  if (xdg.startsWith('/')) return path.posix.join(xdg, 'autostart');
  const home = String(env.HOME || '').trim();
  return home.startsWith('/') ? path.posix.join(home, '.config', 'autostart') : '';
}

// The program to start: an AppImage runs from the path in $APPIMAGE (the mounted file changes every run); else the
// executable itself. args: development's app folder and --hidden. Each part quoted as the Desktop Entry spec wants
// (a double quote, a backquote, a dollar sign and a backslash escaped); null when a part has a line break.
/** @param {{ exe: string, args?: string[], appImage?: string }} o */
export function autostartEntry({ exe, args = [], appImage = '' }) {
  const program = appImage && appImage.startsWith('/') ? appImage : exe;
  const parts = [program, ...args];
  if (!program.startsWith('/') || parts.some((p) => typeof p !== 'string' || /[\r\n\u0000]/.test(p))) return null;
  // The Desktop Entry spec: inside quotes ", `, $ and \ take a backslash; then the whole value's string escaping doubles
  // every backslash; % is a field code, written %% (review G). One pass, each character once (code scanning #12: two
  // chained replacements read as double escaping): " ` $ become \\x, a backslash becomes four
  const ESC = { '"': '\\\\"', '`': '\\\\`', $: '\\\\$', '\\': '\\\\\\\\', '%': '%%' };
  const quote = (p) => `"${p.replace(/["`$\\%]/g, (c) => ESC[c])}"`;
  return ['[Desktop Entry]', 'Type=Application', 'Name=SiberSentez', `Exec=${parts.map(quote).join(' ')}`, 'X-GNOME-Autostart-enabled=true', 'NoDisplay=false', 'Terminal=false', ''].join('\n');
}

/** @param {Record<string, string | undefined>} env @param {typeof fs} [xfs] */
export function readAutostart(env, xfs = fs) {
  const dir = autostartDir(env);
  if (!dir) return false;
  try {
    return xfs.lstatSync(path.posix.join(dir, AUTOSTART_FILE)).isFile();
  } catch {
    return false;
  }
}

// On: the file written (its folder made); off: the file removed. Returns true when done.
/** @param {boolean} on @param {{ env: Record<string, string | undefined>, exe: string, args?: string[], xfs?: typeof fs }} o */
export function writeAutostart(on, { env, exe, args = [], xfs = fs }) {
  const dir = autostartDir(env);
  if (!dir) return false;
  const file = path.posix.join(dir, AUTOSTART_FILE);
  try {
    if (!on) {
      xfs.rmSync(file, { force: true });
      return true;
    }
    const text = autostartEntry({ exe, args, appImage: env.APPIMAGE || '' });
    if (!text) return false;
    xfs.mkdirSync(dir, { recursive: true });
    xfs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}
