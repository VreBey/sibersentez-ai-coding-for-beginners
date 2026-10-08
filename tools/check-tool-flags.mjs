// Tool drift check (roadmap F4, 2026-10-08): SiberSentez starts each AI tool with options checked on its --help on one
// version (server/tools.mjs: the prompt option, plan mode, resume, the sign-in check). A later version can drop or
// rename one, and a job would then fail to start or start the wrong way. This script finds the tools as the app does
// (that runs each one's version and its read-only sign-in check, e.g. "claude auth status"), then runs every installed
// tool's --help (no prompt, nothing signed in or out, no network of ours) and says which of those options it no longer
// names. A tool past its time limit is ended with every process it started.
// Run before a release (docs/release.md): node tools/check-tool-flags.mjs   (exit 1 when something is missing)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, createToolDetector, runArgv, envValue, killTree } from '../server/tools.mjs';

// The words a tool's --help must still name (pure): its prompt option (not for a plain argument), its plan options and
// values, its resume option or subcommand (Copilot's "--resume=" as "--resume"), the first word of its sign-in check
export function expectedTokens(tool) {
  const out = new Set();
  if (tool.prompt && tool.prompt !== 'arg') out.add(tool.prompt);
  for (const a of tool.plan || []) out.add(a);
  for (const a of tool.resume || []) out.add(a.replace(/=$/, ''));
  if (tool.ready?.length) out.add(tool.ready[0]);
  return [...out].filter(Boolean);
}

// The words a help text does not name (pure): as a whole word, case kept
export function missingIn(help, tokens) {
  const text = String(help || '');
  return tokens.filter((tok) => !new RegExp(`(^|[^\\w-])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`, 'm').test(text));
}

// The whole help text (stdout and stderr, at most 512 KB; runQuiet keeps 4 KB, enough for a version only), a hidden
// window, no input, a time limit. argv: runArgv's { cmd, args, verbatim }
function helpText(argv, cwd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(argv.cmd, argv.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: !!argv.verbatim });
    } catch {
      return resolve('');
    }
    const take = (d) => {
      if (out.length < 512 * 1024) out += d;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => killTree(spawn, child), timeoutMs);
    child.on('error', () => resolve(out));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function main() {
  const detector = createToolDetector();
  const found = await detector.detect({ refresh: true });
  const cmdExe = path.win32.join(envValue(process.env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
  let bad = 0;
  for (const tool of TOOLS) {
    const r = found.tools.find((x) => x.id === tool.id);
    if (!r?.chosen) {
      console.log(`${tool.name.padEnd(20)} not installed: not checked`);
      continue;
    }
    const argv = runArgv(r.chosen.file, r.chosen.ext, ['--help'], cmdExe);
    const help = argv ? await helpText(argv, path.win32.dirname(r.chosen.file)) : '';
    // No help text at all is its own failure (not every option "missing"): the tool did not answer
    if (!help.trim()) {
      bad++;
      console.log(`${tool.name.padEnd(20)} ${String(r.version || '?').padEnd(22)} NO HELP TEXT: --help printed nothing`);
      continue;
    }
    const missing = missingIn(help, expectedTokens(tool));
    if (missing.length) bad++;
    console.log(`${tool.name.padEnd(20)} ${String(r.version || '?').padEnd(22)} ${missing.length ? `MISSING: ${missing.join(', ')}` : 'ok'}`);
  }
  if (bad) {
    console.log(`\n${bad} tool(s) no longer name an option SiberSentez starts them with: check server/tools.mjs against their --help.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
