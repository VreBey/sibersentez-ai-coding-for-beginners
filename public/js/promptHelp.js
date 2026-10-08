// Permission prompt helper (docs/embedded-terminal.md, "What the AI asks"): when an AI tool in an embedded terminal
// asks the person for something (edit a file, run a command, fetch a page, trust a folder, sign in, accept a plan),
// a small box beside the terminal says in plain words what it asks and which answer is the safe one. It only
// explains: it never answers, never types into the terminal. Pure (tested in node): the terminal dock feeds it text.
// The prompt texts are the tools' own, as of 2026 (Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI); a text
// the helper does not know shows nothing.
import { esc } from './format.js';
import { t } from './i18n.js';
import { matchError, errorItemsHtml } from './setupCheck.js';

// ANSI escape sequences (colours, cursor moves, OSC titles) and carriage returns out; what is left is the text a
// person sees, near enough to match on
// Cursor moves stand for the space or the line break they draw: Claude Code 2.1.29x writes every space between words as
// ESC[1C and starts each line with ESC[row;colH (seen 2026-10-08 in SiberSentez's terminal; dropped, the words ran
// together and no question of the tool was recognized). A forward move becomes spaces (at most 200), a move to
// another row a line break; a move back to the line's start (ESC[1G, a redraw) is dropped as before.
export function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[(\d{0,4})C/g, (_, n) => ' '.repeat(Math.min(200, Math.max(1, Number(n) || 1))))
    .replace(/\u001b\[[\d;]{0,12}[Hf]|\u001b\[\d{0,4}[BEd]/g, '\n')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

// Kinds, most specific first. re: tested on the tail of the screen text (case-insensitive).
const PROMPTS = [
  // Claude Code 2.1.29x asks "Is this a project you created or one you trust? … Yes, I trust this folder" (seen 2026-10-08)
  { id: 'trust', re: /Do you trust (?:the files in this folder|the contents of this directory)\?|Is this a project you created or one you trust\?|Yes, I trust this folder|Confirm folder trust|Trust folder[\s\S]{0,200}Don't trust/i },
  { id: 'login', re: /Select login method|Sign in with (?:Google|ChatGPT)|Use Gemini API key/i },
  { id: 'edit', re: /Do you want to (?:make this edit to|create|overwrite)\s+([^\n?]{1,120})\?|Would you like to make the following edits\?|Apply this change\?/i },
  // A command before the network: Codex asks to run a command with "Reason: Need network access"
  { id: 'command', near: 1200, re: /Would you like to run the following command\?|Allow execution of:?\s*'?([^'?\n]{1,120})'?\?|Yes, and approve .{1,80} for the rest of the running session|Bash command[\s\S]{0,600}Do you want to proceed\?/i },
  { id: 'fetch', re: /allow Claude to fetch this content\?|Need network access|Do you want to allow access to\s+([^\n?]{1,160})\?/i },
  // A tool or an extension asks to be let in, as "Claude in Chrome wants to create a browser window and read your tabs
  // › 1. Allow 2. Deny (esc)" (seen when using the app, 2026-10-08): what it wants is the subject
  // Its own numbered choices and near the end only: prose that mentions allow and deny, or an answered one left above a
  // newer question, is not it (review 2026-10-08)
  { id: 'allow', near: 700, re: /([^\n]{2,80}?) wants to ([^\n]{3,160}?)\s*\n[\s\S]{0,300}?\b1\.\s*Allow\b[\s\S]{0,120}?\b2\.\s*Deny\b/i },
  // Gemini CLI's exit_plan_mode asks "Ready to start implementation?" (0.61, 2026-10-07)
  { id: 'plan', re: /No, keep planning|Ready to code\?|Ready to start implementation\?|Would you like to proceed\?/i },
  { id: 'confirm', near: 1200, re: /Do you want to proceed\?/i },
  // The tool was stopped (a permission denied, Esc) and asks what to do now: the person has to type (seen when using
  // the app, 2026-10-08: after "Deny" the job sat at "What should Claude do instead?" and nothing said to write).
  // Last, and only near the end: the line stays in the transcript once the tool goes on.
  { id: 'instead', near: 600, re: /What should Claude do instead\?/i },
];

// A command worth a second look before "Yes"
const RISKY_RE = /(?:^|[\s;&|(`$])(?:rm|rmdir|del|erase|format|shutdown|Remove-Item|rd)\b|git\s+push|git\s+reset\s+--hard|curl[^\n|]*\|\s*(?:sh|bash|iex)|irm[^\n|]*\|\s*iex|Invoke-Expression|\biex\b|chmod\s+-R|--force\b/i;
// Answers that give a wide or lasting permission
const WIDE_RE = /don't ask again|allow always|allow all edits|approve .{1,80} for the rest|remember this folder|auto-accept|Yes, auto mode/i;

// The command a prompt asks about: the line under "Bash command" (Claude Code) or after "$ " (Codex), else the
// quoted name (Gemini)
function commandOf(tail, m) {
  // Claude Code 2.1.29x: "Bash command · from the reviewer agent", a tip and a description, then the command in a box
  // line ("│ cd … && find …", seen 2026-10-08)
  // The command starts with a character that is no border, and a closing border is not part of it (an older layout
  // draws the whole box: "│ npm test │"; the empty "│   │" lines are skipped)
  const boxed = /Bash command[^\n]*\n(?:(?!\s*Do you want)[^\n]*\n){0,6}?\s*[│|]\s+([^\s│|][^\n]{0,299})/i.exec(tail);
  if (boxed) return boxed[1].replace(/\s*[│|]\s*$/, '').trim();
  const claude = /Bash command\s*\n\s*([^\n]{1,300})/i.exec(tail);
  if (claude) return claude[1].trim();
  const codex = /\n\s*\$\s+([^\n]{1,300})/.exec(tail);
  if (codex) return codex[1].trim();
  return m?.[1]?.trim() || '';
}

// A short stable mark of a question's text (pure): spaces and digits left out, an FNV-1a hash in base 36
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s).replace(/[\s\d]+/g, '')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

// What the tail of a terminal's text asks, or null. tail: the plain text of the last lines (stripAnsi first).
export function detectPrompt(tail) {
  const text = String(tail || '').slice(-2500);
  // "Near the end" is measured without the runs of spaces a wide terminal pads its lines and boxes with
  const flat = text.replace(/[ \t]+/g, ' ');
  for (const p of PROMPTS) {
    const src = p.near ? flat : text;
    const from = p.near ? Math.max(0, src.length - p.near) : 0;
    const m = p.re.exec(from ? src.slice(from) : src);
    if (!m) continue;
    const at = from + m.index;
    const hit = { id: p.id, detail: '', risky: false, wide: WIDE_RE.test(src.slice(at)) };
    if (p.id === 'command' || p.id === 'confirm') {
      // A command's question whose header slid just out of the end's reach is still that command's question; a long
      // command (a 30-line script) puts its header far above the question, so it is looked for well back (review)
      const back = src.slice(Math.max(0, at - 1600), at);
      const header = back.lastIndexOf('Bash command');
      if (p.id === 'confirm' && header >= 0) hit.id = 'command';
      hit.detail = commandOf(header >= 0 ? back.slice(header) : src.slice(Math.max(0, at - 700)), m);
      hit.risky = RISKY_RE.test(hit.detail);
    } else if (p.id === 'edit' || p.id === 'fetch') hit.detail = (m[1] || '').trim();
    else if (p.id === 'allow') hit.detail = `${m[1].trim()} wants to ${m[2].trim()}`.slice(0, 200);
    // The same prompt shown again (a redraw) has the same signature; a new one differs by kind or subject. A command or
    // a yes/no question with no subject read is told apart by its own text (digits out: a timer may tick in it): one
    // answered must not silence every later one (seen when using the app, 2026-10-08). It is asked only while it is
    // near the end of the screen, so its text is never cut by where the window starts (review 2026-10-08)
    hit.sig = `${hit.id}|${hit.detail}`;
    // When the window was cut (a long screen) and the question sits near its start, the text before it changes with
    // every chunk: the question's own words then (review 2026-10-08)
    const cut = String(tail || '').length >= 2500;
    if (!hit.detail && (hit.id === 'command' || hit.id === 'confirm')) hit.sig += `#${fingerprint(src.slice(at >= 400 ? at - 400 : cut ? at : 0, at + m[0].length))}`;
    return hit;
  }
  return null;
}

// Errors a beginner meets in a terminal (docs/embedded-terminal.md, "Known errors"). Only the exact sentences Windows,
// npm and the tools print: an AI tool's screen shows code and talk that merely mention "certificate" or "401", so the
// broad patterns of the pasted-error box (setupCheck.matchError) are not used to find an error, only to explain it.
const TERM_ERRORS = [
  /running scripts is disabled on this system|betik çalıştırma bu sistemde devre dışı|komut dosyalarının çalıştırılması (?:bu sistemde )?devre dışı/,
  /is not recognized as (?:the name of a cmdlet|an internal or external command)|iç ya da dış komut, çalıştırılabilir program ya da toplu iş dosyası olarak tanınmıyor|cmdlet, işlev, betik dosyası veya çalıştırılabilir program adı olarak tanınmıyor|: command not found/,
  /requires git-bash|claude_code_git_bash_path/,
  /npm (?:warn|err!) ebadengine|unsupported engine/,
  /invalid api key|please run \/login|credit balance is too low|authentication_error/,
  /usage limit reached|limit reached\b.{0,40}\bresets|rate_limit_error|overloaded_error/,
  // Gemini CLI and Qwen Code on a free key (review 2026-10-08): Google's quota answers
  /resource_exhausted|exceeded your current quota|reached your daily [^\n]{0,60}quota|quota exceeded for (?:quota )?metric/,
  /unable to get local issuer certificate|self[- ]signed certificate in certificate chain|could not establish trust relationship/,
  /\beperm\b: operation not permitted|\beacces\b: permission denied/,
  /getaddrinfo enotfound|connect econnrefused|connect etimedout/,
];

// The last local address a dev server printed in a terminal (Vite "Local: http://localhost:5173/", Next "- Local:
// http://localhost:3000", python -m http.server "http://0.0.0.0:8000/"), as a link to open, or null. This computer
// only (localhost, 127.0.0.1, 0.0.0.0 and [::1] become localhost), a port of 2-5 digits other than SiberSentez's
// own (ownPort), a plain path of at most 60 characters. Pure (2026-10-02).
const DEV_URL_RE = /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?!\d)(\/[\w\-./]{0,60})?/gi;
export function previewUrlIn(tail, ownPort = 0) {
  let found = null;
  for (const m of String(tail || '').matchAll(DEV_URL_RE)) {
    const port = Number(m[3]);
    if (port < 1 || port > 65535 || port === Number(ownPort)) continue;
    const host = m[2].toLowerCase() === '127.0.0.1' ? '127.0.0.1' : 'localhost';
    found = `${m[1].toLowerCase()}://${host}:${port}${(m[4] || '/').replace(/\.+$/, '')}`;
  }
  return found;
}

// A known error in the last lines of a terminal, or null. { id: 'error', results (matchError's, 1-2), sig }
export function detectError(tail) {
  const text = String(tail || '').slice(-800);
  const low = text.toLowerCase();
  for (const re of TERM_ERRORS) {
    const m = re.exec(low);
    if (!m) continue;
    const from = low.lastIndexOf('\n', m.index) + 1;
    const to = low.indexOf('\n', m.index + m[0].length);
    const line = text.slice(from, to < 0 ? text.length : to).trim();
    const results = matchError(text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 200)).filter((r) => r.id !== 'errUnknown').slice(0, 2);
    if (!results.length) continue;
    return { id: 'error', results, sig: `error|${results[0].id}|${line.slice(0, 200)}` };
  }
  return null;
}

// Errors of the person's own program (roadmap F2, the error translator): what a plain terminal of a project prints
// when the project is run (npm run dev, python app.py) and fails. Each one is said in plain words and can go to the
// AI tool as one sentence. Only in a plain terminal: in an AI tool's own tab the AI is reading the same error.
export const CODE_ERRORS = Object.freeze([
  Object.freeze({ id: 'module', re: /cannot find module ['"][^'"\n]{1,120}['"]|module not found: (?:error: )?can't resolve ['"][^'"\n]{1,120}['"]|modulenotfounderror: no module named ['"]?[\w.]{1,80}/ }),
  Object.freeze({ id: 'port', re: /eaddrinuse[^\n]{0,60}|port \d{2,5} is (?:already )?in use(?![^\n]{0,60}(?:trying|using available port))|address already in use/ }),
  Object.freeze({ id: 'script', re: /missing script: "?[\w:.-]{1,60}"?/ }),
  Object.freeze({ id: 'syntax', re: /\bsyntaxerror: [^\n]{1,160}|\bindentationerror: [^\n]{1,160}/ }),
  Object.freeze({ id: 'runtime', re: /\b(?:typeerror|referenceerror|rangeerror|nameerror|attributeerror|keyerror|valueerror|zerodivisionerror): [^\n]{1,160}/ }),
  Object.freeze({ id: 'build', re: /failed to compile|build failed|error during build|compilation failed|\berror ts\d{3,5}:[^\n]{0,160}/ }),
]);
const CODE_LINE_MAX = 160;

// A known error of the person's own program in the last lines of a plain terminal, or null:
// { id: 'code', kind, line, sig }. line: the line it is on, as printed (shortened, controls out)
export function detectCodeError(tail) {
  const text = String(tail || '').slice(-1500);
  const low = text.toLowerCase();
  let best = null;
  for (const e of CODE_ERRORS) {
    const m = e.re.exec(low);
    if (!m) continue;
    // The newest error on the screen wins (an old one scrolled above a newer one)
    if (best && m.index < best.index) continue;
    best = { e, index: m.index, len: m[0].length };
  }
  if (!best) return null;
  const from = low.lastIndexOf('\n', best.index) + 1;
  const to = low.indexOf('\n', best.index + best.len);
  const raw = text.slice(from, to < 0 ? text.length : to);
  const line = Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, CODE_LINE_MAX).join('');
  if (!line) return null;
  return { id: 'code', kind: best.e.id, line, sig: `code|${best.e.id}|${line}` };
}

// The sentence that goes to the AI tool for a code error (one line, at most AI_DRAFT_MAX characters, dockState.js)
export function codeFixText(hit) {
  if (!hit || hit.id !== 'code') return '';
  return t('phAskText', { line: hit.line });
}

// The box (HTML). hit: detectPrompt's, detectError's or detectCodeError's answer.
export function promptHelpHtml(hit) {
  if (!hit) return '';
  if (hit.id === 'code') {
    return `<div class="ph-head"><b>${esc(t('phTitle_code'))}</b><button type="button" class="icon-btn ph-close" data-ph="close" aria-label="${esc(t('phHide'))}" title="${esc(t('phHide'))}">×</button></div><code translate="no">${esc(hit.line)}</code><p>${esc(t(`phCode_${hit.kind}`))}</p><button type="button" class="act-btn primary ph-ask" data-ph="ask">${esc(t('phAsk'))}</button><p class="ph-foot">${esc(t('phFoot_code'))}</p>`;
  }
  if (hit.id === 'error') {
    return `<div class="ph-head"><b>${esc(t('phTitle_error'))}</b><button type="button" class="icon-btn ph-close" data-ph="close" aria-label="${esc(t('phHide'))}" title="${esc(t('phHide'))}">×</button></div>${errorItemsHtml(hit.results)}${hit.results.some((r) => r.fixes?.length) ? `<p class="ph-foot">${esc(t('phFoot_error'))}</p>` : ''}`;
  }
  const detail = hit.detail ? `<code translate="no">${esc(hit.detail.length > 140 ? hit.detail.slice(0, 139) + '…' : hit.detail)}</code>` : '';
  const warn = [hit.risky ? t('phRisky') : '', hit.wide ? t('phWide') : ''].filter(Boolean).map((w) => `<p class="ph-warn">${esc(w)}</p>`).join('');
  return `<div class="ph-head"><b>${esc(t(`phTitle_${hit.id}`))}</b><button type="button" class="icon-btn ph-close" data-ph="close" aria-label="${esc(t('phHide'))}" title="${esc(t('phHide'))}">×</button></div>${detail}<p>${esc(t(`phWhat_${hit.id}`))}</p><p class="ph-pick">${esc(t(`phPick_${hit.id}`))}</p>${warn}<p class="ph-foot">${esc(t(hit.id === 'instead' ? 'phFoot_instead' : 'phFoot'))}</p>`;
}
