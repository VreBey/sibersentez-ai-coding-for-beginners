// @ts-check
// What differs between Windows, Linux and macOS, in one place (plan G1). Every other module asks this one instead of
// testing process.platform itself, and takes a platform as a parameter so a test can ask for the other two. Pure: it
// reads only the environment it is given and process.platform as the default.
//   windows   Windows 10 and 11, the platform SiberSentez was built on
//   linux     Linux desktops (plan G2)
//   mac       macOS, experimental: tried in CI only, never on a Mac (plan G3, the owner has no Mac)
import path from 'node:path';

export const PLATFORM_IDS = Object.freeze(['win32', 'linux', 'darwin']);

/** @typedef {ReturnType<typeof platformOf>} Platform */

// One platform's rules. id: Node's process.platform; an unknown one is treated as Linux (another Unix)
/** @param {string} [id] */
export function platformOf(id = process.platform) {
  const windows = id === 'win32';
  const mac = id === 'darwin';
  return Object.freeze({
    id: windows ? 'win32' : mac ? 'darwin' : 'linux',
    windows,
    mac,
    linux: !windows && !mac,
    // Paths: Windows' rules on Windows, POSIX' elsewhere (never the host's by accident)
    path: windows ? path.win32 : path.posix,
    // PATH's separator
    listSep: windows ? ';' : ':',
    // Names that differ only in letter case are the same file: Windows, and macOS' default file system
    caseless: windows || mac,
    // The file types a command is found as: cmd's PATHEXT order on Windows; a plain executable file elsewhere
    runnable: Object.freeze(windows ? ['.exe', '.bat', '.cmd'] : ['']),
    homeVar: windows ? 'USERPROFILE' : 'HOME',
  });
}

export const PLATFORM = platformOf();

// An environment variable by name; Windows' names have no letter case (a copied process.env does)
/** @param {Record<string, string | undefined> | null | undefined} env @param {string} name */
export function envOf(env, name) {
  if (!env) return '';
  if (typeof env[name] === 'string') return /** @type {string} */ (env[name]);
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k && typeof env[k] === 'string' ? /** @type {string} */ (env[k]) : '';
}

// A local absolute path: a drive letter on Windows (never a network or device path); '/' elsewhere (never '//')
/** @param {unknown} p @param {Platform} [plat] */
export function isLocalAbsolute(p, plat = PLATFORM) {
  if (typeof p !== 'string' || !p) return false;
  if (plat.windows) return /^[A-Za-z]:[\\/]/.test(p);
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('\0');
}

// The person's home folder from the environment ('' when unset or not a local absolute path)
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] */
export function homeOf(env, plat = PLATFORM) {
  const h = envOf(env, plat.homeVar).trim();
  return isLocalAbsolute(h, plat) ? h : '';
}

// Where the official installers put a command, beyond PATH (a tool installed after SiberSentez started: this process
// still has the old PATH). [{ dir, key }]; key names the installer for the tools panel.
//   Windows: ~\.local\bin (native Claude Code), %APPDATA%\npm, WinGet's Links, scoop's shims
//   Linux:   ~/.local/bin (native installers, pipx), ~/.npm-global/bin (the npm prefix the docs suggest),
//            /usr/local/bin
//   macOS:   ~/.local/bin, Homebrew (/opt/homebrew/bin on Apple silicon, /usr/local/bin on Intel), ~/.npm-global/bin
// Linux and macOS also: the Node.js that nvm installs (the setup wizard's way; its PATH lives in the shell's profile,
// which an app started from the desktop never reads: review G), newest first, at most three; and the folders of the
// installers that keep their own (~/.bun/bin, ~/.volta/bin, ~/.opencode/bin). listDir(dir): folder names (tests
// inject it; pure otherwise)
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] @param {(dir: string) => string[]} [listDir] */
export function installerDirs(env, plat = PLATFORM, listDir = () => []) {
  const p = plat.path;
  const home = homeOf(env, plat);
  const out = [];
  if (plat.windows) {
    const appData = envOf(env, 'APPDATA');
    const local = envOf(env, 'LOCALAPPDATA');
    if (home) out.push({ dir: p.join(home, '.local', 'bin'), key: 'localBin' });
    if (isLocalAbsolute(appData, plat)) out.push({ dir: p.join(appData, 'npm'), key: 'npm' });
    if (isLocalAbsolute(local, plat)) out.push({ dir: p.join(local, 'Microsoft', 'WinGet', 'Links'), key: 'winget' });
    if (home) out.push({ dir: p.join(home, 'scoop', 'shims'), key: 'scoop' });
    return out;
  }
  if (home) out.push({ dir: p.join(home, '.local', 'bin'), key: 'localBin' });
  if (home) out.push({ dir: p.join(home, '.npm-global', 'bin'), key: 'npm' });
  if (plat.mac) {
    out.push({ dir: '/opt/homebrew/bin', key: 'brew' });
    out.push({ dir: '/usr/local/bin', key: 'brew' });
  } else out.push({ dir: '/usr/local/bin', key: 'system' });
  if (home) {
    const nvmBin = envOf(env, 'NVM_BIN');
    if (isLocalAbsolute(nvmBin, plat)) out.push({ dir: nvmBin, key: 'nvm' });
    const versions = p.join(envOf(env, 'NVM_DIR') && isLocalAbsolute(envOf(env, 'NVM_DIR'), plat) ? envOf(env, 'NVM_DIR') : p.join(home, '.nvm'), 'versions', 'node');
    const num = (v) => v.replace(/^v/, '').split('.').map((x) => Number(x) || 0);
    const newer = (a, b) => {
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    };
    for (const v of listDir(versions).filter((n) => /^v\d+\.\d+\.\d+$/.test(n)).sort(newer).slice(0, 3)) out.push({ dir: p.join(versions, v, 'bin'), key: 'nvm' });
    // nvm and these installers write their own PATH line into the shell's profile: the setup check names no line for them
    for (const d of ['.bun', '.volta', '.opencode']) out.push({ dir: p.join(home, d, 'bin'), key: 'own' });
  }
  return out;
}

// A Windows drive seen from WSL (/mnt/c/...): WSL puts Windows' PATH after its own, and a Windows program found there
// is no Linux tool (asking its version even runs it on Windows, in that Windows folder). Only inside WSL: a Linux
// computer that mounts a disk under /mnt/x is left alone.
/** @param {string} dir @param {Record<string, string | undefined>} env @param {Platform} [plat] */
export function isWindowsDriveFromWsl(dir, env, plat = PLATFORM) {
  if (plat.windows || !(envOf(env, 'WSL_DISTRO_NAME') || envOf(env, 'WSL_INTEROP'))) return false;
  return /^\/mnt\/[a-z](\/|$)/i.test(dir);
}

// Where SiberSentez keeps its own files when the shell names no folder: %LOCALAPPDATA%\SiberSentez; Linux:
// $XDG_DATA_HOME/SiberSentez, else ~/.local/share/SiberSentez; macOS: ~/Library/Application Support/SiberSentez.
// '' when the environment gives no usable folder.
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] */
export function appDataDir(env, plat = PLATFORM) {
  const p = plat.path;
  if (plat.windows) {
    const local = envOf(env, 'LOCALAPPDATA');
    return isLocalAbsolute(local, plat) ? p.join(local, 'SiberSentez') : '';
  }
  const home = homeOf(env, plat);
  if (plat.mac) return home ? p.join(home, 'Library', 'Application Support', 'SiberSentez') : '';
  const xdg = envOf(env, 'XDG_DATA_HOME');
  if (isLocalAbsolute(xdg, plat)) return p.join(xdg, 'SiberSentez');
  return home ? p.join(home, '.local', 'share', 'SiberSentez') : '';
}

// The shell an embedded terminal starts: Windows PowerShell by its full path on Windows (the install commands the AI
// tools document are PowerShell's); elsewhere the person's own login shell ($SHELL when it is an absolute path to a
// known shell), else /bin/bash, else /bin/sh. exists: for the fallbacks (tests inject it).
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] @param {(p: string) => boolean} [exists] */
export function terminalShell(env, plat = PLATFORM, exists = () => true) {
  if (plat.windows) {
    const root = envOf(env, 'SystemRoot');
    const sys = /^[A-Za-z]:\\[^%"]*$/.test(root) ? root : 'C:\\Windows';
    return { file: path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
  }
  const shell = envOf(env, 'SHELL');
  if (isLocalAbsolute(shell, plat) && /\/(bash|zsh|fish|sh|dash|ksh)$/.test(shell) && exists(shell)) return { file: shell, args: ['-l'] };
  if (exists('/bin/bash')) return { file: '/bin/bash', args: ['-l'] };
  return { file: '/bin/sh', args: [] };
}

// The program that shows a folder in the system's file manager: Explorer, xdg-open (Linux desktops), open (macOS)
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] */
export function fileManager(env, plat = PLATFORM) {
  if (plat.windows) {
    const root = envOf(env, 'SystemRoot');
    return path.win32.join(/^[A-Za-z]:\\[^%"]*$/.test(root) ? root : 'C:\\Windows', 'explorer.exe');
  }
  return plat.mac ? '/usr/bin/open' : '/usr/bin/xdg-open';
}

// A local folder as it is compared and stored: normalized, without a trailing separator (the root keeps its own: C:\
// on Windows, / elsewhere)
/** @param {string} p @param {Platform} [plat] */
export function normalizeDir(p, plat = PLATFORM) {
  const d = plat.path.normalize(p);
  if (plat.windows) return d.length > 3 ? d.replace(/[\\/]+$/, '') : d;
  return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

// The root of a file system: a drive ('C:', 'C:\', 'c:/') on Windows, '/' elsewhere
/** @param {unknown} p @param {Platform} [plat] */
export function isFsRoot(p, plat = PLATFORM) {
  if (typeof p !== 'string') return false;
  return plat.windows ? /^[A-Za-z]:[\\/]?$/.test(p) : /^\/+$/.test(p);
}

// A folder of the system itself, never a project: Windows' System32; on Linux and macOS every top folder (/usr, /home,
// /tmp...) and the folders one level below those that hold only the system's own files (/usr/bin, /etc/x, /lib/x...).
// /srv/site, /opt/app, /var/www and /home/<name>/x stay possible project folders.
/** @param {string} n a normPath()ed path (lower case, forward slashes) @param {Platform} [plat] */
export function isSystemFolder(n, plat = PLATFORM) {
  if (plat.windows) return /\/windows\/system32$/.test(n);
  // The root, its known top folders (an unknown one such as /app, /workspace or /data can be a project: a container)
  if (n === '/' || /^\/(usr|etc|bin|sbin|boot|dev|proc|sys|lib|lib32|lib64|libx32|run|tmp|var|opt|srv|home|root|mnt|media|snap|system|library|applications|volumes|private|cores|users)$/.test(n)) return true;
  // and what lies below the folders that hold only the system's own files. Free below them: /usr/local/src and /usr/src
  // (where source is kept; a container's usual working folder) and /run/media (removable drives on Fedora, Arch,
  // openSUSE: review G)
  return /^\/(usr|etc|bin|sbin|boot|dev|proc|sys|lib|lib32|lib64|libx32|run|system)\//.test(n) && !/^\/(?:usr\/local\/src|usr\/src|run\/media)\//.test(n);
}

// The hidden folders of the home folder that hold programs' own files (Linux and macOS; Windows keeps them in
// AppData): never a project, nor anything below them. A hidden folder of the person's own (~/.dotfiles) can be one.
export const PROGRAM_HOME_FOLDERS = Object.freeze(['.npm', '.nvm', '.cargo', '.rustup', '.bun', '.volta', '.pnpm-store', '.yarn', '.gradle', '.m2', '.pyenv', '.rbenv', '.gem', '.deno', '.cache', '.local', '.var', '.opencode', '.codex', '.claude', '.gemini', '.qwen', '.cursor', '.vscode', '.vscode-server', '.android', '.ssh', '.gnupg', '.mozilla', '.thunderbird', '.steam', '.wine', '.docker', '.kube', '.terraform.d', '.oh-my-zsh', '.nuget', '.dotnet', '.aws', '.azure', '.npm-global', '.sdkman', '.conda', '.pub-cache', '.cocoapods', '.julia', '.pnpm', '.node-gyp', '.electron-gyp', '.thumbnails', '.kde', '.gnome', '.pki', '.java']);

// The temp folders (pure): Windows' %TEMP% and %TMP% and <home>\AppData\Local\Temp; Linux' and macOS' /tmp, /var/tmp
// and $TMPDIR (macOS' own lives under /var/folders). Only absolute ones.
/** @param {Record<string, string | undefined>} env @param {string} home @param {Platform} [plat] */
export function tempFolders(env, home, plat = PLATFORM) {
  const p = plat.path;
  const list = plat.windows ? [home ? p.join(home, 'AppData', 'Local', 'Temp') : '', envOf(env, 'TEMP'), envOf(env, 'TMP')] : ['/tmp', '/var/tmp', envOf(env, 'TMPDIR')];
  return list.map((t) => String(t || '').trim()).filter((t) => t && p.isAbsolute(t));
}

// The home folder's places programs keep their own files, never a project however a tool reports it (an editor's
// install folder, a game's save folder): Windows' <home>\AppData; Linux' ~/.local, ~/.cache, ~/.config, ~/.var
// (Flatpak) and ~/snap; macOS' ~/Library as well
/** @param {string} home @param {Platform} [plat] */
export function programDataFolders(home, plat = PLATFORM) {
  if (!home) return [];
  const p = plat.path;
  if (plat.windows) return [p.join(home, 'AppData')];
  return [...['.local', '.cache', '.config', '.var', 'snap'].map((x) => p.join(home, x)), ...(plat.mac ? [p.join(home, 'Library')] : [])];
}

// Where desktop programs keep their settings (VS Code-style editors keep their workspaces there): Windows' roaming
// application data, Linux' $XDG_CONFIG_HOME (else ~/.config), macOS' ~/Library/Application Support
/** @param {Record<string, string | undefined>} env @param {string} home @param {Platform} [plat] */
export function configRoot(env, home, plat = PLATFORM) {
  const p = plat.path;
  if (plat.windows) {
    const appData = envOf(env, 'APPDATA').trim();
    return appData && p.isAbsolute(appData) ? appData : p.join(home, 'AppData', 'Roaming');
  }
  if (plat.mac) return p.join(home, 'Library', 'Application Support');
  const xdg = envOf(env, 'XDG_CONFIG_HOME').trim();
  return isLocalAbsolute(xdg, plat) ? xdg : p.join(home, '.config');
}

// Where VS Code's command is, most likely first (the caller takes the first that exists): its per-user Windows
// installer; on Linux the distribution package, the snap and the tarball's usual place; on macOS the app's own command
/** @param {Record<string, string | undefined>} env @param {Platform} [plat] */
export function editorCandidates(env, plat = PLATFORM) {
  if (plat.windows) {
    const local = envOf(env, 'LOCALAPPDATA') || path.win32.join(envOf(env, 'USERPROFILE'), 'AppData', 'Local');
    return [path.win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')];
  }
  if (plat.mac) return ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/local/bin/code', '/opt/homebrew/bin/code'];
  return ['/usr/bin/code', '/snap/bin/code', '/usr/share/code/bin/code'];
}

// Two paths name the same file: letter case counts only where the file system tells it apart
/** @param {string} a @param {string} b @param {Platform} [plat] */
export function samePathOn(a, b, plat = PLATFORM) {
  const n = (x) => plat.path.normalize(String(x)).replace(/[\\/]+$/, '');
  return plat.caseless ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}
