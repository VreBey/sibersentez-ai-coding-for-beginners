// The launcher in a real Command Prompt (Windows only): when its tool returns, it leaves its ended mark next to itself
// (docs/embedded-terminal.md, "The tool ended, the shell stays"), also when it changed to a project folder with a
// space in its name first, and also when the tool could not start at all. Nothing lands in the project.
// Run: node --test test/launcher-cmd.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launcherText, launchPrompt, ENDED_SUFFIX, cleanupLaunchers } from '../server/launch.mjs';

const WIN = process.platform === 'win32';
const ROOT = WIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'ss-launcher-cmd-')) : null;
after(() => ROOT && fs.rmSync(ROOT, { recursive: true, force: true }));
const CMD = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '';

// Runs the launcher as the dock's fallback way does (relative to the launcher folder), but with /c so it returns
function run(launchDir, name) {
  try {
    execFileSync(CMD, ['/d', '/v:off', '/c', `.\\${name}`], { cwd: launchDir, stdio: 'ignore', timeout: 20000, windowsHide: true });
  } catch {
    // the tool's own exit code is not this test's question
  }
}

test('a tool that returns: the mark is next to the launcher, the project folder (with a space) stays empty', { skip: !WIN && 'Windows only' }, () => {
  const launchDir = path.join(ROOT, 'launch-a');
  fs.mkdirSync(launchDir);
  const project = path.join(ROOT, 'my project a');
  fs.mkdirSync(project);
  // where.exe stands in for an AI tool: it gets the quoted prompt, finds no such file and returns at once
  const tool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  const lt = launcherText({ toolName: 'Test Tool', file: tool, ext: '.exe', args: [launchPrompt('ilk-mesaj.md')], cdDir: project, env: { USERPROFILE: os.homedir() } });
  assert.equal(lt.ok, true, JSON.stringify(lt));
  const name = 'aaaaaaaaaaa1.cmd';
  fs.writeFileSync(path.join(launchDir, name), lt.text, 'ascii');
  run(launchDir, name);
  assert.ok(fs.existsSync(path.join(launchDir, name + ENDED_SUFFIX)), `the mark is there (${fs.readdirSync(launchDir).join(', ')}) in ${launchDir}`);
  assert.deepEqual(fs.readdirSync(project), [], 'nothing in the project');
});

test('a tool that cannot start: the line fails, the mark still comes (nothing runs in the tab)', { skip: !WIN && 'Windows only' }, () => {
  const launchDir = path.join(ROOT, 'launch-b');
  fs.mkdirSync(launchDir);
  // The home folder by its variable, as the app writes it (a user name with letters like ş stays out of the file)
  const lt = launcherText({ toolName: 'Missing', file: path.join(ROOT, 'no-such-tool', 'tool.exe'), ext: '.exe', args: [], env: { USERPROFILE: os.homedir(), LOCALAPPDATA: process.env.LOCALAPPDATA } });
  assert.equal(lt.ok, true, JSON.stringify(lt));
  const name = 'bbbbbbbbbbb2.cmd';
  fs.writeFileSync(path.join(launchDir, name), lt.text, 'ascii');
  run(launchDir, name);
  assert.ok(fs.existsSync(path.join(launchDir, name + ENDED_SUFFIX)));
  // Both go after a day
  const old = Date.now() - 25 * 3600 * 1000;
  for (const f of [name, name + ENDED_SUFFIX]) fs.utimesSync(path.join(launchDir, f), new Date(old), new Date(old));
  assert.equal(cleanupLaunchers(launchDir), 2);
  assert.deepEqual(fs.readdirSync(launchDir), []);
});
