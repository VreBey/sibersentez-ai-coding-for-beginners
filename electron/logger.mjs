// @ts-check
// Size-capped, rotating plain-text log. Never imports Electron (tests run it with plain Node).
// When <name>.log would exceed the cap it becomes <name>.1.log (the older one is deleted), so a log never
// takes more than about 2 × maxBytes. The user's home folder is replaced with '~'; no secrets or environment
// variables are written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactHome } from './helpers.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_LINE = 4000;

export function createLogger({ dir, name, maxBytes = DEFAULT_MAX_BYTES, homeDir = os.homedir(), now = () => new Date() }) {
  const file = path.join(dir, `${name}.log`);
  const rotated = path.join(dir, `${name}.1.log`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* if the folder cannot be created, writes are dropped silently; logging never stops the app */
  }

  function write(message) {
    let line = redactHome(String(message ?? ''), homeDir).replace(/\r?\n+$/, '');
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} ...(truncated)`;
    const text = `${now().toISOString()} ${line}\n`;
    try {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
        fs.rmSync(rotated, { force: true });
        fs.renameSync(file, rotated);
      }
      fs.appendFileSync(file, text, 'utf8');
    } catch {
      /* the log could not be written: swallow */
    }
  }

  return { file, rotated, write };
}
