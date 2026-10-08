// "New project" from an idea (review U05, 2026-10-07): a small window asks for the project's name and what to build,
// shows where its folder goes (Documents › SiberSentez › <name>, the owner's choice) and answers with what the person
// chose. The folder itself is made by the desktop shell (window.sibersentezShell.createIdeaProject, electron/helpers.mjs
// createIdeaProject); this window only asks. An old project folder is still added the old way (its link at the bottom).
import { t } from '../i18n.js';
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { focusableVisible } from '../contextmenu.js';

// Same limit as PROJECT_NAME_MAX in electron/helpers.mjs. The idea: as much as the server keeps with the project
// (IDEA_MAX in server/memory.mjs), so what is typed here is what is kept
export const NAME_MAX = 60;
export const IDEA_FIELD_MAX = 300;
const BAD_RE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/i;

// The folder name the shell will make of a name (pure; the same rule as projectFolderName in electron/helpers.mjs):
// characters Windows refuses become spaces, spaces collapse, no trailing dot or space, never a device name. '' when
// nothing is left (the name cannot be a folder).
export function folderNameOf(name) {
  let s = String(name || '').normalize('NFC').replace(BAD_RE, ' ').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, NAME_MAX).join('').replace(/[. ]+$/, '').trim();
  return s && !RESERVED_RE.test(s) ? s : '';
}

// Where the folder goes, as the window shows it (pure): Documents › SiberSentez › <name>, '…' before a name is written.
// The shell adds " (2)" when the name is taken; the notice after it names the project as it was made.
export function ideaWhereText(name) {
  return [t('npIdeaDocs'), 'SiberSentez', folderNameOf(name) || '…'].join(' › ');
}

// The window's markup (pure); the wrap carries the backdrop, the inner box is the dialog. tabindex -1: a click on its
// text keeps the focus in it (else it fell to the page and the keys went there)
export function ideaDialogHtml({ name = '', idea = '', error = '' } = {}) {
  const err = String(error || '');
  return `<form class="np-idea" role="dialog" aria-modal="true" aria-labelledby="npIdeaH" aria-describedby="npIdeaIntro" tabindex="-1" novalidate>
    <h2 id="npIdeaH">${esc(t('npIdeaTitle'))}</h2>
    <p class="small muted" id="npIdeaIntro">${esc(t('npIdeaIntro'))}</p>
    <label class="np-field"><span>${esc(t('npIdeaName'))}</span><input type="text" name="name" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" placeholder="${esc(t('npIdeaNamePh'))}" aria-describedby="npIdeaWhere npIdeaErr" value="${esc(name)}"></label>
    <p class="np-where small" id="npIdeaWhere">${icon('folder')}<span data-np="where">${esc(t('npIdeaWhere', { path: ideaWhereText(name) }))}</span></p>
    <p class="np-err small" id="npIdeaErr" data-np="err" role="alert"${err ? '' : ' hidden'}>${esc(err)}</p>
    <label class="np-field"><span>${esc(t('npIdeaIdea'))}</span><textarea name="idea" rows="4" maxlength="${IDEA_FIELD_MAX}" placeholder="${esc(t('npIdeaIdeaPh'))}" aria-describedby="npIdeaKeys">${esc(idea)}</textarea></label>
    <p class="small muted np-keys" id="npIdeaKeys">${esc(t('npIdeaKeys', { n: IDEA_FIELD_MAX }))}</p>
    <div class="np-acts">
      <button type="submit" class="act-btn primary" data-np="create">${icon('folder')}<span>${esc(t('npIdeaCreate'))}</span></button>
      <button type="button" class="act-btn" data-np="elsewhere">${esc(t('npIdeaElsewhere'))}</button>
      <button type="button" class="act-btn np-cancel" data-np="cancel">${esc(t('npIdeaCancel'))}</button>
    </div>
    <p class="np-existing small"><button type="button" class="np-link" data-np="existing">${esc(t('npIdeaExisting'))}</button></p>
  </form>`;
}

// The window. ask(prev) opens it (prev: { name, idea, error } of a try that did not work: the window comes back with
// them and the reason in it) and resolves once with { action: 'create' | 'elsewhere', name, idea } (a name that makes a
// folder name; the idea trimmed), { action: 'existing' } (the old folder picker) or { action: 'cancel' } (Esc, Cancel,
// a click beside it). While it is open the rest of the page is inert (no click, no focus, no screen reader), focus
// stays inside and goes back to where it was; keys typed in it do not reach the page's shortcuts (digits, Ctrl+K,
// Shift+F10). Enter in the name goes on to the idea; Create (or Ctrl+Enter) makes it.
export function createIdeaDialog(doc = document) {
  const root = doc.createElement('div');
  root.className = 'np-wrap';
  root.hidden = true;
  doc.body.appendChild(root);
  let done = null;
  let back = null;
  let inerted = [];

  const part = (k) => root.querySelector(`[data-np="${k}"]`);
  const field = (n) => root.querySelector(`[name="${n}"]`);
  const focusables = () => [...root.querySelectorAll('input, textarea, button')].filter((el) => !el.disabled && el.getClientRects().length);

  // The page behind: inert while the window is open, as it was before once it closes
  function setPageInert(on) {
    if (on) {
      inerted = [...doc.body.children].filter((el) => el !== root && !el.inert);
      for (const el of inerted) el.inert = true;
    } else {
      for (const el of inerted) el.inert = false;
      inerted = [];
    }
  }

  function finish(answer) {
    if (!done) return;
    const resolve = done;
    done = null;
    root.hidden = true;
    root.innerHTML = '';
    setPageInert(false);
    const to = back;
    back = null;
    if (focusableVisible(to)) to.focus({ preventScroll: true });
    resolve(answer);
  }

  function chosen(action) {
    const name = folderNameOf(field('name').value);
    if (!name) {
      const err = part('err');
      err.textContent = t('npIdeaBadName');
      err.hidden = false;
      field('name').setAttribute('aria-invalid', 'true');
      field('name').focus();
      return;
    }
    finish({ action, name, idea: field('idea').value.trim().slice(0, IDEA_FIELD_MAX) });
  }

  function ask(prev = null) {
    if (done) return Promise.resolve({ action: 'busy' });
    const a = doc.activeElement;
    back = a && a !== doc.body && !root.contains(a) ? a : null;
    root.innerHTML = ideaDialogHtml(prev || {});
    root.hidden = false;
    setPageInert(true);
    const name = field('name');
    if (prev?.error) name.setAttribute('aria-invalid', 'true');
    name.addEventListener('input', () => {
      part('where').textContent = t('npIdeaWhere', { path: ideaWhereText(name.value) });
      if (!part('err').hidden) {
        part('err').hidden = true;
        name.removeAttribute('aria-invalid');
      }
    });
    // Enter in the name goes on to the idea (the project is not made before the idea could be written)
    name.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) chosen('create');
      else field('idea').focus();
    });
    root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      chosen('create');
    });
    // Ctrl+Enter in the idea creates it, as the job boxes start with it
    field('idea').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        chosen('create');
      }
    });
    part('elsewhere').addEventListener('click', () => chosen('elsewhere'));
    part('cancel').addEventListener('click', () => finish({ action: 'cancel' }));
    part('existing').addEventListener('click', () => finish({ action: 'existing' }));
    name.focus();
    if (prev?.name) name.setSelectionRange?.(name.value.length, name.value.length);
    return new Promise((resolve) => {
      done = resolve;
    });
  }

  root.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish({ action: 'cancel' });
    } else if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const i = list.indexOf(doc.activeElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i < 0 || i === list.length - 1 ? 0 : i + 1;
      e.preventDefault();
      list[next].focus();
    }
  });
  // Focus that leaves it some other way comes back to the name
  root.addEventListener('focusout', (e) => {
    if (!root.hidden && e.relatedTarget && !root.contains(e.relatedTarget)) field('name')?.focus();
  });
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) finish({ action: 'cancel' });
  });

  return { ask, isOpen: () => !root.hidden, close: () => finish({ action: 'cancel' }) };
}
