// The setup check of the tools panel (docs/ai-start.md, "Setup check"): what the detection adds (Git, the API key
// flag, the installer folder PATH lacks), the page's diagnosis, the pasted-error matcher and their HTML.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectGit, envFlags, searchDirs, createToolDetector, publicTools } from '../server/tools.mjs';
import { diagnose, matchError, pathFix, setupCheckHtml, errorBoxHtml, FIX, NPM_PACKAGES } from '../public/js/setupCheck.js';
import { normalizeTools } from '../public/js/views/tools.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const ENV = {
  Path: 'C:\\Windows\\System32;C:\\Tools',
  USERPROFILE: 'C:\\Users\\u',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
};

function inLanguages(fn) {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      fn(lang, STRINGS[lang]);
    }
  } finally {
    setLanguage('en');
  }
}

const tool = (id, name, extra = {}) => ({ id, name, installed: true, version: '1.0.0', via: 'native', ready: 'yes', installs: 1, others: [], onPath: true, pathDir: null, app: false, ...extra });
const ready = (extra = {}) => ({ status: 'ready', tools: [tool('claude', 'Claude Code')], node: { installed: true, version: '24.1.0' }, git: { installed: true, onPath: true }, env: { anthropicKey: false }, ...extra });
const ids = (list) => list.map((p) => p.id);

describe('setup check: what the detection adds', () => {
  test('Git: a file look-up on PATH, then its installer folders (off PATH); only git.exe counts; no process', () => {
    const dirs = searchDirs(ENV);
    assert.deepEqual(detectGit(dirs, ENV, (f) => f === 'C:\\Tools\\git.exe'), { installed: true, onPath: true });
    assert.deepEqual(detectGit(dirs, ENV, (f) => f === 'C:\\Program Files\\Git\\cmd\\git.exe'), { installed: true, onPath: false });
    assert.deepEqual(detectGit(dirs, ENV, (f) => f === 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'), { installed: true, onPath: false }, 'installed for one user');
    assert.deepEqual(detectGit(dirs, ENV, (f) => f === 'C:\\Tools\\git.cmd'), { installed: false, onPath: false });
    assert.deepEqual(detectGit(dirs, ENV, () => false), { installed: false, onPath: false });
  });

  test('the API key: presence only, any letter case, blank is not set; its value never reaches the page', async () => {
    assert.deepEqual(envFlags({ ANTHROPIC_API_KEY: 'sk-ant-secret' }), { anthropicKey: true });
    assert.deepEqual(envFlags({ anthropic_api_key: 'x' }), { anthropicKey: true });
    assert.deepEqual(envFlags({ ANTHROPIC_API_KEY: '  ' }), { anthropicKey: false });
    assert.deepEqual(envFlags({}), { anthropicKey: false });
    const env = { ...ENV, ANTHROPIC_API_KEY: 'sk-ant-secret-123' };
    const files = new Set(['C:\\Users\\u\\.local\\bin\\claude.exe']);
    const spawn = () => {
      throw new Error('no process in this test');
    };
    const r = await createToolDetector({ env, spawn, isFile: (f) => files.has(f), isDir: () => false, readDir: () => [] }).detect();
    const pub = publicTools(r);
    assert.deepEqual(pub.env, { anthropicKey: true });
    assert.deepEqual(pub.git, { installed: false, onPath: false });
    assert.doesNotMatch(JSON.stringify(pub), /sk-ant|secret|Users|\\\\/);
    const claude = pub.tools.find((x) => x.id === 'claude');
    assert.deepEqual([claude.onPath, claude.pathDir], [false, 'localBin'], 'the installer folder PATH lacks, as a known word');
  });

  test('pathDir: a known word or null; the page keeps it only when known; git and env missing from an older server: null', () => {
    const bad = publicTools({ tools: [{ id: 'claude', name: 'Claude Code', installed: true, installs: [{}], chosen: { extra: true, key: 'C:\\evil' } }] });
    assert.equal(bad.tools[0].pathDir, null);
    const onPath = publicTools({ tools: [{ id: 'claude', name: 'Claude Code', installed: true, installs: [{}], chosen: { extra: false, key: 'npm' } }] });
    assert.equal(onPath.tools[0].pathDir, null, 'on PATH: nothing to fix');
    const n = normalizeTools({ tools: [{ id: 'claude', installed: true, onPath: false, pathDir: 'winget' }, { id: 'codex', installed: true, onPath: false, pathDir: 'C:\\x' }], git: { installed: true, onPath: 1 }, env: { anthropicKey: 'yes' } });
    assert.deepEqual(n.tools.map((x) => x.pathDir), ['winget', null]);
    assert.deepEqual([n.git, n.env], [{ installed: true, onPath: false }, { anthropicKey: false }], 'only true is true');
    const old = normalizeTools({ tools: [] });
    assert.deepEqual([old.git, old.env], [null, null]);
  });
});

describe('setup check: diagnosis', () => {
  test('nothing to fix on a ready computer; nothing before the detection answered', () => {
    assert.deepEqual(diagnose(ready()), []);
    assert.deepEqual(diagnose({ status: 'loading', tools: [] }), []);
    assert.deepEqual(diagnose(null), []);
    assert.deepEqual(diagnose(ready({ git: null, env: null })), [], 'an older server: no word about Git or the key');
  });

  test('no tool yet: one note, and Git missing is a note (not a warning) until Claude Code is there', () => {
    const d = diagnose(ready({ tools: [], git: { installed: false, onPath: false } }));
    assert.deepEqual(ids(d), ['noTool', 'noGit']);
    assert.deepEqual(d.map((p) => p.level), ['info', 'info']);
    assert.equal(diagnose(ready({ git: { installed: false, onPath: false } }))[0].level, 'warn', 'with Claude Code: a warning');
    assert.deepEqual(diagnose(ready({ git: { installed: false, onPath: false } }))[0].fixes, [{ how: 'winget', cmd: FIX.git }]);
    assert.deepEqual(ids(diagnose(ready({ git: { installed: true, onPath: false } }))), ['gitOffPath']);
  });

  test('Node.js: missing or older than 20 only matters for a tool installed with npm', () => {
    const npm = [tool('gemini', 'Gemini CLI', { via: 'npm' })];
    assert.deepEqual(ids(diagnose(ready({ tools: npm, node: { installed: false, version: null } }))), ['nodeMissing']);
    const old = diagnose(ready({ tools: npm, node: { installed: true, version: '18.19.0' } }));
    assert.deepEqual([ids(old), old[0].vars], [['nodeOld'], { tools: 'Gemini CLI', version: '18.19.0', min: 20 }]);
    assert.deepEqual(diagnose(ready({ tools: npm, node: { installed: true, version: '20.0.0' } })), []);
    assert.deepEqual(diagnose(ready({ node: { installed: false, version: null } })), [], 'a native install needs no Node.js');
  });

  test('"is not recognized": a tool off PATH gets the PATH line for its folder; an unknown folder gets the advice only', () => {
    const d = diagnose(ready({ tools: [tool('claude', 'Claude Code', { onPath: false, pathDir: 'localBin' })] }));
    assert.deepEqual(ids(d), ['notOnPath']);
    assert.equal(d[0].vars.command, 'claude');
    assert.equal(d[0].fixes[0].cmd, pathFix('localBin'));
    assert.match(pathFix('localBin'), /SetEnvironmentVariable\('Path', \[Environment\]::GetEnvironmentVariable\('Path', 'User'\) \+ ';' \+ \(Join-Path \$env:USERPROFILE '\.local\\bin'\), 'User'\)/);
    for (const k of ['npm', 'winget', 'scoop']) assert.match(pathFix(k), /^\[Environment\]::SetEnvironmentVariable\('Path'/);
    assert.equal(pathFix('C:\\x'), null);
    assert.deepEqual(diagnose(ready({ tools: [tool('claude', 'Claude Code', { onPath: false, pathDir: null })] }))[0].fixes, []);
  });

  test('several installs: the npm copy is named for removal only when native and npm are mixed', () => {
    const mixed = diagnose(ready({ tools: [tool('claude', 'Claude Code', { installs: 2, others: [{ via: 'npm', version: '2.1.0' }] })] }));
    assert.deepEqual(ids(mixed), ['multiNpm']);
    assert.equal(mixed[0].fixes[0].cmd, `npm uninstall -g ${NPM_PACKAGES.claude}`);
    assert.deepEqual(diagnose(ready({ tools: [tool('claude', 'Claude Code', { via: 'npm', installs: 2, others: [{ via: 'native' }] })] })).length, 1, 'npm first on PATH: the same advice');
    assert.deepEqual(diagnose(ready({ tools: [tool('claude', 'Claude Code', { installs: 2, others: [{ via: 'winget' }] })] })), [], 'no npm copy: the card says it already');
    assert.deepEqual(diagnose(ready({ tools: [tool('cursor', 'Cursor CLI', { installs: 2, others: [{ via: 'npm' }] })] })), [], 'no npm package known');
  });

  test('the API key: a warning with Claude Code, a note without; the fix removes the user variable', () => {
    const d = diagnose(ready({ env: { anthropicKey: true } }));
    assert.deepEqual([ids(d), d[0].level, d[0].fixes[0].cmd], [['apiKey'], 'warn', FIX.apiKeyOff]);
    assert.equal(diagnose(ready({ tools: [tool('codex', 'Codex CLI')], env: { anthropicKey: true } }))[0].level, 'info');
  });

  test('not signed in: a note with the command to type', () => {
    const d = diagnose(ready({ tools: [tool('codex', 'Codex CLI', { ready: 'no' })] }));
    assert.deepEqual([ids(d), d[0].level, d[0].vars.command], [['notSigned'], 'info', 'codex']);
  });
});

describe('setup check: a pasted error', () => {
  test('the common Windows errors are told apart (English and Turkish Windows)', () => {
    const cases = [
      ["claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'errNotRecognized'],
      ["'claude' is not recognized as an internal or external command,", 'errNotRecognized'],
      ["'claude' terimi cmdlet, işlev, betik dosyası veya çalıştırılabilir program adı olarak tanınmıyor.", 'errNotRecognized'],
      ['claude.ps1 cannot be loaded because running scripts is disabled on this system.', 'errPolicy'],
      ['Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).', 'errGitBash'],
      ['npm WARN EBADENGINE Unsupported engine { required: { node: ">=20" } }', 'errNode'],
      ['Invoke-RestMethod : The underlying connection was closed: Could not establish trust relationship for the SSL/TLS secure channel.', 'errTls'],
      ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'errAuth'],
      ['API Error: 429 rate_limit_error', 'errLimit'],
      ['Error: spawn EPERM', 'errPerm'],
      ['getaddrinfo ENOTFOUND api.anthropic.com', 'errNetwork'],
    ];
    for (const [text, id] of cases) assert.equal(matchError(text)[0].id, id, text);
  });

  test('a sentence typed into a plain shell is told apart from a missing tool', () => {
    for (const text of [
      "nasıl : The term 'nasıl' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      "'how' is not recognized as an internal or external command,",
      "'merhaba' terimi cmdlet, işlev, betik dosyası veya çalıştırılabilir program adı olarak tanınmıyor.",
      "PS C:\\p> nasil calistirilir\nnasil : The term 'nasil' is not recognized as the name of a cmdlet",
    ]) assert.deepEqual(matchError(text).map((r) => r.id), ['errNotACommand'], text);
    for (const text of ["claude : The term 'claude' is not recognized as the name of a cmdlet", "npm : The term 'npm' is not recognized as the name of a cmdlet", "'foo' is not recognized as an internal or external command,"])
      assert.equal(matchError(text)[0].id, 'errNotRecognized', text);
  });

  test('the command named in "not recognized" is used only when it is a known one; empty text: nothing; unknown text: one honest answer', () => {
    assert.equal(matchError("The term 'claude' is not recognized")[0].vars.command, 'claude');
    assert.equal(matchError("The term 'rm-rf-evil' is not recognized")[0].vars.command, STRINGS.en.scThisCommand);
    assert.deepEqual(matchError('   '), []);
    assert.deepEqual(ids(matchError('something odd happened')), ['errUnknown']);
    assert.ok(matchError('x'.repeat(10000) + " is not recognized as").every((r) => r.id === 'errUnknown'), 'only the first 4000 characters are read');
    assert.ok(matchError('401 unauthorized rate limit 429 EPERM ENOTFOUND').length <= 3, 'three answers at most');
  });
});

describe('setup check: HTML', () => {
  test('the block in both languages: warnings counted, each with its reason and a copy button; all good says so', () => {
    inLanguages((lang, S) => {
      const st = ready({ tools: [tool('claude', 'Claude Code', { onPath: false, pathDir: 'npm' })], env: { anthropicKey: true } });
      const h = setupCheckHtml(st);
      assert.ok(h.includes(S.scTitle), lang);
      assert.ok(h.includes(S.scFound.replace('{count}', '2')), lang);
      assert.ok(h.includes('data-sc="notOnPath"') && h.includes('data-sc="apiKey"'));
      assert.equal((h.match(/data-ai-copy/g) || []).length, 2);
      assert.ok(h.includes(S.scNeverRuns.replace(/“/g, '“')));
      assert.ok(setupCheckHtml(ready()).includes(S.scAllGood));
      assert.equal(setupCheckHtml({ status: 'loading', tools: [] }), '');
    });
  });

  test('the error box: the pasted text is escaped and stays in the box; results follow the text', () => {
    const h = errorBoxHtml("<img src=x onerror=alert(1)> 'claude' is not recognized as");
    assert.ok(!h.includes('<img'), 'escaped');
    assert.ok(h.includes('data-sc="errNotRecognized"'));
    assert.ok(h.includes('<details class="sc-err" open>'));
    const empty = errorBoxHtml('');
    assert.ok(empty.includes('<details class="sc-err">') && empty.includes('data-sc-results></ul>'));
  });

  test('every problem and error id has a title and a reason in both languages', () => {
    const idsAll = ['noTool', 'nodeMissing', 'nodeOld', 'noGit', 'gitOffPath', 'notOnPath', 'multiNpm', 'apiKey', 'notSigned', 'errPolicy', 'errGitBash', 'errNode', 'errNotRecognized', 'errNotACommand', 'errTls', 'errAuth', 'errLimit', 'errPerm', 'errNetwork', 'errUnknown'];
    for (const lang of ['en', 'tr']) for (const id of idsAll) for (const k of [`sc_${id}`, `scWhy_${id}`]) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  });
});
