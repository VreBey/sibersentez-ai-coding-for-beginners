// The setup wizard (roadmap F2, 2026-10-08): the sign-in state of the tools without a sign-in command, read from
// their own files (names of fields and whether a file or a variable exists only), Cursor's `status`, and the wizard's
// steps, commands and texts. No tool, window or terminal is started.
// Run: node --test test/setup-wizard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileReady, toolById, createToolDetector, publicTools } from '../server/tools.mjs';
import { wizardState, wizardHtml, installCommand, signInCommand, WIZARD_TOOLS, PREREQS } from '../public/js/views/setupWizard.js';
import { TOOL_INFO, normalizeTools, wizardFirst, wizardPanelHtml } from '../public/js/views/tools.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { WIN_ONLY } from './lib/winonly.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const HOME = 'C:\\Users\\u';
const env = (extra = {}) => ({ USERPROFILE: HOME, ...extra });
const files = (map) => ({ readJson: (p) => (p in map ? map[p] : null), isFile: (p) => p in map });
const at = (...p) => [HOME, ...p].join('\\');

test('Gemini CLI: the sign-in type it chose with what that type needs (its Google sign-in file, GEMINI_API_KEY), or either without a type', { skip: WIN_ONLY }, () => {
  const settings = (o) => ({ [at('.gemini', 'settings.json')]: o });
  const creds = { [at('.gemini', 'oauth_creds.json')]: {} };
  assert.equal(fileReady('gemini', { env: env({ GEMINI_API_KEY: 'x' }), ...files(settings({ security: { auth: { selectedType: 'gemini-api-key' } } })) }), 'yes');
  assert.equal(fileReady('gemini', { env: env(), ...files(settings({ security: { auth: { selectedType: 'gemini-api-key' } } })) }), 'unknown', 'the key may be in a .env file: not looked for');
  // A Google sign-in serves only a Code Assist licence since 2026-06-18: its file alone is not known; with the licence's
  // Cloud project it is
  assert.equal(fileReady('gemini', { env: env(), ...files({ ...settings({ selectedAuthType: 'oauth-personal' }), ...creds }) }), 'unknown', 'the older field');
  assert.equal(fileReady('gemini', { env: env({ GOOGLE_CLOUD_PROJECT: 'p' }), ...files({ ...settings({ selectedAuthType: 'oauth-personal' }), ...creds }) }), 'yes');
  assert.equal(fileReady('gemini', { env: env(), ...files(settings({ security: { auth: { selectedType: 'oauth-personal' } } })) }), 'no', 'Google chosen, never signed in (review 2026-10-08)');
  assert.equal(fileReady('gemini', { env: env({ GOOGLE_CLOUD_PROJECT: 'p' }), ...files(settings({ security: { auth: { selectedType: 'vertex-ai' } } })) }), 'yes');
  assert.equal(fileReady('gemini', { env: env(), ...files(settings({ security: { auth: { selectedType: 'cloud-shell' } } })) }), 'unknown');
  assert.equal(fileReady('gemini', { env: env(), ...files({ [at('.gemini', 'oauth_creds.json')]: {} }) }), 'unknown', 'a Google sign-in file alone (since 2026-06-18)');
  assert.equal(fileReady('gemini', { env: env({ GEMINI_API_KEY: 'x' }), ...files({}) }), 'yes');
  assert.equal(fileReady('gemini', { env: env(), ...files({ [at('.gemini', 'settings.json')]: { mcpServers: {} } }) }), 'no');
  assert.equal(fileReady('gemini', { env: {}, ...files({}) }), 'unknown', 'no home folder');
});

test('Qwen Code: its sign-in type; a provider through the variable its key comes from or a key field; Qwen OAuth through its file', { skip: WIN_ONLY }, () => {
  const s = (o) => ({ [at('.qwen', 'settings.json')]: o });
  const nv = { security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: [{ id: 'kimi', envKey: 'NVIDIA_API_KEY' }] } };
  assert.equal(fileReady('qwen', { env: env({ NVIDIA_API_KEY: 'k' }), ...files(s(nv)) }), 'yes');
  assert.equal(fileReady('qwen', { env: env(), ...files(s(nv)) }), 'no', 'the variable is not set');
  assert.equal(fileReady('qwen', { env: env(), ...files(s({ security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: [{ apiKey: 'secret' }] } })) }), 'yes');
  assert.equal(fileReady('qwen', { env: env(), ...files({ ...s({ security: { auth: { selectedType: 'qwen-oauth' } } }), [at('.qwen', 'oauth_creds.json')]: {} }) }), 'yes');
  assert.equal(fileReady('qwen', { env: env(), ...files(s({ security: { auth: { selectedType: 'qwen-oauth' } } })) }), 'no');
  assert.equal(fileReady('qwen', { env: env(), ...files({}) }), 'no');
  assert.equal(fileReady('qwen', { env: env(), ...files(s({ security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: [{ envKey: 'bad name' }] } })) }), 'no', 'only a variable name');
});

test('OpenCode: a provider in its credentials file, or a variable of a provider it reads', { skip: WIN_ONLY }, () => {
  const auth = at('.local', 'share', 'opencode', 'auth.json');
  assert.equal(fileReady('opencode', { env: env(), ...files({ [auth]: { anthropic: { type: 'oauth' } } }) }), 'yes');
  assert.equal(fileReady('opencode', { env: env(), ...files({ [auth]: {} }) }), 'no');
  assert.equal(fileReady('opencode', { env: env({ NVIDIA_API_KEY: 'k' }), ...files({}) }), 'yes');
  assert.equal(fileReady('opencode', { env: env({ XDG_DATA_HOME: 'D:\\data' }), ...files({ 'D:\\data\\opencode\\auth.json': { openai: {} } }) }), 'yes', 'XDG_DATA_HOME');
  assert.equal(fileReady('copilot', { env: env(), ...files({}) }), 'unknown', 'Copilot keeps it in the Windows credential store');
});

test('Cursor CLI: `status` answers 0 either way, so its words decide; the output is never part of the answer', { skip: WIN_ONLY }, async () => {
  const c = toolById('cursor');
  assert.deepEqual(c.ready, ['status']);
  assert.equal(c.readyOut('✓ Logged in as someone@example.com'), true);
  assert.equal(c.readyOut('Not logged in'), false);
  assert.equal(c.readyOut(''), false);
  for (const [out, want] of [['✓ Logged in as a@b.c', 'yes'], ['Not logged in', 'no']]) {
    const file = `${HOME}\\AppData\\Local\\cursor-agent\\cursor-agent.cmd`;
    const spawn = (bin, args) => {
      const line = args.join(' ');
      const child = { stdout: { on: (e, f) => e === 'data' && setTimeout(() => f(Buffer.from(line.includes('status') ? out : '2026.10.01')), 1) }, stderr: { on: () => {} }, on: (e, f) => e === 'close' && setTimeout(() => f(0), 5), kill: () => {}, pid: 1 };
      return child;
    };
    const d = createToolDetector({ env: { USERPROFILE: HOME, PATH: `${HOME}\\AppData\\Local\\cursor-agent`, PATHEXT: '.CMD;.EXE' }, spawn, isFile: (f) => f === file, isDir: () => false, readDir: () => [], readJson: () => null, cmdExe: 'C:\\Windows\\System32\\cmd.exe' });
    const r = await d.detect();
    const cur = r.tools.find((x) => x.id === 'cursor');
    assert.equal(cur.ready, want, out);
    const pub = JSON.stringify(publicTools(r));
    assert.doesNotMatch(pub, /@|Logged/, 'no output reaches the page');
    assert.equal(publicTools(r).tools.find((x) => x.id === 'cursor').cmd, 'cursor-agent');
  }
});

const ready = (tools, extra = {}) => ({ status: 'ready', tools, node: { installed: true, version: '24.0.0' }, git: { installed: true, onPath: true }, ...extra });

test('the steps: pick, what it needs, install, sign in, ready; Git for Claude Code, Node.js for an npm-only tool not installed yet', () => {
  assert.equal(wizardState(ready([]), null, TOOL_INFO).step, 'pick');
  assert.equal(wizardState(ready([]), 'nope', TOOL_INFO).step, 'pick');
  const noGit = ready([], { git: { installed: false, onPath: false } });
  const w1 = wizardState(noGit, 'claude', TOOL_INFO);
  assert.deepEqual([w1.step, w1.needs], ['needs', [{ id: 'git', ok: false }]]);
  assert.equal(wizardState(ready([], { git: { installed: true, onPath: false } }), 'claude', TOOL_INFO).step, 'needs', 'Git not on PATH is not enough');
  const w2 = wizardState(ready([]), 'claude', TOOL_INFO);
  assert.deepEqual([w2.step, w2.install.how], ['install', 'powershell']);
  const noNode = ready([], { node: { installed: false } });
  assert.deepEqual(wizardState(noNode, 'gemini', TOOL_INFO).needs, [{ id: 'node', ok: false }]);
  assert.equal(wizardState(noNode, 'copilot', TOOL_INFO).install.how, 'winget', 'a command without Node.js first');
  assert.equal(wizardState(noNode, 'copilot', TOOL_INFO).step, 'install');
  assert.equal(wizardState(ready([{ id: 'gemini', installed: true, ready: 'no' }], { node: { installed: false } }), 'gemini', TOOL_INFO).step, 'signin', 'installed: Node.js no longer asked');
  assert.equal(wizardState(ready([{ id: 'claude', installed: true, ready: 'yes', cmd: 'claude' }]), 'claude', TOOL_INFO).step, 'done');
  assert.equal(wizardState(ready([{ id: 'copilot', installed: true, ready: 'unknown' }]), 'copilot', TOOL_INFO).step, 'done', 'unknown: the done step asks');
});

test('commands: the install command needs nothing missing; the sign-in line is the tool’s own, with its found command name', () => {
  assert.equal(installCommand(TOOL_INFO.codex, false).how, 'powershell');
  assert.equal(installCommand(TOOL_INFO.gemini, false).how, 'npm', 'the only command');
  assert.equal(signInCommand({ id: 'cursor', cmd: 'agent' }), 'agent login');
  assert.equal(signInCommand({ id: 'cursor', cmd: 'bad name; rm' }), 'cursor-agent login', 'only a plain name');
  assert.equal(signInCommand({ id: 'claude' }), 'claude auth login');
  assert.equal(signInCommand({ id: 'opencode', cmd: 'opencode' }), 'opencode auth login');
  assert.equal(signInCommand({ id: 'gemini', cmd: 'gemini' }), 'gemini', 'it asks how to sign in when it opens');
  for (const c of Object.values(PREREQS)) assert.match(c.cmd, /^winget install --id [A-Za-z.]+ -e --source winget$/);
  assert.deepEqual([...WIZARD_TOOLS].sort(), Object.keys(TOOL_INFO).sort());
  // Every command fits the setup terminal's rule (one line of printable ASCII, at most 200)
  for (const id of WIZARD_TOOLS) for (const c of [...TOOL_INFO[id].install.map((x) => x.cmd), signInCommand({ id })]) assert.match(c, /^[\x20-\x7e]{1,200}$/);
});

test('the markup: the tools to pick with the best fit and a free start marked; each step its command; "I signed in" where the state cannot be read; texts in both languages', () => {
  const src = read('public/js/views/setupWizard.js');
  const keys = new Set([...src.matchAll(/t\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  for (const k of ['needs', 'install', 'signin', 'done']) keys.add(`wz_step_${k}`);
  for (const n of ['git', 'node']) keys.add(`wzNeed_${n}`).add(`wzNeed_${n}_ok`);
  for (const id of WIZARD_TOOLS) keys.add(`wzSignIn_${id}`).add(`aiAcct_${id}`);
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    for (const k of keys) assert.ok(STRINGS[lang][k]?.trim(), `${lang}: ${k}`);
    const st = ready([]);
    const pick = wizardHtml(wizardState(st, null, TOOL_INFO), { info: TOOL_INFO, st });
    assert.equal((pick.match(/data-wz="pick:/g) || []).length, 7);
    assert.ok(pick.includes(STRINGS[lang].wzBestFit) && pick.includes(STRINGS[lang].wzFreeStart));
    // "Can start free" sits on Copilot's card (its free plan includes the CLI), never on Gemini's (paid API keys only
    // since 2026-06-18)
    const card = (id) => pick.slice(pick.indexOf(`data-wz="pick:${id}"`), pick.indexOf('</li>', pick.indexOf(`data-wz="pick:${id}"`)));
    assert.ok(card('copilot').includes(STRINGS[lang].wzFreeStart) && !card('gemini').includes(STRINGS[lang].wzFreeStart));
    assert.ok(pick.indexOf('pick:copilot') < pick.indexOf('pick:gemini'), 'the free start before Gemini');
    const inst = wizardHtml(wizardState(st, 'claude', TOOL_INFO), { info: TOOL_INFO, st, canType: true });
    assert.ok(inst.includes('irm https://claude.ai/install.ps1 | iex') && inst.includes('class="ai-cmd"'));
    assert.ok(inst.includes(STRINGS[lang].wzTypeHow));
    assert.ok(wizardHtml(wizardState(st, 'claude', TOOL_INFO), { info: TOOL_INFO, st, canType: false }).includes(STRINGS[lang].wzCopyHow));
    const unk = ready([{ id: 'copilot', installed: true, ready: 'unknown', cmd: 'copilot' }]);
    const done = wizardHtml(wizardState(unk, 'copilot', TOOL_INFO), { info: TOOL_INFO, st: unk });
    assert.ok(done.includes('data-wz="signed"') && done.includes('copilot login') && done.includes('data-wz="use"'));
    assert.ok(!wizardHtml(wizardState(unk, 'copilot', TOOL_INFO), { info: TOOL_INFO, st: unk, signedIn: true }).includes('data-wz="signed"'));
    assert.ok(wizardPanelHtml(st, null).includes('id="aiPanelH"'), 'the dialog keeps its name');
  }
  setLanguage('en');
});

test('wiring: the wizard opens by itself while no tool is installed, asks again every 15 s while installing or signing in, ends at the New project window', () => {
  assert.equal(wizardFirst(ready([])), true);
  assert.equal(wizardFirst(ready([{ id: 'claude', installed: true }])), false);
  assert.equal(wizardFirst({ status: 'loading', tools: [] }), false);
  assert.equal(normalizeTools({ tools: [{ id: 'cursor', installed: true, cmd: 'agent' }] }).tools[0].cmd, 'agent');
  assert.equal(normalizeTools({ tools: [{ id: 'cursor', installed: true, cmd: 'C:\\x\\agent' }] }).tools[0].cmd, null);
  const tools = read('public/js/views/tools.js');
  assert.ok(tools.includes("pollFor(step === 'needs' || step === 'install' || step === 'signin');"));
  assert.ok(tools.includes('export const WIZARD_POLL_MS = 15 * 1000;'));
  assert.ok(tools.includes("const canType = !!setupTyper && actionsState().mode === 'live';"), 'typing only where the setup terminal can take it');
  assert.ok(tools.includes('saveTool(pick);'), '"Use it" makes it the tool jobs start with');
  const main = read('public/js/main.js');
  assert.ok(main.indexOf('setWizardDone(() => newProject.start());') > main.indexOf('const newProject = createNewProjectFlow('), 'after the flow exists');
});

test('Gemini CLI: the words say a paid API key; never that a Google account is enough (review B/C, Google 2026-06-18)', () => {
  assert.match(STRINGS.tr.aiAcct_gemini, /ücretli/i);
  assert.match(STRINGS.en.aiAcct_gemini, /paid/i);
  assert.match(STRINGS.tr.wzSignIn_gemini, /artık çalışmıyor/);
  assert.doesNotMatch(STRINGS.tr.aiAcct_gemini, /^Bir Google hesabı/);
  assert.doesNotMatch(STRINGS.en.aiAcct_gemini, /^A Google account/);
});

test('one table of what SiberSentez does with each tool, and one honest line in the tools panel (plan D4)', async () => {
  const { TOOLS, capabilities } = await import('../server/tools.mjs');
  const { capsLine } = await import('../public/js/views/tools.js');
  const caps = Object.fromEntries(TOOLS.map((t) => [t.id, capabilities(t)]));
  assert.deepEqual([caps.claude.live, caps.codex.live], ['yes', 'no'], 'live status: Claude Code only');
  assert.deepEqual([caps.codex.plan, caps.opencode.plan, caps.claude.plan], ['no', 'no', 'yes']);
  assert.equal(caps.cursor.usage, 'no', 'Cursor logs carry no tokens');
  assert.equal(caps.copilot.signIn, 'unknown');
  assert.equal(caps.gemini.signIn, 'file', 'read from its settings files, often not for sure (review D)');
  assert.equal(caps.claude.signIn, 'yes');
  setLanguage('tr');
  try {
    assert.match(capsLine(caps.gemini), /giriş denetimi: ayar dosyasından/);
  } finally {
    setLanguage('en');
  }
  assert.equal(caps.copilot.planMin, '1.0.93');
  setLanguage('tr');
  try {
    const line = capsLine(caps.copilot);
    assert.ok(line.includes('plan kipi: var (1.0.93 ya da yenisi)') && line.includes('giriş denetimi: bilinmiyor') && line.includes('canlı durum: yok'));
    assert.equal(capsLine(null), '', 'an older server: nothing');
    assert.equal(capsLine({ plan: 'maybe' }), '', 'unknown words are never shown');
  } finally {
    setLanguage('en');
  }
});

test('a tool whose sign-in cannot be seen: the done step says the tool\'s own way to sign in (review D: Gemini, a Google account alone)', async () => {
  const { wizardHtml } = await import('../public/js/views/setupWizard.js');
  const { TOOL_INFO } = await import('../public/js/views/tools.js');
  setLanguage('tr');
  try {
    const w = { step: 'done', tool: { id: 'gemini', installed: true, ready: 'unknown' }, needs: [], install: null, signIn: 'gemini', ready: 'unknown' };
    const html = wizardHtml(w, { info: TOOL_INFO, st: null });
    assert.match(html, /Google hesabıyla giriş artık çalışmıyor/);
    assert.doesNotMatch(wizardHtml({ ...w, ready: 'yes' }, { info: TOOL_INFO, st: null }), /wz-tool-sign/, 'a signed-in tool: no sign-in text');
    assert.doesNotMatch(wizardHtml(w, { info: TOOL_INFO, st: null, signedIn: true }), /wz-tool-sign/, 'the person said done');
  } finally {
    setLanguage('en');
  }
});
