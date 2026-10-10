// @ts-check
// The support bundle (docs/internal/support-bundle-plan.md): Settings → Help shows the diagnostic info, the hub's
// settings.json and the last lines of the logs in one text, masked by the shell (electron/support-bundle.mjs), before
// the person copies it or saves it as a file. Nothing is sent anywhere. Pure (tested in node). The text's labels are
// English, like the diagnostic info and the logs: it is for whoever helps.
import { t } from './i18n.js';
import { esc } from './format.js';
import { icon } from './icons.js';

const LOG_NAME = /^[\w.-]{1,40}$/;

// { diagnostics (diagnosticsText), parts (the shell's supportParts answer) } -> text
export function supportBundleText({ diagnostics = '', parts = null } = {}) {
  const out = ['SiberSentez support bundle', 'Keys, passwords, the home folder and folder paths are masked. Nothing was sent anywhere.', '', '== Diagnostic info ==', diagnostics || '(not available)', '', '== settings.json (masked) =='];
  out.push(typeof parts?.settings === 'string' ? parts.settings : '(not read)');
  for (const l of Array.isArray(parts?.logs) ? parts.logs : []) {
    if (!l || !LOG_NAME.test(String(l.name))) continue;
    const lines = Array.isArray(l.lines) ? l.lines.filter((x) => typeof x === 'string') : [];
    const what = l.missing ? 'not there' : `the last ${lines.length} line${lines.length === 1 ? '' : 's'}${l.cut ? ', older ones left out' : ''}`;
    out.push('', `== ${l.name}: ${what} ==`, ...lines);
  }
  return out.join('\n');
}

const btn = (act, label, ic = '', primary = false) => `<button type="button" class="act-btn${primary ? ' primary' : ''}" data-set-act="${act}" data-fk="set:${act}">${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;

// The preview under the Support bundle row. st: null | { step: 'loading' | 'ready' | 'failed', text }
export function supportPreviewHtml(st) {
  if (!st) return '';
  if (st.step === 'loading') return `<div class="sb-prev"><p class="small" role="status">${esc(t('setBundleLoading'))}</p></div>`;
  if (st.step !== 'ready') return `<div class="sb-prev"><p class="small warn" role="status">${esc(t('setBundleFailed'))}</p><div class="flow-btns">${btn('bundle-close', t('setBundleClose'))}</div></div>`;
  return `<div class="sb-prev" role="group" aria-labelledby="sbHead"><p id="sbHead" class="small"><b>${esc(t('setBundleCheck'))}</b> ${esc(t('setBundleNote'))}</p><textarea class="sb-text" readonly rows="14" spellcheck="false" translate="no" data-fk="set:bundle-text" aria-label="${esc(t('setBundleLabel'))}">${esc(st.text || '')}</textarea><div class="flow-btns">${btn('bundle-copy', t('setBundleCopy'), 'copy', true)}${btn('bundle-save', t('setBundleSave'), 'folder')}${btn('bundle-close', t('setBundleClose'))}</div></div>`;
}
