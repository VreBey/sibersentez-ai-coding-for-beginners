// @ts-check
// node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, so every terminal fails there with
// "posix_spawnp failed" (seen in the macOS CI, 2026-10-09). Run after npm install (package.json "postinstall"): on
// macOS it gives each prebuilt spawn-helper its execute bit back; elsewhere it does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} root @param {string} platform @returns {string[]} the helpers made executable */
export function fixPtyMode(root = ROOT, platform = process.platform) {
  if (platform !== 'darwin') return [];
  const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
  const fixed = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'));
  } catch {
    return fixed;
  }
  for (const d of dirs) {
    const helper = path.join(prebuilds, d, 'spawn-helper');
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, mode | 0o755);
        fixed.push(helper);
      }
    } catch {
      // no helper in this build: nothing to do
    }
  }
  return fixed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of fixPtyMode()) console.log(`node-pty: execute bit set on ${path.relative(ROOT, f)}`);
}
