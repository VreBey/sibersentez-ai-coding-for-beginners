// The Settings screen (docs/shell.md): what used to sit in the header and the footer, in a few plain groups.
// settingsHtml is pure (tested in node); createSettingsView wires its buttons. Nothing here writes a setting the
// server or the desktop shell owns: the actions mode goes through the actions panel, the tools panel checks the tools.
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { t, modeName, language } from '../i18n.js';
import { actionsState, onActionsChange } from '../actions.js';
import { costShown, setCostShown, advancedShown, setAdvancedShown, onPrefs } from '../usage.js';
import { installedTools, toolsState, onToolsChange, needTools } from './tools.js';
import { preferredTool, readTool, saveTool } from './job.js';

const LANG_NAMES = { tr: 'Türkçe', en: 'English' };

function row(title, text, control = '') {
  return `<div class="set-row"><div class="set-text"><b>${esc(title)}</b><p class="small muted">${esc(text)}</p></div>${control ? `<div class="set-ctl">${control}</div>` : ''}</div>`;
}

function group(id, ic, title, rows) {
  return `<section class="set-group" aria-labelledby="set-${id}"><h2 id="set-${id}">${icon(ic)}${esc(title)}</h2>${rows.join('')}</section>`;
}

const btn = (act, label, ic = '') => `<button type="button" class="act-btn" data-set-act="${act}" data-fk="set:${act}">${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;

// The language row: a choice in the desktop app (auto follows Windows), the language in words elsewhere
function languageRow(lang, choice, canLang) {
  if (!canLang) return row(t('setLanguage', { lang: LANG_NAMES[lang] || lang }), t('setLanguageText'));
  const opt = (v, label) => `<option value="${v}"${v === choice ? ' selected' : ''}>${esc(label)}</option>`;
  return row(t('setLanguagePick'), t('setLanguagePickText'), `<select data-set-lang data-fk="set:lang" aria-label="${esc(t('setLanguagePick'))}">${opt('auto', t('setLanguageAuto'))}${opt('tr', LANG_NAMES.tr)}${opt('en', LANG_NAMES.en)}</select>`);
}

const toggle = (attr, fk, on, label) => `<label class="set-switch"><input type="checkbox" ${attr} data-fk="${fk}" aria-label="${esc(label)}"${on ? ' checked' : ''}><span>${esc(t(on ? 'setOn' : 'setOff'))}</span></label>`;

// Where the source code is offered (every copy tells where the source and the license are; docs/direction.md §3.6)
export const SOURCE_URL = 'https://sibersentez.com';
// Donations: the product's own address, which forwards to where donations are taken (GitHub Sponsors today), so the
// app names no personal account and the place can change without an update (like SOURCE_URL)
export const SPONSOR_URL = 'https://sibersentez.com/destek';

// s: { mode, lang, cost, advanced, canSwitch, langChoice ('auto'|'en'|'tr'), canLang } -> HTML
// The tool jobs start with (docs/simplify.md): a choice among the installed tools
// looking: the tools are still being looked for (not "none found": opening Settings first said so, 2026-10-02)
function toolRow(tools, tool, looking = false) {
  if (!tools.length) return row(t('setToolTitle'), t(looking ? 'aiLoading' : 'setToolNone'));
  const opts = tools.map((x) => `<option value="${esc(x.id)}"${x.id === tool ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  return row(t('setToolTitle'), t('setToolText'), `<select data-set-tool data-fk="set:tool" aria-label="${esc(t('setToolLabel'))}">${opts}</select>`);
}

export function settingsHtml({ mode = 'off', lang = 'en', cost = false, advanced = false, canSwitch = false, langChoice = 'auto', canLang = false, tools = [], tool = '', toolsLooking = false } = {}) {
  const modeText = t(`setMode_${['off', 'dry', 'live'].includes(mode) ? mode : 'off'}`);
  return [
    group('actions', 'action', t('setActions'), [
      row(t('setActionsNow', { mode: modeName(mode) }), modeText, canSwitch ? btn('actions', t('setActionsChange')) : `<span class="small muted">${esc(t('setActionsAppOnly'))}</span>`),
    ]),
    group('tools', 'spark', t('navTools'), [toolRow(tools, tool, toolsLooking), row(t('setToolsTitle'), t('setToolsText'), btn('tools', t('setToolsOpen'), 'spark'))]),
    group('usage', 'cpu', t('setUsage'), [
      row(t('setCostTitle'), t('setCostText'), toggle('data-set-cost', 'set:cost', cost, t('setCostTitle'))),
    ]),
    group('general', 'globe', t('setGeneral'), [languageRow(lang, langChoice, canLang), row(t('setAdvancedTitle'), t('setAdvancedText'), toggle('data-set-advanced', 'set:advanced', advanced, t('setAdvancedTitle')))]),
    group('help', 'prompt', t('setHelp'), [row(t('setGuideTitle'), t('setGuideText'), btn('guide', t('setGuideOpen'))), row(t('setDiagTitle'), t('setDiagText'), btn('diag', t('setDiagCopy'))), row(t('setLicenseTitle'), t('setLicenseText', { url: SOURCE_URL })), row(t('setSupportTitle'), t('setSupportText'), `<a class="act-btn" href="${SPONSOR_URL}" target="_blank" rel="noopener noreferrer" data-fk="set:support">${icon('heart')}<span>${esc(t('setSupportOpen'))}</span></a>`)]),
  ].join('');
}

export function createSettingsView(root, { openTools = () => {}, openGuide = () => {}, openActions = null, copyDiagnostics = () => {} } = {}) {
  // The language the desktop app passed (?lang=) is the one chosen; none means "follow Windows"
  const bridge = () => (typeof globalThis.sibersentezShell?.setLanguage === 'function' ? globalThis.sibersentezShell : null);
  let langChoice = 'auto';
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('lang');
    if (q === 'en' || q === 'tr') langChoice = q;
  } catch {
    /* no address */
  }
  function render() {
    // The tools are looked for once, on the first screen that needs them (Settings can be the first one)
    needTools();
    const st = toolsState();
    const html = settingsHtml({ toolsLooking: st.status === 'idle' || st.status === 'loading', mode: actionsState().mode, lang: language(), cost: costShown(), advanced: advancedShown(), canSwitch: typeof openActions === 'function', langChoice, canLang: !!bridge(), tools: installedTools(toolsState()).map((x) => ({ id: x.id, name: x.name })), tool: preferredTool(installedTools(toolsState()), readTool())?.id || '' });
    if (root._html === html) return;
    const fk = root.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    root._html = html;
    root.innerHTML = html;
    if (fk) root.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }
  root.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-set-act]')?.dataset.setAct;
    if (act === 'tools') openTools();
    else if (act === 'guide') openGuide();
    else if (act === 'actions') openActions?.();
    else if (act === 'diag') copyDiagnostics();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches?.('[data-set-cost]')) setCostShown(e.target.checked);
    if (e.target.matches?.('[data-set-advanced]')) setAdvancedShown(e.target.checked);
    if (e.target.matches?.('[data-set-tool]')) {
      saveTool(e.target.value);
      render();
    }
    if (e.target.matches?.('[data-set-lang]') && bridge()) {
      const v = e.target.value;
      e.target.disabled = true;
      // The window loads again in the new language; an answer that is not ok leaves the choice as it was
      Promise.resolve(bridge().setLanguage(v))
        .then((r) => {
          if (!r?.ok) {
            e.target.disabled = false;
            e.target.value = langChoice;
          }
        })
        .catch(() => {
          e.target.disabled = false;
          e.target.value = langChoice;
        });
    }
  });
  onActionsChange(() => !root.closest('[hidden]') && render());
  onPrefs(() => !root.closest('[hidden]') && render());
  onToolsChange(() => !root.closest('[hidden]') && render());
  return { render };
}
