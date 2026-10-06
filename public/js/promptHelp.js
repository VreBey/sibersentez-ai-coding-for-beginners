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
export function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

// Kinds, most specific first. re: tested on the tail of the screen text (case-insensitive).
const PROMPTS = [
  { id: 'trust', re: /Do you trust (?:the files in this folder|the contents of this directory)\?|Confirm folder trust|Trust folder[\s\S]{0,200}Don't trust/i },
  { id: 'login', re: /Select login method|Sign in with (?:Google|ChatGPT)|Use Gemini API key/i },
  { id: 'edit', re: /Do you want to (?:make this edit to|create|overwrite)\s+([^\n?]{1,120})\?|Would you like to make the following edits\?|Apply this change\?/i },
  // A command before the network: Codex asks to run a command with "Reason: Need network access"
  { id: 'command', re: /Would you like to run the following command\?|Allow execution of:?\s*'?([^'?\n]{1,120})'?\?|Yes, and approve .{1,80} for the rest of the running session|Bash command[\s\S]{0,600}Do you want to proceed\?/i },
  { id: 'fetch', re: /allow Claude to fetch this content\?|Need network access|Do you want to allow access to\s+([^\n?]{1,160})\?/i },
  { id: 'plan', re: /No, keep planning|Ready to code\?|Would you like to proceed\?/i },
  { id: 'confirm', re: /Do you want to proceed\?/i },
];

// A command worth a second look before "Yes"
const RISKY_RE = /(?:^|[\s;&|(`$])(?:rm|rmdir|del|erase|format|shutdown|Remove-Item|rd)\b|git\s+push|git\s+reset\s+--hard|curl[^\n|]*\|\s*(?:sh|bash|iex)|irm[^\n|]*\|\s*iex|Invoke-Expression|\biex\b|chmod\s+-R|--force\b/i;
// Answers that give a wide or lasting permission
const WIDE_RE = /don't ask again|allow always|allow all edits|approve .{1,80} for the rest|remember this folder|auto-accept|Yes, auto mode/i;

// The command a prompt asks about: the line under "Bash command" (Claude Code) or after "$ " (Codex), else the
// quoted name (Gemini)
function commandOf(tail, m) {
  const claude = /Bash command\s*\n\s*([^\n]{1,300})/i.exec(tail);
  if (claude) return claude[1].trim();
  const codex = /\n\s*\$\s+([^\n]{1,300})/.exec(tail);
  if (codex) return codex[1].trim();
  return m?.[1]?.trim() || '';
}

// What the tail of a terminal's text asks, or null. tail: the plain text of the last lines (stripAnsi first).
export function detectPrompt(tail) {
  const text = String(tail || '').slice(-2500);
  for (const p of PROMPTS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const hit = { id: p.id, detail: '', risky: false, wide: WIDE_RE.test(text.slice(m.index)) };
    if (p.id === 'command' || p.id === 'confirm') {
      hit.detail = commandOf(text.slice(Math.max(0, m.index - 700)), m);
      hit.risky = RISKY_RE.test(hit.detail);
    } else if (p.id === 'edit' || p.id === 'fetch') hit.detail = (m[1] || '').trim();
    // The same prompt shown again (a redraw) has the same signature; a new one differs by kind or subject
    hit.sig = `${hit.id}|${hit.detail}`;
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

// The box (HTML). hit: detectPrompt's or detectError's answer.
export function promptHelpHtml(hit) {
  if (!hit) return '';
  if (hit.id === 'error') {
    return `<div class="ph-head"><b>${esc(t('phTitle_error'))}</b><button type="button" class="icon-btn ph-close" data-ph="close" aria-label="${esc(t('phHide'))}" title="${esc(t('phHide'))}">×</button></div>${errorItemsHtml(hit.results)}${hit.results.some((r) => r.fixes?.length) ? `<p class="ph-foot">${esc(t('phFoot_error'))}</p>` : ''}`;
  }
  const detail = hit.detail ? `<code translate="no">${esc(hit.detail.length > 140 ? hit.detail.slice(0, 139) + '…' : hit.detail)}</code>` : '';
  const warn = [hit.risky ? t('phRisky') : '', hit.wide ? t('phWide') : ''].filter(Boolean).map((w) => `<p class="ph-warn">${esc(w)}</p>`).join('');
  return `<div class="ph-head"><b>${esc(t(`phTitle_${hit.id}`))}</b><button type="button" class="icon-btn ph-close" data-ph="close" aria-label="${esc(t('phHide'))}" title="${esc(t('phHide'))}">×</button></div>${detail}<p>${esc(t(`phWhat_${hit.id}`))}</p><p class="ph-pick">${esc(t(`phPick_${hit.id}`))}</p>${warn}<p class="ph-foot">${esc(t('phFoot'))}</p>`;
}
