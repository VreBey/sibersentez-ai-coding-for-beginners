// "How to run it" in the project drawer (docs/run-hint.md): the steps GET /api/projects/<id>/run found, each command
// with a copy button. SiberSentez runs none of them: the person pastes them into a terminal. runSectionHtml is pure
// (tested in node); createRunHint keeps the answers (asked again after 20 s, so what the AI just built shows up).
import { esc } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const KINDS = new Set(['unity', 'godot', 'unreal', 'node', 'python', 'flutter', 'go', 'rust', 'dotnet', 'static']);
const STEPS = new Set(['unity', 'godot', 'unreal', 'install', 'script', 'window', 'address', 'node', 'uvsync', 'pip', 'python', 'flutterget', 'open']);
// A command as the server builds it: fixed words, a checked name; anything else is not shown
const CMD_RE = /^[\w .:/-]{1,80}$/;

async function fetchRun(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/run`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Types a command into the project's embedded terminal without pressing Enter (set by main.js when the desktop app has
// the terminal dock); null: only the copy button
let typer = null;
export function setRunTyper(fn) {
  typer = typeof fn === 'function' ? fn : null;
}
// Opens the project's own index.html in the browser (set by main.js: the explorer action with open: 'index.html', on
// the person's click, as every action); null: the step only says to double-click it
let opener = null;
export function setRunOpener(fn) {
  opener = typeof fn === 'function' ? fn : null;
}

// The way is not known (review U09): the question goes into the project's running AI tab without Enter (set by
// main.js: terminalDock askAi, and whether an AI of the project runs there); null: no terminal dock
let asker = null;
export function setRunAsker(ask, running) {
  asker = typeof ask === 'function' && typeof running === 'function' ? { ask, running } : null;
}

const askBtn = () => `<button type="button" class="act-btn primary" data-run-ask data-fk="run:ask">${icon('prompt')}<span>${esc(t('runAskAi'))}</span></button>`;
const asJobBtn = () => `<button type="button" class="act-btn" data-run-job data-fk="run:job">${icon('spark')}<span>${esc(t('runAskJob'))}</span></button>`;

const typeBtn = () => `<button type="button" class="act-btn run-type" data-run-type>${icon('prompt')}<span>${esc(t('runType'))}</span></button>`;
const copyBtn = () => `<button type="button" class="act-btn ai-copy" data-run-copy>${icon('copy')}<span>${esc(t('aiCopy'))}</span></button>`;

const openBtn = () => `<button type="button" class="act-btn primary run-open" data-run-open>${icon('play')}<span>${esc(t('runOpenPage'))}</span></button>`;

function stepHtml(s, n, canType, canOpen) {
  const cmd = typeof s.cmd === 'string' && CMD_RE.test(s.cmd) ? `<div class="ai-cmd run-cmd${canType ? ' can-type' : ''}"><code translate="no">${esc(s.cmd)}</code>${canType ? typeBtn() : ''}${copyBtn()}</div>` : '';
  const file = typeof s.file === 'string' && /^[\w.-]{1,60}$/.test(s.file) ? s.file : '';
  // A plain web page: one button opens it (only index.html, the one file the server opens)
  const open = canOpen && s.id === 'open' && file === 'index.html' ? `<div class="run-open-row">${openBtn()}</div>` : '';
  return `<li><span class="run-n">${n}</span><div><p>${esc(t(`run_${s.id}`, { file }))}</p>${cmd}${open}</div></li>`;
}

// The section. data: the server's answer, or null while it is asked; p: the project; canType: the "Type in terminal"
// button (the desktop app's terminal dock); canOpen: the "Open in the browser" button of a plain web page; aiRuns: an
// AI of the project runs in SiberSentez's terminal (the unknown way asks it there, else as a new job)
export function runSectionHtml(p, data, { canType = false, canOpen = false, aiRuns = false } = {}) {
  if (!p?.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  const head = `<h3 id="runH">${icon('play')} ${esc(t('runTitle'))}</h3>`;
  let inner;
  if (!data) inner = `<p class="muted small">${esc(t('runLoading'))}</p>`;
  else if (data.state === 'empty') inner = `<p class="muted small">${esc(t('runEmpty'))}</p>`;
  else if (data.state === 'ok' && Array.isArray(data.plans) && data.plans.length) {
    const plans = data.plans.filter((pl) => KINDS.has(pl?.kind) && Array.isArray(pl.steps)).slice(0, 2);
    inner = plans
      .map((pl) => {
        const steps = pl.steps.filter((s) => STEPS.has(s?.id));
        return `<div class="run-plan"><b class="run-kind">${esc(t(`runKind_${pl.kind}`))}</b><ol class="run-steps">${steps.map((s, i) => stepHtml(s, i + 1, canType, canOpen)).join('')}</ol></div>`;
      })
      .join('');
    // The note on pasting commands only where there is a command (a plain web page has none)
    if (plans.some((pl) => pl.steps.some((s) => typeof s?.cmd === 'string' && CMD_RE.test(s.cmd)))) inner += `<p class="muted small">${esc(t(canType ? 'runFootType' : 'runFoot'))}</p>`;
  } else if (data.state === 'unreadable') return '';
  else {
    // One way that leads somewhere (review U09): into the running AI, else into the job box; copying stays
    const way = aiRuns ? `<div class="run-open-row">${askBtn()}</div><p class="muted small">${esc(t('runAskAiNote'))}</p>` : `<div class="run-open-row">${asJobBtn()}</div><p class="muted small">${esc(t('runAskJobNote'))}</p>`;
    inner = `<p class="small">${esc(t('runUnknown'))}</p><div class="ai-cmd run-cmd"><code>${esc(t('runAsk'))}</code>${copyBtn()}</div>${way}`;
  }
  return `<section class="dr-sec run" data-sec="run" aria-labelledby="runH">${head}${inner}</section>`;
}

// Answers per project. onData(projectId): an answer arrived (the drawer redraws when that project is open).
export function createRunHint({ fetchJson = fetchRun, onData = () => {}, now = () => Date.now(), ttl = 20000 } = {}) {
  const cache = new Map();
  function get(projectId) {
    const e = cache.get(projectId);
    if (e && (e.pending || now() - e.at < ttl)) return e;
    const next = { at: e?.at || 0, data: e?.data || null, pending: true };
    cache.set(projectId, next);
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => cache.set(projectId, { at: now(), data, pending: false }),
        () => cache.set(projectId, { at: now(), data: next.data || { state: 'unreadable', plans: [] }, pending: false }),
      )
      .then(() => {
        try {
          onData(projectId);
        } catch (err) {
          console.error(err);
        }
      });
    return next;
  }
  return { get, html: (p) => (p?.path ? runSectionHtml(p, get(p.id).data, { canType: !!typer, canOpen: !!opener, aiRuns: !!asker && asker.running(p.id) }) : '') };
}

// Buttons of the section (the drawer body): the command beside the button goes to the clipboard, or into the project's
// terminal (never with Enter). projectOf(el): the open project's id. asJob(projectId, text): the question goes into
// the project's job box (the drawer's own, Start stays the person's)
export function bindRunHint(bodyEl, { projectOf = () => null, asJob = () => {} } = {}) {
  bodyEl.addEventListener('click', (e) => {
    const ab = e.target.closest?.('[data-run-ask], [data-run-job]');
    if (ab) {
      const id = projectOf(ab);
      if (!id) return;
      // The AI stopped since the section was drawn: the question still goes somewhere, into the job box
      const r = ab.hasAttribute('data-run-ask') && asker ? asker.ask(id, t('runAsk')) : null;
      // An existing question needs the person's answer in this tab, not a second job.
      if (!r?.ok && r?.reason !== 'asks') asJob(id, t('runAsk'));
      return;
    }
    const ob = e.target.closest?.('[data-run-open]');
    if (ob && opener) {
      const id = projectOf(ob);
      if (id) {
        ob.disabled = true;
        Promise.resolve(opener(id)).finally(() => (ob.disabled = false));
      }
      return;
    }
    const tb = e.target.closest?.('[data-run-type]');
    if (tb && typer) {
      const cmd = tb.parentElement.querySelector('code')?.textContent || '';
      const id = projectOf(tb);
      if (id && CMD_RE.test(cmd)) {
        tb.disabled = true;
        Promise.resolve(typer(id, cmd)).finally(() => (tb.disabled = false));
      }
      return;
    }
    const cp = e.target.closest?.('[data-run-copy]');
    if (!cp) return;
    const label = cp.querySelector('span');
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(cp.parentElement.querySelector('code')?.textContent || ''))
      .then(
        () => {
          if (label) label.textContent = t('aiCopied');
          setTimeout(() => label && (label.textContent = t('aiCopy')), 1500);
        },
        () => label && (label.textContent = t('aiCopyFailed')),
      );
  });
}
