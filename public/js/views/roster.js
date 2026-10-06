// Roster tab: every skill, agent and plugin on this machine, which folder it sits in, where it applies and how often
// it was called. On top: how many skills and agents are in the user's own library (copies counted once), and one line
// on the SiberSentez kit that comes with the app (docs/kit.md). Below: a folder list (library categories, the kit's
// categories, projects, personal folders, plugins, claude.ai, built-in, logs) that filters the
// list; on a narrow window it becomes a drop-down. The selected folder stays in the address (?folder=; the older
// ?source= opens the matching group). Strings: ../strings/roster-folders.js.
import { store } from '../store.js';
import { esc, ago, num, agentColor, projectColor, itemDescription, kitSummary } from '../format.js';
import { icon } from '../icons.js';
import { SOURCE_HINT, sourcesOf, sourceLabel, everywhere, matchesFilter, libraryState, isLibraryItem, libraryCounts, kitCounts, folderIndex, folderCounts, folderGroups, parseFolder, sourceFolder, githubRows, githubSelectable, githubPicks, installGroups, githubItems, originRepo, KIT_SOURCE } from '../rosterModel.js';
import { actionsState, actionsReady, onActionsChange, runAction } from '../actions.js';
import { importBatches, skillErrorText, categoryLabel, reasonText, planRows, LIBRARY_CATEGORIES, MAX_SKILL_ITEMS } from '../contextmenu.js';
import { fitReasonsText } from './drawer.js';
import { t, language } from '../i18n.js';
import { multiTool, toolOptions, toolTagsHtml, toolSelectHtml } from '../toolTags.js';
import { ghTrustHtml } from '../githubTrust.js';

const PAGE = 120;
const FOLDER_PARAM = 'folder';
const SOURCE_PARAM = 'source';
// A folder group with more folders than this starts folded (plugins: often hundreds)
const FOLD_OVER = 12;
const KINDS = ['all', 'agent', 'skill', 'plugin'];
const KIND_KEY = { all: 'rfKindAll', agent: 'rfKindAgent', skill: 'rfKindSkill', plugin: 'rfKindPlugin' };
const ZERO = Object.freeze({ skill: 0, agent: 0, plugin: 0, total: 0 });

export function createRosterView(root, openDrawer) {
  const f = { q: '', kind: 'all', used: false, sort: 'usage', folder: initialFolder(), tool: 'all' };
  // Folder groups the user folded or unfolded (group -> open)
  const openState = new Map();
  let limit = PAGE;
  // The tab's text is in the chosen language: upper-cased headings follow its rules ("LIBRARY", not "LİBRARY")
  root.setAttribute('lang', language());
  root.innerHTML = `
    <div class="hub-note-wrap" data-k="hub"></div>
    <div class="imp-wrap" data-k="import"></div>
    <div class="roster-top">
      <div data-k="lib"></div>
      <div class="leaders adv-only" data-k="leaders"></div>
    </div>
    <div class="toolbar">
      <label class="search">${icon('search')}<input type="search" placeholder="${esc(t('rfSearch'))}" data-k="q" aria-label="${esc(t('rfSearchLabel'))}" autocomplete="off" spellcheck="false"></label>
      <div class="seg" data-k="kind" role="group" aria-label="${esc(t('rfKind'))}">
        ${KINDS.map((k) => `<button type="button" data-v="${k}" class="${k === 'all' ? 'on' : ''}" aria-pressed="${k === 'all'}">${esc(t(KIND_KEY[k]))}</button>`).join('')}
      </div>
      <select class="rf-select" data-k="folderSel" aria-label="${esc(t('rfFolderPick'))}"></select>
      <select class="tool-sel" data-k="tool" aria-label="${esc(t('tvFilterLabel'))}" title="${esc(t('tvFilterLabel'))}" hidden></select>
      <select data-k="sort" aria-label="${esc(t('rfSort'))}">
        <option value="usage">${esc(t('rfSortUsage'))}</option><option value="recent">${esc(t('rfSortRecent'))}</option><option value="name">${esc(t('rfSortName'))}</option>
      </select>
      <label class="toggle"><input type="checkbox" data-k="used"><span>${esc(t('rfUsedOnly'))}</span></label>
    </div>
    <div class="rbody">
      <nav class="rfolders" data-k="folders" aria-label="${esc(t('rfFolders'))}"></nav>
      <div class="rcol">
        <div class="rf-now" data-k="fhead"></div>
        <div class="rlist" data-k="list"></div>
      </div>
    </div>`;
  const $ = (k) => root.querySelector(`[data-k=${k}]`);
  // Rewrites an element only when its markup changed (keeps focus, selection and the copy button's state)
  const setIf = (el, html) => {
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  };
  const filtersChanged = () => {
    limit = PAGE;
    renderFolders();
    renderList();
  };
  $('q').addEventListener('input', (e) => {
    f.q = e.target.value.trim().toLocaleLowerCase('tr-TR');
    filtersChanged();
  });
  $('kind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    f.kind = b.dataset.v;
    for (const x of $('kind').children) {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    }
    filtersChanged();
  });
  $('sort').addEventListener('change', (e) => {
    f.sort = e.target.value;
    limit = PAGE;
    renderList();
  });
  $('used').addEventListener('change', (e) => {
    f.used = e.target.checked;
    filtersChanged();
  });
  $('folderSel').addEventListener('change', (e) => setFolder(e.target.value));
  $('tool').addEventListener('change', (e) => {
    f.tool = e.target.value || 'all';
    filtersChanged();
  });
  // The tool filter (docs/tool-view.md): only when more than one AI tool left traces here
  let multi = false;
  function renderTools() {
    multi = multiTool(store.tools, store.roster);
    const el = $('tool');
    const html = multi ? toolSelectHtml(toolOptions(store.roster, store.tools), f.tool, t('tvAllTools')) : '';
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
    el.hidden = !multi;
    f.tool = multi ? el.value : 'all';
  }
  root.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy-text]');
    if (cp) return copyPath(cp);
    const fb = e.target.closest('[data-folder]');
    if (fb) return setFolder(fb.dataset.folder);
    if (e.target.closest('[data-more]')) {
      limit += PAGE * 2;
      return renderList();
    }
    const r = e.target.closest('[data-roster]');
    if (r) openDrawer({ type: 'roster', id: r.dataset.roster });
  });
  // A folded or unfolded group stays that way across redraws
  root.addEventListener(
    'toggle',
    (e) => {
      const g = e.target.dataset?.rfGroup;
      if (g) openState.set(g, e.target.open);
    },
    true,
  );

  function setFolder(v) {
    const next = parseFolder(v);
    if (next === f.folder) return;
    f.folder = next;
    writeFolderParam(next);
    limit = PAGE;
    renderFolders();
    renderHead();
    renderList();
    // The list starts above the window (a folder picked far down the page): bring its head into view
    const head = $('fhead');
    if (head.getBoundingClientRect().top < 0) head.scrollIntoView({ block: 'start' });
  }

  // No hub folder: short explanation (an empty library is explained by the library count below the import section)
  function renderHub() {
    setIf($('hub'), hubNote(libraryState(store.hub)));
  }

  // How many skills and agents the user's own library holds (copies once), and the most used items
  function renderTop() {
    setIf($('lib'), libraryCard(libraryCounts(store.roster), libraryState(store.hub), actionsState().mode, kitCounts(store.roster)));
    const used = store.roster.filter((i) => i.usage && i.usage.count);
    const top = (kind) => used.filter((i) => i.kind === kind).sort((a, b) => b.usage.count - a.usage.count).slice(0, 8);
    const bars = (list, colorOf) => {
      const max = Math.max(1, ...list.map((i) => i.usage.count));
      return list.length
        ? list.map((i) => `<button class="hbar" data-roster="${esc(i.id)}" style="--c:${colorOf(i)};--w:${((i.usage.count / max) * 100).toFixed(1)}%"><span class="hb-name">${esc(i.name)}</span><span class="hb-track"><i></i></span><b>${num(i.usage.count)}</b></button>`).join('')
        : `<p class="muted small">${esc(t('rfLeadNone'))}</p>`;
    };
    const days = num(store.windowDays);
    setIf(
      $('leaders'),
      `<section><h4>${icon('agent')} ${esc(t('rfLeadAgents', { days }))}</h4>${bars(top('agent'), (i) => agentColor(i.name))}</section>
      <section><h4>${icon('skill')} ${esc(t('rfLeadSkills', { days }))}</h4>${bars(top('skill'), () => '#ffd66b')}</section>`,
    );
  }

  // Folder list (wide window) and folder drop-down (narrow window). Counts follow the other filters (kind, search,
  // used); a folder with nothing matching is hidden unless it is the selected one.
  let labels = new Map();
  // The folder last scrolled into the folder list's view (see renderFolderNav)
  let revealed = '';
  // Every folder of the current roster (the roster array is replaced, never changed in place)
  let fullFor = null;
  let fullIndex = null;
  function renderFolders() {
    const items = store.roster;
    if (fullFor !== items) {
      fullFor = items;
      fullIndex = folderIndex(items);
    }
    const full = fullIndex;
    labels = folderLabels([...full.values()]);
    // A folder from the address that is not there (any more): all folders. The library group always exists.
    if (f.folder !== 'all' && !folderKnown(full, f.folder)) {
      f.folder = 'all';
      writeFolderParam('all');
    }
    // A group of a single folder is that folder
    if (f.folder.startsWith('group:')) {
      const g = f.folder.slice(6);
      const members = [...full.values()].filter((e) => e.group === g);
      if (members.length === 1) {
        f.folder = members[0].key;
        writeFolderParam(f.folder);
      }
    }
    const vis = folderIndex(items, f);
    const entries = [...vis.values()];
    if (full.has(f.folder) && !vis.has(f.folder)) entries.push({ ...full.get(f.folder), counts: ZERO });
    const groups = folderGroups(entries, (e) => labels.get(e.key) || e.name);
    // Folders per group whatever the filters: a group of several folders offers "All ..." even when a filter
    // leaves one of them
    const fullGroups = new Map();
    for (const e of full.values()) fullGroups.set(e.group, (fullGroups.get(e.group) || 0) + 1);
    renderFolderNav(groups, fullGroups);
    renderFolderSelect(groups, fullGroups);
  }

  function renderFolderNav(groups, fullGroups) {
    const el = $('folders');
    const item = (key, label, counts, extra = '') => {
      const on = f.folder === key;
      const what = counts ? whatText(counts) : '';
      return `<button type="button" class="rf-item${on ? ' on' : ''}${extra}" data-folder="${esc(key)}" aria-pressed="${on}"${what ? ` title="${esc(t('rfFolderTitle', { name: label, what }))}"` : ''}><span class="rf-name"${key.startsWith('plugin:') || key.startsWith('home:') ? ' translate="no"' : ''}>${esc(label)}</span>${counts ? `<b>${num(counts.total)}</b>` : ''}</button>`;
    };
    const parts = [`<p class="rf-title">${esc(t('rfFolders'))}</p>`, item('all', t('rfAllFolders'), null, ' rf-all')];
    for (const g of groups) {
      const total = fullGroups.get(g.key) || 0;
      if (!g.folders.length && g.key !== 'library') continue;
      const selectedHere = f.folder === `group:${g.key}` || g.folders.some((e) => e.key === f.folder);
      const open = selectedHere || (openState.has(g.key) ? openState.get(g.key) : g.folders.length <= FOLD_OVER);
      const rows = [];
      if (g.key !== 'more' && total > 1) rows.push(item(`group:${g.key}`, t(`rfGroupAll_${g.key}`), null, ' rf-grp'));
      for (const e of g.folders) rows.push(item(e.key, labels.get(e.key) || e.name, e.counts));
      if (!g.folders.length) rows.push(`<p class="rf-empty">${esc(total ? t('rfGroupNoMatch') : t('rfGroupEmpty_library'))}</p>`);
      parts.push(`<details class="rf-group g-${g.key}" data-rf-group="${g.key}"${open ? ' open' : ''}>
        <summary><span class="rf-gname">${esc(t(`rfGroup_${g.key}`))}</span>${g.key === 'more' || !g.folders.length ? '' : `<small>${esc(countText(g.folders.length, 'rfFolders1', 'rfFoldersN'))}</small>`}</summary>
        <div class="rf-items">${rows.join('')}</div>
      </details>`);
    }
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset?.folder : null;
    const scroll = el.scrollTop;
    if (setIf(el, parts.join(''))) {
      el.scrollTop = scroll;
      if (focused) el.querySelector(`[data-folder="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
    // A folder chosen elsewhere (address, drop-down, library card) is scrolled into the list's view once
    if (revealed !== f.folder) {
      revealed = f.folder;
      const b = el.querySelector('.rf-item.on');
      if (b) {
        const r = b.getBoundingClientRect();
        const p = el.getBoundingClientRect();
        if (r.top < p.top) el.scrollTop += r.top - p.top - 40;
        else if (r.bottom > p.bottom) el.scrollTop += r.bottom - p.bottom + 40;
      }
    }
  }

  function renderFolderSelect(groups, fullGroups) {
    const sel = $('folderSel');
    const opt = (key, label, counts) => `<option value="${esc(key)}"${f.folder === key ? ' selected' : ''}>${esc(counts ? `${label} (${num(counts.total)})` : label)}</option>`;
    let html = opt('all', t('rfAllFolders'));
    for (const g of groups) {
      const total = fullGroups.get(g.key) || 0;
      // "All ..." of a group of several folders; an empty library too (choosing it explains where the library
      // folder is); and the selected group, so the drop-down always shows the choice
      const showAll = g.key !== 'more' && (total > 1 || (g.key === 'library' && !total) || f.folder === `group:${g.key}`);
      if (!g.folders.length && !showAll) continue;
      const rows = [];
      if (showAll) rows.push(opt(`group:${g.key}`, t(`rfGroupAll_${g.key}`)));
      for (const e of g.folders) rows.push(opt(e.key, labels.get(e.key) || e.name, e.counts));
      html += `<optgroup label="${esc(t(`rfGroup_${g.key}`))}">${rows.join('')}</optgroup>`;
    }
    if (setIf(sel, html) || sel.value !== f.folder) sel.value = f.folder;
  }

  // One line above the list: which folder is shown and what is in it (plain counts, copies once)
  function renderHead() {
    const el = $('fhead');
    const all = `<button type="button" class="rf-clear" data-folder="all">${esc(t('rfShowAll'))}</button>`;
    if (f.folder === 'all') return setIf(el, `<p>${esc(t('rfHeadAll'))}</p>`);
    if (f.folder.startsWith('group:')) {
      const g = f.folder.slice(6);
      let n = 0;
      for (const e of fullIndex?.values() || []) if (e.group === g) n++;
      // Only the library group can be empty (it is always offered)
      const text = n ? t('rfHeadGroup', { folders: countText(n, 'rfFolders1', 'rfFoldersN') }) : t('rfLibEmpty');
      return setIf(el, `<p><b>${esc(t(`rfGroupAll_${g}`))}</b> · ${esc(text)}</p>${all}`);
    }
    const c = folderCounts(store.roster, f.folder);
    const label = labels.get(f.folder) || f.folder;
    const text = c.total ? t('rfHeadHas', { what: whatText(c) }) : t('rfHeadEmpty');
    setIf(el, `<p><b translate="no">${esc(label)}</b> <span class="rf-kindof">${folderKindHtml(f.folder)}</span> · ${esc(text)}</p>${all}`);
  }

  function filtered() {
    const list = store.roster.filter((i) => matchesFilter(i, f));
    const u = (i) => i.usage?.count || 0;
    if (f.sort === 'usage') list.sort((a, b) => u(b) - u(a) || a.name.localeCompare(b.name, 'tr'));
    else if (f.sort === 'recent') list.sort((a, b) => (b.usage?.lastAt || 0) - (a.usage?.lastAt || 0) || a.name.localeCompare(b.name, 'tr'));
    else list.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return list;
  }

  function renderList() {
    const list = filtered();
    const max = Math.max(1, ...list.map((i) => i.usage?.count || 0));
    const rows = list.slice(0, limit).map((i) => row(i, max, multi)).join('');
    $('list').innerHTML = `<div class="rhead"><span></span><span>${esc(t('rfColName'))}</span><span>${esc(t('rfColWhere'))}</span><span>${esc(t('rfColUsage'))}</span></div>${rows || emptyList(f)}${
      list.length > limit ? `<button type="button" class="more" data-more>${esc(t('rfMore', { count: num(list.length - limit) }))}</button>` : ''
    }<p class="muted small list-foot">${esc(countText(list.length, 'rfShown1', 'rfShownN'))}</p>`;
  }

  // ---------- import into the library (docs/skills-flow.md §5): folder -> scan -> choose -> import ----------
  // Two tabs: from a folder on this computer, or from GitHub (docs/github-import.md §8)
  const imp = { tab: 'local', source: '', open: false, busy: '', scan: null, picks: new Map(), msg: '', result: null };
  // GitHub: the link, what runs (busy), the Preview plan, the download's items and picks, the import's summary, the
  // install and update-check answers
  const gh = { url: '', busy: '', busyArg: '', plan: null, fetch: null, picks: new Map(), showAll: false, msg: '', imported: null, installs: new Map(), checks: new Map() };

  // The library card has its own "Add to the library" button: the closed section is not shown as a second one
  // (2026-10-02); opened from the card, its summary stays to close it. Without that button it is the only way in.
  // Asked again after the card is drawn (it comes after this section).
  function syncImportShown() {
    $('import').hidden = !imp.open && !!root.querySelector('[data-imp-open]');
  }

  function renderImport() {
    const el = $('import');
    syncImportShown();
    const html = importHtml(imp, gh, actionsState().mode, libraryCategoryList());
    if (el._html === html) return;
    // The focused control (data-fk) keeps focus after a redraw
    const act = document.activeElement;
    const fk = act && el.contains(act) ? act.dataset?.fk : null;
    el._html = html;
    el.innerHTML = html;
    if (fk) el.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }

  async function scan() {
    if (imp.busy) return;
    imp.busy = 'scan';
    imp.msg = '';
    imp.result = null;
    renderImport();
    const r = await runAction({ action: 'library-scan', source: imp.source.trim() });
    imp.busy = '';
    if (r.ok) {
      imp.scan = r.result;
      imp.picks = new Map((r.result?.items || []).map((it) => [it.path, { on: it.status === 'new' && !it.problems.length, category: it.category, replace: false }]));
      imp.msg = r.result?.items?.length ? t('skScanCount', { count: num(r.result.items.length), source: r.result.source }) : t('skScanNone');
    } else {
      imp.scan = null;
      imp.msg = skillErrorText(r);
    }
    renderImport();
  }

  // "Choose a folder" (the desktop app only): the system folder picker fills the field and scans at once
  async function pickFolder() {
    const bridge = globalThis.sibersentezShell;
    if (imp.busy || typeof bridge?.pickLibraryFolder !== 'function') return;
    let r;
    try {
      r = await bridge.pickLibraryFolder();
    } catch {
      r = { ok: false, reason: 'error' };
    }
    if (r?.ok && typeof r.path === 'string') {
      imp.source = r.path;
      return scan();
    }
    if (r?.reason && r.reason !== 'cancelled') {
      imp.msg = t(r.reason === 'too-long' ? 'skPickTooLong' : r.reason === 'busy' ? 'skPickBusy' : 'skPickFailed');
      renderImport();
    }
  }

  async function runImport() {
    const src = imp.scan?.source;
    const picks = (imp.scan?.items || [])
      .filter((it) => imp.picks.get(it.path)?.on && importable(it, imp.picks.get(it.path)))
      .map((it) => ({ path: it.path, category: imp.picks.get(it.path).category, ...(imp.picks.get(it.path).replace ? { replace: true } : {}) }));
    if (!src || !picks.length || imp.busy) {
      imp.msg = t('skImportNothing');
      return renderImport();
    }
    imp.busy = 'import';
    imp.msg = '';
    renderImport();
    const plan = [];
    let ok = true;
    let dry = false;
    let copied = 0;
    let updated = 0;
    let error = null;
    // Batches stay under the server's body limit; each one is its own request
    for (const batch of importBatches(src, picks)) {
      const r = await runAction({ action: 'library-import', source: src, items: batch });
      if (!r.ok) {
        ok = false;
        error = r;
        break;
      }
      dry = r.mode === 'dry';
      plan.push(...(r.plan || []));
      copied += r.result?.copied || 0;
      updated += r.result?.updated || 0;
    }
    imp.busy = '';
    imp.result = { ok, dry, plan };
    imp.msg = !ok ? skillErrorText(error) : dry ? t('skDryNote') : t('skImportDone', { copied: num(copied), updated: num(updated) });
    renderImport();
  }

  // ---------- from GitHub (docs/github-import.md §8): link -> fetch -> choose -> library -> project ----------

  // Deletes the download the page still holds (a new fetch, "Cancel", after the import). In Preview nothing is deleted.
  async function ghDropDownload() {
    const id = gh.fetch?.fetchId;
    if (!id || gh.fetch.discarded || actionsState().mode !== 'live') return;
    const r = await runAction({ action: 'github-discard', fetchId: id });
    if (r.ok) gh.fetch.discarded = true;
  }

  async function ghFetch() {
    const url = gh.url.trim();
    if (gh.busy || !url) return;
    gh.busy = 'fetch';
    gh.msg = '';
    renderImport();
    await ghDropDownload();
    Object.assign(gh, { plan: null, fetch: null, imported: null, installs: new Map(), picks: new Map(), showAll: false });
    const r = await runAction({ action: 'github-fetch', url });
    gh.busy = '';
    if (!r.ok) gh.msg = ghErrorText(r);
    else if (!r.result?.executed) gh.plan = r.result || {};
    else {
      gh.fetch = r.result;
      gh.picks = new Map((r.result.items || []).map((it) => [it.path, { on: !!it.selected, category: it.category, replace: false }]));
    }
    renderImport();
  }

  async function ghImport() {
    const f = gh.fetch;
    const picks = f ? githubPicks(f.items, gh.picks) : [];
    if (gh.busy || !picks.length) {
      gh.msg = t('ghImportNothing');
      return renderImport();
    }
    gh.busy = 'import';
    gh.msg = '';
    renderImport();
    const plan = [];
    let dry = false;
    let error = null;
    for (const batch of importBatches(f.fetchId, picks)) {
      const r = await runAction({ action: 'github-import', fetchId: f.fetchId, items: batch });
      if (!r.ok) {
        error = r;
        break;
      }
      dry = r.mode === 'dry' || !r.result?.executed;
      plan.push(...(r.plan || []));
    }
    if (error && !plan.length) {
      gh.busy = '';
      gh.msg = ghErrorText(error);
      return renderImport();
    }
    const byKey = new Map(f.items.map((it) => [`${it.kind}:${it.name}`.toLowerCase(), it]));
    const done = plan.filter((e) => e.op === 'copy' || e.op === 'update').map((e) => ({ kind: e.kind, name: e.name, category: e.category, fits: byKey.get(`${e.kind}:${e.name}`.toLowerCase())?.fits || [] }));
    gh.imported = { dry, items: done, skipped: plan.filter((e) => e.op === 'skip'), plan, error: error ? ghErrorText(error) : '' };
    // The download is not needed any more: deleted at once (in Preview it stays for a second try)
    if (!dry) await ghDropDownload();
    gh.busy = '';
    renderImport();
  }

  async function ghDiscard() {
    if (gh.busy || !gh.fetch) return;
    gh.busy = 'discard';
    renderImport();
    const live = actionsState().mode === 'live';
    await ghDropDownload();
    Object.assign(gh, { busy: '', fetch: null, imported: null, picks: new Map(), msg: live ? t('ghDiscarded') : t('skDryNote') });
    renderImport();
  }

  async function ghInstall(projectId) {
    const g = installGroups(gh.imported?.items || [], { max: MAX_SKILL_ITEMS }).find((x) => x.projectId === projectId);
    if (gh.busy || !g) return;
    gh.busy = 'install';
    gh.busyArg = projectId;
    renderImport();
    const r = await runAction({ action: 'skills-install', projectId, items: g.items });
    gh.installs.set(projectId, r);
    gh.busy = '';
    gh.busyArg = '';
    renderImport();
  }

  function ghAgain() {
    if (gh.busy) return;
    Object.assign(gh, { url: '', plan: null, fetch: null, imported: null, installs: new Map(), picks: new Map(), msg: '', showAll: false });
    renderImport();
    root.querySelector('[data-gh-url]')?.focus();
  }

  // An update download is kept while an unapplied update still points at it
  async function ghReleaseCheck(key) {
    const c = gh.checks.get(key)?.item;
    gh.checks.delete(key);
    const id = c?.fetchId;
    if (!id || actionsState().mode !== 'live') return;
    const others = [...gh.checks.values()].some((x) => x.item?.status === 'update' && !x.applied && x.item.fetchId === id);
    if (!others) await runAction({ action: 'github-discard', fetchId: id });
  }

  async function ghCheck(key) {
    const it = githubItems(store.roster).find((x) => `${x.kind}:${x.name}`.toLowerCase() === key);
    if (gh.busy || !it) return;
    gh.busy = 'check';
    gh.busyArg = key;
    renderImport();
    const r = await runAction({ action: 'github-check-update', items: [{ kind: it.kind, name: it.name }] });
    gh.busy = '';
    gh.busyArg = '';
    if (!r.ok) gh.checks.set(key, { error: ghErrorText(r) });
    else if (!r.result?.executed) gh.checks.set(key, { dry: r.plan?.[0] || null });
    else gh.checks.set(key, { item: r.result.items?.[0] || null });
    renderImport();
  }

  async function ghApply(key) {
    const c = gh.checks.get(key)?.item;
    if (gh.busy || c?.status !== 'update') return;
    gh.busy = 'apply';
    gh.busyArg = key;
    renderImport();
    const r = await runAction({ action: 'github-import', fetchId: c.fetchId, items: [{ path: c.path, category: c.category, replace: true }] });
    gh.busy = '';
    gh.busyArg = '';
    const ok = r.ok && (r.plan || []).some((e) => e.op === 'update' || e.op === 'copy');
    if (ok && r.result?.executed) {
      gh.checks.set(key, { item: c, applied: true });
      const others = [...gh.checks.values()].some((x) => x.item?.status === 'update' && !x.applied && x.item.fetchId === c.fetchId);
      if (!others) await runAction({ action: 'github-discard', fetchId: c.fetchId });
    } else gh.checks.set(key, { item: c, applyError: r.ok ? reasonText((r.plan || [])[0]?.reason || 'error') : ghErrorText(r), dryApply: r.ok && !r.result?.executed });
    renderImport();
  }

  async function ghLater(key) {
    if (gh.busy) return;
    await ghReleaseCheck(key);
    renderImport();
  }

  root.addEventListener('input', (e) => {
    if (e.target.matches?.('[data-imp-src]')) imp.source = e.target.value;
    else if (e.target.matches?.('[data-gh-url]')) {
      const had = !!gh.url.trim();
      gh.url = e.target.value;
      // The Fetch button follows the field (redrawn only when it turns on or off)
      if (had !== !!gh.url.trim()) renderImport();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('[data-imp-src]')) {
      e.preventDefault();
      scan();
    } else if (e.key === 'Enter' && e.target.matches?.('[data-gh-url]')) {
      e.preventDefault();
      ghFetch();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.matches?.('[data-imp-tab]')) {
      // The two tabs: arrow keys move between them (and choose)
      e.preventDefault();
      imp.tab = imp.tab === 'local' ? 'github' : 'local';
      renderImport();
      root.querySelector(`[data-imp-tab="${imp.tab}"]`)?.focus();
    }
  });
  root.addEventListener('change', (e) => {
    const ghRow = e.target.closest?.('[data-gh-path]');
    if (ghRow) {
      const p = gh.picks.get(ghRow.dataset.ghPath);
      if (!p) return;
      if (e.target.matches('[data-gh-on]')) p.on = e.target.checked;
      else if (e.target.matches('[data-gh-cat]')) p.category = e.target.value;
      else if (e.target.matches('[data-gh-rep]')) p.replace = e.target.checked;
      else return;
      return renderImport();
    }
    const row = e.target.closest?.('[data-imp-path]');
    if (!row) return;
    const p = imp.picks.get(row.dataset.impPath);
    if (!p) return;
    if (e.target.matches('[data-imp-on]')) p.on = e.target.checked;
    else if (e.target.matches('[data-imp-cat]')) p.category = e.target.value;
    else if (e.target.matches('[data-imp-rep]')) p.replace = e.target.checked;
    else return;
    renderImport();
  });
  root.addEventListener('click', (e) => {
    const tab = e.target.closest?.('[data-imp-tab]');
    if (tab) {
      imp.tab = tab.dataset.impTab === 'github' ? 'github' : 'local';
      return renderImport();
    }
    const g = e.target.closest?.('[data-gh-act]');
    if (g) {
      if (g.getAttribute('aria-disabled') === 'true') return;
      const arg = g.dataset.ghArg || '';
      const run = { fetch: ghFetch, import: ghImport, discard: ghDiscard, again: ghAgain, install: () => ghInstall(arg), check: () => ghCheck(arg), apply: () => ghApply(arg), later: () => ghLater(arg) }[g.dataset.ghAct];
      if (g.dataset.ghAct === 'toggle') {
        gh.showAll = !gh.showAll;
        return renderImport();
      }
      return run?.();
    }
    if (e.target.closest?.('[data-imp-open]')) return openImport();
    const b = e.target.closest?.('[data-imp-act]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    if (b.dataset.impAct === 'scan') scan();
    else if (b.dataset.impAct === 'import') runImport();
    else if (b.dataset.impAct === 'pick') pickFolder();
  });

  // Opens "Add to the library" and brings it into view (the library card's button, the command palette); tab:
  // 'local' or 'github' picks that tab
  function openImport(tab) {
    if (tab === 'local' || tab === 'github') imp.tab = tab;
    imp.open = true;
    renderImport();
    const el = $('import');
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    el.querySelector('summary')?.focus({ preventScroll: true });
  }
  root.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('[data-imp]')) {
        imp.open = e.target.open;
        // Closed again: it folds away behind the card's button
        if (!imp.open) renderImport();
      }
    },
    true,
  );
  onActionsChange(() => {
    renderImport();
    // The library hint names the import section only while it is shown
    if (store.loaded) renderTop();
  });
  // QA hooks (qaImportHooks): ?qa=1&import=<folder> and ?qa=1&github=<link> fill the section; the scan and the fetch
  // run only in Preview (the server answers with a plan and reaches nothing), never in live mode: any page can open
  // this address. ?qa=1&github=demo|demo-done: a sample answer, no request.
  try {
    const hooks = qaImportHooks(location.search, 'off');
    if (hooks.open) imp.open = true;
    if (hooks.tab) imp.tab = hooks.tab;
    if (hooks.source) imp.source = hooks.source;
    if (hooks.url) gh.url = hooks.url;
    if (hooks.sample) {
      const done = hooks.sample === 'demo-done';
      const when = () => (store.loaded ? Object.assign(gh, qaGitHubSample(done), { url: 'https://github.com/acme/skills' }) && renderImport() : setTimeout(when, 200));
      when();
    }
    if (hooks.source || hooks.url) {
      actionsReady().then((s) => {
        const now = qaImportHooks(location.search, s.mode);
        if (now.scan) scan();
        if (now.fetch) ghFetch();
      });
    }
  } catch {
    /* no address (node tests) */
  }

  // Categories offered for an import: the known ones plus the library's own
  function libraryCategoryList() {
    const own = new Set(store.roster.filter((i) => isLibraryItem(i) && i.category).map((i) => i.category));
    return [...new Set([...LIBRARY_CATEGORIES, ...[...own].filter((c) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(c)).sort()])];
  }

  function render() {
    renderTools();
    renderHub();
    renderImport();
    renderTop();
    syncImportShown();
    renderFolders();
    renderHead();
    renderList();
  }

  return { render, openImport };
}

// ---------- counts in words ----------

function countText(n, one, many) {
  return t(n === 1 ? one : many, { count: num(n) });
}

// "12 agents, 30 skills and 1 plugin" (zero kinds left out)
function whatText(c) {
  const parts = [];
  if (c.agent) parts.push(countText(c.agent, 'rfAgent1', 'rfAgentN'));
  if (c.skill) parts.push(countText(c.skill, 'rfSkill1', 'rfSkillN'));
  if (c.plugin) parts.push(countText(c.plugin, 'rfPlugin1', 'rfPluginN'));
  if (parts.length < 2) return parts[0] || '';
  return t('rfAnd', { a: parts.slice(0, -1).join(', '), b: parts.at(-1) });
}

// The same count with the number in bold (the template is escaped first, then the number goes in)
function countHtml(n, one, many) {
  return esc(t(n === 1 ? one : many)).replace('{count}', `<b>${num(n)}</b>`);
}

// ---------- folders ----------

// Display name of every folder: library categories by their localized name, projects by their name (two projects
// with the same name get their parent folder's name), personal folders as sent (home-relative), plugins by name
function folderLabels(entries) {
  const out = new Map();
  const projName = (id) => store.projects.get(id)?.name || id;
  const names = new Map();
  for (const e of entries) {
    if (e.group !== 'projects') continue;
    const n = projName(e.name).toLocaleLowerCase('tr-TR');
    names.set(n, (names.get(n) || 0) + 1);
  }
  for (const e of entries) {
    const k = e.key;
    let label;
    if (k.startsWith('lib:') || k.startsWith('kit:')) label = e.name ? categoryLabel(e.name) : t('rfUncategorized');
    else if (k.startsWith('proj:')) {
      label = projName(e.name);
      if (names.get(label.toLocaleLowerCase('tr-TR')) > 1) {
        const hint = parentName(store.projects.get(e.name)?.path);
        if (hint) label = `${label} · ${hint}`;
      }
    } else if (k.startsWith('home:')) label = e.name || t('rfPersonalUnknown');
    else if (k.startsWith('plugin:')) label = e.name;
    else label = t(`rfFolder_${k}`);
    out.set(k, label);
  }
  return out;
}

// Name of the folder that holds a project folder ("D:" for a folder at a drive root); never the full path
function parentName(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

// Is a folder or group key there? The library group always is (an empty library is explained in the list).
function folderKnown(full, key) {
  if (key === 'group:library') return true;
  if (key.startsWith('group:')) {
    const g = key.slice(6);
    return [...full.values()].some((e) => e.group === g);
  }
  return full.has(key);
}

// What kind of folder a key is, for the line above the list: "library folder (library\web)", "project folder", ...
function folderKindHtml(key) {
  if (key.startsWith('lib:')) return `${esc(t('rfWhat_lib'))} <code translate="no">library\\${esc(key.slice(4))}</code>`;
  if (key.startsWith('kit:')) return esc(t('rfWhat_kit'));
  if (key.startsWith('proj:')) return esc(t('rfWhat_proj'));
  if (key.startsWith('home:')) return esc(t('rfWhat_home'));
  if (key.startsWith('plugin:')) return esc(t('rfWhat_plugin'));
  return esc(t(`rfFolderHint_${key}`));
}

// ---------- library count, hub note, empty list ----------

// kit: the SiberSentez kit's counts; one line under the library count while the kit has items (the library count itself
// stays the user's own)
function libraryCard(c, st, mode, kit = { total: 0 }) {
  const empty = !c.total;
  const kitLine = kit.total
    ? `<p class="lc-kit"><span class="rsrc s-kit">${esc(t('rfKitName'))}</span><span>${countHtml(kit.skill, 'rfSkill1', 'rfSkillN')}</span><span class="lc-dot" aria-hidden="true">·</span><span>${countHtml(kit.agent, 'rfAgent1', 'rfAgentN')}</span><span class="lc-kit-note">${esc(t('rfKitReady'))}</span><button type="button" class="linkish lc-kit-show" data-folder="group:kit">${esc(t('rfKitShow'))}</button></p>`
    : '';
  const how = st.state === 'none' ? '' : `<p class="lc-how">${esc(t('rfLibEmpty'))} ${esc(t(mode === 'off' ? 'rfLibHowToOff' : 'rfLibHowTo'))}</p>`;
  const path =
    empty && st.libraryPath
      ? `<p class="hn-path"><span class="muted">${esc(t('rfLibFolder'))}</span><code translate="no">${esc(st.libraryPath)}</code><button type="button" class="icon-btn hn-copy" data-copy-text="${esc(st.libraryPath)}" aria-label="${esc(t('rfCopyPathLabel'))}" title="${esc(t('rfCopyPath'))}">${icon('copy')}</button><span class="sr-only" role="status" aria-live="polite" data-copy-live></span></p>`
      : '';
  return `<section class="lib-card${empty ? ' is-empty' : ''}" aria-labelledby="libCardT" data-copy-scope>
    <span class="lc-ic" aria-hidden="true">${icon('folder')}</span>
    <div class="lc-body">
      <h3 id="libCardT">${esc(t('rfLibTitle'))}</h3>
      <p class="lc-nums"><span>${countHtml(c.skill, 'rfSkill1', 'rfSkillN')}</span><span class="lc-dot" aria-hidden="true">·</span><span>${countHtml(c.agent, 'rfAgent1', 'rfAgentN')}</span></p>
      ${empty ? how + path : `<p class="lc-note">${esc(t('rfLibNote'))}</p>`}
      ${kitLine}
    </div>
    <div class="lc-acts">
      ${st.state === 'none' ? '' : `<button type="button" class="act-btn primary lc-add" data-imp-open data-fk="lib:add">${icon('folder')}<span>${esc(t('rfLibAdd'))}</span></button>`}
      ${empty ? '' : `<button type="button" class="act-btn lc-show" data-folder="group:library">${esc(t('rfLibShow'))}</button>`}
    </div>
  </section>`;
}

// No hub folder: what that means and where the app creates it
function hubNote(st) {
  if (st.state !== 'none') return '';
  const text = esc(t('rfNoHubText')).replace('{path}', '<code translate="no">%USERPROFILE%\\SiberSentez</code>');
  return `<section class="hub-note" aria-labelledby="hubNoteT">
      <span class="hn-ic" aria-hidden="true">${icon('folder')}</span>
      <div class="hn-body">
        <h3 id="hubNoteT">${esc(t('rfNoHubTitle'))}</h3>
        <p>${text}</p>
      </div>
    </section>`;
}

// Empty list: in a library folder explain the hub/library state, otherwise a plain message
function emptyList(f) {
  if (f.folder === 'group:library' || f.folder.startsWith('lib:')) {
    const st = libraryState(store.hub);
    if (st.state === 'none') return `<div class="empty-state">${esc(t('rfNoHubList'))}</div>`;
    if (st.state === 'empty' && !f.q) return `<div class="empty-state"><b>${esc(t('rfLibEmptyList'))}</b><br><code translate="no">${esc(st.libraryPath)}</code></div>`;
  }
  return `<div class="empty-state">${esc(t('rfNoMatch'))}</div>`;
}

// ---------- address ----------

// ?folder=<key> opens the roster on that folder; the older ?source=<source> opens its group
function initialFolder() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has(FOLDER_PARAM)) return parseFolder(q.get(FOLDER_PARAM));
    return sourceFolder(q.get(SOURCE_PARAM));
  } catch {
    return 'all';
  }
}
function writeFolderParam(v) {
  try {
    const u = new URL(location.href);
    u.searchParams.delete(SOURCE_PARAM);
    if (v === 'all') u.searchParams.delete(FOLDER_PARAM);
    else u.searchParams.set(FOLDER_PARAM, v);
    history.replaceState(history.state, '', u);
  } catch {
    /* address not writable: the filter still works */
  }
}

async function copyPath(btn) {
  const text = btn.dataset.copyText || '';
  const live = btn.closest('[data-copy-scope]')?.querySelector('[data-copy-live]');
  try {
    await navigator.clipboard.writeText(text);
    btn.dataset.done = '1';
    if (live) live.textContent = t('rfCopied');
  } catch {
    if (live) live.textContent = t('rfCopyFailed');
  }
  setTimeout(() => {
    delete btn.dataset.done;
    if (live) live.textContent = '';
  }, 2500);
}

// ---------- rows ----------

// A scan result the import may take: no problem, not already the same; a conflict only with replace
function importable(it, pick) {
  if (it.problems?.length || it.status === 'same') return false;
  return it.status !== 'conflict' || !!pick?.replace;
}

// The "Add to the library" section: two tabs, from a folder on this computer and from GitHub. Actions Off: each tab
// says how to turn them on.
function importHtml(imp, gh, mode, categories) {
  const badge = mode === 'dry' ? `<span class="cm-badge">${esc(t('skDryBadge'))}</span>` : '';
  const tab = (k, label) =>
    `<button type="button" role="tab" class="gh-tab${imp.tab === k ? ' on' : ''}" id="impTab-${k}" aria-controls="impPanel" aria-selected="${imp.tab === k}" tabindex="${imp.tab === k ? 0 : -1}" data-imp-tab="${k}" data-fk="imp-tab:${k}">${esc(label)}</button>`;
  const body = imp.tab === 'github' ? githubHtml(gh, mode, categories) : mode === 'off' ? `<p class="gh-note gh-off">${esc(t('actionsOffError'))}</p>` : localImportHtml(imp, categories);
  return `<details class="imp flow" data-imp${imp.open ? ' open' : ''}>
    <summary>${icon('folder')}<span>${esc(t('skImportTitle'))}</span>${badge}</summary>
    <div class="gh-tabs" role="tablist" aria-label="${esc(t('ghTabs'))}">${tab('local', t('ghTabLocal'))}${tab('github', t('ghTabGithub'))}</div>
    <div class="gh-panel" id="impPanel" role="tabpanel" aria-labelledby="impTab-${imp.tab}">${body}</div>
  </details>`;
}

// ---------- GitHub tab (docs/github-import.md §8) ----------

// Text of an id, or the fallback when the table has none
function tOr(key, fallback) {
  const v = t(key);
  return v === key ? fallback : v;
}

// An error answer of a GitHub action: its own text (ghErr_<code>), else the skill flow's
function ghErrorText(r) {
  const e = String(r?.error || '');
  if (r && Number(r.status) >= 400 && /^[a-z][a-z-]*$/.test(e)) {
    const own = tOr(`ghErr_${e}`, '');
    if (own) return own;
  }
  return skillErrorText(r);
}

const projName = (id) => store.projects.get(id)?.name || id;

// A numbered step with its one-sentence explanation
function ghStep(n, title, help) {
  return `<div class="gh-step"><h4><span class="gh-num" aria-hidden="true">${n}</span>${esc(title)}</h4><p class="gh-help">${esc(help)}</p></div>`;
}

const reviewText = (code) => tOr(`ghReview_${code}`, t('ghReview_other'));

// Every reason of a review, one per line: "Dangerous: pipes a download into a shell (scripts/run.sh, line 2)"
function reviewTitle(review) {
  const lines = (review?.reasons || []).map((r) => `${t(`ghLevel_${r.level}`)}: ${reviewText(r.code)}${r.file ? ` (${r.line ? t('ghReviewAt', { file: r.file, line: r.line }) : r.file})` : ''}`);
  return lines.length ? lines.join('\n') : t('ghLevelHelp_ok');
}

function safetyHtml(review) {
  const level = ['ok', 'caution', 'danger'].includes(review?.level) ? review.level : 'caution';
  const reasons = review?.reasons || [];
  const why = reasons.length ? `<span class="gh-why">${esc(reviewText(reasons[0].code))}${reasons.length > 1 ? ` <b>+${num(reasons.length - 1)}</b>` : ''}</span>` : '';
  return `<span class="gh-badge lv-${level}" title="${esc(reviewTitle(review))}">${esc(t(`ghLevel_${level}`))}</span>${why}`;
}

// The license badge: the SPDX id, or the family's name; no license at all carries its warning
function licenseHtml(l) {
  const fam = ['permissive', 'copyleft', 'cc', 'proprietary', 'unknown', 'none'].includes(l?.family) ? l.family : 'none';
  const id = typeof l?.spdx === 'string' && !['proprietary', 'unknown'].includes(l.spdx) ? l.spdx : '';
  const label = id || t(`ghLicense_${fam === 'proprietary' ? 'proprietary' : fam === 'none' ? 'none' : 'unknown'}`);
  const warn = fam === 'none' || fam === 'proprietary' ? `<span class="gh-why gh-warn">${esc(t(`ghLicenseHelp_${fam}`))}</span>` : '';
  return `<span class="gh-lic f-${fam}" title="${esc(t(`ghLicenseHelp_${fam}`))}" translate="no">${esc(label)}</span>${warn}`;
}

function fitsHtml(fits) {
  if (!Array.isArray(fits) || !fits.length) return `<span class="gh-fit none">${esc(t('ghFitNone'))}</span>`;
  const chip = (f) => `<span class="gh-fit c-${f.confidence === 'high' ? 'high' : 'medium'}" style="--c:${projectColor(f.projectId)}" title="${esc(fitReasonsText(f.reasons, projName))}"><i></i>${esc(projName(f.projectId))}<small>${esc(t(f.confidence === 'high' ? 'ghFitHigh' : 'ghFitMedium'))}</small></span>`;
  return fits.slice(0, 3).map(chip).join('') + (fits.length > 3 ? `<span class="gh-fit more">+${num(fits.length - 3)}</span>` : '');
}

// Where the item already is: the library (same or another version), the SiberSentez kit, projects
function statusHtml(it) {
  const out = [];
  if (it.problems?.length) out.push(reasonText(it.problems[0]));
  else out.push(t(`skStatus_${it.status}`));
  if (it.kit) out.push(t(it.kit === 'same' ? 'ghStatus_kitSame' : 'ghStatus_kit'));
  for (const pid of (it.inProjects || []).slice(0, 2)) out.push(t('ghStatus_inProject', { project: projName(pid) }));
  return `<span class="gh-status${it.status === 'new' && !it.problems?.length ? ' new' : ''}">${esc(out.join(' · '))}</span>`;
}

function ghRowHtml(it, p, categories, busy) {
  const can = !busy && githubSelectable(it);
  const cats = categories.includes(p.category) ? categories : [p.category, ...categories].filter(Boolean);
  const level = it.review?.level || 'caution';
  const rep = it.status === 'conflict' && !it.problems?.length ? `<label class="imp-rep"><input type="checkbox" data-gh-rep data-fk="gh-rep:${esc(it.path)}"${p.replace ? ' checked' : ''}${busy ? ' disabled' : ''}><span>${esc(t('skReplace'))}</span></label>` : '';
  return `<div class="gh-row lv-${esc(level)}${can ? '' : ' off'}" data-gh-path="${esc(it.path)}">
    <input type="checkbox" data-gh-on data-fk="gh-on:${esc(it.path)}" aria-label="${esc(it.name)}"${p.on && can ? ' checked' : ''}${can ? '' : ' disabled'}>
    <span class="gh-name"><span class="skl-name" translate="no">${esc(it.name)}</span><span class="skl-meta">${esc(t(`skKind_${it.kind}`))} · <code translate="no">${esc(it.path)}</code></span>${it.description ? `<span class="gh-desc">${esc(it.description)}</span>` : ''}</span>
    <select data-gh-cat data-fk="gh-cat:${esc(it.path)}" aria-label="${esc(t('skColCategory'))}"${can && it.status !== 'conflict' ? '' : ' disabled'}>${cats.map((c) => `<option value="${esc(c)}"${c === p.category ? ' selected' : ''}>${esc(categoryLabel(c))}</option>`).join('')}</select>
    <div class="gh-facts">
      <span class="gh-fact"><span class="gh-k">${esc(t('ghColSafety'))}</span>${safetyHtml(it.review)}</span>
      <span class="gh-fact"><span class="gh-k">${esc(t('ghColLicense'))}</span>${licenseHtml(it.license)}</span>
      <span class="gh-fact"><span class="gh-k">${esc(t('ghColFits'))}</span>${fitsHtml(it.fits)}</span>
      <span class="gh-fact"><span class="gh-k">${esc(t('ghColStatus'))}</span>${statusHtml(it)}${rep}</span>
    </div>
  </div>`;
}

function ghBusyText(gh) {
  if (gh.busy === 'install') return t('ghBusyInstall', { project: projName(gh.busyArg) });
  return t(`ghBusy_${gh.busy}`);
}

// What Fetch would do (Preview mode): repository, ref, folder, method, hosts, temporary place
function ghPlanHtml(plan) {
  const hosts = Array.isArray(plan.hosts) ? plan.hosts.join(', ') : 'github.com';
  const lines = [
    t('ghPlanRepo', { repo: plan.repo || '' }),
    plan.ref ? t('ghPlanRef', { ref: plan.ref }) : t('ghPlanDefaultRef'),
    plan.path ? t('ghPlanPath', { path: plan.path }) : '',
    t(`ghPlanMethod_${plan.method === 'git' ? 'git' : 'tar'}`),
    t('ghPlanHosts', { hosts }),
    t('ghPlanTarget', { target: plan.target || 'incoming' }),
  ].filter(Boolean);
  return `<div class="gh-plan"><p><b>${esc(t('ghPlanTitle'))}</b></p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
}

function ghResultHtml(gh, categories) {
  const f = gh.fetch;
  const c = f.counts || { total: 0, ok: 0, caution: 0, danger: 0, fitting: 0 };
  // The repository's own license only when it has one: most skill repositories license each item (shown per row)
  const repoLic = f.license && f.license.family !== 'none' ? licenseHtml(f.license) : '';
  const head = `<p class="gh-found"><span>${esc(t('ghFound', { repo: f.repo, commit: String(f.commit || '').slice(0, 7), count: num(c.total), ok: num(c.ok), caution: num(c.caution), danger: num(c.danger), fitting: num(c.fitting) }))}</span>${repoLic}</p>${ghTrustHtml(f)}`;
  if (gh.imported) return head;
  const parts = [ghStep(2, t('ghStep2'), t('ghStep2Help')), head];
  if (!f.items?.length) return [...parts, `<p class="muted small">${esc(t('ghFoundNone'))}</p>`].join('');
  if (f.truncated) parts.push(`<p class="small muted">${esc(t('ghTruncated'))}</p>`);
  const busy = !!gh.busy;
  const { rows, hidden } = githubRows(f.items, { showAll: gh.showAll });
  parts.push(`<div class="gh-list" role="group" aria-label="${esc(t('ghStep2'))}">${rows.map((it) => ghRowHtml(it, gh.picks.get(it.path) || {}, categories, busy)).join('') || `<p class="muted small">${esc(t('ghNoneFits'))}</p>`}</div>`);
  if (hidden) parts.push(`<button type="button" class="gh-link" data-gh-act="toggle" data-fk="gh:toggle" aria-expanded="${gh.showAll}">${esc(gh.showAll ? t('ghShowFewer') : t('ghShowAll', { count: num(hidden) }))}</button>`);
  const chosen = githubPicks(f.items, gh.picks).length;
  parts.push(ghStep(3, t('ghStep3'), t('ghStep3Help')));
  parts.push(`<div class="flow-btns">${ghBtn('import', t('ghImport', { count: num(chosen) }), busy || !chosen, 'primary')}${ghBtn('discard', t('ghDiscard'), busy)}</div>`);
  return parts.join('');
}

function ghBtn(act, label, off, cls = '', arg = '') {
  return `<button type="button" class="act-btn ${cls}" data-gh-act="${act}" data-fk="gh:${act}${arg ? `:${esc(arg)}` : ''}"${arg ? ` data-gh-arg="${esc(arg)}"` : ''}${off ? ' aria-disabled="true"' : ''}>${esc(label)}</button>`;
}

// After the import: how many went in, which project they fit best, one install button per project
function ghImportedHtml(gh) {
  const im = gh.imported;
  const n = im.items.length;
  const groups = installGroups(im.items, { max: MAX_SKILL_ITEMS });
  const parts = [];
  if (im.dry) parts.push(`<p class="gh-note gh-dry">${esc(t('ghDryImport'))}</p>`);
  const best = groups[0];
  const bestText = best ? ` · ${t(best.high ? 'ghImportedBest' : 'ghImportedGood', { count: num(best.high || best.items.length), project: projName(best.projectId) })}` : '';
  parts.push(`<p class="gh-done"><b>${esc(t(im.dry ? 'ghImportedDry' : 'ghImported', { count: num(n) }))}</b>${esc(bestText)}${im.skipped.length ? ` · ${esc(t('ghImportedSkipped', { count: num(im.skipped.length) }))}` : ''}</p>`);
  if (im.error) parts.push(`<p class="flow-status small">${esc(im.error)}</p>`);
  if (im.skipped.length) {
    parts.push(`<ul class="plan-list">${planRows(im.skipped)
      .map((r) => `<li class="plan-row op-${esc(r.op)}"><span class="plan-op">${esc(r.opText)}</span><span class="plan-name" translate="no">${esc(r.name)}</span><span class="plan-meta">${esc(r.kindText)}</span><span class="plan-why">${esc(r.reasonText)}</span></li>`)
      .join('')}</ul>`);
  }
  if (n) {
    parts.push(ghStep(4, t('ghStep4'), t('ghStep4Help')));
    if (!groups.length) parts.push(`<p class="muted small">${esc(t('ghInstallNone'))}</p>`);
    else {
      const busy = !!gh.busy;
      parts.push(
        `<div class="gh-installs">${groups
          .map((g) => {
            const r = gh.installs.get(g.projectId);
            return `<div class="gh-install">${ghBtn('install', t('ghInstall', { project: projName(g.projectId), count: num(g.items.length) }), busy || !!r?.result?.executed, 'primary', g.projectId)}<span class="gh-install-what" translate="no">${esc(g.items.map((x) => x.name).join(', '))}</span>${r ? `<p class="flow-status small">${esc(installText(g, r))}</p>` : ''}</div>`;
          })
          .join('')}</div>`,
      );
    }
  }
  parts.push(`<div class="flow-btns">${ghBtn('again', t('ghAgain'), !!gh.busy)}</div>`);
  return parts.join('');
}

function installText(g, r) {
  const name = projName(g.projectId);
  if (!r.ok) return `${name}: ${ghErrorText(r)}`;
  const plan = r.plan || [];
  const did = plan.filter((e) => e.op === 'copy' || e.op === 'update').length;
  const skipped = plan.filter((e) => e.op === 'skip');
  const why = [...new Set(skipped.map((e) => reasonText(e.reason)))].join(', ');
  if (!r.result?.executed) return t('ghInstallDry', { project: name, count: num(did) });
  return t('ghInstalled', { project: name, copied: num((r.result.copied || 0) + (r.result.updated || 0)), skipped: num(skipped.length) }) + (why ? ` (${why})` : '');
}

// The library items that came from GitHub, each with "Check for update" (only when pressed; never by itself)
function ghOriginsHtml(gh, mode) {
  const list = githubItems(store.roster);
  if (!list.length) return '';
  const rows = list.slice(0, 100).map((it) => {
    const key = `${it.kind}:${it.name}`.toLowerCase();
    const c = gh.checks.get(key);
    const busy = !!gh.busy;
    const checking = (gh.busy === 'check' || gh.busy === 'apply') && gh.busyArg === key;
    let out = '';
    if (checking) out = `<p class="flow-status small">${esc(t(`ghBusy_${gh.busy}`))}</p>`;
    else if (c?.error) out = `<p class="flow-status small">${esc(c.error)}</p>`;
    else if (c?.dry) out = `<p class="flow-status small">${esc(t('ghCheckDry', { repo: c.dry.repo || it.origin.repo }))}</p>`;
    else if (c?.item) out = checkHtml(key, c, busy);
    return `<li class="gh-orow"><span class="gh-oname"><span class="skl-name" translate="no">${esc(it.name)}</span><span class="skl-meta">${esc(t(`skKind_${it.kind}`))} · <span translate="no">${esc(originRepo(it.origin))}</span></span></span>${licenseHtml({ spdx: it.origin.license, family: it.origin.family })}${ghBtn('check', t('ghCheck'), busy || mode === 'off' || c?.item?.status === 'update', '', key)}${out}</li>`;
  });
  return `<section class="gh-origins" aria-labelledby="ghOriginsT"><h4 id="ghOriginsT">${esc(t('ghFromTitle'))}</h4><p class="gh-help">${esc(t('ghFromHelp'))}</p><ul>${rows.join('')}</ul></section>`;
}

function checkHtml(key, c, busy) {
  const x = c.item;
  if (!x) return '';
  if (c.applied) return `<p class="flow-status small gh-ok">${esc(t('ghApplied'))}</p>`;
  if (x.status === 'error') return `<p class="flow-status small">${esc(t('ghCheck_error', { error: tOr(`ghErr_${x.error}`, x.error || '') }))}</p>`;
  if (x.status !== 'update') return `<p class="flow-status small">${esc(tOr(`ghCheck_${x.status}`, x.status))}${x.localChanged ? ` ${esc(t('ghLocalChangedNote'))}` : ''}</p>`;
  const changes = (x.changes || []).map((ch) => `<li><code translate="no">${esc(ch.file)}</code> <span>${esc(t(`ghChange_${ch.change}`))}</span></li>`).join('');
  const more = x.more ? `<li>${esc(t('ghMoreFiles', { count: num(x.more) }))}</li>` : '';
  const warn = x.localChanged ? `<p class="gh-warn small">${esc(t('ghLocalChanged'))}</p>` : '';
  const risk = x.review && x.review.level !== 'ok' ? `<p class="small">${safetyHtml(x.review)}</p>` : '';
  const err = c.applyError ? `<p class="flow-status small">${esc(c.dryApply ? t('skDryNote') : c.applyError)}</p>` : '';
  return `<div class="gh-update"><p class="small"><b>${esc(t('ghCheck_update', { commit: x.commit, count: num((x.changes || []).length + (x.more || 0)) }))}</b></p><ul class="gh-changes">${changes}${more}</ul>${warn}${risk}${err}<div class="flow-btns">${ghBtn('apply', t('ghApply'), busy || x.review?.level === 'danger', 'primary', key)}${ghBtn('later', t('ghCancelUpdate'), busy, '', key)}</div></div>`;
}

function githubHtml(gh, mode, categories) {
  const busy = !!gh.busy;
  const parts = [ghStep(1, t('ghStep1'), t('ghStep1Help')), `<p class="gh-note gh-net">${icon('globe')}<span>${esc(t('ghNetNote'))}</span></p>`];
  if (mode === 'off') parts.push(`<p class="gh-note gh-off">${esc(t('ghOff'))}</p>`);
  else {
    if (mode === 'dry') parts.push(`<p class="gh-note gh-dry">${esc(t('ghDry'))}</p>`);
    parts.push(
      `<div class="imp-bar"><label class="imp-src"><span>${esc(t('ghUrlLabel'))}</span><input type="text" inputmode="url" data-gh-url data-fk="gh:url" value="${esc(gh.url)}" placeholder="${esc(t('ghUrlPlaceholder'))}" spellcheck="false" autocomplete="off"${busy ? ' disabled' : ''}></label>${ghBtn('fetch', t('ghFetch'), busy || !gh.url.trim(), 'primary')}</div>`,
    );
  }
  if (gh.busy && !['check', 'apply'].includes(gh.busy)) parts.push(`<p class="flow-status small gh-busy" role="status">${esc(ghBusyText(gh))}</p>`);
  else if (gh.msg) parts.push(`<p class="flow-status small" role="status">${esc(gh.msg)}</p>`);
  if (gh.plan) parts.push(ghPlanHtml(gh.plan));
  if (gh.fetch) parts.push(ghResultHtml(gh, categories));
  if (gh.imported) parts.push(ghImportedHtml(gh));
  parts.push(ghOriginsHtml(gh, mode));
  return parts.join('');
}

// The QA hooks of the import section (pure): what ?qa=1&import=<folder> and ?qa=1&github=<link>|demo|demo-done may
// do in an actions mode. They fill the section in any mode; they scan or fetch only in Preview ('dry'), where the
// server answers with a plan and reaches nothing. Never in live mode: the server lets any page open this address
// (a document navigation to /?...), so a hook that sent a live action would let another site start a download.
export function qaImportHooks(search, mode) {
  const out = { open: false, tab: null, source: null, url: null, sample: null, scan: false, fetch: false };
  const q = new URLSearchParams(search || '');
  if (!q.has('qa')) return out;
  const src = q.get('import');
  if (src) Object.assign(out, { open: true, source: src, scan: mode === 'dry' });
  const g = q.get('github');
  if (g) {
    Object.assign(out, { open: true, tab: 'github' });
    if (g === 'demo' || g === 'demo-done') out.sample = g;
    else Object.assign(out, { url: g, fetch: mode === 'dry' });
  }
  return out;
}

// A sample answer for looking at the GitHub tab (?qa=1&github=demo; demo-done: after the import, with one project
// installed): no request is sent. Project ids are the first listed projects (or made-up ones on an empty computer).
function qaGitHubSample(done = false) {
  const ids = [...store.projects.keys()].slice(0, 2);
  const [a, b] = [ids[0] || 'demo', ids[1] || ids[0] || 'shop'];
  const fit = (projectId, confidence, reasons) => ({ projectId, confidence, score: confidence === 'high' ? 9 : 5, reasons, installable: true });
  const item = (name, kind, level, reasons, fits, extra = {}) => ({
    path: kind === 'agent' ? `agents/${name}.md` : `skills/${name}`,
    kind,
    name,
    description: extra.description || '',
    category: extra.category || 'general',
    status: extra.status || 'new',
    problems: [],
    review: { level, reasons },
    license: extra.license || { spdx: 'MIT', family: 'permissive', source: 'repo', file: 'LICENSE' },
    fits,
    kit: extra.kit || null,
    inProjects: extra.inProjects || [],
    selectable: level !== 'danger',
    selected: level === 'ok' && fits.length > 0 && (extra.status || 'new') === 'new',
  });
  const items = [
    item('unity-ui-toolkit', 'skill', 'ok', [], [fit(a, 'high', ['stack:unity', 'topic:ui'])], { description: 'Build game menus and HUDs with Unity UI Toolkit.', category: 'game' }),
    item('unity-reviewer', 'agent', 'ok', [], [fit(a, 'medium', ['stack:unity'])], { description: 'Reviews Unity C# scripts and prefabs.', category: 'game' }),
    item('next-seo', 'skill', 'ok', [], [fit(b, 'medium', ['stack:nextjs'])], { description: 'SEO metadata for Next.js pages.', category: 'web', license: { spdx: null, family: 'none', source: null, file: null } }),
    item('build-runner', 'skill', 'caution', [{ code: 'script-files', level: 'caution', file: 'scripts/build.sh', line: 0, count: 2 }, { code: 'network', level: 'caution', file: 'scripts/build.sh', line: 4, count: 1 }], [fit(a, 'medium', ['stack:unity'])], { description: 'Runs Unity builds from the command line.', category: 'game', status: 'conflict' }),
    item('quick-setup', 'skill', 'danger', [{ code: 'pipe-to-shell', level: 'danger', file: 'SKILL.md', line: 12, count: 1 }], [fit(a, 'medium', ['topic:gamedev'])], { description: 'One line setup for your game project.', category: 'game', license: { spdx: 'proprietary', family: 'proprietary', source: 'item', file: 'LICENSE.txt' } }),
    item('pasta-recipes', 'skill', 'ok', [], [], { description: 'Recipes for pasta and bread.' }),
  ];
  const counts = { total: items.length, ok: 4, caution: 1, danger: 1, fitting: 5, selected: 3 };
  const out = {
    plan: null,
    fetch: { executed: true, fetchId: 'acme-skills@a1b2c3d', repo: 'acme/skills', ref: null, path: null, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', committedAt: '2026-09-20T10:00:00.000Z', method: 'git', license: { spdx: 'MIT', family: 'permissive', source: 'repo', file: 'LICENSE' }, counts, truncated: false, items },
    picks: new Map(items.map((it) => [it.path, { on: it.selected, category: it.category, replace: false }])),
  };
  if (!done) return out;
  const added = items.filter((it) => it.selected).map((it) => ({ kind: it.kind, name: it.name, category: it.category, fits: it.fits }));
  const skipped = [{ op: 'skip', kind: 'skill', name: 'quick-setup', category: 'game', reason: 'review-danger' }];
  out.fetch.discarded = true;
  out.imported = { dry: false, items: added, skipped, plan: skipped, error: '' };
  out.installs = new Map([[a, { ok: true, mode: 'live', plan: [{ op: 'copy', kind: 'skill', name: 'unity-ui-toolkit', reason: 'new' }, { op: 'skip', kind: 'agent', name: 'unity-reviewer', reason: 'project-owned' }], result: { executed: true, copied: 1, updated: 0 } }]]);
  return out;
}

function localImportHtml(imp, categories, canPick = typeof globalThis.sibersentezShell?.pickLibraryFolder === 'function') {
  const busy = !!imp.busy;
  const btn = (act, label, off, cls = '') => `<button type="button" class="act-btn ${cls}" data-imp-act="${act}" data-fk="imp:${act}"${off ? ' aria-disabled="true"' : ''}>${esc(label)}</button>`;
  const items = imp.scan?.items || [];
  const rows = items
    .map((it) => {
      const p = imp.picks.get(it.path) || {};
      const status = it.problems?.length ? reasonText(it.problems[0]) : t(`skStatus_${it.status}`);
      const can = !busy && !it.problems?.length && it.status !== 'same';
      const cats = categories.includes(p.category) ? categories : [p.category, ...categories].filter(Boolean);
      return `<div class="skl-row imp-row" data-imp-path="${esc(it.path)}">
        <input type="checkbox" data-imp-on data-fk="imp-on:${esc(it.path)}" aria-label="${esc(it.name)}"${p.on && can ? ' checked' : ''}${can ? '' : ' disabled'}>
        <span class="imp-name"><span class="skl-name" translate="no">${esc(it.name)}</span><span class="skl-meta">${esc(t(`skKind_${it.kind}`))} · ${esc(status)}</span><code class="plan-path" translate="no">${esc(it.path)}</code></span>
        <select data-imp-cat data-fk="imp-cat:${esc(it.path)}" aria-label="${esc(t('skColCategory'))}"${can && it.status !== 'conflict' ? '' : ' disabled'}>${cats.map((c) => `<option value="${esc(c)}"${c === p.category ? ' selected' : ''}>${esc(categoryLabel(c))}</option>`).join('')}</select>
        ${it.status === 'conflict' && !it.problems?.length ? `<label class="imp-rep"><input type="checkbox" data-imp-rep data-fk="imp-rep:${esc(it.path)}"${p.replace ? ' checked' : ''}${busy ? ' disabled' : ''}><span>${esc(t('skReplace'))}</span></label>` : '<span></span>'}
      </div>`;
    })
    .join('');
  const chosen = items.filter((it) => imp.picks.get(it.path)?.on && importable(it, imp.picks.get(it.path))).length;
  const plan = imp.result?.plan?.length
    ? `<ul class="plan-list">${planRows(imp.result.plan)
        .map((r) => `<li class="plan-row op-${esc(r.op)}"><span class="plan-op">${esc(r.opText)}</span><span class="plan-name" translate="no">${esc(r.name)}</span><span class="plan-meta">${esc([r.kindText, r.category].filter(Boolean).join(' · '))}</span><span class="plan-why">${esc(r.reasonText)}</span>${r.path ? `<code class="plan-path" translate="no">${esc(r.path)}</code>` : ''}</li>`)
        .join('')}</ul>`
    : '';
  return `<p class="muted small">${esc(t('skImportIntro'))}</p>
    <div class="imp-bar">
      ${canPick ? btn('pick', t('skPickFolder'), busy, 'primary') : ''}
      <label class="imp-src"><span>${esc(t(canPick ? 'skImportPathOr' : 'skImportPath'))}</span><input type="text" data-imp-src data-fk="imp:src" value="${esc(imp.source)}" placeholder="${esc(t('skImportPlaceholder'))}" spellcheck="false" autocomplete="off"${busy ? ' disabled' : ''}></label>
      ${btn('scan', t('skScan'), busy)}
    </div>
    ${imp.busy ? `<p class="flow-status small">${esc(t(`skBusy_${imp.busy}`))}</p>` : imp.msg ? `<p class="flow-status small">${esc(imp.msg)}</p>` : ''}
    ${!imp.busy && imp.result?.ok && !imp.result.dry && imp.result.plan?.some((e) => e.op === 'copy' || e.op === 'update') ? `<p class="small imp-next">${esc(t('skImportNext'))} <button type="button" class="linkish" data-folder="group:library" data-fk="imp:show">${esc(t('rfLibShow'))}</button></p>` : ''}
    ${imp.scan?.truncated ? `<p class="small muted">${esc(t('skScanTruncated'))}</p>` : ''}
    ${rows ? `<div class="skl-list" role="group" aria-label="${esc(t('skImportTitle'))}">${rows}</div><div class="flow-btns">${btn('import', t('skImport'), busy || !chosen, 'primary')}</div>` : ''}
    ${plan}`;
}

function where(i) {
  if (i.kind === 'plugin') return i.enabled ? `<span class="wchip on">${esc(t('rfWhereOn'))}</span>` : `<span class="wchip">${esc(t('rfWhereOff'))}</span>`;
  const src = sourcesOf(i);
  const chips = [];
  if (src.includes('plugin') && i.plugin) chips.push(`<span class="wchip${i.enabled === false ? ' dim' : ''}" translate="no" title="${esc(t('rfWherePlugin'))}">${icon('plugin')}${esc(i.enabled === false ? t('rfWherePluginOff', { name: i.plugin }) : i.plugin)}</span>`);
  if (everywhere(i)) chips.push(`<span class="wchip on">${esc(t('rfWhereEverywhere'))}</span>`);
  for (const pid of (i.installedIn || []).slice(0, 3)) {
    const p = store.projects.get(pid);
    chips.push(`<span class="wchip" style="--c:${projectColor(pid)}"><i></i>${esc(p?.name || pid)}</span>`);
  }
  if ((i.installedIn || []).length > 3) chips.push(`<span class="wchip">+${i.installedIn.length - 3}</span>`);
  if (!chips.length && src.includes('library')) chips.push(`<span class="wchip dim">${esc(t('rfWhereWaiting'))}</span>`);
  if (!chips.length && src.includes(KIT_SOURCE)) chips.push(`<span class="wchip dim">${esc(t('rfWhereKit'))}</span>`);
  if (!chips.length && src[0] === 'other') chips.push(`<span class="wchip dim">${esc(t('rfWhereLogs'))}</span>`);
  return chips.join('');
}

function row(i, max, multi = false) {
  const u = i.usage;
  const color = i.kind === 'agent' ? agentColor(i.name) : i.kind === 'skill' ? '#ffd66b' : '#8fa3bf';
  const src = sourcesOf(i);
  const srcChips = src.map((k, n) => `<em class="rsrc s-${k}${n ? ' alt' : ''}" title="${esc(SOURCE_HINT[k] || '')}">${esc(sourceLabel(k))}</em>`).join('');
  // A category only means something in the library and the kit: the folder it sits in there (other categories repeat
  // a source or plugin)
  const cat = src.includes('library') ? i.category : src.includes(KIT_SOURCE) ? i.kitCategory || i.category : '';
  // Brought from GitHub (docs/github-import.md §7): "Source: owner/repo @ abc1234 · MIT"
  const o = i.origin && i.origin.type === 'github' && src.includes('library') ? i.origin : null;
  const lic = o ? (o.license && !['proprietary', 'unknown'].includes(o.license) ? o.license : t(`ghLicense_${o.family === 'proprietary' ? 'proprietary' : o.family === 'unknown' ? 'unknown' : 'none'}`)) : '';
  const origin = o ? `<em class="rorigin" title="${esc(t('ghOriginTitle', { repo: o.repo, commit: o.commit || '?', license: lic }))}"><span translate="no">${esc(t('ghOrigin', { repo: originRepo(o) }))}</span> · ${esc(lic)}</em>` : '';
  return `<button type="button" class="rrow" data-roster="${esc(i.id)}" style="--c:${color}">
    <span class="rkind k-${esc(i.kind)}" aria-hidden="true">${icon(i.kind === 'agent' ? 'agent' : i.kind === 'skill' ? 'skill' : 'plugin')}</span>
    <span class="rmain"><span class="rname"><span class="rn" translate="no">${esc(i.name)}</span><span class="sr-only">, ${esc(t(`rfKindName_${i.kind}`))}</span>${srcChips}${cat ? `<em class="rcat">${esc(categoryLabel(cat))}</em>` : ''}${origin}${multi ? toolTagsHtml(i.tools, store.tools) : ''}</span><span class="rdesc">${esc(kitSummary(i.kind, i.name, itemDescription(i.description), i.source === 'kit') || '—')}</span></span>
    <span class="rwhere">${where(i)}</span>
    <span class="ruse">${u ? `<b>${num(u.count)}</b><span>${ago(u.lastAt)}</span><i class="ubar" style="--w:${((u.count / max) * 100).toFixed(1)}%"></i>` : '<span class="muted">—</span>'}</span>
  </button>`;
}
