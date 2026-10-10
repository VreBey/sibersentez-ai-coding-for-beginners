// @ts-check
// A moved project linked to its new folder (docs/internal/project-relink-plan.md; server/relinks.mjs): the drawer of a
// project whose folder is gone offers the listed folders with its name; a preview says what joins and what stays (it
// writes nothing); the link is written by the project-relink action in live mode, with the preview's planId. A linked
// project says so and offers to undo it, after a question. Pure.
import { t } from './i18n.js';
import { esc, dayTime } from './format.js';
import { icon } from './icons.js';

// The listed folders a moved project may be linked to: an unregistered project with the same name (letter case
// ignored) whose folder is there, not a left-behind folder, not linked itself, not the project itself
export function relinkCandidates(projects, p) {
  if (!p?.name) return [];
  const name = String(p.name).toLowerCase();
  return [...projects].filter((x) => x && x.id !== p.id && x.kind === 'adhoc' && x.path && x.exists !== false && !x.toolsOnly && !x.linked && !x.broad && String(x.name || '').toLowerCase() === name).slice(0, 5);
}

// The words of a refusal (the preview's problem, the action layer's error codes)
export function relinkErrorText(r, fallback = (_r) => '') {
  const code = String(r?.error || '');
  if (!/^[a-z][a-z-]*$/.test(code)) return fallback(r);
  // Its own words, else the new-project folder rules' (the same checks: catalog.mjs checkNewProjectFolder)
  for (const key of [`rlErr_${code}`, `npErr_${code}`]) {
    const text = t(key);
    if (text !== key) return text;
  }
  return fallback(r);
}

// The section's heading takes the focus after a step that removes the button pressed (data-fk keeps it across redraws;
// the linked note carries the same key, so the focus stays when the snapshot turns the offer into the note)
const HEAD = 'data-fk="rl:head" tabindex="-1"';

// The offer in a moved project's drawer. ui: { step: 'loading' | 'confirm' | 'busy' | 'failed' | 'done', from, plan,
// error }; mode: the actions mode (off: nothing can be asked; dry: the preview only; live: the link too)
export function relinkOfferHtml(p, candidates, ui = {}, mode = 'off') {
  if (!p?.path || p.exists !== false || p.linked) return '';
  const step = ui.step || '';
  let body;
  if (step === 'done') {
    body = `<p class="small" role="status">${esc(t('rlDone', { name: p.name }))}</p>`;
  } else if (step === 'confirm' && ui.plan) {
    const pl = ui.plan;
    const joins = pl.joining ? t(pl.joining.sessions === 1 ? 'rlJoins_one' : 'rlJoins', { count: pl.joining.sessions || 0 }) : t('rlJoinsNone');
    const keeps = t('rlKeeps', { sessions: pl.kept?.sessions || 0, points: pl.kept?.points || 0, jobs: pl.kept?.jobs || 0 });
    const yes = mode === 'live' ? `<button type="button" class="act-btn primary" data-rl-act="yes" data-fk="rl:yes">${icon('check')}<span>${esc(t('rlYes'))}</span></button>` : `<p class="small muted">${esc(t('rlDry'))}</p>`;
    body = `<div class="flow-confirm" role="group" aria-labelledby="rlQ"><p id="rlQ"><b>${esc(t('rlQuestion', { name: p.name }))}</b></p><p class="small"><code translate="no">${esc(pl.folder)}</code></p><ul class="small rl-what"><li>${esc(keeps)}</li><li>${esc(joins)}</li><li>${esc(t('rlInstalls'))}</li><li>${esc(t('rlUndo'))}</li></ul><div class="flow-btns">${yes}<button type="button" class="act-btn" data-rl-act="no" data-fk="rl:no">${esc(t('rlNo'))}</button></div></div>`;
  } else if (step === 'loading' || step === 'busy') {
    body = `<p class="small" role="status">${esc(t(step === 'busy' ? 'rlBusy' : 'rlLoading'))}</p>`;
  } else {
    // Actions off: the folders are named, nothing can be asked (the server answers no action then)
    const ask = mode === 'live' || mode === 'dry';
    const rows = candidates.map((x) => `<li><code translate="no">${esc(x.path)}</code>${ask ? ` <button type="button" class="act-btn" data-rl-act="preview" data-rl-from="${esc(x.id)}" data-fk="rl:${esc(x.id)}">${icon('link')}<span>${esc(t('rlLink'))}</span></button>` : ''}</li>`).join('');
    const failed = step === 'failed' ? `<p class="small warn" role="status">${esc(ui.error || t('rlFailed'))}</p>` : '';
    const off = rows && !ask ? `<p class="small muted">${esc(t('rlOff'))}</p>` : '';
    body = `${failed}${rows ? `<p class="small">${esc(t('rlOffer'))}</p><ul class="rl-list">${rows}</ul>${off}` : `<p class="small muted">${esc(t('rlNone'))}</p>`}`;
  }
  return `<section class="dr-sec rl" aria-labelledby="rlH"><h3 id="rlH" ${HEAD}>${icon('link')} ${esc(t('rlTitle'))}</h3>${body}</section>`;
}

// A linked project: when, and from which folder; the way to undo it (live mode), after a question that says what an
// undo gives back and what it does not. ui: { step: 'unlink' | 'busy' | 'failed', error } or nothing
export function relinkedHtml(p, mode = 'off', ui = {}) {
  if (!p?.linked) return '';
  const step = ui?.step || '';
  let tail = '';
  if (mode === 'live' && step === 'unlink') {
    tail = `<div class="flow-confirm" role="group" aria-labelledby="rlUq"><p id="rlUq"><b>${esc(t('rlUnlinkQ'))}</b></p><p class="small">${esc(t('rlUnlinkWhat'))}</p><div class="flow-btns"><button type="button" class="act-btn primary" data-rl-act="unlink-yes" data-fk="rl:unlink-yes">${esc(t('rlUnlinkYes'))}</button><button type="button" class="act-btn" data-rl-act="unlink-no" data-fk="rl:unlink-no">${esc(t('rlNo'))}</button></div></div>`;
  } else if (mode === 'live' && step === 'busy') {
    tail = `<p class="small" role="status">${esc(t('rlUnlinking'))}</p>`;
  } else if (mode === 'live') {
    const failed = step === 'failed' ? `<p class="small warn" role="status">${esc(ui.error || t('rlFailed'))}</p>` : '';
    tail = `${failed}<button type="button" class="act-btn" data-rl-act="unlink" data-fk="rl:unlink">${icon('replay')}<span>${esc(t('rlUnlink'))}</span></button>`;
  }
  return `<div class="dr-linked small" role="note"><p ${HEAD}>${esc(t('rlLinked', { time: dayTime(p.linked.at), old: p.linked.oldPath }))}</p>${tail}</div>`;
}
