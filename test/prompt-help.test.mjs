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
  // Claude Code 2.1.29x draws spaces as cursor moves and each line at its own row (as SiberSentez's terminal received it,
  // 2026-10-08): the words stay apart and the question is recognized
  const raw = `${ESC}[1m${ESC}[6;2HAccessing${ESC}[1Cworkspace:${ESC}[m${ESC}[10;2HQuick${ESC}[1Csafety${ESC}[1Ccheck:${ESC}[1CIs${ESC}[1Cthis${ESC}[1Ca${ESC}[1Cproject${ESC}[1Cyou${ESC}[1Ccreated${ESC}[1Cor${ESC}[1Cone${ESC}[1Cyou${ESC}[1Ctrust?${ESC}[18;2H${ESC}[38;5;153m❯${ESC}[1CNo,${ESC}[1Cexit${ESC}[19;4HYes,${ESC}[1CI${ESC}[1Ctrust${ESC}[1Cthis${ESC}[1Cfolder${ESC}[21;2HEnter${ESC}[1Cto${ESC}[1Cconfirm`;
  assert.equal(stripAnsi(raw), '\nAccessing workspace:\nQuick safety check: Is this a project you created or one you trust?\n❯ No, exit\nYes, I trust this folder\nEnter to confirm');
  assert.equal(detectPrompt(stripAnsi(raw))?.id, 'trust');
  // An extension asking to be let in, as Claude Code drew it (2026-10-08)
  const allow = `${ESC}[1m${ESC}[14;2HClaude${ESC}[1Cin${ESC}[1CChrome${ESC}[1Cwants${ESC}[1Cto${ESC}[1Ccreate${ESC}[1Ca${ESC}[1Cbrowser${ESC}[1Cwindow${ESC}[1Cand${ESC}[1Cread${ESC}[1Cyour${ESC}[1Ctabs${ESC}[m    ${ESC}[16;2H❯${ESC}[1C1.${ESC}[1CAllow${ESC}[17;4H2.${ESC}[1CDeny${ESC}[1C(esc)`;
  const hit = detectPrompt(stripAnsi(allow));
  assert.deepEqual([hit?.id, hit?.detail], ['allow', 'Claude in Chrome wants to create a browser window and read your tabs']);
  assert.equal(detectPrompt('● I want to add a button. Users can Allow or Deny cookies.\n> '), null, 'talk about allow and deny is no question');
  // Claude Code 2.1.29x's command question: the command sits in a box line under a tip and a description
  const boxedCmd = 'Bash command · from the reviewer agent\nTip: auto mode handles these prompts for you — choose "switch to auto mode" below\nList all project files with timestamps\n\n│ cd "/c/p" && find . -type f | xargs ls -la\n\nThis command requires approval\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for: xargs ls -la\n  3. Yes, and switch to auto mode\n  4. No';
  const bc = detectPrompt(boxedCmd);
  assert.deepEqual([bc.id, bc.detail, bc.wide], ['command', 'cd "/c/p" && find . -type f | xargs ls -la', true]);
  // Two different questions with no subject read are told apart; the same one redrawn (a timer ticking) is the same
  const yes = (what, secs) => `● ${what}\n✻ Working ${secs}s\nDo you want to proceed?\n❯ 1. Yes\n  2. No`;
  assert.notEqual(detectPrompt(yes('Check the page', 3)).sig, detectPrompt(yes('Delete the old files', 3)).sig);
  assert.equal(detectPrompt(yes('Check the page', 3)).sig, detectPrompt(yes('Check the page', 41)).sig);
  // Review 2026-10-08: an answered question left on the screen keeps its mark while the tool's output flows below it
  const answered = '● Checking the page\n\nBash command\n\n  (a check)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n';
  const marks = new Set();
  let flow = 'x'.repeat(3000) + '\n' + answered;
  for (let i = 0; i < 20; i++) {
    flow += `● Step ${'y'.repeat(60)}\n`;
    marks.add(detectPrompt(flow.slice(-2500))?.sig);
  }
  assert.equal([...marks].filter(Boolean).length, 1, `one mark while it is on the screen: ${[...marks].join(' ')}`);
  assert.equal(detectPrompt(flow.slice(-2500)), null, 'once the output pushed it up, it asks nothing (no "waiting" for an answered question)');
  // A long command (a 30-line script): its header far above the question; still a command, its first line read
  const longCmd = 'Bash command · from the builder agent\nWrite the page\n\n│ rm -rf build && cat > index.html <<EOF\n' + '│   <p>line</p>\n'.repeat(40) + '│ EOF\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No';
  const lc = detectPrompt(longCmd);
  assert.deepEqual([lc.id, lc.detail, lc.risky], ['command', 'rm -rf build && cat > index.html <<EOF', true]);
  // A heavily padded screen cut at its start, the question near that start: its mark does not change chunk by chunk
  const padded = (k) => ('p'.repeat(k) + ' '.repeat(300) + '\n').repeat(3) + '● Check it\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n' + (' '.repeat(400) + '\n').repeat(3);
  const cutMarks = new Set([10, 20, 30].map((k) => detectPrompt(('x'.repeat(3000) + padded(k)).slice(-2500))?.sig));
  assert.equal(cutMarks.size, 1, [...cutMarks].join(' '));
  // The older layout draws the whole box: the command is read without its borders, never as "│"
  const fullBox = '╭──────╮\n│ Bash command                    │\n│                                 │\n│   npm run build                 │\n│   Build the site                │\n╰──────╯\nDo you want to proceed?\n❯ 1. Yes\n  2. No';
  assert.equal(detectPrompt(fullBox).detail, 'npm run build');
  // allow: its own numbered choices and the end of the screen only
  assert.equal(detectPrompt('The plugin wants to read files when you Allow it; Deny turns it off.\n> '), null, 'prose');
  const oldAllow = 'X wants to read your tabs\n❯ 1. Allow\n  2. Deny (esc)\n' + '● Going on\n'.repeat(80);
  assert.equal(detectPrompt(oldAllow + "Here is Claude's plan\nWould you like to proceed?\n❯ 1. Yes\n  2. No, keep planning")?.id, 'plan', 'an answered one above does not hide the newer question');
  // instead on a wide terminal: the padding of its input box is not counted
  const wide = 'Called x\n  └ Interrupted · What should Claude do instead?\n' + ('─'.repeat(10) + ' '.repeat(190) + '\n').repeat(4) + '❯ ' + ' '.repeat(190) + '\n';
  assert.equal(detectPrompt(wide)?.id, 'instead');
  // Stopped (a permission denied) and asked what to do instead: only while it is the last thing on the screen
  const stopped = 'Called claude-in-chrome\n  └ Interrupted · What should Claude do instead?\n\n✻ Cogitated for 23m 58s\n─────\n❯ \n─────\n  ⏵⏵ accept edits on';
  assert.equal(detectPrompt(stopped)?.id, 'instead');
  assert.equal(detectPrompt(stopped + '\n● Going on without the browser.\n' + '● Read(index.html)\n'.repeat(40)), null, 'the tool went on: the old line far above asks nothing');
  setLanguage('tr');
  assert.ok(promptHelpHtml(detectPrompt(stopped)).includes(STRINGS.tr.phFoot_instead), 'its own footer: write, no number');
  setLanguage('en');
  assert.equal(stripAnsi(`a${ESC}[3Cb${ESC}[9999Cc`), 'a   b' + ' '.repeat(200) + 'c', 'a forward move: its spaces, at most 200');
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
    // Claude Code 2.1.29x, as it printed in SiberSentez's terminal on a new project (2026-10-08)
    ["Accessing workspace:\n\nC:\\Users\\u\\Documents\\SiberSentez\\Kafe\n\nQuick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\nClaude Code'll be able to read, edit, and execute files here.\n\nSecurity guide\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel", 'trust', '', false, false],
    ['Select login method:\n❯ 1. Claude account with subscription', 'login', '', false, false],
    ['Here is Claude\'s plan\n…\nWould you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, manually approve edits\n  3. No, keep planning', 'plan', '', false, true],
    ['1. Yes\n2. Yes, and approve git for the rest of the running session\n3. No, and tell Copilot what to do differently (Esc)', 'command', '', false, true],
    // Gemini CLI's plan mode (exit_plan_mode, 0.61)
    ['Plan: add a menu page\nReady to start implementation?\n● 1. Yes\n  2. No', 'plan', '', false, false],
  ];
  for (const [text, id, detail, risky, wide] of cases) {
    const hit = detectPrompt(text);
    assert.ok(hit, text.slice(0, 40));
    assert.deepEqual([hit.id, hit.detail, hit.risky, hit.wide], [id, detail, risky, wide], text.slice(0, 50));
    // A command or yes/no without a subject read carries a mark of its own text
    if (!detail && (id === 'command' || id === 'confirm')) assert.match(hit.sig, new RegExp(`^${id}\\|#[0-9a-z]+$`));
    else assert.equal(hit.sig, `${id}|${detail}`);
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
    // Gemini CLI on a free API key, its daily quota used up (review 2026-10-08)
    ['[API Error: {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}]', 'errLimit'],
    ['You have reached your daily gemini-2.5-pro quota limit. Please wait or switch models.', 'errLimit'],
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
      for (const id of ['trust', 'login', 'edit', 'fetch', 'command', 'allow', 'plan', 'confirm', 'instead']) for (const k of ['phTitle_', 'phWhat_', 'phPick_']) assert.ok(S[k + id], `${lang} ${k}${id}`);
    }
  } finally {
    setLanguage('en');
  }
  assert.equal(promptHelpHtml(null), '');
});

test('the dock: a tab whose tool asks is marked (not for an error) and says so in both languages; the prompt comes before the error', async () => {
  const fs = await import('node:fs');
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("const asks = !!hit && hit.id !== 'error' && hit.id !== 'code';") && dock.includes("x.tabEl.classList.toggle('asks', asks);"), 'an error (setup or code) is not a question');
  assert.ok(dock.includes('const prompt = !x.ended ? detectPrompt(x.plain.slice(-2500)) : null;') && dock.includes('const hit = prompt || detectError(x.plain) || (!x.ai && x.projectId ? detectCodeError(x.plain) : null);'), 'a question first, then a setup error, then an error of the program');
  assert.match(fs.readFileSync(new URL('../public/css/terminal-dock.css', import.meta.url), 'utf8'), /\.td-tab\.asks \.td-dot \{ background: var\(--waiting\)/);
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].dockAsks?.includes('{name}'), lang);
});
