// @ts-check
// Diagnostics (docs/shell.md, "Diagnostics"): the text Settings copies for a problem report. It says which SiberSentez,
// which Windows and which AI tools, and what the setup check found, so whoever helps does not have to ask. It holds
// no folder path, no user name, no project name and no account: only versions and fixed words. diagnosticsText is
// pure (tested in node); collectDiagnostics asks the server. The labels are English, like a log: the text is for
// whoever helps, and it reads the same in both languages.
import { diagnose } from './setupCheck.js';
import { TOOL_ORDER, TOOL_INFO } from './views/tools.js';

// A version or a word from the server, kept only when it looks like one (never a path)
const WORD_RE = /^[\w .()+-]{1,40}$/;
const word = (v) => (typeof v === 'string' && WORD_RE.test(v) ? v : null);

function toolLine(x) {
  if (!x.installed) return `- ${x.name}: not installed${x.app ? ' (the desktop app is there, the command is not)' : ''}`;
  const bits = [x.via || 'other', `signed in: ${x.ready}`];
  if (x.onPath === false) bits.push(`not on PATH (${x.pathDir || 'other folder'})`);
  if (x.installs > 1) bits.push(`${x.installs} installs: ${(x.others || []).map((o) => [o.via, o.version].filter(Boolean).join(' ')).join(', ')}`);
  return `- ${x.name} ${x.version || '(version unknown)'} (${bits.join('; ')})`;
}

// { about (GET /api/about), tools (the tools state), mode, lang, desktop (the desktop app or a browser), pageErrors (how
// many errors the page met this run, pageErrors.js; their text stays in the log), now } -> text
export function diagnosticsText({ about = null, tools = null, mode = 'off', lang = 'en', desktop = false, pageErrors = null, now = Date.now() } = {}) {
  const a = about && typeof about === 'object' ? about : {};
  const head = [`SiberSentez ${word(a.version) || '(version unknown)'}`, word(a.os), word(a.arch), word(a.electron) ? `Electron ${word(a.electron)}` : null, word(a.node) ? `server Node ${word(a.node)}` : null].filter(Boolean);
  const lines = [head.join(' · '), `Language: ${lang === 'tr' ? 'tr' : 'en'} · Actions: ${['off', 'dry', 'live'].includes(mode) ? mode : 'off'} · ${desktop ? 'desktop app' : 'browser'}`];
  if (tools?.status === 'ready') {
    const node = tools.node;
    lines.push(`Node.js: ${node?.installed ? node.version || 'installed' : 'not found'}`);
    const git = tools.git;
    lines.push(`Git: ${!git ? 'unknown' : !git.installed ? 'not found' : git.onPath ? 'installed' : 'installed, not on PATH'}`);
    if (tools.env) lines.push(`ANTHROPIC_API_KEY set: ${tools.env.anthropicKey ? 'yes' : 'no'}`);
    lines.push('AI tools:');
    for (const id of TOOL_ORDER) {
      const x = (tools.tools || []).find((y) => y.id === id);
      if (x) lines.push(toolLine(x));
    }
    const found = diagnose(tools);
    lines.push(`Setup check: ${found.length ? found.map((p) => (p.tool ? `${p.id} (${TOOL_INFO[p.tool]?.name || p.tool})` : p.id)).join(', ') : 'nothing found'}`);
  } else lines.push('AI tools: not checked (the check did not answer)');
  if (Number.isInteger(pageErrors) && pageErrors >= 0) lines.push(`Page errors this run: ${pageErrors}${pageErrors && desktop ? ' (details in main.log)' : ''}`);
  lines.push(`At: ${new Date(now).toISOString()}`);
  return lines.join('\n');
}

// Asks the server for the versions and the tools (a fresh check is not forced: the last one is at most five minutes
// old). deps: { fetch, loadTools, toolsState }. Never throws: a part that fails is left out of the text.
export async function collectDiagnostics({ fetch = (input, init) => globalThis.fetch(input, init), loadTools = undefined, toolsState = undefined } = {}) {
  let about = null;
  try {
    const res = await fetch('/api/about', { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) about = await res.json();
  } catch {
    /* left out */
  }
  let tools = toolsState?.() || null;
  if (tools?.status !== 'ready' && typeof loadTools === 'function') {
    try {
      tools = await loadTools();
    } catch {
      /* left out */
    }
  }
  return { about, tools };
}
