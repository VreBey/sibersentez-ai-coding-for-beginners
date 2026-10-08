// The permission mode an AI session runs in, in plain words (docs/attention.md): Claude Code writes it on every line
// the person writes (permissionMode: plan, default, acceptEdits, auto, dontAsk, bypassPermissions); Codex's approval
// and sandbox policies are said in the same words (server/toolLogs.mjs codexPermission). SiberSentez
// changes nothing here; it only says how freely the AI acts, as the competitors show beside their send button.
// Pure (tested in node).
import { esc } from './format.js';
import { t } from './i18n.js';

// tone: ok (it asks or only plans), warn (it acts without asking for some steps), stop (it asks for nothing)
const MODES = Object.freeze({ plan: 'ok', default: 'ok', dontAsk: 'ok', acceptEdits: 'warn', auto: 'warn', bypassPermissions: 'stop' });

// { label, hint, tone } or null for no mode or one not known
export function permModeWords(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) return null;
  return { label: t(`pm_${mode}`), hint: t(`pmHint_${mode}`), tone: MODES[mode] };
}

// A small chip (the Building's card, a session's drawer); its title says what the mode lets the AI do
export function permModeChip(mode, cls = 'perm-chip') {
  const w = permModeWords(mode);
  return w ? `<span class="${cls} ${w.tone}" title="${esc(w.hint)}">${esc(w.label)}</span>` : '';
}

// One line for a project's drawer: the mode of its newest open session, said with what it means
export function permModeLine(sessions, projectId) {
  let s = null;
  for (const x of sessions) if (x?.projectId === projectId && x.live && x.permissionMode && (!s || x.lastAt > s.lastAt)) s = x;
  const w = permModeWords(s?.permissionMode);
  return w ? `<p class="small perm-line ${w.tone}">${esc(t('pmLine', { mode: w.label }))} ${esc(w.hint)}</p>` : '';
}
