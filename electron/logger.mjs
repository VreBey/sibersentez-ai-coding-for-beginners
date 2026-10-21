// @ts-check
// Size-capped, rotating plain-text log. Never imports Electron (tests run it with plain Node).
// When <name>.log would exceed the cap it becomes <name>.1.log (the older one is deleted), so a log never
// takes more than about 2 × maxBytes. The user's home folder is replaced with '~'; no secrets or environment
// variables are written.
// buffered: the lines are kept in memory and written together once the current task is done (setImmediate), or at
// once past BUFFER_BYTES; flush() writes them now. The server's output comes line by line into the window's main
// process, where a file look and a write per line would hold it (independent review 2026-10-20, T11). The file's size
// is kept in memory, looked up once when the log is made and again after a failed write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactHome } from './helpers.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_LINE = 4000;
export const BUFFER_BYTES = 64 * 1024;

export function createLogger({ dir, name, maxBytes = DEFAULT_MAX_BYTES, homeDir = os.homedir(), now = () => new Date(), buffered = false, schedule = setImmediate }) {
  const file = path.join(dir, `${name}.log`);
  const rotated = path.join(dir, `${name}.1.log`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* if the folder cannot be created, writes are dropped silently; logging never stops the app */
  }
  const sizeNow = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  let size = sizeNow();
  let pending = [];
  let pendingBytes = 0;
  let scheduled = false;

  // One piece of text into the file: rotated first when it would pass the cap
  function append(text) {
    const bytes = Buffer.byteLength(text);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        fs.rmSync(rotated, { force: true });
        fs.renameSync(file, rotated);
        size = 0;
      }
      fs.appendFileSync(file, text, 'utf8');
      size += bytes;
    } catch {
      /* the log could not be written: swallow, and look at the file again next time */
      size = sizeNow();
    }
  }

  // The kept lines, each group under the cap written as one piece
  function flush() {
    scheduled = false;
    const lines = pending;
    pending = [];
    pendingBytes = 0;
    let chunk = '';
    for (const text of lines) {
      if (chunk && size + Buffer.byteLength(chunk) + Buffer.byteLength(text) > maxBytes) {
        append(chunk);
        chunk = '';
      }
      chunk += text;
    }
    if (chunk) append(chunk);
  }

  function write(message) {
    let line = redactHome(String(message ?? ''), homeDir).replace(/\r?\n+$/, '');
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} ...(truncated)`;
    const text = `${now().toISOString()} ${line}\n`;
    if (!buffered) return append(text);
    pending.push(text);
    pendingBytes += Buffer.byteLength(text);
    if (pendingBytes >= BUFFER_BYTES) return flush();
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  }

  return { file, rotated, write, flush };
}
