// Plan G4: what the tools panel, the setup wizard and the setup check tell the person to run, per platform. The server
// names its platform (GET /api/tools); an older server's answer has none and reads as Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_INFO, TOOL_ORDER, installsFor, normalizeTools, toolsPanelHtml } from '../public/js/views/tools.js';
import { wizardState, wizardHtml, prereqFor } from '../public/js/views/setupWizard.js';
import { diagnose, pathFix } from '../public/js/setupCheck.js';
import { setLanguage } from '../public/js/i18n.js';

test('every tool has its own commands on Linux and macOS; Windows keeps its list', () => {
  for (const id of TOOL_ORDER) {
    for (const p of ['linux', 'darwin']) {
      const list = installsFor(TOOL_INFO[id], p);
      assert.ok(list.length > 0, `${id} on ${p}`);
      for (const c of list) {
        assert.ok(['shell', 'brew', 'npm'].includes(c.how), `${id} ${p}: ${c.how}`);
        assert.doesNotMatch(c.cmd, /winget|irm |iex|powershell/i, `${id} ${p}: no Windows command`);
      }
    }
    assert.equal(installsFor(TOOL_INFO[id], 'win32'), TOOL_INFO[id].install);
  }
  assert.equal(installsFor(TOOL_INFO.claude, 'linux')[0].cmd, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installsFor(TOOL_INFO.codex, 'linux')[0].cmd, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  assert.equal(installsFor(TOOL_INFO.cursor, 'darwin')[0].cmd, 'curl https://cursor.com/install -fsS | bash');
  assert.ok(installsFor(TOOL_INFO.claude, 'darwin').some((c) => c.cmd === 'brew install --cask claude-code'));
});

test('the platform comes from the server\'s answer; none (an older server) or an unknown one is Windows', () => {
  assert.equal(normalizeTools({ tools: [], platform: 'linux' }).platform, 'linux');
  assert.equal(normalizeTools({ tools: [] }).platform, 'win32');
  assert.equal(normalizeTools({ tools: [], platform: 'freebsd' }).platform, 'win32');
});

test('the wizard on Linux: no Git for Windows step, Node.js through nvm, the install script first', () => {
  const st = { status: 'ready', platform: 'linux', tools: [{ id: 'claude', installed: false, ready: 'unknown' }, { id: 'gemini', installed: false, ready: 'unknown' }], node: { installed: false }, git: { installed: false, onPath: false } };
  const claude = wizardState(st, 'claude', TOOL_INFO);
  assert.equal(claude.step, 'install', 'git is not a step on Linux');
  assert.equal(claude.install.cmd, 'curl -fsSL https://claude.ai/install.sh | bash');
  const gemini = wizardState(st, 'gemini', TOOL_INFO);
  assert.equal(gemini.step, 'install', 'Homebrew needs no Node.js: it is offered while Node.js is missing');
  assert.equal(gemini.install.how, 'brew');
  assert.match(prereqFor('node', 'linux').cmd, /nvm-sh\/nvm\/v0\.40\.8\/install\.sh \| bash && \. "\$HOME\/\.nvm\/nvm\.sh" && nvm install 24$/);
  assert.equal(prereqFor('git', 'darwin').cmd, 'brew install git');
  assert.equal(prereqFor('git', 'win32').how, 'winget', 'Windows as before');
  const win = wizardState({ ...st, platform: 'win32' }, 'claude', TOOL_INFO);
  assert.equal(win.step, 'needs', 'Windows still asks for Git for Windows first');
  setLanguage('en');
  const html = wizardHtml(win, { info: TOOL_INFO, st: { ...st, platform: 'win32' } });
  assert.match(html, /<span class="ai-how">winget<\/span><code translate="no">winget install --id Git\.Git/);
});

test('the tools panel on Linux: the curl line, no PowerShell tip', () => {
  setLanguage('en');
  const st = normalizeTools({ platform: 'linux', tools: [{ id: 'gemini', installed: false }], node: { installed: true, version: '24.18.0' } });
  const html = toolsPanelHtml({ ...st, status: 'ready' }, Date.now(), [], '', null);
  assert.match(html, /brew install gemini-cli/);
  assert.doesNotMatch(html, /PowerShell/);
  const win = toolsPanelHtml({ ...normalizeTools({ tools: [{ id: 'gemini', installed: false }], node: { installed: true } }), status: 'ready' }, Date.now(), [], '', null);
  assert.match(win, /PowerShell/, 'Windows keeps its tip');
});

test('the setup check on Linux and macOS: its own fixes', () => {
  const base = { status: 'ready', tools: [{ id: 'gemini', name: 'Gemini CLI', installed: true, via: 'npm', onPath: false, pathDir: 'npm', installs: 1, others: [] }], node: { installed: false }, git: { installed: false }, env: { anthropicKey: true } };
  const linux = diagnose({ ...base, platform: 'linux' });
  const fixes = (id) => linux.find((x) => x.id === id)?.fixes.map((f) => [f.how, f.cmd]);
  assert.match(fixes('nodeMissing')[0][1], /nvm install 24$/);
  assert.deepEqual(fixes('noGitUnix'), [['apt', 'sudo apt-get install git']]);
  assert.equal(linux.find((x) => x.id === 'noGitUnix').level, 'info', 'git is useful, never required there');
  assert.deepEqual(fixes('notOnPath'), [['shell', `echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc`]]);
  assert.deepEqual(fixes('apiKey'), [['shell', 'unset ANTHROPIC_API_KEY']]);
  assert.equal(pathFix('localBin', 'darwin'), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
  assert.equal(pathFix('winget', 'linux'), null);
  const win = diagnose(base);
  assert.ok(win.some((x) => x.id === 'noGit') && win.find((x) => x.id === 'notOnPath').fixes[0].how === 'powershell', 'Windows as before');
});

test('GET /api/tools names the server\'s platform', async () => {
  const { toolsAnswer } = await import('../server/tools.mjs');
  const { PLATFORM } = await import('../server/platform.mjs');
  const r = await toolsAnswer({ detect: async () => ({ at: 1, tools: [], node: null }) });
  assert.equal(r.body.platform, PLATFORM.id);
});

test('a text with a _unix twin reads without PowerShell on Linux and macOS; the server\'s word sets the page\'s platform', async () => {
  const { tOs, setPagePlatform, pagePlatformNow } = await import('../public/js/i18n.js');
  setLanguage('tr');
  try {
    assert.match(tOs('dockPlain', {}, 'win32'), /PowerShell/);
    assert.equal(tOs('dockPlain', {}, 'linux'), 'Düz terminal: komutlar için, yapay zekâ değil');
    assert.equal(tOs('aiTitle', {}, 'linux'), tOs('aiTitle', {}, 'win32'), 'a text without a twin is the same everywhere');
    const before = pagePlatformNow();
    setPagePlatform('darwin');
    assert.match(tOs('scNeverRuns'), /bir terminalde/);
    setPagePlatform('bogus');
    assert.equal(pagePlatformNow(), 'darwin', 'an unknown word changes nothing');
    setPagePlatform(before);
  } finally {
    setLanguage('en');
  }
});

test('the context menu on Linux and macOS offers no Windows Terminal item; with the dock a session goes on there', async () => {
  const { setPagePlatform, pagePlatformNow } = await import('../public/js/i18n.js');
  const cm = await import('../public/js/contextmenu.js');
  const before = pagePlatformNow();
  const ids = (items) => (Array.isArray(items) ? items : [items]).flat().filter((x) => x && !x.sep && !x.header).map((x) => x.id);
  const project = { id: 'p', name: 'P', path: '/home/a/p', kind: 'registered' };
  try {
    setPagePlatform('linux');
    cm.setDockOpener(() => {});
    const withDock = ids(cm.menuModel({ type: 'project', id: 'p' }, { projects: new Map([['p', project]]), sessions: new Map() }, 'live'));
    assert.ok(!withDock.includes('resume-outside') && !withDock.some((x) => x === 'terminal'), JSON.stringify(withDock));
    setPagePlatform('win32');
    const win = ids(cm.menuModel({ type: 'project', id: 'p' }, { projects: new Map([['p', project]]), sessions: new Map() }, 'live'));
    assert.ok(win.includes('terminal'), 'Windows keeps its Windows Terminal item');
  } finally {
    cm.setDockOpener(null);
    setPagePlatform(before);
  }
});

test('an error in a Linux or macOS terminal gets that platform\'s fix and words; Windows\' own errors are never matched there (review G)', async () => {
  const { matchError } = await import('../public/js/setupCheck.js');
  const { tOs } = await import('../public/js/i18n.js');
  const fixes = (text, pl) => matchError(text, pl).flatMap((r) => r.fixes.map((f) => f.cmd));
  assert.match(fixes('bash: node: command not found', 'linux').join(), /nvm install 24/);
  assert.deepEqual(fixes('bash: node: command not found', 'darwin'), ['brew install node']);
  assert.match(fixes("'node' is not recognized as an internal or external command", 'win32').join(), /winget install --id OpenJS\.NodeJS\.LTS/, 'Windows as before');
  assert.deepEqual(fixes('self-signed certificate in certificate chain', 'linux'), [], 'no PowerShell line');
  assert.ok(fixes('self-signed certificate in certificate chain', 'win32').some((c) => /Tls12/.test(c)));
  assert.equal(matchError('running scripts is disabled on this system', 'linux').some((r) => r.id === 'errPolicy'), false);
  assert.equal(matchError('running scripts is disabled on this system', 'win32')[0].id, 'errPolicy');
  setLanguage('en');
  for (const key of ['scWhy_errNotRecognized', 'scWhy_errNotACommand', 'scWhy_apiKey', 'scWhy_errTls', 'scWhy_gitOffPath', 'phFoot_error', 'nfyDenied', 'setDiagText', 'setLanguageAuto', 'setLanguageText', 'dockNoPty', 'dockFailed', 'runAsk']) {
    assert.doesNotMatch(tOs(key, {}, 'linux'), /Windows|PowerShell/, key);
  }
  assert.match(tOs('scWhy_errNotRecognized', {}, 'win32'), /Windows/);
});

test('review G round 2: the TLS help says nothing of PowerShell on Linux; a tool found where nvm or its own installer put it gets no wrong PATH line', async () => {
  const { matchError, errorItemsHtml, diagnose } = await import('../public/js/setupCheck.js');
  const { setPagePlatform, pagePlatformNow } = await import('../public/js/i18n.js');
  const before = pagePlatformNow();
  setLanguage('en');
  try {
    setPagePlatform('linux');
    assert.doesNotMatch(errorItemsHtml(matchError('npm ERR! UNABLE_TO_GET_ISSUER_CERT_LOCALLY certificate', 'linux')), /PowerShell/);
    setPagePlatform(before);
    for (const pathDir of ['nvm', 'own']) {
      const st = { status: 'ready', platform: 'linux', tools: [{ id: 'claude', name: 'Claude Code', installed: true, via: 'npm', onPath: false, pathDir, installs: 1, others: [] }], node: { installed: true, version: '24.0.0' }, git: { installed: true, onPath: true }, env: {} };
      assert.equal(diagnose(st).some((x) => x.id === 'notOnPath'), false, pathDir);
    }
    const npmGlobal = { status: 'ready', platform: 'linux', tools: [{ id: 'claude', name: 'Claude Code', installed: true, via: 'npm', onPath: false, pathDir: 'npm', installs: 1, others: [] }], node: { installed: true, version: '24.0.0' }, git: { installed: true, onPath: true }, env: {} };
    assert.equal(diagnose(npmGlobal).some((x) => x.id === 'notOnPath'), true, '~/.npm-global still gets its line');
  } finally {
    setPagePlatform(before);
  }
});
