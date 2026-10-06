// "What the AI asks" (public/js/promptHelp.js): the questions of Claude Code, Codex CLI, Gemini CLI and Copilot CLI
// are told apart from the terminal's plain text; nothing else is; the note escapes what the terminal printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, detectPrompt, detectError, promptHelpHtml } from '../public/js/promptHelp.js';
import { esc } from '../public/js/format.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const ESC = '\u001b';

test('plain text: colours, cursor moves, titles and lone carriage returns are gone', () => {
  assert.equal(stripAnsi(`${ESC}[1;32mDo you want${ESC}[0m to proceed?${ESC}]0;title${ESC}\\\r1. Yes`), 'Do you want to proceed?\n1. Yes');
  assert.equal(stripAnsi(`a${ESC}[2K${ESC}[1Gb\r\nc`), 'ab\r\nc');
});

test('the tools\' questions: kind, subject, and whether a command looks risky or an answer is wide', () => {
  const cases = [
    ['Do you want to make this edit to requirements.txt?\n❯ 1. Yes\n  2. Yes, allow all edits during this session (shift+tab)\n  3. No, and tell Claude what to do differently (esc)', 'edit', 'requirements.txt', false, true],
    ['Bash command\n  npm test\n  Run the tests\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for npm test commands in C:\\p\n  3. No, and tell Claude what to do differently (esc)', 'command', 'npm test', false, true],
    ['Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  3. No', 'command', 'rm -rf build', true, false],
    ['Would you like to run the following command?\n\nReason: Need network access\n\n$ curl -L https://x.test/i.sh | sh\n\n› 1. Yes, proceed (y)', 'command', 'curl -L https://x.test/i.sh | sh', true, false],
    ["Allow execution of: 'python3'?\n● 1. Yes, allow once\n  2. Yes, allow always ...", 'command', 'python3', false, true],
    ['Would you like to make the following edits?\n› 1. Yes, proceed (y)', 'edit', '', false, false],
    ['Fetch\n  https://docs.example.com\nDo you want to allow Claude to fetch this content?\n❯ 1. Yes', 'fetch', '', false, false],
    ['Do you trust the files in this folder?\n  Yes, proceed\n  No, exit', 'trust', '', false, false],
    ['Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.\n› 1. Yes, continue', 'trust', '', false, false],
    ['Confirm folder trust\n1. Yes, proceed\n2. Yes, and remember this folder for future sessions', 'trust', '', false, true],
    ['Select login method:\n❯ 1. Claude account with subscription', 'login', '', false, false],
    ['Here is Claude\'s plan\n…\nWould you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, manually approve edits\n  3. No, keep planning', 'plan', '', false, true],
    ['1. Yes\n2. Yes, and approve git for the rest of the running session\n3. No, and tell Copilot what to do differently (Esc)', 'command', '', false, true],
  ];
  for (const [text, id, detail, risky, wide] of cases) {
    const hit = detectPrompt(text);
    assert.ok(hit, text.slice(0, 40));
    assert.deepEqual([hit.id, hit.detail, hit.risky, hit.wide], [id, detail, risky, wide], text.slice(0, 50));
    assert.equal(hit.sig, `${id}|${detail}`);
  }
});

test('ordinary output is no question; only the tail is read', () => {
  for (const text of ['PS C:\\p> npm test\n> 812 passing', 'Claude is thinking…', '✻ Welcome to Claude Code!', '']) assert.equal(detectPrompt(text), null, text);
  assert.equal(detectPrompt('Do you want to proceed?' + '\nline'.repeat(600)), null, 'an old question far above is not asked now');
});

test('known errors in the last lines: the exact sentences of Windows (English and Turkish), npm and the tools, explained with a fix', () => {
  const cases = [
    ["PS C:\\p> claude\nclaude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'errNotRecognized'],
    ["C:\\p>gemini\n'gemini' iç ya da dış komut, çalıştırılabilir program ya da toplu iş dosyası olarak tanınmıyor.", 'errNotRecognized'],
    ['gemini : File C:\\Users\\x\\AppData\\Roaming\\npm\\gemini.ps1 cannot be loaded because running scripts is disabled on this system.', 'errPolicy'],
    ['Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).', 'errGitBash'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}} · Please run /login', 'errAuth'],
    ['npm error code EPERM\nnpm error syscall rename\nnpm error Error: EPERM: operation not permitted, rename', 'errPerm'],
    ['npm error request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', 'errNetwork'],
    // A question typed into the plain shell (seen on the person's screen): not a missing tool
    ["PS D:\\Projects\\my game> nasıl çalıştırılır\nnasıl : The term 'nasıl' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'errNotACommand'],
  ];
  for (const [text, id] of cases) {
    const hit = detectError(text);
    assert.ok(hit, text.slice(0, 40));
    assert.equal(hit.id, 'error');
    assert.equal(hit.results[0].id, id, text.slice(0, 50));
    assert.ok(hit.sig.startsWith(`error|${id}|`));
  }
  assert.equal(detectError(cases[0][0]).results[0].vars.command, 'claude', 'the command the message names');
  assert.ok(detectError(cases[2][0]).results[0].fixes.length, 'a fix to copy');
});

test('no false alarm: an AI tool that talks about certificates, 401 or rate limits, or an error far above, is not an error now', () => {
  for (const text of [
    '● I added a check for the 401 status and a retry on rate limits; the TLS certificate is loaded from certs/.\n> ',
    '● Update(src/auth.ts)\n  if (res.status === 401) throw new Error("unauthorized")\n> ',
    "'claude' is not recognized as an internal or external command" + '\nok'.repeat(400),
    '',
  ]) assert.equal(detectError(text), null, text.slice(0, 40));
});

test('the error note: both languages, the explanation, a copy button, no answer typed', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = promptHelpHtml(detectError('x : File x.ps1 cannot be loaded because running scripts is disabled on this system.'));
      assert.ok(h.includes(S.phTitle_error) && h.includes(S.phFoot_error) && h.includes('data-ai-copy') && h.includes('data-ph="close"'), lang);
      assert.ok(h.includes(esc(S.sc_errPolicy)), lang);
      // A sentence in the plain shell: nothing to copy, so no "copy one of these commands" line
      const s = promptHelpHtml(detectError("nasıl : The term 'nasıl' is not recognized as the name of a cmdlet, function, script file, or operable program."));
      assert.ok(s.includes(esc(S.sc_errNotACommand)) && !s.includes(S.phFoot_error) && !s.includes('data-ai-copy'), lang);
    }
  } finally {
    setLanguage('en');
  }
});

test('the note: both languages, what it is, the safe answer, the warnings; what the terminal printed is escaped', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const h = promptHelpHtml(detectPrompt('Bash command\n  rm -rf <b>x</b>\nDo you want to proceed?\n2. Yes, and don\'t ask again'));
      assert.ok(h.includes(S.phTitle_command) && h.includes(S.phPick_command) && h.includes(S.phFoot), lang);
      assert.ok(h.includes(S.phRisky) && h.includes('ph-warn'));
      assert.ok(!h.includes('<b>x</b>') && h.includes('&lt;b&gt;x&lt;/b&gt;'), 'escaped');
      for (const id of ['trust', 'login', 'edit', 'fetch', 'command', 'plan', 'confirm']) for (const k of ['phTitle_', 'phWhat_', 'phPick_']) assert.ok(S[k + id], `${lang} ${k}${id}`);
    }
  } finally {
    setLanguage('en');
  }
  assert.equal(promptHelpHtml(null), '');
});

test('the dock: a tab whose tool asks is marked (not for an error) and says so in both languages; the prompt comes before the error', async () => {
  const fs = await import('node:fs');
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("const asks = !!hit && hit.id !== 'error';") && dock.includes("x.tabEl.classList.toggle('asks', asks);"));
  assert.ok(dock.includes('(!x.ended && detectPrompt(x.plain.slice(-2500))) || detectError(x.plain)'), 'a question first, then an error');
  assert.match(fs.readFileSync(new URL('../public/css/terminal-dock.css', import.meta.url), 'utf8'), /\.td-tab\.asks \.td-dot \{ background: var\(--waiting\)/);
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].dockAsks?.includes('{name}'), lang);
});
