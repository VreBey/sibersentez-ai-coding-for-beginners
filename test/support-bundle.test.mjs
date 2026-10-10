// The support bundle (docs/internal/support-bundle-plan.md): Settings → Help shows the diagnostic info, the hub's
// settings.json and the last log lines in one text, masked by the shell, before it is copied or saved. Nothing is sent
// anywhere. Run: node --test test/support-bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskLine, tailLines, maskSettings, supportParts, supportSaveRequest, supportFileName, SUPPORT_PARTS_IPC_CHANNEL, SUPPORT_SAVE_IPC_CHANNEL, SUPPORT_TEXT_MAX, SUPPORT_LOG_LINES } from '../electron/support-bundle.mjs';
import { supportBundleText, supportPreviewHtml } from '../public/js/supportBundle.js';
import { settingsHtml } from '../public/js/views/settings.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const HOME = String.raw`C:\Users\Ayşe`;
const ORIGIN = 'http://127.0.0.1:47700';
const PANEL = { mainWindow: true, frame: { top: true, url: `${ORIGIN}/?lang=tr` }, origin: ORIGIN };

test('a log line: keys and e-mail masked, the home folder ~, every folder path <path> whole (to its quote or the line end); addresses, versions and the default hub stay', () => {
  assert.equal(maskLine(String.raw`hub: C:\Users\Ayşe\SiberSentez · already present`, HOME), String.raw`hub: ~\SiberSentez · already present`);
  assert.equal(maskLine(String.raw`hub: C:\Users\Ayşe\SiberSentez`, HOME), String.raw`hub: ~\SiberSentez`);
  assert.equal(maskLine(String.raw`opened C:\Users\Ayşe\SiberSentez Projelerim\kafe`, HOME), 'opened <path>', 'a folder that only starts like the hub is masked');
  assert.equal(maskLine(String.raw`opened C:\Users\ayşe\Desktop\Kafe Menüsü`, HOME), 'opened <path>', 'the home folder in any letter case; a name with a space is masked whole');
  assert.equal(maskLine(String.raw`copied D:\My Projects\Client Secret App\src, 3 files`, HOME), 'copied <path>', 'an unquoted path runs on to the end of the line');
  assert.equal(maskLine(String.raw`ENOENT: no such file or directory, open 'C:\Users\Ayşe\Desktop\Yeni klasör (2)\kafe\plan.md'`, HOME), "ENOENT: no such file or directory, open '<path>'", 'Windows names a second folder "(2)"');
  assert.equal(maskLine(String.raw`EPERM: rename 'D:\Ayşe'nin Ödevi\a.tmp' -> 'D:\Müşteri [Acme]\site\index.html'`, HOME), "EPERM: rename '<path>' -> '<path>'", 'apostrophes and brackets inside quoted paths');
  assert.equal(maskLine(String.raw`at load (D:\Work\App(1)\src\a.js:12:5)`, HOME), 'at load (<path>');
  assert.equal(maskLine(String.raw`the folder "D:\Acme Corp\x" is gone`, HOME), 'the folder "<path>" is gone');
  assert.equal(maskLine(String.raw`share \\nas\team\menu: here`, HOME), 'share <path>');
  assert.equal(maskLine('read /home/ayse/my shop · /Users/ayse/x', HOME), 'read <path> · <path>');
  assert.equal(maskLine('mail ayse.yilmaz@example.com.tr, ok', HOME), 'mail <email>, ok');
  assert.equal(maskLine("open '/run/media/ali/USB Disk/Client/x'", HOME), "open '<path>'", 'Linux removable drives');
  assert.equal(maskLine('see file:///mnt/data/Client/x', HOME), 'see file://<path>');
  assert.equal(maskLine(String.raw`opened C:\Users\Ayşe\SiberSentez'nin Kopyası\kafe`, HOME), 'opened <path>', 'only the hub itself stays');
  assert.equal(maskLine(String.raw`opened C:\Users\Ayşe\SiberSentez, Eski\kafe`, HOME), 'opened <path>');
  assert.equal(maskLine(String.raw`hub overlaps the program folder; skeleton not created · C:\Users\Ayşe\x · C:\Program Files\SiberSentez`, HOME), 'hub overlaps the program folder; skeleton not created · <path> · <path>', 'the shell\'s line keeps its words');
  assert.equal(maskLine('node-pty@1.0.0 electron@44.7.0', HOME), 'node-pty@1.0.0 electron@44.7.0', 'a package@version is not an address');
  assert.equal(maskLine('server ready: http://127.0.0.1:47700/api/snapshot · pid 1234', HOME), 'server ready: http://127.0.0.1:47700/api/snapshot · pid 1234');
  assert.equal(maskLine('[action] start-ai x-#6d54ccab 200 live', HOME), '[action] start-ai x-#6d54ccab 200 live');
  const key = maskLine('env ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', HOME);
  assert.ok(!key.includes('abcdefghijklmnop'), key);
  assert.ok(maskLine('x'.repeat(2000), HOME).length < 600, 'cut');
  assert.equal(maskLine('a\u0000b\u001bc', HOME), 'a b c');
});

test('the tail: at most the line limit and the byte cap; a line cut by the start is dropped; a missing file is null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  try {
    const f = path.join(dir, 'main.log');
    fs.writeFileSync(f, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const all = tailLines(f);
    assert.equal(all.lines.length, SUPPORT_LOG_LINES);
    assert.equal(all.lines.at(-1), 'line 499');
    assert.equal(all.cut, true);
    const small = tailLines(f, { maxLines: 1000, maxBytes: 20 });
    assert.deepEqual(small.lines, ['line 498', 'line 499'], 'the first, cut line is dropped');
    fs.writeFileSync(f, 'one\r\ntwo\r\n');
    assert.deepEqual(tailLines(f), { lines: ['one', 'two'], cut: false });
    assert.equal(tailLines(path.join(dir, 'none.log')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings.json: known keys keep a plain value, others are listed without it; missing and broken files are said', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  try {
    assert.equal(maskSettings(null), '(no hub folder)');
    assert.equal(maskSettings(dir), '(settings.json is not there)');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
    assert.equal(maskSettings(dir), '(settings.json is not valid JSON)');
    fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ version: 1, language: 'tr', actions: 'live', theme: String.raw`C:\Users\x`, token: 'abc', 'C:\\odd key': 1 }));
    assert.equal(maskSettings(dir), 'version: 1\nlanguage: tr\nactions: live\ntheme: (set, value hidden)\ntoken: (set, value hidden)\n(1 other key, names hidden)');
    const parts = supportParts({ logDir: path.join(dir, 'logs'), hubDir: dir, homeDir: HOME });
    assert.equal(parts.ok, true);
    assert.deepEqual(parts.logs.map((l) => [l.name, l.missing]), [['main.log', true], ['server.log', true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page text: the diagnostic info, the settings and each log with how much of it; odd parts are left out', () => {
  const text = supportBundleText({ diagnostics: 'SiberSentez 0.18.1', parts: { ok: true, settings: 'language: tr', logs: [{ name: 'main.log', lines: ['a', 'b'], cut: true }, { name: 'server.log', lines: [], missing: true }, { name: '../x', lines: ['no'] }, { name: 'one.log', lines: ['z', 5] }] } });
  assert.match(text, /^SiberSentez support bundle\n/);
  assert.match(text, /== Diagnostic info ==\nSiberSentez 0\.18\.1\n/);
  assert.match(text, /== settings\.json \(masked\) ==\nlanguage: tr\n/);
  assert.match(text, /== main\.log: the last 2 lines, older ones left out ==\na\nb\n/);
  assert.match(text, /== server\.log: not there ==/);
  assert.match(text, /== one\.log: the last 1 line ==\nz$/);
  assert.ok(!text.includes('../x') && !text.includes('\nno'));
  assert.match(supportBundleText(), /\(not available\)[\s\S]*\(not read\)/);
});

test('Settings: the row only in the desktop app; the preview in both languages, escaped, with Copy, Save and Close', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      for (const k of ['setBundleTitle', 'setBundleText', 'setBundleOpen', 'setBundleLoading', 'setBundleFailed', 'setBundleCheck', 'setBundleNote', 'setBundleLabel', 'setBundleCopy', 'setBundleSave', 'setBundleClose', 'setBundleCopied', 'setBundleSaved', 'setBundleSaveFailed']) assert.ok(S[k], `${lang} ${k}`);
      assert.ok(!settingsHtml({ lang }).includes('data-set-act="bundle"'), 'a browser has no logs to read');
      assert.ok(settingsHtml({ lang, canBundle: true }).includes('data-set-act="bundle"'));
      const ready = settingsHtml({ lang, canBundle: true, bundle: { step: 'ready', text: '<b>x</b>' } });
      assert.ok(ready.includes('&lt;b&gt;x&lt;/b&gt;</textarea>') && ready.includes('readonly'));
      for (const act of ['bundle-copy', 'bundle-save', 'bundle-close']) assert.ok(ready.includes(`data-set-act="${act}"`), act);
      assert.ok(ready.includes(S.setBundleCheck));
      assert.ok(supportPreviewHtml({ step: 'loading' }).includes('role="status"'));
      const failed = supportPreviewHtml({ step: 'failed' });
      assert.ok(failed.includes(S.setBundleFailed) && failed.includes('bundle-close') && !failed.includes('bundle-copy'));
      assert.equal(supportPreviewHtml(null), '');
    }
  } finally {
    setLanguage('en');
  }
});

test('the bridge: only our own page; the text bounded; the file name; the shell reads its own files, never a page path', () => {
  assert.deepEqual(supportSaveRequest({ text: 'x', ...PANEL }), { ok: true, text: 'x' });
  assert.equal(supportSaveRequest({ text: 'x', ...PANEL, mainWindow: false }).ok, false);
  assert.equal(supportSaveRequest({ text: 'x', ...PANEL, frame: { top: true, url: 'https://example.com/' } }).ok, false);
  assert.equal(supportSaveRequest({ text: '', ...PANEL }).reason, 'invalid');
  assert.equal(supportSaveRequest({ text: 'x'.repeat(SUPPORT_TEXT_MAX + 1), ...PANEL }).reason, 'invalid');
  assert.equal(supportSaveRequest({ text: 5, ...PANEL }).reason, 'invalid');
  assert.equal(supportFileName(new Date(2026, 9, 3)), 'SiberSentez-support-2026-10-03.txt');
  const preload = read('electron/preload.cjs');
  assert.ok(preload.includes(`const SUPPORT_PARTS_CHANNEL = '${SUPPORT_PARTS_IPC_CHANNEL}';`) && preload.includes(`const SUPPORT_SAVE_CHANNEL = '${SUPPORT_SAVE_IPC_CHANNEL}';`) && preload.includes(`const SUPPORT_TEXT_MAX = ${SUPPORT_TEXT_MAX / 1024} * 1024;`));
  assert.ok(preload.includes('return ipcRenderer.invoke(SUPPORT_PARTS_CHANNEL);') && preload.includes('return ipcRenderer.invoke(SUPPORT_SAVE_CHANNEL, text);'));
  const main = read('electron/main.mjs');
  assert.ok(main.includes('ipcMain.handle(SUPPORT_PARTS_IPC_CHANNEL, onSupportParts);') && main.includes('ipcMain.handle(SUPPORT_SAVE_IPC_CHANNEL, onSupportSave);'));
  assert.ok(main.includes('return supportParts({ logDir: LOG_DIR, hubDir: state.hubPath, homeDir: HOME_DIR });'), 'the shell\'s own folders');
  assert.ok(main.includes('await dialog.showSaveDialog(win, {'), 'through the guarded dialog: a hidden QA run never shows it');
  assert.ok(!/log\(`support bundle[^`]*\$\{pick/.test(main), 'the log never names the file');
});
