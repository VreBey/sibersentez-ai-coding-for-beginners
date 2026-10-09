// Plan G2: "Start at login" on Linux is a .desktop file in ~/.config/autostart (electron/autostart.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autostartDir, autostartEntry, readAutostart, writeAutostart, AUTOSTART_FILE } from '../electron/autostart.mjs';

test('the folder: $XDG_CONFIG_HOME/autostart, else ~/.config/autostart; nothing without an absolute home', () => {
  assert.equal(autostartDir({ HOME: '/home/a' }), '/home/a/.config/autostart');
  assert.equal(autostartDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/cfg' }), '/cfg/autostart');
  assert.equal(autostartDir({ HOME: 'relative' }), '');
  assert.equal(autostartDir({}), '');
});

test('the entry: the program and its arguments quoted as the spec wants; an AppImage starts from its own file', () => {
  const text = autostartEntry({ exe: '/opt/SiberSentez/sibersentez', args: ['--hidden'] });
  assert.ok(text.startsWith('[Desktop Entry]\nType=Application\nName=SiberSentez\n'));
  assert.match(text, /^Exec="\/opt\/SiberSentez\/sibersentez" "--hidden"$/m);
  assert.match(autostartEntry({ exe: '/tmp/.mount_x/sibersentez', args: ['--hidden'], appImage: '/home/a/Apps/SiberSentez.AppImage' }), /^Exec="\/home\/a\/Apps\/SiberSentez\.AppImage" "--hidden"$/m);
  assert.ok(autostartEntry({ exe: '/home/a/my "$x" app/run', args: [] }).includes(String.raw`Exec="/home/a/my \\"\\$x\\" app/run"`), 'escaped inside the quotes, then the backslashes doubled');
  assert.ok(autostartEntry({ exe: '/home/a/100% app/run', args: [] }).includes('Exec="/home/a/100%% app/run"'), '% is a field code');
  assert.equal(autostartEntry({ exe: 'relative', args: [] }), null);
  assert.equal(autostartEntry({ exe: '/a/b', args: ['x\nExec=evil'] }), null, 'a line break never adds a line');
});

test('on writes the file, off removes it, and reading says which', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-autostart-'));
  try {
    // A POSIX home is needed for the rule; the temp folder stands in through XDG_CONFIG_HOME on Windows too
    const cfg = home.split(path.sep).join('/');
    const env = { HOME: '/home/a', XDG_CONFIG_HOME: cfg.startsWith('/') ? cfg : `/${cfg}` };
    const posixFs = {
      ...fs,
      lstatSync: (p) => fs.lstatSync(toLocal(p)),
      rmSync: (p, o) => fs.rmSync(toLocal(p), o),
      mkdirSync: (p, o) => fs.mkdirSync(toLocal(p), o),
      writeFileSync: (p, t, o) => fs.writeFileSync(toLocal(p), t, o),
    };
    function toLocal(p) {
      return process.platform === 'win32' ? p.replace(/^\//, '') : p;
    }
    assert.equal(readAutostart(env, posixFs), false);
    assert.equal(writeAutostart(true, { env, exe: '/opt/s/sibersentez', args: ['--hidden'], xfs: posixFs }), true);
    assert.equal(readAutostart(env, posixFs), true);
    assert.match(fs.readFileSync(path.join(home, 'autostart', AUTOSTART_FILE), 'utf8'), /Exec="\/opt\/s\/sibersentez" "--hidden"/);
    assert.equal(writeAutostart(false, { env, exe: '/opt/s/sibersentez', xfs: posixFs }), true);
    assert.equal(readAutostart(env, posixFs), false);
    assert.equal(writeAutostart(true, { env: {}, exe: '/opt/s/x' }), false, 'no home: not done');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
