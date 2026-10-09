// Plan G1: starting an AI tool on Linux and macOS: the sh launcher, where it goes, its name, and the embedded
// terminal's shell and ended mark. Pure: runs on any computer. The real start is tried on Linux itself (WSL, plan G2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOf } from '../server/platform.mjs';
import { shellLauncherText, pickLaunchDir, newLauncherName, LAUNCHER_NAME_RE } from '../server/launch.mjs';
import { terminalProgram, createTerminals } from '../electron/terminals.mjs';

const WIN = platformOf('win32');
const LINUX = platformOf('linux');
const shell = { file: '/bin/bash', args: ['-l'] };

test('the sh launcher: every path quoted, the ended mark taken first, the person\'s shell after the tool', () => {
  const r = shellLauncherText({ toolName: 'Claude Code', file: '/home/a/.local/bin/claude', args: ['--permission-mode', 'plan', 'Read .sibersentez/ilk-mesaj.md'], shell });
  assert.equal(r.ok, true);
  assert.deepEqual(r.text.split('\n'), [
    '#!/bin/sh',
    '# SiberSentez: starts Claude Code in the project folder (docs/ai-start.md). Removed after 24 hours.',
    'ended="$0.ended"',
    'PATH=\'/home/a/.local/bin\'${PATH:+:$PATH}; export PATH',
    "trap ':' INT",
    "'/home/a/.local/bin/claude' '--permission-mode' 'plan' 'Read .sibersentez/ilk-mesaj.md'",
    'trap - INT',
    ': > "$ended" 2>/dev/null',
    "exec '/bin/bash' -l",
    '',
  ]);
});

test('a quote or a Turkish letter in a folder name stays text; anything else unsafe is refused', () => {
  const cd = shellLauncherText({ toolName: 'X', file: '/t/x', args: [], cdDir: "/home/a/Oyun çalışması/it's", shell });
  assert.ok(cd.text.includes("cd -- '/home/a/Oyun çalışması/it'\\''s' || exit 1\n"));
  assert.equal(shellLauncherText({ toolName: 'X', file: 'relative/x', args: [], shell }).error, 'tool-path-unsafe');
  assert.equal(shellLauncherText({ toolName: 'X', file: '/t/x\nreboot', args: [], shell }).error, 'tool-path-unsafe');
  assert.equal(shellLauncherText({ toolName: 'X', file: '/t/x', args: ['$(reboot)'], shell }).error, 'tool-path-unsafe', 'only the fixed prompt sentence');
  assert.equal(shellLauncherText({ toolName: 'X', file: '/t/x', args: [], shell: { file: '/bin/bash', args: ['; reboot'] } }).error, 'tool-path-unsafe');
  assert.equal(shellLauncherText({ toolName: 'X', file: '/t/x', args: [], cdDir: '//server/share', shell }).error, 'folder-path-unsafe');
});

test('where the launcher goes and its name', () => {
  assert.deepEqual(pickLaunchDir(['C:\\x', '/home/a/hub/launch'], () => false, LINUX), { ok: true, mode: 'absolute', dir: '/home/a/hub/launch' });
  assert.deepEqual(pickLaunchDir(['relative'], () => false, LINUX), { ok: false });
  assert.equal(pickLaunchDir(['C:\\SiberSentez\\launch'], () => false, WIN).mode, 'absolute', 'Windows as before');
  const name = newLauncherName(() => Buffer.from('abcdef', 'utf8'), LINUX);
  assert.match(name, /^[0-9a-f]{12}\.sh$/);
  assert.match(newLauncherName(() => Buffer.from('abcdef', 'utf8'), WIN), /^[0-9a-f]{12}\.cmd$/);
  assert.ok(LAUNCHER_NAME_RE.test(name) && LAUNCHER_NAME_RE.test('abcdef012345.cmd') && !LAUNCHER_NAME_RE.test('abcdef012345.ps1'));
});

test('the embedded terminal on Linux: the person\'s shell, and the sh launcher\'s ended mark', () => {
  assert.deepEqual(terminalProgram(undefined, LINUX, { SHELL: '/usr/bin/zsh' }, () => true), { file: '/usr/bin/zsh', args: ['-l'] });
  assert.equal(terminalProgram('C:\\Windows', WIN).file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const marks = new Set();
  const timers = [];
  const m = createTerminals({
    spawn: () => ({ onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pid: 1 }),
    exists: (p) => marks.has(p),
    every: (fn, ms) => (timers.push({ fn, ms }), timers.at(-1)),
    stopEvery: () => {},
  });
  m.open({ dir: '/home/a/p', projectId: 'p1', launch: { file: '/bin/sh', args: ['/home/a/hub/launch/abcdef012345.sh'] }, tool: 'claude' });
  timers[0].fn();
  assert.equal(m.sessions()[0].running, true);
  marks.add('/home/a/hub/launch/abcdef012345.sh.ended');
  timers[0].fn();
  assert.equal(m.sessions()[0].running, false, 'the tool ended, the shell stays');
});

test('the other actions on Linux and macOS: Windows Terminal\'s refused with their own reason, the folder opens in the file manager, VS Code from its usual places', async () => {
  const { createValidators, buildArgv } = await import('../server/actionInput.mjs');
  const { editorCandidates } = await import('../server/platform.mjs');
  const MAC = platformOf('darwin');
  const v = createValidators({ catalog: { getProject: () => null }, ingest: { sessions: new Map() }, hubDir: null, codeExe: '/usr/bin/code', appCwd: '/', plat: LINUX });
  for (const action of ['terminal', 'resume', 'fork', 'new']) {
    const body = action === 'terminal' ? { action, projectId: 'p' } : action === 'new' ? { action, projectId: 'p' } : { action, sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100' };
    const r = v.validate(body);
    assert.deepEqual([r.ok, r.status, r.body?.error], [false, 501, 'windows-terminal-only'], action);
  }
  assert.deepEqual(buildArgv('explorer', { dir: '/home/a/p' }, LINUX), ['/usr/bin/xdg-open', '/home/a/p']);
  assert.deepEqual(buildArgv('explorer', { dir: '/Users/a/p', file: '/Users/a/p/index.html' }, MAC), ['/usr/bin/open', '/Users/a/p/index.html']);
  assert.deepEqual(buildArgv('explorer', { dir: 'C:\\p' }, WIN), ['explorer.exe', '"C:\\p"'], 'Windows as before');
  assert.equal(editorCandidates({}, LINUX)[0], '/usr/bin/code');
  assert.match(editorCandidates({}, MAC)[0], /Visual Studio Code\.app/);
  assert.equal(editorCandidates({ LOCALAPPDATA: 'C:\\L' }, WIN)[0], 'C:\\L\\Programs\\Microsoft VS Code\\Code.exe');
});

test('an option with a quote in it stays one quoted argument (review G: options were written bare)', () => {
  const r = shellLauncherText({ toolName: 'X', file: '/t/x', args: ["-p 'a"], shell });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes(String.raw`'/t/x' '-p '\''a'`), r.text);
});

test('review G round 2: an empty PATH gets no empty entry; a tool folder with a colon leaves PATH alone', () => {
  const r = shellLauncherText({ toolName: 'X', file: '/t:a/x', args: [], shell });
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes('PATH='), r.text);
});
