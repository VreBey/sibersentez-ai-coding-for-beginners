// @ts-check
// Writing a file so that a reader, a crash or a full disk never meets half of it (review A3). The text goes to a new
// temporary file next to the target ('wx': never an existing file, never a link left there), is flushed to the disk,
// and then takes the target's place in a single rename. On Windows an antivirus or a search indexer may hold the
// target for a moment: the rename is tried again a few times (EPERM, EBUSY, EACCES) before it gives up. On failure the
// temporary file is removed and the error is thrown; the target is left as it was. Only node: modules, so the desktop
// shell uses it too.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const RENAME_TRIES = 4;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
// A short synchronous pause (25, 50, 75 ms): the callers are synchronous, and the lock usually lasts a moment
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameRetrying(from, to, { fsImpl = fs, tries = RENAME_TRIES, wait = pause } = {}) {
  for (let i = 1; ; i++) {
    try {
      return fsImpl.renameSync(from, to);
    } catch (e) {
      if (i >= tries || !BUSY.has(e?.code)) throw e;
      wait(25 * i);
    }
  }
}

// A temporary name next to the file, never the same twice
const tempName = (file) => `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;

// tmp: a caller's own temporary name (a cleanup elsewhere may know its pattern); fsImpl and wait: for tests
export function writeFileAtomic(file, data, { fsImpl = fs, tmp = tempName(file), wait = pause } = {}) {
  try {
    fsImpl.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx', flush: true });
    renameRetrying(tmp, file, { fsImpl, wait });
  } catch (e) {
    // EEXIST: the name was taken before this write ('wx'), so the file there is not ours to remove
    if (e?.code !== 'EEXIST') {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {
        /* a leftover temporary file is harmless; the target is untouched */
      }
    }
    throw e;
  }
}
