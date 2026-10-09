// @ts-check
// "Start with AI" (docs/ai-start.md): the first-message file, the launcher and the command lines that open an AI tool
// in Windows Terminal. Pure apart from the small file helpers at the end (injectable fs), so every rule is tested
// without starting anything.
//
// How the tool reaches the terminal. Windows Terminal (wt.exe) reads ';' as a command separator even inside quotes,
// and how it quotes an argument with spaces again for the program it starts is not documented. So no tool path, no
// prompt and no user text is ever an argument of wt.exe. SiberSentez writes a one-line launcher (<id>.cmd, ASCII only)
// into its own folder and wt starts only `cmd.exe /d /v:off /k <launcher>`:
//   absolute  the launcher's full path has no space and only safe ASCII characters: wt -d <project folder> ...
//             cmd.exe /d /v:off /k C:\...\launch\<id>.cmd
//   relative  otherwise (a user name with a space or a Turkish letter): wt -d <launcher folder> ... cmd.exe /d /v:off
//             /k .\<id>.cmd, and the launcher changes to the project folder (cd /d "..."). The .\ names cmd's working
//             directory, SiberSentez's own folder (never a project folder), and still works when the parent process set
//             NoDefaultCurrentDirectoryInExePath (a bare name would then not be found).
// The launcher's first line (NO_CWD_SEARCH_LINE) stops cmd from looking a bare program name up in the project folder.
// Paths inside the launcher are written with %USERPROFILE%, %LOCALAPPDATA%, ... where they start with one, so the file
// stays ASCII and holds no user name; a path that is still not plain ASCII is refused (the plain terminal still works).
//
// Linux and macOS (plan G1, G2): no Windows Terminal. The tool starts in SiberSentez's own terminal only, from a small
// sh launcher (<id>.sh, shellLauncherText) run as `/bin/sh <launcher>` in the project folder; every path in it is
// single-quoted, so no character of a folder name is read as shell syntax.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newJobId, validJobId, jobMessageName } from './job-id.mjs';
import { PLATFORM, isLocalAbsolute, platformOf } from './platform.mjs';

export const FIRST_DIR = '.sibersentez';
// The folder's name before the product was renamed (2026-09-30)
export const LEGACY_FIRST_DIR = '.orkestra';

// A project that still has the old folder and not the new one: the old one is renamed (it is SiberSentez's own
// folder: the first messages and the team's plan, tasks and reviews), so the team goes on where it was. Nothing is
// done when both exist or the old one is not a real folder. Returns true when it moved.
export function takeOverLegacyFolder(dir, xfs = fs) {
  try {
    const legacy = path.join(dir, LEGACY_FIRST_DIR);
    const st = xfs.lstatSync(legacy);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    try {
      xfs.lstatSync(path.join(dir, FIRST_DIR));
      return false;
    } catch (e) {
      if (e?.code !== 'ENOENT') return false;
    }
    xfs.renameSync(legacy, path.join(dir, FIRST_DIR));
    return true;
  } catch {
    return false;
  }
}
const FIRST_BASE = 'ilk-mesaj';
// Other names tried when .sibersentez/ilk-mesaj.md already holds something else: ilk-mesaj-2.md ... ilk-mesaj-9.md
export const FIRST_NAMES = Object.freeze([`${FIRST_BASE}.md`, ...Array.from({ length: 8 }, (_, i) => `${FIRST_BASE}-${i + 2}.md`)]);
export const GITIGNORE_TEXT = '*\n';
const MAX_EXISTING = 64 * 1024; // an existing file larger than this is never read (it is not ours)

// The fixed prompt: plain ASCII words, no character any shell or Windows Terminal treats specially
export const PROMPT_SAFE_RE = /^[A-Za-z0-9 .,'/_-]{1,200}$/;
export function launchPrompt(fileName) {
  const p = `Please read ${FIRST_DIR}/${fileName} and follow it. Reply in the user's language.`;
  if ((!FIRST_NAMES.includes(fileName) && !/^job-J[0-9a-f]{32}\.md$/.test(fileName)) || !PROMPT_SAFE_RE.test(p)) throw new Error('unsafe prompt');
  return p;
}

// Arguments that start a tool interactively with the prompt (null: no prompt). tool.prompt: 'arg' or an option.
// A job (docs/simplify.md) starts the tool in its own plan mode when it has one (tools.mjs plan: Claude Code, Gemini
// CLI): it reads and plans first and asks the person to approve the plan in its own prompt. SiberSentez never answers
// that question itself. A tool without a known plan mode starts as usual (the job file asks it for the plan first).
export function jobArgs(tool, version = null) {
  if (!Array.isArray(tool?.plan)) return [];
  if (tool.planMin && !(versionAtLeast(version, tool.planMin))) return [];
  return [...tool.plan];
}

// The arguments that continue a session of that tool (server/tools.mjs resume): the id after them, or joined to the
// last one when it ends with "=" (Copilot CLI's optional value: --resume=<id>)
export function resumeArgs(tool, id) {
  const r = Array.isArray(tool?.resume) ? [...tool.resume] : [];
  if (!r.length || typeof id !== 'string' || !id) return [];
  const last = r[r.length - 1];
  return last.endsWith('=') ? [...r.slice(0, -1), `${last}${id}`] : [...r, id];
}

// "0.61.2" >= "0.61.0" (the numbers of a version text, in order); false when either has none
export function versionAtLeast(version, min) {
  const a = String(version || '').match(/\d+(?:\.\d+)*/)?.[0]?.split('.').map(Number);
  const b = String(min || '').match(/\d+(?:\.\d+)*/)?.[0]?.split('.').map(Number);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

export function toolArgs(tool, prompt) {
  if (!prompt) return [];
  return tool.prompt === 'arg' ? [prompt] : [tool.prompt, prompt];
}

// The first message (UTF-8 Markdown). The idea is the one the person saved with the project (at most 300 characters,
// cleaned by the server); each of its lines is quoted. The instructions are English so that every tool reads them the
// same way; the tool is asked to talk in the language of the idea.
export function firstMessageText(idea) {
  const quoted = String(idea || '')
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return [
    '# First message from SiberSentez',
    '',
    'SiberSentez wrote this file so that you start from my project idea. It is not part of the project: the',
    '.sibersentez folder has its own .gitignore.',
    '',
    '## My idea',
    '',
    quoted,
    '',
    '## What I want from you',
    '',
    '1. Work out a plan for this idea with me, step by step. I may be new to coding: use plain words.',
    '2. Ask me one question at a time and wait for my answer before the next one.',
    '3. Where you can, offer 2 to 4 numbered choices and say which one you recommend, so I can answer with a',
    '   number. Leave room for my own answer. If your question tool numbers its options itself, do not put numbers',
    '   in the option labels too.',
    '4. Do not write or change code before I say the plan is right.',
    '5. When the plan is clear, write it to PLAN.md in the project folder and tell me what the first step is.',
    '6. If the idea-to-plan skill is installed, use it.',
    '',
    'Talk to me in the language my idea is written in.',
    '',
  ].join('\n');
}

// The first message of "Do a job" (docs/kit-in-app.md): the job the person typed (fit.mjs normalizeJob: its lines
// kept, at most JOB_MAX characters), each line quoted, and the team flow of the SiberSentez kit (docs/kit-v2.md §3). The tool uses the orchestrate
// skill when it is installed; otherwise it follows the same steps itself. SiberSentez writes nothing into the project's
// own files: the tool may offer the starter lines of agent-rules, and adds them only after the person's yes.
export function jobMessageText(job, jobId = newJobId()) {
  if (!validJobId(jobId)) throw new Error('invalid job id');
  const quoted = String(job || '')
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return [
    '# A job from SiberSentez',
    '',
    `Job-ID: ${jobId}`,
    '',
    'SiberSentez wrote this file so that you start from the job below. It is not part of the project: the .sibersentez',
    'folder has its own .gitignore.',
    '',
    '## The job',
    '',
    quoted,
    '',
    '## How I want it done',
    '',
    'Keep the Job-ID above for this job, including when resuming. Before any build, copy it as a top-level',
    'Job-ID: line below the title in .sibersentez/PLAN.md and TASKS.md, and immediately below every review heading',
    'in .sibersentez/REVIEW.md. Pass it to every helper. Never copy an old review into this job or relabel it.',
    'The app owns .sibersentez/current-job.json; do not edit it. If it names another job, stop and explain that',
    'a newer job was started. Existing plans, tasks and reviews with another or missing id belong to earlier work;',
    'preserve them and make a fresh plan for this job. Always finish with an independent whole-job review under',
    '## Review: whole job, with this Job-ID and a final VERDICT object containing verdict (APPROVE or REVISE),',
    'blockers (an array) and nits (an array).',
    '',
    '1. Use the orchestrate skill for this job if it is installed. It runs Plan, Build, Check and Finish with a small',
    '   team of roles and keeps its files in the .sibersentez folder.',
    '2. If it is not installed, follow the same steps yourself: agree a short plan with me, build in small steps, check',
    '   the result with a fresh look, and tell me plainly what is done.',
    '3. I decide twice: I approve the plan before any code is written, and I approve the result at the end. Ask me',
    '   before you delete, move or overwrite files, install anything, push, publish or pay.',
    '   If you started in plan mode, read what you need, then show me the plan with your plan tool: I approve it there',
    '   (SiberSentez shows it to me as well). Keep the plan short: the steps, the files, how you will check it.',
    '4. I may be new to coding: use plain words, one question at a time, with 2 to 4 numbered choices where you can',
    '   (if your question tool numbers its options itself, leave the numbers out of the labels).',
    '5. If this project has no AGENTS.md or CLAUDE.md starter lines from SiberSentez and the agent-rules skill is',
    '   installed, offer once to add them. Add them only after I say yes.',
    '',
    'Talk to me in the language the job is written in.',
    '',
  ].join('\n');
}

// ---------------- paths in the launcher ----------------

// Environment variables a path may start with, most specific first. cmd expands them when it runs the launcher.
const PATH_VARS = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles(x86)', 'ProgramFiles', 'ProgramData', 'SystemRoot'];
// What may follow the variable (and a path with no variable) inside double quotes in a batch file: ASCII without
// % (expanded even in quotes), " (ends the quoting), ! ^ & | < > ; and controls
const BATCH_REST_RE = /^[A-Za-z0-9 _.\\:()\-+,~'@#$[\]{}=]*$/;

function envGet(env, name) {
  if (!env) return '';
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k && typeof env[k] === 'string' ? env[k] : '';
}

// A path as the launcher writes it (pure): %VAR%\rest when it starts with one of PATH_VARS (the longest match), the
// path itself otherwise. { ok: true, expr } or { ok: false } when the rest is not plain safe ASCII.
export function batchPath(p, env) {
  if (typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p)) return { ok: false };
  const norm = path.win32.normalize(p);
  let best = null;
  for (const name of PATH_VARS) {
    let v = envGet(env, name);
    if (!v || !/^[A-Za-z]:\\/.test(v)) continue;
    v = path.win32.normalize(v).replace(/\\+$/, '');
    const low = norm.toLowerCase();
    const vl = v.toLowerCase();
    if ((low === vl || low.startsWith(vl + '\\')) && (!best || v.length > best.v.length)) best = { name, v };
  }
  const rest = best ? norm.slice(best.v.length) : norm;
  if (!BATCH_REST_RE.test(rest)) return { ok: false };
  return { ok: true, expr: best ? `%${best.name}%${rest}` : rest };
}

// A launcher path that may be a bare argument of wt.exe and cmd.exe: drive, then folders of letters, digits, _ . ~ -
export const SAFE_LAUNCH_RE = /^[A-Za-z]:\\(?:[A-Za-z0-9_.~-]+\\)*[A-Za-z0-9_.~-]+$/;
export const LAUNCHER_NAME_RE = /^[0-9a-f]{12}\.(?:cmd|sh)$/;
export const newLauncherName = (rand = crypto.randomBytes, plat = PLATFORM) => `${rand(6).toString('hex')}${plat.windows ? '.cmd' : '.sh'}`;

// The first line of every launcher. cmd looks a bare program name up in the working folder before PATH, and the
// working folder is the project, which may not be trusted: an npm shim (gemini.cmd, ...) calls a bare `node`, so a
// node.exe, node.bat or node.cmd in the project would run instead of Node.js. With this variable set cmd (and every
// program started from this shell, through CreateProcess's search) skips the working folder. It stays set in the shell
// that remains open after the tool: a program in the project folder is started there as .\name.
const NO_CWD_SEARCH_LINE = '@set NoDefaultCurrentDirectoryInExePath=1';

// The tool ended, the shell stays open (docs/embedded-terminal.md §7): the launcher leaves <launcher>.ended next to
// itself once the tool's line returns, and the desktop shell sees it, so an open tab is never taken for a working AI.
// The path is taken before any cd (relative mode), so the mark never lands in the project. Ctrl+C answered "Y" at
// "Terminate batch job" skips it: the tab then still counts as running (the safe side for a restore).
export const ENDED_SUFFIX = '.ended';
export const ENDED_PATH_LINE = '@set "SIBERSENTEZ_ENDED=%~f0.ended"';
export const ENDED_MARK_LINE = '@type nul>"%SIBERSENTEZ_ENDED%" 2>nul';

// The launcher text (pure). tool: the found install ({ file, ext }); args: toolArgs(); cdDir: the folder to change
// to first (relative mode) or null. { ok: true, text } or { ok: false, error: 'tool-path-unsafe' | 'folder-path-unsafe' }.
// Every line starts with @ (no echo; "@echo off" would hide the prompt of the shell that stays open after the tool).
// The first line is NO_CWD_SEARCH_LINE.
export function launcherText({ toolName, file, ext, args, cdDir = null, env }) {
  const exe = batchPath(file, env);
  if (!exe.ok) return { ok: false, error: 'tool-path-unsafe' };
  const lines = [NO_CWD_SEARCH_LINE, `@rem SiberSentez: starts ${String(toolName).replace(/[^A-Za-z0-9 .-]/g, '')} in the project folder (docs/ai-start.md). Removed after 24 hours.`, ENDED_PATH_LINE];
  if (cdDir) {
    const dir = batchPath(cdDir, env);
    if (!dir.ok) return { ok: false, error: 'folder-path-unsafe' };
    lines.push(`@cd /d "${dir.expr}" || exit /b 1`);
  }
  // An option, or an option with a session's UUID joined to it (Copilot CLI's --resume=<id>), or a safe word
  for (const a of args) if (!PROMPT_SAFE_RE.test(a) && !/^-{1,2}[a-z]+(?:=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(a)) return { ok: false, error: 'tool-path-unsafe' };
  const tail = args.map((a) => (/^-/.test(a) ? a : `"${a}"`)).join(' ');
  const call = ext === '.exe' ? '' : 'call ';
  lines.push(`@${call}"${exe.expr}"${tail ? ' ' + tail : ''}`, ENDED_MARK_LINE);
  const text = lines.join('\r\n') + '\r\n';
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) return { ok: false, error: 'tool-path-unsafe' };
  return { ok: true, text };
}

// The sh launcher (pure; Linux and macOS): the same work as the cmd one. "$0" is the launcher's own absolute path
// (it is run as /bin/sh <full path>), so the ended mark is taken before any cd and never lands in the project; after
// the tool the person's own shell takes the terminal over (as cmd /k keeps it). Every path single-quoted ('\'' for a
// quote in it); a path with a line break or a NUL, or not absolute, is refused. The text is UTF-8: a Turkish folder
// name is fine here.
const POSIX = platformOf('linux');
const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const SH_PATH_OK = (p) => isLocalAbsolute(p, POSIX) && !/[\u0000-\u001f\u007f]/.test(p);
export function shellLauncherText({ toolName, file, args, cdDir = null, shell }) {
  if (!SH_PATH_OK(file)) return { ok: false, error: 'tool-path-unsafe' };
  if (!shell || !SH_PATH_OK(shell.file) || !(shell.args || []).every((a) => /^-[a-z]+$/.test(a))) return { ok: false, error: 'tool-path-unsafe' };
  const lines = ['#!/bin/sh', `# SiberSentez: starts ${String(toolName).replace(/[^A-Za-z0-9 .-]/g, '')} in the project folder (docs/ai-start.md). Removed after 24 hours.`, 'ended="$0.ended"'];
  if (cdDir) {
    if (!SH_PATH_OK(cdDir)) return { ok: false, error: 'folder-path-unsafe' };
    lines.push(`cd -- ${shQuote(cdDir)} || exit 1`);
  }
  for (const a of args) if (!PROMPT_SAFE_RE.test(a) && !/^-{1,2}[a-z]+(?:=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(a)) return { ok: false, error: 'tool-path-unsafe' };
  // Every argument quoted, options too (review G: an option was written bare)
  const tail = args.map(shQuote).join(' ');
  // The tool's own folder first on PATH: a tool nvm installed runs "#!/usr/bin/env node", and nvm's PATH lives only in
  // the shell's profile, which an app started from the desktop never read (review G). Ctrl+C reaches the tool, never
  // the launcher (a handler, not an ignore: the tool still gets it), so the ended mark and the shell always follow.
  const dir = file.slice(0, file.lastIndexOf('/')) || '/';
  // ${PATH:+:$PATH}: an empty PATH adds no empty entry (one that would mean the project folder); a folder with a ':'
  // in its name would split PATH, so then it is left as it is
  const pathLine = dir.includes(':') ? [] : [`PATH=${shQuote(dir)}\${PATH:+:$PATH}; export PATH`];
  lines.push(...pathLine, "trap ':' INT", `${shQuote(file)}${tail ? ' ' + tail : ''}`, "trap - INT", ': > "$ended" 2>/dev/null', `exec ${shQuote(shell.file)}${(shell.args || []).map((a) => ' ' + a).join('')}`);
  return { ok: true, text: lines.join('\n') + '\n' };
}

// Where the launcher goes and how wt reaches it (pure). candidates: SiberSentez's launcher folders in order (the hub's
// launch folder, then %LOCALAPPDATA%\SiberSentez\launch); unsafe(p): the Windows Terminal argument guard.
// { ok: true, mode: 'absolute' | 'relative', dir } or { ok: false }.
export function pickLaunchDir(candidates, unsafe, plat = PLATFORM) {
  // Linux and macOS: the first local absolute folder; sh gets the launcher as an argument, nothing parses it
  if (!plat.windows) {
    const d = candidates.find((x) => typeof x === 'string' && SH_PATH_OK(x));
    return d ? { ok: true, mode: 'absolute', dir: d } : { ok: false };
  }
  const list = candidates.filter((d) => typeof d === 'string' && /^[A-Za-z]:\\/.test(d));
  const abs = list.find((d) => SAFE_LAUNCH_RE.test(d));
  if (abs) return { ok: true, mode: 'absolute', dir: abs };
  const rel = list.find((d) => !unsafe(d));
  return rel ? { ok: true, mode: 'relative', dir: rel } : { ok: false };
}

// wt.exe argv (pure). absolute: the tab opens in the project folder and cmd runs the launcher by full path; relative:
// the tab opens in the launcher folder, cmd runs the launcher as .\<name> and the launcher changes to the project folder.
// The tab keeps the project's name (--suppressApplicationTitle), as the Claude Code session actions do.
export function buildAiArgv({ mode, dir, launchDir, launcher, title, cmdExe }) {
  const start = mode === 'absolute' ? dir : launchDir;
  const target = mode === 'absolute' ? path.win32.join(launchDir, launcher) : '.\\' + launcher;
  return ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', start, '--title', title, '--suppressApplicationTitle', cmdExe, '/d', '/v:off', '/k', target];
}

// Without Windows Terminal: a console window of its own through `start` (as the plain terminal's fallback), started
// with the same working directory as the tab (the project folder, or the launcher folder in relative mode). Nothing
// from the request is on this command line.
export function buildAiFallbackArgv({ mode, launchDir, launcher, cmdExe }) {
  const target = mode === 'absolute' ? path.win32.join(launchDir, launcher) : '.\\' + launcher;
  return [cmdExe, '/d', '/c', 'start', '', cmdExe, '/d', '/v:off', '/k', target];
}

// ---------------- files (fs injectable) ----------------

// The .sibersentez folder may be missing (created) or a real folder; a file, a link or a junction in its place blocks
// the start (nothing is written through a link).
function folderState(dir, xfs) {
  try {
    const st = xfs.lstatSync(path.join(dir, FIRST_DIR));
    return st.isDirectory() && !st.isSymbolicLink() ? 'folder' : 'blocked';
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'blocked';
  }
}

// An existing entry: 'same' when it is a plain file with exactly this text, else 'other'
function entryState(file, text, xfs) {
  let st;
  try {
    st = xfs.lstatSync(file);
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'other';
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_EXISTING) return 'other';
  try {
    return xfs.readFileSync(file, 'utf8') === text ? 'same' : 'other';
  } catch {
    return 'other';
  }
}

// What starting would write into the folder (read-only). The first free name holds the message: the same text there
// already is used as it is (nothing written), another text is never overwritten (the next name is tried).
// { ok: true, folder: 'create' | 'keep', file, op: 'create' | 'same', gitignore: 'create' | 'keep' } or
// { ok: false, error: 'first-message-blocked' | 'first-message-busy' }.
export function planFirstMessage(dir, text, xfs = fs, jobId = null) {
  const names = jobId ? [jobMessageName(jobId)] : FIRST_NAMES;
  const folder = folderState(dir, xfs);
  if (folder === 'blocked') return { ok: false, error: 'first-message-blocked' };
  const gitignore = folder === 'missing' || entryState(path.join(dir, FIRST_DIR, '.gitignore'), GITIGNORE_TEXT, xfs) === 'missing' ? 'create' : 'keep';
  if (folder === 'missing') return { ok: true, folder: 'create', file: names[0], op: 'create', gitignore };
  for (const name of names) {
    const s = entryState(path.join(dir, FIRST_DIR, name), text, xfs);
    if (s === 'missing') return { ok: true, folder: 'keep', file: name, op: 'create', gitignore };
    if (s === 'same') return { ok: true, folder: 'keep', file: name, op: 'same', gitignore };
  }
  return { ok: false, error: 'first-message-busy' };
}

// Writes the first message (and .sibersentez/.gitignore when missing). Every file is created exclusively ('wx'): an
// entry that appears meanwhile is never overwritten, it is read and compared like in planFirstMessage.
// Returns the plan that was carried out, or { ok: false, error } ('first-message-failed' on a write error).
export function writeFirstMessage(dir, text, xfs = fs, jobId = null) {
  const names = jobId ? [jobMessageName(jobId)] : FIRST_NAMES;
  takeOverLegacyFolder(dir, xfs);
  const folderPath = path.join(dir, FIRST_DIR);
  let folder = folderState(dir, xfs);
  if (folder === 'blocked') return { ok: false, error: 'first-message-blocked' };
  try {
    if (folder === 'missing') {
      xfs.mkdirSync(folderPath);
      if (folderState(dir, xfs) !== 'folder') return { ok: false, error: 'first-message-blocked' };
    }
  } catch (e) {
    if (e?.code !== 'EEXIST' || folderState(dir, xfs) !== 'folder') return { ok: false, error: 'first-message-failed' };
    folder = 'folder';
  }
  const create = (file, data) => {
    try {
      xfs.writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' });
      return 'create';
    } catch (e) {
      return e?.code === 'EEXIST' ? 'exists' : 'failed';
    }
  };
  let gitignore = 'keep';
  if (entryState(path.join(folderPath, '.gitignore'), GITIGNORE_TEXT, xfs) === 'missing') {
    const g = create(path.join(folderPath, '.gitignore'), GITIGNORE_TEXT);
    if (g === 'failed') return { ok: false, error: 'first-message-failed' };
    gitignore = g === 'create' ? 'create' : 'keep';
  }
  for (const name of names) {
    const file = path.join(folderPath, name);
    const s = entryState(file, text, xfs);
    if (s === 'same') return { ok: true, folder: folder === 'missing' ? 'create' : 'keep', file: name, op: 'same', gitignore };
    if (s !== 'missing') continue;
    const w = create(file, text);
    if (w === 'create') return { ok: true, folder: folder === 'missing' ? 'create' : 'keep', file: name, op: 'create', gitignore };
    if (w === 'failed') return { ok: false, error: 'first-message-failed' };
    if (entryState(file, text, xfs) === 'same') return { ok: true, folder: 'keep', file: name, op: 'same', gitignore };
  }
  return { ok: false, error: 'first-message-busy' };
}

// Removes launchers older than maxAgeMs from a launcher folder (only names SiberSentez makes). Returns the count.
export function cleanupLaunchers(dir, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, xfs = fs } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = xfs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    // A launcher, or the mark it left when its tool ended (ENDED_SUFFIX): both go after a day
    if (!LAUNCHER_NAME_RE.test(n) && !(n.endsWith(ENDED_SUFFIX) && LAUNCHER_NAME_RE.test(n.slice(0, -ENDED_SUFFIX.length)))) continue;
    const f = path.join(dir, n);
    try {
      const st = xfs.lstatSync(f);
      if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
        xfs.unlinkSync(f);
        removed++;
      }
    } catch {
      // gone or locked: tried again next time
    }
  }
  return removed;
}
