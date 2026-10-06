// "What changed" in the project drawer (docs/changes.md): the files an AI tool created or changed, newest first, from
// GET /api/projects/<id>/changes. changesSectionHtml is pure (tested in node); createChanges keeps the answers (asked
// again after 20 s, so the next draw shows what the AI just did).
import { esc, ago } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const KINDS = new Set(['new', 'changed', 'deleted', 'renamed']);
const SHOWN = 12;

async function fetchChanges(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/changes`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// The section. data: the server's answer, or null while it is asked; p: the project
export function changesSectionHtml(p, data) {
  if (!p?.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  if (data && data.via !== 'git' && data.via !== 'time') return '';
  const head = `<h3 id="chgH">${icon('list')} ${esc(t('chgTitle'))}</h3>`;
  if (!data) return `<section class="dr-sec chg" data-sec="changes" aria-labelledby="chgH">${head}<p class="muted small">${esc(t('chgLoading'))}</p></section>`;
  const files = (Array.isArray(data.files) ? data.files : []).filter((f) => typeof f?.path === 'string' && KINDS.has(f.kind));
  const intro = `<p class="muted small">${esc(t(data.via === 'git' ? 'chgViaGit' : data.gitSkipped ? 'chgGitSkipped' : 'chgViaTime'))}</p>`;
  if (!files.length) return `<section class="dr-sec chg" data-sec="changes" aria-labelledby="chgH">${head}<p class="small">${esc(t(data.via === 'git' ? 'chgNoneGit' : 'chgNoneTime'))}</p></section>`;
  const rows = files
    .slice(0, SHOWN)
    .map((f) => `<li><span class="chg-kind k-${f.kind}">${esc(t(`chgKind_${f.kind}`))}</span><code translate="no" title="${esc(f.path)}">${esc(f.path)}</code>${Number.isFinite(f.t) && f.t > 0 ? `<time>${esc(ago(f.t))}</time>` : ''}</li>`)
    .join('');
  // Hidden here, or not even read (the server stops after 30)
  const hidden = files.length - SHOWN;
  const more = data.more ? t('chgMoreMany') : hidden > 0 ? t('chgMore', { count: hidden }) : '';
  const moreHtml = more ? `<p class="muted small">${esc(more)}</p>` : '';
  return `<section class="dr-sec chg" data-sec="changes" aria-labelledby="chgH">${head}${intro}<ul class="chg-list">${rows}</ul>${moreHtml}</section>`;
}

// Answers per project. onData(projectId): an answer arrived (the drawer redraws when that project is open).
export function createChanges({ fetchJson = fetchChanges, onData = () => {}, now = () => Date.now(), ttl = 20000 } = {}) {
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
        () => cache.set(projectId, { at: now(), data: next.data || { via: null, files: [] }, pending: false }),
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
  return {
    get,
    // Ask again at once (an AI tool just started in the project)
    refresh(projectId) {
      cache.delete(projectId);
      return get(projectId);
    },
    html: (p) => (p?.path ? changesSectionHtml(p, get(p.id).data) : ''),
  };
}
