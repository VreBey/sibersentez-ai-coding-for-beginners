// One way to write a file whole (review A3, server/atomic.mjs): a new temporary file, flushed, then one rename that is
// tried again while Windows holds the target for a moment. Run: node --test test/atomic.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENAME_TRIES, writeFileAtomic } from '../server/atomic.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-atomic-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const fresh = (text = null) => {
  const dir = path.join(TMP, `c${++n}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'state.json');
  if (text !== null) fs.writeFileSync(file, text);
  return { dir, file };
};
const boom = (code) => Object.assign(new Error(code), { code });
// The real file system, with a rename that fails `times` times with `code` first
const flaky = (code, times) => {
  let left = times;
  const calls = [];
  return {
    calls,
    fsImpl: {
      writeFileSync: (p, d, o) => {
        calls.push(['write', path.basename(p), o]);
        return fs.writeFileSync(p, d, o);
      },
      renameSync: (a, b) => {
        calls.push(['rename']);
        if (left-- > 0) throw boom(code);
        return fs.renameSync(a, b);
      },
      rmSync: (...a) => fs.rmSync(...a),
    },
  };
};

test('the whole text, flushed, through a new temporary file; nothing left beside it', () => {
  const { dir, file } = fresh('old\n');
  const f = flaky('EPERM', 0);
  writeFileAtomic(file, '{"a":1}\n', { fsImpl: f.fsImpl, tmp: path.join(dir, 'state.json.x.tmp') });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(f.calls, [['write', 'state.json.x.tmp', { encoding: 'utf8', flag: 'wx', flush: true }], ['rename']]);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  writeFileAtomic(file, 'second\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second\n', 'the real file system, with its own temporary name');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('a target held for a moment (EPERM, EBUSY, EACCES): the rename is tried again with short pauses, then it works', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const { dir, file } = fresh('old\n');
    const f = flaky(code, RENAME_TRIES - 1);
    const waits = [];
    writeFileAtomic(file, 'new\n', { fsImpl: f.fsImpl, wait: (ms) => waits.push(ms) });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', code);
    assert.deepEqual(waits, [25, 50, 75], code);
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], code);
  }
});

test('held for too long, or another error: thrown; the target as it was; the temporary file removed; no pause for a real error', () => {
  const held = fresh('old\n');
  const f = flaky('EBUSY', RENAME_TRIES);
  const waits = [];
  assert.throws(() => writeFileAtomic(held.file, 'new\n', { fsImpl: f.fsImpl, wait: (ms) => waits.push(ms) }), { code: 'EBUSY' });
  assert.equal(f.calls.filter((c) => c[0] === 'rename').length, RENAME_TRIES);
  assert.equal(fs.readFileSync(held.file, 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(held.dir), ['state.json']);

  const other = fresh('old\n');
  const g = flaky('EXDEV', 1);
  const none = [];
  assert.throws(() => writeFileAtomic(other.file, 'new\n', { fsImpl: g.fsImpl, wait: (ms) => none.push(ms) }), { code: 'EXDEV' });
  assert.deepEqual(none, [], 'not a lock: no retry');
  assert.deepEqual(fs.readdirSync(other.dir), ['state.json']);

  const full = fresh('old\n');
  const fsImpl = {
    writeFileSync: (p, d, o) => {
      fs.writeFileSync(p, String(d).slice(0, 2), o); // a cut temporary file, as a full disk leaves it
      throw boom('ENOSPC');
    },
    renameSync: () => assert.fail('never renamed'),
    rmSync: (...a) => fs.rmSync(...a),
  };
  assert.throws(() => writeFileAtomic(full.file, 'new\n', { fsImpl }), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(full.file, 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(full.dir), ['state.json']);
});

test("a file already at the temporary name is never written through ('wx')", () => {
  const { dir, file } = fresh('old\n');
  const tmp = path.join(dir, 'state.json.taken.tmp');
  fs.writeFileSync(tmp, 'someone else\n');
  assert.throws(() => writeFileAtomic(file, 'new\n', { tmp }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
  assert.equal(fs.readFileSync(tmp, 'utf8'), 'someone else\n', 'the file that was there is not ours to remove');
});
