// @ts-check
// The Settings screen (docs/shell.md): what used to sit in the header and the footer, in a few plain groups.
// settingsHtml is pure (tested in node); createSettingsView wires its buttons. Nothing here writes a setting the
// server or the desktop shell owns: the actions mode goes through the actions panel, the tools panel checks the tools.
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { t, modeName, language, tOs } from '../i18n.js';
import { actionsState, onActionsChange, runAction } from '../actions.js';
import { sizeText } from '../restore.js';
import { costShown, setCostShown, advancedShown, setAdvancedShown, onPrefs, terminalReaderOn, setTerminalReader } from '../usage.js';
import { installedTools, toolsState, onToolsChange, needTools, capsLine } from './tools.js';
import { preferredTool, readTool, saveTool } from './job.js';
import { updatesOn, setUpdatesOn, updatesState, updateRowHtml, onUpdates } from '../updates.js';
import { THEME_CHOICES, themeChoice, setThemeChoice } from '../theme.js';
import { supportPreviewHtml } from '../supportBundle.js';

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
  if (!canLang) return row(t('setLanguage', { lang: LANG_NAMES[lang] || lang }), tOs('setLanguageText'));
  const opt = (v, label) => `<option value="${v}"${v === choice ? ' selected' : ''}>${esc(label)}</option>`;
  return row(t('setLanguagePick'), t('setLanguagePickText'), `<select data-set-lang data-fk="set:lang" aria-label="${esc(t('setLanguagePick'))}">${opt('auto', tOs('setLanguageAuto'))}${opt('tr', LANG_NAMES.tr)}${opt('en', LANG_NAMES.en)}</select>`);
}

// The look (plan E4): dark, light or like the system; it changes at once, nothing loads again
function themeRow(choice) {
  const label = { dark: t('setThemeDark'), light: t('setThemeLight'), system: tOs('setThemeSystem') };
  const opts = THEME_CHOICES.map((v) => `<option value="${v}"${v === choice ? ' selected' : ''}>${esc(label[v])}</option>`).join('');
  return row(t('setThemeTitle'), t('setThemeText'), `<select data-set-theme data-fk="set:theme" aria-label="${esc(t('setThemeTitle'))}">${opts}</select>`);
}

const toggle = (attr, fk, on, label) => `<label class="set-switch"><input type="checkbox" ${attr} data-fk="${fk}" aria-label="${esc(label)}"${on ? ' checked' : ''}><span>${esc(t(on ? 'setOn' : 'setOff'))}</span></label>`;

// Where the source code is offered (every copy tells where the source and the license are; docs/direction.md §3.6)
export const SOURCE_URL = 'https://sibersentez.com';
// Donations: the product's own address, which forwards to where donations are taken (GitHub Sponsors today), so the
// app names no personal account and the place can change without an update (like SOURCE_URL)
export const SPONSOR_URL = 'https://sibersentez.com/destek';

// s: { mode, lang, cost, advanced, canSwitch, langChoice ('auto'|'en'|'tr'), canLang, theme ('dark'|'light'|'system') } -> HTML
// The tool jobs start with (docs/simplify.md): a choice among the installed tools
// looking: the tools are still being looked for (not "none found": opening Settings first said so, 2026-10-02)
// Under the choice, what SiberSentez does with the chosen tool (tools.js capsLine: plan mode, resume, live state, usage,
// sign-in check, what the result observes), so the difference shows where the tool is chosen (ui-states-plan U2)
function toolRow(tools, tool, looking = false) {
  if (!tools.length) return row(t('setToolTitle'), t(looking ? 'aiLoading' : 'setToolNone'));
  const opts = tools.map((x) => `<option value="${esc(x.id)}"${x.id === tool ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const chosen = tools.find((x) => x.id === tool) || tools[0];
  const select = `<select data-set-tool data-fk="set:tool" aria-label="${esc(t('setToolLabel'))}">${opts}</select>`;
  return `<div class="set-row"><div class="set-text"><b>${esc(t('setToolTitle'))}</b><p class="small muted">${esc(t('setToolText'))}</p>${capsLine(chosen?.caps)}</div><div class="set-ctl">${select}</div></div>`;
}

// The restore copies (independent review 2026-10-20, T05): what every point in the hub takes, and the points of projects
// no longer listed with a way to remove them, asked once inline (pure). disk: null (not asked yet), { state: 'loading' |
// 'failed' } or { state: 'ready', data: the /api/restore-disk answer, step: null | 'ask' | 'busy', result }; mode: the
// actions mode (removing is a writing action: live only)
const NAMES_SHOWN = 4;
export function diskRowHtml(disk, mode = 'off') {
  const say = (text, cls = 'muted') => `<p class="small ${cls}">${esc(text)}</p>`;
  let body = '';
  if (!disk || disk.state === 'loading') body = say(t('setDiskLoading'));
  else if (disk.state !== 'ready') body = say(t('setDiskFailed'));
  else {
    const d = disk.data || {};
    const orphans = Array.isArray(d.orphans) ? d.orphans : [];
    body = say(t('setDiskTotal', { size: sizeText(d.bytes) || '0 KB' }), '');
    // The list of projects could not be read whole just now: nothing is offered for removal (pre-release review)
    if (d.unsure === true) body += say(t(d.why === 'memory-set-aside' ? 'setDiskUnsureMemory' : 'setDiskUnsure'));
    if (disk.error) body += say(t('setDiskCleanFailed'), 'warn');
    if (disk.result) {
      body += say(t('setDiskDone', { count: disk.result.removed }), 'ok');
      if (disk.result.kept) body += say(t('setDiskKept', { count: disk.result.kept }));
    }
    if (orphans.length) {
      const size = sizeText(orphans.reduce((n, o) => n + (Number(o.bytes) || 0), 0)) || '0 KB';
      const names = orphans.slice(0, NAMES_SHOWN).map((o) => String(o.projectId)).join(', ') + (orphans.length > NAMES_SHOWN ? ', …' : '');
      body += say(t('setDiskOrphans', { count: orphans.length, size, names }), '');
      if (mode !== 'live') body += say(t('setDiskLive'));
      else if (disk.step === 'ask' || disk.step === 'busy') {
        const off = disk.step === 'busy' ? ' disabled' : '';
        body += `<div class="set-ask" role="group" aria-label="${esc(t('setDiskClean'))}">${say(t('setDiskAsk', { count: orphans.length }), 'warn')}<button type="button" class="act-btn danger" data-set-act="disk-yes" data-fk="set:disk-yes"${off}><span>${esc(t('setDiskYes'))}</span></button> <button type="button" class="act-btn" data-set-act="disk-no" data-fk="set:disk-no"${off}><span>${esc(t('setDiskNo'))}</span></button></div>`;
      } else body += btn('disk-clean', t('setDiskClean'));
    }
  }
  return `<div class="set-row"><div class="set-text"><b>${esc(t('setDiskTitle'))}</b><p class="small muted">${esc(t('setDiskText'))}</p><div class="set-disk" aria-live="polite">${body}</div></div></div>`;
}

// canLogs: the desktop app can open its log folder (review A4); a browser has none. canBundle: the desktop app can put
// the support bundle together (supportBundle.js); bundle: its preview's state, or null
export function settingsHtml({ disk = null, canBundle = false, bundle = null, mode = 'off', lang = 'en', cost = false, advanced = false, canSwitch = false, langChoice = 'auto', canLang = false, tools = [], tool = '', toolsLooking = false, updates = updatesState(), updatesChecked = updatesOn(), canLogs = false, theme = themeChoice() } = {}) {
  const modeText = t(`setMode_${['off', 'dry', 'live'].includes(mode) ? mode : 'off'}`);
  return [
    group('actions', 'action', t('setActions'), [
      row(t('setActionsNow', { mode: modeName(mode) }), modeText, canSwitch ? btn('actions', t('setActionsChange')) : `<span class="small muted">${esc(t('setActionsAppOnly'))}</span>`),
    ]),
    group('tools', 'spark', t('navTools'), [toolRow(tools, tool, toolsLooking), row(t('setToolsTitle'), t('setToolsText'), btn('tools', t('setToolsOpen'), 'spark'))]),
    group('usage', 'cpu', t('setUsage'), [
      row(t('setCostTitle'), t('setCostText'), toggle('data-set-cost', 'set:cost', cost, t('setCostTitle'))),
    ]),
    group('general', 'globe', t('setGeneral'), [languageRow(lang, langChoice, canLang), themeRow(theme), row(t('setAdvancedTitle'), t('setAdvancedText'), toggle('data-set-advanced', 'set:advanced', advanced, t('setAdvancedTitle'))), row(t('setReaderTitle'), t('setReaderText'), toggle('data-set-reader', 'set:reader', terminalReaderOn(), t('setReaderTitle'))), row(t('updTitle'), t('updText'), `${toggle('data-set-updates', 'set:updates', updatesChecked, t('updTitle'))}<div class="upd-state" aria-live="polite">${updateRowHtml(updates)}</div>`), diskRowHtml(disk, mode)]),
    group('help', 'prompt', t('setHelp'), [row(t('setGuideTitle'), t('setGuideText'), btn('guide', t('setGuideOpen'))), row(t('setDiagTitle'), tOs('setDiagText'), btn('diag', t('setDiagCopy'))), ...(canLogs ? [row(t('setLogsTitle'), t('setLogsText'), btn('logs', t('setLogsOpen')))] : []), ...(canBundle ? [row(t('setBundleTitle'), t('setBundleText'), btn('bundle', t('setBundleOpen'))) + supportPreviewHtml(bundle)] : []), row(t('setLicenseTitle'), tOs('setLicenseText', { url: SOURCE_URL })), row(t('setSupportTitle'), t('setSupportText'), `<a class="act-btn" href="${SPONSOR_URL}" target="_blank" rel="noopener noreferrer" data-fk="set:support">${icon('heart')}<span>${esc(t('setSupportOpen'))}</span></a>`)]),
  ].join('');
}

export function createSettingsView(root, { openTools = () => {}, openGuide = () => {}, openActions = null, copyDiagnostics = () => {}, openLogs = null, supportBundle = null } = {}) {
  // The language the desktop app passed (?lang=) is the one chosen; none means "follow Windows"
  const bridge = () => (typeof globalThis.sibersentezShell?.setLanguage === 'function' ? globalThis.sibersentezShell : null);
  let langChoice = 'auto';
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('lang');
    if (q === 'en' || q === 'tr') langChoice = q;
  } catch {
    /* no address */
  }
  // The support bundle's preview (supportBundle.js): null, or { step: 'loading' | 'ready' | 'failed', text }
  let bundle = null;
  // The restore copies' row (diskRowHtml): asked when Settings is drawn first, and again after a removal
  let disk = null;
  async function loadDisk() {
    // A removal's result stays shown once the copies are counted again (review of the fix, 2026-10-20)
    const result = disk?.result || null;
    disk = { state: 'loading' };
    try {
      const res = await fetch('/api/restore-disk', { cache: 'no-store', credentials: 'same-origin' });
      const data = res.ok ? await res.json() : null;
      disk = data && Number.isFinite(data.bytes) ? { state: 'ready', data, step: null, result } : { state: 'failed' };
    } catch {
      disk = { state: 'failed' };
    }
    if (!root.closest('[hidden]')) render();
  }
  async function diskAct(act) {
    if (disk?.state !== 'ready') return;
    if (act === 'disk-clean') disk = { ...disk, step: 'ask', result: null, error: false };
    else if (act === 'disk-no') disk = { ...disk, step: null };
    else if (act === 'disk-yes' && disk.step === 'ask') {
      const keys = (disk.data.orphans || []).map((o) => o.key);
      disk = { ...disk, step: 'busy' };
      render();
      const r = await runAction({ action: 'restore-clean', keys });
      const done = r?.ok && r.result?.executed;
      if (!done) {
        // Said, not counted again over it
        disk = { ...disk, step: null, result: null, error: true };
        return render();
      }
      disk = { ...disk, step: null, result: { removed: r.result.removed.length, kept: r.result.kept.length } };
      return loadDisk();
    }
    render();
    root.querySelector(act === 'disk-clean' ? '[data-fk="set:disk-no"]' : '[data-fk="set:disk-clean"]')?.focus({ preventScroll: true });
  }
  function render() {
    if (!disk) loadDisk();
    // The tools are looked for once, on the first screen that needs them (Settings can be the first one)
    needTools();
    const st = toolsState();
    const html = settingsHtml({ toolsLooking: st.status === 'idle' || st.status === 'loading', mode: actionsState().mode, lang: language(), cost: costShown(), advanced: advancedShown(), canSwitch: typeof openActions === 'function', langChoice, canLang: !!bridge(), tools: installedTools(toolsState()).map((x) => ({ id: x.id, name: x.name, caps: x.caps })), tool: preferredTool(installedTools(toolsState()), readTool())?.id || '', canLogs: typeof openLogs === 'function', canBundle: !!supportBundle, bundle, disk });
    if (root._html === html) return;
    const fk = root.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset?.fk : null;
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
    else if (act === 'logs') openLogs?.();
    else if (act && act.startsWith('bundle')) bundleAct(act);
    else if (act && act.startsWith('disk-')) diskAct(act);
  });
  // Preview: the shell's parts and the diagnostic info, put together; Copy and Save hand the same text on (main.js
  // says how it went); Close gives the focus back to Preview
  async function bundleAct(act) {
    if (!supportBundle) return;
    if (act === 'bundle') {
      if (bundle?.step === 'loading') return;
      bundle = { step: 'loading', text: '' };
      render();
      let text = '';
      try {
        text = await supportBundle.build();
      } catch {
        text = '';
      }
      bundle = text ? { step: 'ready', text } : { step: 'failed', text: '' };
      render();
      root.querySelector(bundle.step === 'ready' ? '[data-fk="set:bundle-text"]' : '[data-fk="set:bundle-close"]')?.focus();
    } else if (act === 'bundle-copy' && bundle?.text) supportBundle.copy(bundle.text);
    else if (act === 'bundle-save' && bundle?.text) supportBundle.save(bundle.text);
    else if (act === 'bundle-close') {
      bundle = null;
      render();
      root.querySelector('[data-fk="set:bundle"]')?.focus({ preventScroll: true });
    }
  }
  root.addEventListener('change', (e) => {
    if (e.target.matches?.('[data-set-cost]')) setCostShown(e.target.checked);
    if (e.target.matches?.('[data-set-advanced]')) setAdvancedShown(e.target.checked);
    if (e.target.matches?.('[data-set-reader]')) setTerminalReader(e.target.checked);
    if (e.target.matches?.('[data-set-theme]')) {
      setThemeChoice(e.target.value);
      render();
    }
    // "A new version is out" (roadmap F3a): on, the page asks its own server now and at every start; off, never
    if (e.target.matches?.('[data-set-updates]')) Promise.resolve(setUpdatesOn(e.target.checked)).finally(render);
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
  onUpdates(() => !root.closest('[hidden]') && render());
  return { render };
}
