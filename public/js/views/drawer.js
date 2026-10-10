// @ts-check
// Detail drawer: project, session, agent, roster item
import { store } from '../store.js';
import { esc, ago, num, tok, dur, dayTime, modelName, projectColor, agentColor, STATUS, fillAgo, actionLine, agoTag, shownDescription, kitSummary, replaceHtml, projectKindText, waitWhat } from '../format.js';
import { sourcesOf, sourceLabel, SOURCE_HINT, everywhere, accessText, isSourceKey, originRepo } from '../rosterModel.js';
import { icon } from '../icons.js';
import { eventRow, bindOpen } from './feed.js';
import { actionsState, argvSummary, runAction, initActions } from '../actions.js';
import { replyError } from '../actionsSwitch.js';
import { errorText, menuModel, previewValid, runMenuItem, focusKeyOf, focusableVisible, findFocusTarget, focusScopeOf, itemInstallView, installTargets, planRows, skillErrorText, skillTargets, libraryInstallable, AI_STARTED_EVENT } from '../contextmenu.js';
import { t } from '../i18n.js';
import { sessionState, liveKnown } from '../attention.js';
import { createProjectUsage, setPeriod, dateText } from '../usage.js';
import { everyVisible } from '../whileVisible.js';
import { bindAiStart, toolsState, installedTools, preferredTool } from './tools.js';
import { createRunHint, bindRunHint, askAiDraft } from '../runHint.js';
import { sessionToolName } from '../jobId.js';
import { createJob, TEAM_KEYS, TEAM_ITEMS, teamInstalled, teamUpdates, giveJob, fetchFitFor, resumeCandidate, aiStateIn, jobSession, stepsHtml, jobCountText, realTwin, toolsOnlyHtml, nextFor, NEXT_KEYS } from './job.js';
import { createChanges } from '../changes.js';
import { createPublishCheck, publishJobText } from '../publishCheck.js';
import { createRestore, startPointOf, askJobPoint, createScopes, scopeHtml, scopeTakesCopy } from '../restore.js';
import { createJobCosts, estimateText, jobCostText } from '../jobCost.js';
import { createJobResult, jobTips } from '../jobResult.js';
import { apiErrorHtml, projectApiError, liveApiError } from '../apiError.js';
import { permModeChip, permModeLine } from '../permMode.js';
import { q, activeEl } from '../dom.js';
import { acceptGuideHtml, readMarks, writeMark, changeDraft, guideItems } from '../acceptGuide.js';
import { relinkCandidates, relinkOfferHtml, relinkedHtml, relinkErrorText } from '../relink.js';
import { fitView, fitRequestBody, fitRequestKey, fitOutcome, ideaWith, fitSectionHtml, offBannerHtml, startNextHtml, fitBusyText, cleanIdea, planList, targetPicker } from './drawerFit.js';
// The fit view and the idea box live in drawerFit.js (docs/internal/module-split-plan.md D1); tests import them from here
export { fitTagLabel, ideaWordOf, fitReasonText, fitReasonsText, fitProblemText, fitBlockedText, fitSourceText, autoSelection, fitSignature, ensureFitSelection, FIT_MAIN_MAX, fitView, fitRequestBody, fitRequestKey, planCounts, fitOutcome, ideaBoxHtml, IDEA_KINDS, STACK_CHOICES, stackChoiceFor, ideaWith, ideaStateHtml, fitOutcomeHtml, fitSectionHtml, offBannerHtml, startNextHtml, cleanIdea, IDEA_MAX } from './drawerFit.js';

// Redraw of one skill-flow section after its data arrived (set by createDrawer)
let rerenderFlow = (_fkey) => {};
// A project's usage arrived (GET /api/usage): redraw when that project is open (set by createDrawer)
let rerenderUsage = (_projectId) => {};
const projectUsage = createProjectUsage({ onData: (projectId) => rerenderUsage(projectId) });
// "How to run it" (runHint.js): its answer redraws the open project like the usage does
const runHint = createRunHint({ onData: (projectId) => rerenderUsage(projectId) });
// "Do a job" (views/job.js): its progress answer redraws the open project the same way
const job = createJob({ onData: (projectId) => rerenderUsage(projectId) });
// The project drawer's "Details" fold (docs/simplify.md): open per project while the page lives; a flow inside it
// (skills, install, team) opens it by itself
const moreOpen = new Set();
// Projects whose Start is getting ready (the team and the helpers being set up)
const jobBusy = new Set();
// Projects whose 'nothing but AI setup here' notice was shown once (drawer Start)
// The relink offer of a moved project (relink.js): { step, from, plan, error } per project id
const relinkUi = new Map();
const toolsOnlyAsked = new Set();
// Projects whose Start asks "turn actions on and start?" (actions off in the desktop app)
const startAsk = new Set();
// "What changed" (changes.js): the same way
const changes = createChanges({ onData: (projectId) => rerenderUsage(projectId) });
// "Put it online" first looks for what should not go online (plan E1, publishCheck.js); asked only when pressed
const publish = createPublishCheck({ onData: (projectId) => rerenderUsage(projectId) });
// "Restore points" (restore.js, docs/restore.md): the same way
const restore = createRestore({ onData: (projectId) => rerenderUsage(projectId) });
// "This job's result" (jobResult.js): what changed since the job's own start copy, the checks apart, going back
const jobResult = createJobResult({ onData: (projectId) => rerenderUsage(projectId) });
// What a job uses, before and after (jobCost.js, plan B5): the same way
const jobCosts = createJobCosts({ onData: (projectId) => rerenderUsage(projectId) });
// What the copy a job's start takes would hold, shown under Start (restore.js scopeHtml, docs/restore.md §12); its
// fold keeps its state across redraws per project
const scopes = createScopes({ onData: (projectId) => rerenderUsage(projectId) });
const scopeOpen = new Set();
// The result's ways (review B3): open goes through "How to run it" (its own button, or the section itself when the way
// is not a button); a change and an acceptance are drafts into the project's running AI tab (never with Enter). With no
// AI there, a change becomes the job box's follow-up, and acceptance says the AI is not running.
let resultAct = (_projectId, _act) => {};
// A project's fit arrived (set by createDrawer from its onFit option): the project list badge follows it
let fitArrived = (_projectId, _fit) => {};
// Whether "Turn actions on and install" can be offered (set by createDrawer: it has turnActionsOn)
let canTurnOn = false;

// Where Tab goes while the drawer is open (pure; tested in node): 'first', 'last' or null (the browser's own move).
// Inside, Tab and Shift+Tab go round. Outside, only focus that fell to the page body (a redraw) comes back: the terminal
// dock sits over the drawer and is used while it is open, so its Tab (completion) and Shift+Tab (Claude Code's mode
// switch) stay its own, and so do the notices' buttons (review 2026-10-07, round 2)
export function drawerTabTarget({ shift = false, inside = false, atFirst = false, atLast = false, onBody = false } = {}) {
  if (inside) return shift ? (atFirst ? 'last' : null) : atLast ? 'first' : null;
  return onBody ? (shift ? 'last' : 'first') : null;
}

// Options (all optional): toast shows action results; openActionsChooser opens the desktop shell's actions chooser
// (or explains where the mode is changed); onFit(projectId, fit) hears every fit the drawer loaded; keepIdea(projectId,
// text) keeps a project's idea with the project in the desktop app (window.sibersentezShell.saveProjectIdea; absent in a
// plain browser, where the idea stays in this browser only); turnActionsOn() turns actions on through the header
// switch (actionsSwitch.js turnOn) for "Turn actions on and install" (absent in a plain browser and in QA).
export function createDrawer(drawerEl, scrimEl, { toast = undefined, openActionsChooser = undefined, onFit = undefined, keepIdea = undefined, turnActionsOn = undefined } = {}) {
  const body = drawerEl.querySelector('[data-k=body]');
  let current = null;
  let reqId = 0;
  // The element that opened the drawer: focus returns to it on close (found by its data attribute if it was redrawn)
  let opener = null;
  let openerKey = null;
  let openerTag = null;
  let openerScope = null;
  let firstTarget = null; // the first target at opening: with no opener (scene, palette) focus returns to its card
  // Persistent status region: it stays in place when the drawer body is rewritten, and changed text is announced
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  drawerEl.appendChild(live);
  let liveTimer = null;
  function announce(text) {
    live.textContent = '';
    clearTimeout(liveTimer);
    if (text) liveTimer = setTimeout(() => (live.textContent = text), 60);
  }
  drawerEl.inert = true;
  // A dialog over the page (review U02, the owner's choice: it stays one, as it looks): while it is open the page
  // behind takes no focus and no screen-reader cursor (inert), Tab and Shift+Tab go round inside it, Escape closes
  // it (main.js) and focus goes back to what opened it (close)
  drawerEl.setAttribute('role', 'dialog');
  // The actions chooser sits in the page's header, behind this dialog: the drawer closes first, so it can be used
  const chooseActions = () => {
    close();
    openActionsChooser?.();
  };
  const pageEl = () => q(document, '.app');
  const focusables = () => [...drawerEl.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && !el.closest('[hidden]') && !el.closest('[inert]') && el.getClientRects().length > 0);
  // On the document while open (capture): focus that fell to the page body after a redraw is brought back too
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || drawerEl.inert) return;
    // Another dialog over the drawer (the search, the guide, the tools panel) keeps its own keyboard
    const over = document.activeElement?.closest?.('[role="dialog"], [role="alertdialog"]');
    if (over && over !== drawerEl) return;
    const list = focusables();
    if (!list.length) return;
    const at = document.activeElement;
    const to = drawerTabTarget({ shift: e.shiftKey, inside: drawerEl.contains(at), atFirst: at === list[0], atLast: at === list[list.length - 1], onBody: !at || at === document.body || at === document.documentElement });
    if (!to) return;
    e.preventDefault();
    (to === 'first' ? list[0] : list[list.length - 1]).focus();
  }, true);

  // target.section: scroll to 'skills' (project: suggested skills) or 'install' (roster: install into a project)
  function open(target) {
    // When moving from inside the drawer to another detail, the first opener is kept
    if (!drawerEl.contains(document.activeElement)) {
      opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      openerKey = focusKeyOf(opener);
      openerTag = opener?.tagName || null;
      openerScope = focusScopeOf(opener);
      firstTarget = target;
    }
    current = target;
    // A flow asked for (skills, install) sits in the Details fold: open it
    if (target.type === 'project' && target.section) moreOpen.add(target.id);
    drawerEl.inert = false;
    drawerEl.classList.add('open');
    drawerEl.setAttribute('aria-hidden', 'false');
    drawerEl.setAttribute('aria-modal', 'true');
    const page = pageEl();
    if (page) page.inert = true;
    scrimEl.hidden = false;
    body.scrollTop = 0;
    body._html = null;
    lastRefresh = Date.now();
    render(true);
    const sec = target.section ? body.querySelector(`[data-sec="${target.section}"]`) : null;
    if (sec) {
      // Keep it below the close button (top right)
      body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top - 56;
      // The first enabled control; if there is none (e.g. only an external package) the section itself takes focus
      const first = sec.querySelector('input:not([disabled]), select, button:not([aria-disabled="true"])');
      (first || (sec.hasAttribute('tabindex') ? sec : drawerEl.querySelector('.drawer-close'))).focus({ preventScroll: true });
    } else {
      drawerEl.querySelector('.drawer-close').focus({ preventScroll: true });
    }
  }

  function close() {
    if (!current && drawerEl.inert) return;
    // A question left open is not asked again on the next opening
    startAsk.clear();
    current = null;
    drawerEl.classList.remove('open');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.removeAttribute('aria-modal');
    // A closed drawer takes no focus and stays out of the Tab order; the page behind takes them again (before focus
    // goes back to the opener, which is in it)
    drawerEl.inert = true;
    const page = pageEl();
    if (page) page.inert = false;
    scrimEl.hidden = true;
    announce('');
    // The temporary results of the flows (trial, output, message, confirmation) must not go stale until the next opening
    resetFlows();
    // Focus return order: the opener → its counterpart in the same container if it was redrawn → the card/row of the opened target
    // (when opened from the scene or without an opener) → the active tab button (a safe target; focus must not fall to BODY)
    let back = opener;
    if (!focusableVisible(back)) back = findFocusTarget(openerKey, openerTag, openerScope);
    if (!back && firstTarget) back = [...document.querySelectorAll(`[data-${firstTarget.type}="${CSS.escape(String(firstTarget.id))}"]`)].find((e) => focusableVisible(e) && !drawerEl.contains(e)) || null;
    if (!focusableVisible(back)) back = document.querySelector('[data-tab].on');
    opener = openerKey = openerTag = openerScope = firstTarget = null;
    back?.focus({ preventScroll: true });
  }

  drawerEl.querySelector('.drawer-close').addEventListener('click', close);
  scrimEl.addEventListener('click', close);
  // "Then: start with AI" (docs/ai-start.md): the idea choice, the tools panel, redraw when the tools answer
  bindAiStart(body, { rerender: () => rerender() });
  // A sentence goes into the open project's job box, the keyboard after it; Start stays the person's. In sight: while a
  // result waits the box is at the drawer's end (review U07)
  const fillJob = (projectId, text) => {
    if (current?.type !== 'project' || current.id !== projectId) return;
    job.setText(projectId, text);
    render();
    const input = body.querySelector('[data-fk="job:text"]');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView?.({ block: 'nearest' });
    input?.setSelectionRange?.(input.value.length, input.value.length);
  };
  bindRunHint(body, { projectOf: () => (current?.type === 'project' ? current.id : null), asJob: fillJob });
  resultAct = (projectId, act) => {
    if (act === 'open') {
      const open = body.querySelector('[data-run-open]');
      if (open) return open.click();
      const run = body.querySelector('[data-sec="run"]');
      run?.scrollIntoView?.({ block: 'start' });
      return (run?.querySelector('button, a') || run)?.focus?.({ preventScroll: true });
    }
    if (act === 'change' || act === 'accept') {
      const r = askAiDraft(projectId, t(act === 'change' ? 'jrChangeDraft' : 'jrAcceptDraft'));
      if (r?.ok || r?.reason === 'asks') return;
      if (act === 'change') return fillJob(projectId, t('jobNextText_change'));
      return toast?.({ tone: 'info', title: t('jrTitle'), body: t('jrAcceptNoAi') });
    }
    // "What did it do?" (plan C3): the AI explains its own work in plain words; without it there, as a new job
    // "Ask for a new review" (evidence card E2): files changed after the verdict; the same draft, never Enter
    if (act === 'explain' || act === 're-review') {
      const text = t(act === 'explain' ? 'jrExplainDraft' : 'jrReReviewDraft');
      const r = askAiDraft(projectId, text);
      if (r?.ok || r?.reason === 'asks') return;
      return fillJob(projectId, text);
    }
    // The plan (review B7): the same drafts, for the plan the AI waits on
    if (act === 'plan-ok' || act === 'plan-change') {
      const r = askAiDraft(projectId, t(act === 'plan-ok' ? 'jobPlanOkDraft' : 'jobPlanChangeDraft'));
      if (r?.ok || r?.reason === 'asks') return;
      return toast?.({ tone: 'info', title: t('jobAsk'), body: t('jobPlanNoAi') });
    }
  };
  const acceptJob = (projectId) => job.get(projectId).data;
  function acceptMark(projectId, btn) {
    const d = acceptJob(projectId);
    const jobId = d?.plan?.jobId;
    if (!jobId) return;
    const key = btn.dataset.agKey;
    const value = btn.getAttribute('aria-pressed') === 'true' ? null : btn.dataset.ag;
    writeMark(projectId, jobId, key, value);
    rerender();
    q(body, `[data-ag="${btn.dataset.ag}"][data-ag-key="${key}"]`)?.focus({ preventScroll: true });
  }
  function acceptChange(projectId) {
    const d = acceptJob(projectId);
    const text = changeDraft(guideItems(d), readMarks(projectId, d?.plan?.jobId));
    if (!text) return;
    const r = askAiDraft(projectId, text);
    if (r?.ok || r?.reason === 'asks') return;
    fillJob(projectId, text);
  }
  body.addEventListener('click', (e) => {
    // Usage section: a period button (the choice is shared with the strip; main.js redraws both)
    const up = e.target.closest('[data-usage-period]');
    if (up) return setPeriod(up.dataset.usagePeriod);
    const fit = e.target.closest('[data-fit-act]');
    if (fit) return fitAct(fit);
    const fa = e.target.closest('[data-flow-act]');
    if (fa) return flowAct(fa);
    const ad = e.target.closest('[data-adopt]');
    if (ad) return adoptAct(ad);
    const ja = e.target.closest('[data-job-act]');
    if (ja) return jobAct(ja);
    // The result's ways (review B3, jobResult.js resultActsHtml)
    // Try it yourself: a mark (pressed again: cleared), or the items marked "Not as asked" to the AI as a draft
    const ag = e.target.closest('[data-ag]');
    if (ag && current?.type === 'project') return acceptMark(current.id, ag);
    const agc = e.target.closest('[data-ag-act="change"]');
    if (agc && current?.type === 'project') return acceptChange(current.id);
    const jr = e.target.closest('[data-jr-act]');
    if (jr && current?.type === 'project') return resultAct(current.id, jr.dataset.jrAct);
    // A finished job's follow-up: its sentence goes into the job box; Start stays the person's
    const jn = e.target.closest('[data-job-next]');
    // "Put it online": the publish check first (plan E1); its own button writes the steps into the job box
    if (jn && current?.type === 'project' && jn.dataset.jobNext === 'deploy') {
      publish.start(current.id);
      return render();
    }
    if (jn && current?.type === 'project' && NEXT_KEYS.includes(jn.dataset.jobNext)) return fillJob(current.id, t(`jobNextText_${jn.dataset.jobNext}`));
    const pa = e.target.closest('[data-pub-act]');
    if (pa && current?.type === 'project') {
      const id = current.id;
      if (pa.dataset.pubAct === 'again') publish.start(id);
      else {
        const data = publish.get(id)?.data;
        publish.close(id);
        if (pa.dataset.pubAct === 'write') return fillJob(id, publishJobText(data));
      }
      return render();
    }
    const ra = e.target.closest('[data-rst-act]');
    if (ra) return restoreAct(ra);
    const rl = e.target.closest('[data-rl-act]');
    if (rl && current?.type === 'project') return relinkAct(current.id, rl);
    const ma = e.target.closest('[data-menu-act]');
    if (ma) return menuAct(ma);
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const text = cp.parentElement.querySelector('code')?.textContent || '';
      navigator.clipboard?.writeText(text).then(
        () => {
          cp.dataset.done = '1';
          announce(t('shDrCopied'));
        },
        () => announce(t('shDrCopyFailed')),
      );
      setTimeout(() => delete cp.dataset.done, 1500);
      return;
    }
    if (e.target.closest('[data-flow]')) return; // clicks on labels/checkboxes in a flow section do not navigate the drawer
    const r = e.target.closest('[data-roster]');
    if (r) return open({ type: 'roster', id: r.dataset.roster });
    bindOpen(e, open);
  });
  // The Details fold keeps its state across redraws (toggle does not bubble: caught on the way down)
  body.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      // What the start's copy leaves out (the job box): open per project
      if (d?.matches?.('details.job-scope') && current?.type === 'project') {
        if (d.open) scopeOpen.add(current.id);
        else scopeOpen.delete(current.id);
        return;
      }
      if (!d?.matches?.('details.dr-more')) return;
      if (d.open) moreOpen.add(d.dataset.more);
      else moreOpen.delete(d.dataset.more);
    },
    true,
  );

  // Focusable list rows (session, agent, project): Enter/Space opens the detail; Shift+F10 the menu (main.js)
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target;
    if (!row.matches?.('li[tabindex="0"][data-session], li[tabindex="0"][data-agent], li[tabindex="0"][data-project]')) return;
    e.preventDefault();
    e.stopPropagation(); // the page shortcut (Space = play in replay mode) must not run
    const d = row.dataset;
    open(d.session ? { type: 'session', id: d.session } : d.agent ? { type: 'agent', id: d.agent } : { type: 'project', id: d.project });
  });

  // "Do a job" (views/job.js, docs/kit-in-app.md): the typed job is kept per project; nothing is sent while typing
  body.addEventListener('input', (e) => {
    const box = e.target.closest?.('[data-job-text]');
    if (!box) return;
    job.setText(box.dataset.jobText, box.value);
    // The count near the limit, in place (no redraw while typing)
    const count = body.querySelector(`[data-job-count="${CSS.escape(box.dataset.jobText)}"]`);
    if (count) count.textContent = jobCountText(box.value);
  });
  // Ctrl+Enter (Cmd+Enter on a Mac) in the job box starts it, as its button does; Enter alone is a new line
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const box = e.target.closest?.('[data-job-text]');
    if (!box) return;
    e.preventDefault();
    box.closest('section')?.querySelector('[data-job-act="start"]')?.click();
  });

  // "Restore points": "Go back to this" asks for the plan (restore-preview, nothing written), the question shows it;
  // "Yes, go back" runs restore-apply (live only), then the list is asked again (the present is a new point)
  // A moved project linked to its new folder (relink.js, server/relinks.mjs): preview, then yes (live mode only);
  // a linked project's link undone. The catalog reloads on the server and the snapshot brings the change
  async function relinkAct(projectId, btn) {
    const act = btn.dataset.rlAct;
    const p = store.projects.get(projectId);
    if (!p) return;
    const live = actionsState().mode === 'live';
    if (act === 'no') {
      const from = relinkUi.get(projectId)?.from;
      relinkUi.delete(projectId);
      render();
      return focusFk(from && body.querySelector(`[data-fk="rl:${CSS.escape(from)}"]`) ? `rl:${from}` : 'rl:head');
    }
    // The preview writes nothing in any mode (plan: true)
    if (act === 'preview') {
      const from = btn.dataset.rlFrom;
      relinkUi.set(projectId, { step: 'loading', from });
      render();
      const r = await runAction({ action: 'project-relink', projectId, from, plan: true });
      relinkUi.set(projectId, r?.ok ? { step: 'confirm', from, plan: r } : { step: 'failed', from, error: relinkErrorText(r, errorText) });
      render();
      return focusFk(r?.ok ? (live ? 'rl:yes' : 'rl:no') : `rl:${from}`);
    }
    // Yes: the link, only as the preview showed it (planId; the server answers plan-changed otherwise)
    if (act === 'yes') {
      const ui = relinkUi.get(projectId);
      if (!live || ui?.step !== 'confirm' || !ui.plan?.planId) {
        relinkUi.delete(projectId);
        return render();
      }
      relinkUi.set(projectId, { ...ui, step: 'busy' });
      render();
      focusFk('rl:head');
      const r = await runAction({ action: 'project-relink', projectId, from: ui.from, planId: ui.plan.planId });
      const done = r?.ok && r.result?.executed;
      const said = done ? t('rlDone', { name: p.name }) : relinkErrorText(r, errorText);
      relinkUi.set(projectId, done ? { step: 'done' } : { step: 'failed', from: ui.from, error: said });
      toast?.({ tone: done ? 'ok' : 'err', title: t('rlTitle'), body: said });
      announce(said);
      render();
      return focusFk('rl:head');
    }
    // Undo: a question first (what comes back and what does not), then the undo
    if (act === 'unlink' || act === 'unlink-no') {
      if (!live) return;
      if (act === 'unlink') relinkUi.set(projectId, { step: 'unlink' });
      else relinkUi.delete(projectId);
      render();
      return focusFk(act === 'unlink' ? 'rl:unlink-no' : 'rl:unlink');
    }
    if (act === 'unlink-yes') {
      if (!live || relinkUi.get(projectId)?.step !== 'unlink') return;
      relinkUi.set(projectId, { step: 'busy' });
      render();
      focusFk('rl:head');
      const r = await runAction({ action: 'project-unlink', projectId });
      const done = r?.ok && r.result?.executed;
      const said = done ? t('rlUndone') : relinkErrorText(r, errorText);
      if (done) relinkUi.delete(projectId);
      else relinkUi.set(projectId, { step: 'failed', error: said });
      toast?.({ tone: done ? 'ok' : 'err', title: t('rlTitle'), body: said });
      announce(said);
      render();
      return focusFk('rl:head');
    }
  }

  async function restoreAct(btn) {
    if (current?.type !== 'project') return;
    const p = store.projects.get(current.id);
    if (!p) return;
    if (btn.getAttribute('aria-disabled') === 'true') return chooseActions();
    if (btn.disabled) return;
    const act = btn.dataset.rstAct;
    const mode = actionsState().mode;
    const ui = restore.ui(p.id);
    if (act === 'no') {
      const back = ui.pointId ? `rst:${ui.pointId}` : '';
      restore.setUi(p.id, {});
      render();
      return back && focusFk(back);
    }
    if (act === 'preview') {
      const pointId = btn.dataset.rstId;
      restore.setUi(p.id, { step: 'loading', pointId });
      render();
      const r = await runAction({ action: 'restore-preview', projectId: p.id, pointId });
      restore.setUi(p.id, r?.ok ? { step: 'confirm', pointId, plan: r } : { step: 'failed', pointId, error: errorText(r) });
      render();
      return focusFk(r?.ok ? (r.counts && r.counts.changed + r.counts.missing + r.counts.added > 0 && mode === 'live' ? 'rst:yes' : 'rst:no') : `rst:${pointId}`);
    }
    // The yes holds only in live mode and only for the point it asked about
    if (act === 'yes') {
      if (mode !== 'live' || ui.step !== 'confirm' || !ui.pointId) {
        restore.setUi(p.id, {});
        return render();
      }
      const pointId = ui.pointId;
      restore.setUi(p.id, { step: 'busy', pointId });
      render();
      announce(t('rstBusy'));
      // The plan the person saw: the server refuses one that changed since (plan-changed)
      const r = await runAction({ action: 'restore-apply', projectId: p.id, pointId, planId: ui.plan?.planId });
      const done = r?.ok && r.result?.executed;
      restore.setUi(p.id, done ? { step: 'done', pointId, result: r.result } : { step: 'failed', pointId, error: errorText(r) });
      toast?.({ tone: done ? (r.result.failed?.length ? 'err' : 'ok') : 'err', title: t('rstTitle'), body: done ? t('rstDone', { restored: r.result.restored, removed: r.result.removed }) : errorText(r) });
      restore.refresh(p.id);
      scopes.forget(p.id);
      render();
      announce(done ? t('rstDone', { restored: r.result.restored, removed: r.result.removed }) : errorText(r));
    }
  }

  // One Start (docs/simplify.md): the team and the helpers that fit this job are set up, then the AI tool starts with
  // the job as its first message, on the same path as every start (the dock when there is one; the job rides in the
  // request, never on a command line: docs/ai-start.md)
  async function startJob(p, text, mode) {
    if (jobBusy.has(p.id)) return; // a second click while it gets ready
    // Nothing but AI tools' setup here (a moved project's old folder): the first Start says so; a second one starts
    if (p.toolsOnly && !toolsOnlyAsked.has(p.id)) {
      toolsOnlyAsked.add(p.id);
      toast?.({ tone: 'warn', title: t('jobToolsOnlyTitle'), body: t('jobToolsOnlyAgain') });
      return;
    }
    jobBusy.add(p.id);
    announce(t('jobPreparing'));
    let r;
    try {
      r = await giveJob(p, text, { mode, tools: toolsState(), fetchFit: fetchFitFor, runAction, runMenuItem, openDrawer: open, toast });
    } finally {
      jobBusy.delete(p.id);
    }
    if (r && r.ok && r.mode === 'live') {
      const st = flows.get(`fit:${p.id}`);
      if (st) st.stale = true;
      scopes.forget(p.id);
    }
    if (r) announce(r.ok ? (r.mode === 'dry' ? t('shDrDryDone') : t('shDrDone')) : errorText(r));
    // A started job leaves the box: the next job is written fresh (a failed or previewed one stays to try again)
    if (r?.ok && r.mode === 'live') {
      job.setText(p.id, '');
      render();
    }
  }

  async function jobAct(btn) {
    if (current?.type !== 'project') return;
    const p = store.projects.get(current.id);
    if (!p) return;
    const act = btn.dataset.jobAct;
    const mode = actionsState().mode;
    if (btn.getAttribute('aria-disabled') === 'true') return chooseActions();
    // A moved project's old folder: open the real one instead
    if (act === 'open-twin' && btn.dataset.jobTwin) return void open({ type: 'project', id: btn.dataset.jobTwin });
    // The job stopped (its terminal was closed): the last session goes on where it stopped, in the terminal below
    if (act === 'resume' && btn.dataset.jobSession) return void window.dispatchEvent(new CustomEvent('hq-action', { detail: { action: 'resume-session', sessionId: btn.dataset.jobSession, projectId: p.id } }));
    // The result waits: the job's AI session, as the Building's result card goes there (main.js open-ai-terminal)
    if (act === 'open-ai') return void window.dispatchEvent(new CustomEvent('hq-action', { detail: { action: 'open-ai-terminal', projectId: p.id, sessionId: btn.dataset.jobSession || null } }));
    if (act === 'start') {
      const text = job.text(p.id).trim();
      if (!text) {
        toast?.({ tone: 'err', title: t('jobTitle'), body: t('jobEmpty') });
        return focusFk('job:text');
      }
      // Actions off in the desktop app: one question here turns them on and starts (no trip to the header switch)
      if (jobBusy.has(p.id)) return;
      if (mode === 'off' && canTurnOn) {
        startAsk.add(p.id);
        render();
        return focusFk('job:start-on');
      }
      return startJob(p, text, mode);
    }
    if (act === 'start-no') {
      startAsk.delete(p.id);
      render();
      return focusFk('job:start');
    }
    // "Yes, turn on and start": the text in the box when the person says yes; already On (the tray was quicker) starts
    // at once. The project counts as getting ready while actions are turned on, so a second Start meanwhile does
    // nothing (review 2026-10-02: two clicks could start the job twice)
    if (act === 'start-on') {
      startAsk.delete(p.id);
      const text = job.text(p.id).trim();
      if (!text) {
        render();
        return focusFk('job:text');
      }
      if (jobBusy.has(p.id)) return;
      if (mode === 'off') {
        jobBusy.add(p.id);
        render();
        announce(fitBusyText('turn-on'));
        let on;
        try {
          on = await turnOnLive();
        } finally {
          jobBusy.delete(p.id);
        }
        if (!on.ok) {
          toast?.({ tone: 'err', title: t('jobTurnOnStart'), body: on.error });
          render();
          announce(on.error);
          return focusFk('job:start');
        }
      }
      return startJob(p, text, actionsState().mode);
    }
    if (act === 'team') {
      if (mode !== 'live') return runTeam(p);
      job.setUi(p.id, 'confirm');
      render();
      return focusFk('job:team-yes');
    }
    if (act === 'team-no') {
      job.setUi(p.id, '');
      render();
      return focusFk('job:team');
    }
    // The yes holds only in live mode (a mode change meanwhile asks again)
    if (act === 'team-yes') {
      if (mode !== 'live') {
        job.setUi(p.id, '');
        render();
        return focusFk('job:team');
      }
      return runTeam(p);
    }
    // "Update the team": a preview first (writes nothing), then a yes for exactly the items it found newer
    if (act === 'team-check') return checkTeam(p);
    if (act === 'team-update-no') {
      job.setUi(p.id, '');
      render();
      return focusFk('job:team-check');
    }
    if (act === 'team-update-yes') {
      if (mode !== 'live') {
        job.setUi(p.id, '');
        render();
        return focusFk('job:team-check');
      }
      return updateTeam(p);
    }
  }

  async function checkTeam(p) {
    job.setUi(p.id, 'checking');
    render();
    const r = await runAction({ action: 'skills-preview', projectId: p.id, items: [...TEAM_ITEMS] });
    const list = r?.ok ? teamUpdates(r.plan ?? r.result?.plan) : [];
    job.setUpdates(p.id, list);
    job.setUi(p.id, !r?.ok ? 'update-failed' : list.length ? 'update' : 'current');
    render();
    if (!r?.ok) toast?.({ tone: 'err', title: t('jobTeamCheck'), body: errorText(r) });
    if (list.length) focusFk('job:team-update-yes');
  }

  async function updateTeam(p) {
    const items = job.updates(p.id);
    if (!items.length) return checkTeam(p);
    job.setUi(p.id, 'updating');
    render();
    const r = await runAction({ action: 'skills-install', projectId: p.id, items });
    job.setUpdates(p.id, []);
    job.setUi(p.id, !r?.ok ? 'update-failed' : r.mode === 'live' ? 'updated' : 'plan');
    const st = flows.get(`fit:${p.id}`);
    if (st && r?.ok && r.mode === 'live') st.stale = true;
    toast?.({ tone: r?.ok ? 'ok' : 'err', title: t('jobTeamCheck'), body: r?.ok ? t(r.mode === 'live' ? 'jobTeamUpdated' : 'jobTeamPlan') : errorText(r) });
    render();
  }

  // "Install the team": the kit's team through the same request as the fit's install (the server skips what is
  // installed and plans only in Preview)
  async function runTeam(p) {
    job.setUi(p.id, 'busy');
    render();
    const r = await runAction({ action: 'skills-apply', projectId: p.id, keys: [...TEAM_KEYS] });
    job.setUi(p.id, !r?.ok ? 'failed' : r.mode === 'live' ? 'done' : 'plan');
    const st = flows.get(`fit:${p.id}`);
    if (st && r?.ok && r.mode === 'live') {
      st.stale = true;
      st.sel = null;
    }
    toast?.({ tone: r?.ok ? 'ok' : 'err', title: t('jobTeamInstall'), body: r?.ok ? t(r.mode === 'live' ? 'jobTeamDone' : 'jobTeamPlan') : errorText(r) });
    if (current?.type === 'project' && current.id === p.id) render();
  }

  // The action buttons of the session/agent drawer: from the same model as the context menu (menuModel)
  async function menuAct(btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const target = { type: btn.dataset.menuType, id: btn.dataset.menuId };
    const it = menuModel(target, store, actionsState().mode).find((x) => x.id === btn.dataset.menuAct);
    if (!it || it.disabled) return;
    const openSkills = (t) => open({ ...t, section: t.type === 'project' ? 'skills' : 'install' });
    if (it.action && !it.flow) announce(t('shDrSending', { label: it.label }));
    const r = await runMenuItem(it, { target, openDrawer: open, openSkills, toast });
    if (r) announce(r.ok ? (r.mode === 'dry' ? t('shDrDryDone') : t('shDrDone')) : errorText(r));
  }

  // Skill flow: a checkbox, a target or the project changed -> state updated, section redrawn; any open
  // confirmation closes (the confirmed selection would no longer be the one on screen)
  body.addEventListener('change', (e) => {
    const sec = e.target.closest('[data-flow]');
    if (!sec) return;
    const st = flowState(sec.dataset.flow);
    const toggle = (field, value) => {
      st[field] = st[field] || new Set();
      if (e.target.checked) st[field].add(value);
      else st[field].delete(value);
    };
    if (e.target.matches('[data-flow-item]')) toggle('sel', e.target.dataset.flowItem);
    else if (e.target.matches('[data-flow-target]')) toggle('targets', e.target.dataset.flowTarget);
    else if (e.target.matches('[data-flow-proj]')) st.proj = e.target.value;
    else return;
    st.confirm = '';
    // Skills for this project: the last plan or result no longer matches the selection on screen
    if (sec.dataset.flow.startsWith('fit:')) {
      st.out = null;
      st.msg = '';
    }
    render();
  });

  // The folded parts of "Skills for this project" keep their state across redraws (the toggle event does not bubble)
  body.addEventListener(
    'toggle',
    (e) => {
      const fold = e.target.matches?.('[data-fit-fold]') ? e.target.dataset.fitFold : null;
      const fkey = fold ? e.target.closest('[data-flow]')?.dataset.flow : null;
      if (!fkey) return;
      const st = flowState(fkey);
      st.folds = st.folds || {};
      st.folds[fold] = e.target.open;
    },
    true,
  );

  // The idea box of "Skills for this project" (docs/start-flow.md): what is typed is kept per project (localStorage)
  // and asked for once typing stops for a moment (IDEA_WAIT_MS), at once with Enter or "Find fitting skills".
  // Typing itself never redraws the drawer.
  let ideaTimer = null;
  let composing = false;
  let renderAfterComposing = false;
  const ideaFlowKey = (el) => {
    const k = el?.closest?.('[data-flow]')?.dataset.flow || '';
    return k.startsWith('fit:') ? k : '';
  };
  body.addEventListener('input', (e) => {
    if (!e.target.matches?.('[data-idea]')) return;
    const fkey = ideaFlowKey(e.target);
    if (!fkey) return;
    const st = flowState(fkey);
    st.idea = String(e.target.value || '');
    st.ideaTouched = true;
    saveIdea(fkey.slice(4), cleanIdea(st.idea));
    keepIdeaLater(fkey.slice(4), st);
    clearTimeout(ideaTimer);
    ideaTimer = setTimeout(() => findIdea(fkey), IDEA_WAIT_MS);
  });

  // The idea is also kept with the project in the desktop app (docs/start-flow.md): sent once typing stopped for a
  // moment, only when it differs from what was sent last; the browser copy stays as the fallback. Failures are quiet
  // (the idea still works in this browser).
  // A project whose idea the app cannot keep (ideaKeptAnswer: 'local-only') is not sent again in this page session.
  const hubTimers = new Map();
  function keepIdeaLater(pid, st) {
    if (typeof keepIdea !== 'function' || ideaStaysLocal(pid)) return;
    clearTimeout(hubTimers.get(pid));
    hubTimers.set(
      pid,
      setTimeout(() => {
        hubTimers.delete(pid);
        const text = cleanIdea(st.idea);
        if (st.hubSent === text || ideaStaysLocal(pid)) return;
        Promise.resolve()
          .then(() => keepIdea(pid, text))
          .then((r) => {
            if (ideaKeptAnswer(pid, st, text, r) === 'local-only') rerenderFlow(`fit:${pid}`);
          })
          .catch(() => {});
      }, HUB_IDEA_WAIT_MS),
    );
  }
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches?.('[data-idea]')) return;
    const fkey = ideaFlowKey(e.target);
    if (!fkey) return;
    e.preventDefault();
    findIdea(fkey);
  });
  body.addEventListener('compositionstart', () => (composing = true));
  body.addEventListener('compositionend', () => {
    composing = false;
    if (renderAfterComposing) {
      renderAfterComposing = false;
      render();
    }
  });

  // Ask for the fit of the idea on screen (nothing is sent when it is the one already shown)
  function findIdea(fkey) {
    clearTimeout(ideaTimer);
    const st = flowState(fkey);
    st.ideaWanted = cleanIdea(st.idea);
    loadFit(fkey.slice(4), st);
    render();
  }

  function focusFk(k) {
    body.querySelector(`[data-fk="${k}"]`)?.focus({ preventScroll: true });
  }

  // Preview -> (successful, same selection and mode) Install -> explicit confirmation -> install. Try starts a
  // Claude Code session with a trial folder (nothing installed). Remove -> confirmation -> remove.
  async function flowAct(btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const fkey = btn.closest('[data-flow]')?.dataset.flow;
    if (!fkey) return;
    const st = flowState(fkey);
    const act = btn.dataset.flowAct;
    if (act === 'cancel') return cancelConfirm(st);
    const req = flowRequest(fkey, st);
    if (!req) return;
    const mode = actionsState().mode;
    // Install and "Yes, install": the preview must still hold (same mode, same selection); otherwise nothing is sent
    if ((act === 'install' || act === 'confirm') && !previewValid(st, req.key, mode)) {
      st.confirm = '';
      st.preview = null;
      st.msg = t('skWhyStale');
      render();
      announce(st.msg);
      return focusFk('flow:preview');
    }
    if (act === 'install' || act === 'remove') {
      st.confirm = act;
      render();
      return focusFk('flow:cancel');
    }
    const action = { preview: 'skills-preview', try: 'skills-trial', confirm: 'skills-install', 'confirm-remove': 'skills-remove' }[act];
    if (!action || st.busy) return;
    st.confirm = '';
    st.busy = act;
    st.msg = '';
    render();
    announce(t(`skBusy_${act}`));
    const reqBody = { action, projectId: req.projectId, items: req.items };
    if (action !== 'skills-trial' && req.targets.length) reqBody.targets = req.targets;
    const r = await runAction(reqBody);
    st.busy = '';
    const msg = !r.ok ? skillErrorText(r) : r.mode === 'dry' && act !== 'preview' ? t('skDryNote') : doneText(act, r);
    toast?.({ tone: !r.ok ? 'err' : r.mode === 'dry' ? 'dry' : 'ok', title: t(ACT_LABEL[act]), body: msg, code: act === 'try' && r.ok && Array.isArray(r.argv) ? argvSummary(r.argv) : '' });
    // A live install or remove changed the project: its suggestions (installed marks) are fetched again
    if (r.ok && r.mode === 'live' && (act === 'confirm' || act === 'confirm-remove')) markStale(req.projectId);
    // Moved to another drawer or closed meanwhile: the result is not kept (the toast showed it), focus stays put
    const visible = !!current && flowKeyOf(current) === fkey;
    if (!visible) {
      st.preview = null;
      st.out = null;
      st.msg = '';
      return;
    }
    // The preview keeps its mode: if the mode changes, Install does not open without a new preview (previewValid)
    if (act === 'preview') st.preview = { key: req.key, ok: !!r.ok, mode: r.mode || mode, label: req.label, r };
    else {
      if (act !== 'try') st.preview = null;
      st.out = { ok: !!r.ok, label: req.label, r };
    }
    st.msg = msg;
    render();
    announce(msg);
    const focusHere = drawerEl.contains(document.activeElement) || document.activeElement === document.body;
    if (focusHere) focusFk(act === 'preview' && previewValid(st, req.key, actionsState().mode) ? 'flow:install' : 'flow:preview');
  }

  // Close the confirmation (nothing is written); focus goes back to the button that opened it
  function cancelConfirm(st) {
    const back = st.confirm === 'remove' ? 'flow:remove' : st.confirm === 'apply' ? 'fit:apply' : 'flow:install';
    st.confirm = '';
    render();
    focusFk(back);
  }

  // "Skills for this project" (docs/auto-skills.md §4). Preview mode: the primary button asks the server for the plan
  // at once (nothing is written) and a banner says so. Live: the primary button opens a confirmation first; "Yes,
  // install" sends skills-apply with the keys on screen, then the fit is loaded again. Try starts Claude Code with the
  // selected library items in a trial folder (nothing is installed).
  async function fitAct(btn) {
    const act = btn.dataset.fitAct;
    if (act === 'chooser') return chooseActions();
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const fkey = btn.closest('[data-flow]')?.dataset.flow || '';
    if (!fkey.startsWith('fit:')) return;
    const st = flowState(fkey);
    if (act === 'more') {
      st.showLow = !st.showLow;
      render();
      return focusFk('fit:more');
    }
    // "Also from my other projects": their items join the list; hidden again, they leave the selection too
    if (act === 'others') {
      st.showOthers = !st.showOthers;
      render();
      return focusFk('fit:others');
    }
    // The idea box: "Find fitting skills", or an example put into the box and asked for at once
    if (act === 'find') return findIdea(fkey);
    // "Not sure yet": nothing is asked; the note says the planning skill asks the questions instead
    if (act === 'unsure') {
      st.ideaUnsure = st.dataIdea ?? '';
      render();
      return focusFk('fit:idea');
    }
    if (act === 'example' || act === 'refine') {
      st.idea = act === 'example' ? cleanIdea(btn.dataset.ideaExample) : ideaWith(st.idea, btn.dataset.ideaAdd);
      st.ideaTouched = true;
      saveIdea(fkey.slice(4), st.idea);
      keepIdeaLater(fkey.slice(4), st);
      findIdea(fkey);
      return focusFk('fit:idea');
    }
    if (act === 'cancel') return cancelConfirm(st);
    const p = store.projects.get(fkey.slice(4));
    if (!p || !st.data || st.busy) return;
    const mode = actionsState().mode;
    const v = fitView(st.data, st, mode, { turnOn: !!turnActionsOn });
    if (act === 'apply') {
      if (v.applyDisabled) return;
      if (v.oneStep) {
        st.confirm = 'turn-on';
        st.confirmFor = fitRequestKey(v);
        render();
        return focusFk('fit:cancel');
      }
      if (mode !== 'live') return runFit(p, st, 'apply', v);
      st.confirm = 'apply';
      st.confirmFor = fitRequestKey(v);
      render();
      return focusFk('fit:cancel');
    }
    if (act === 'confirm' || act === 'confirm-start') {
      // The confirmation holds only in live mode and only for the selection and targets it asked about
      if (mode !== 'live' || v.applyDisabled || st.confirmFor !== fitRequestKey(v)) {
        st.confirm = '';
        render();
        return focusFk('fit:apply');
      }
      st.thenStart = act === 'confirm-start';
      return runFit(p, st, 'apply', v);
    }
    if (act === 'confirm-on') {
      // Holds only while actions are still off and for the selection it asked about
      if (!v.oneStep || v.applyDisabled || st.confirmFor !== fitRequestKey(v)) {
        st.confirm = '';
        render();
        return focusFk('fit:apply');
      }
      return turnOnAndApply(p, st);
    }
    if (act === 'try' && !v.tryDisabled) return runFit(p, st, 'try', v);
  }

  // "Yes, turn on and install": the shell saves On (the same path as the header switch), the page learns the new mode
  // and token, then the same install as "Yes, install" runs with the selection the question named. If the mode does
  // not become On, nothing is installed and the reason is shown.
  // Turn actions On through the header switch and wait until the page knows: { ok } or { ok: false, error (text) }
  async function turnOnLive() {
    let reply = null;
    try {
      reply = await turnActionsOn();
    } catch {
      reply = null;
    }
    // Saved now, or On already (another window or the tray was quicker)
    let live = reply?.mode === 'live' && (reply.reason === 'saved' || reply.reason === 'same');
    // The server takes the mode in place and tells the page; asking again covers a missed event (at most ~8 s)
    for (let i = 0; live && actionsState().mode !== 'live' && i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (i % 4 === 3) await initActions();
    }
    live = live && actionsState().mode === 'live';
    return live ? { ok: true } : { ok: false, error: t(reply ? replyError(reply) : 'actionsSwitchErrOther') };
  }

  async function turnOnAndApply(p, st) {
    st.confirm = '';
    st.out = null;
    st.busy = 'turn-on';
    render();
    announce(fitBusyText('turn-on'));
    const on = await turnOnLive();
    st.busy = '';
    if (!on.ok) {
      const text = on.error;
      toast?.({ tone: 'err', title: t('fitTurnOnInstall'), body: text });
      render();
      announce(text);
      return focusFk('fit:apply');
    }
    const v = fitView(st.data, st, 'live');
    if (v.applyDisabled) {
      render();
      return focusFk('fit:apply');
    }
    return runFit(p, st, 'apply', v);
  }

  async function runFit(p, st, act, v) {
    const fkey = `fit:${p.id}`;
    const mode = actionsState().mode;
    // "Yes, install and start": asked for this run only
    const thenStart = act === 'apply' && !!st.thenStart;
    st.thenStart = false;
    st.confirm = '';
    st.out = null;
    st.msg = '';
    st.busy = act === 'try' ? 'try' : mode === 'live' ? 'apply' : 'plan';
    render();
    announce(fitBusyText(st.busy));
    const r = await runAction(fitRequestBody(p.id, act, v));
    st.busy = '';
    const out = fitOutcome(act, r);
    toast?.({ tone: out.tone === 'none' ? 'ok' : out.tone, title: act === 'try' ? t('fitTry') : t(r?.mode === 'live' ? 'fitApplyLive' : 'fitApplyDry'), body: out.text, code: act === 'try' && r?.ok && Array.isArray(r.argv) ? argvSummary(r.argv) : '' });
    // A live install changed the project: its fit is loaded again and the selection follows the new fit
    if (act === 'apply' && r?.ok && r.mode === 'live') {
      st.stale = true;
      st.sel = null;
    }
    // Moved to another drawer or closed meanwhile: the result is not kept (the toast showed it)
    if (!current || flowKeyOf(current) !== fkey) return;
    st.out = { act, r };
    render();
    announce(out.text);
    // Installed for real: the first AI tool starts through the same button "Then: start with AI" shows (its request,
    // its idea choice), so nothing here launches anything the user could not press by hand
    if (thenStart && r?.ok && r.mode === 'live' && out.tone === 'ok') {
      const go = body.querySelector('[data-menu-act^="start-ai:"]:not([aria-disabled="true"])');
      if (go) return menuAct(go);
    }
    const focusHere = drawerEl.contains(document.activeElement) || document.activeElement === document.body;
    if (focusHere) focusFk(act === 'try' ? 'fit:try' : out.tone === 'dry' ? 'fit:chooser' : 'fit:apply');
  }

  // Esc: if an install confirmation is open, only it is cancelled and true is returned (the drawer stays open)
  function escape() {
    const fkey = body.querySelector('[data-flow] .flow-confirm')?.closest('[data-flow]')?.dataset.flow;
    const st = fkey ? flows.get(fkey) : null;
    if (!st?.confirm) return false;
    cancelConfirm(st);
    return true;
  }

  // If the content did not change, leave the DOM alone: clicks, focus and selection in the open drawer are kept.
  // If it changed, the focused control (data-fk) takes focus again after the redraw (the keyboard flow must not break).
  function setBody(html) {
    if (body._html === html) return;
    body._html = html;
    const scroll = body.scrollTop;
    const act = /** @type {HTMLInputElement | null} */ (activeEl());
    const inBody = !!act && body.contains(act);
    const fk = inBody ? act.dataset?.fk : null;
    const rowKey = inBody && !fk ? focusKeyOf(act) : null;
    const rowTag = act?.tagName?.toLowerCase();
    // A text box being typed in (the idea box, the job box) keeps its caret and selection across the redraw
    const caret = fk && act.matches?.('input[type="text"], textarea') ? [act.selectionStart, act.selectionEnd, act.selectionDirection] : null;
    replaceHtml(body, html);
    body.scrollTop = scroll;
    fillAgo(body);
    if (fk) focusFk(fk);
    if (caret) {
      const box = body.querySelector(`[data-fk="${fk}"]`);
      try {
        if (box && document.activeElement === box) box.setSelectionRange(caret[0], caret[1], caret[2] || 'none');
      } catch {
        // a box that takes no selection
      }
    }
    else if (rowKey) body.querySelector(`${rowTag}[${rowKey[0]}="${CSS.escape(rowKey[1])}"]`)?.focus({ preventScroll: true });
    // If the focused element is not in the new content, focus must not fall to BODY: the drawer's close button
    if (inBody && (document.activeElement === document.body || !document.activeElement)) drawerEl.querySelector('.drawer-close')?.focus({ preventScroll: true });
  }

  async function render(fresh = false) {
    if (!current) return;
    // While a word is being composed in the idea box (an input method), the box is not replaced: after it
    if (composing) {
      renderAfterComposing = true;
      return;
    }
    const { type, id } = current;
    const my = ++reqId;
    if (type === 'project') setBody(projectHtml(id));
    else if (type === 'roster') setBody(rosterHtml(id));
    else if (type === 'session' || type === 'agent') {
      if (fresh) setBody(`<div class="dr-loading">${esc(t('shLoading'))}</div>`);
      try {
        const res = await fetch(`/api/${type}/${encodeURIComponent(id)}`);
        if (my !== reqId) return;
        if (!res.ok) throw new Error(String(res.status));
        const d = await res.json();
        if (my !== reqId) return;
        setBody(type === 'session' ? sessionHtml(d) : agentHtml(d));
      } catch {
        if (my === reqId) setBody(`<div class="empty-state">${esc(t('shDrGone'))}</div>`);
      }
    }
  }

  // While open, the content is refreshed at most every 3 s by incoming patches; the last change that arrives
  // inside the window is not lost, so it is refreshed once more at the end of the window
  let lastRefresh = 0;
  let trailing = null;
  function refresh() {
    if (!current) return;
    const wait = 3000 - (Date.now() - lastRefresh);
    if (wait > 0) {
      if (!trailing) trailing = setTimeout(() => ((trailing = null), refresh()), wait);
      return;
    }
    lastRefresh = Date.now();
    render();
  }

  // When the actions mode changes, redraw without waiting
  function rerender() {
    if (!current) return;
    body._html = null;
    render();
  }

  // "Add to the library" of a listed skill or agent (docs/skills-flow.md §5.1): kind and name only; the answer's line
  // stays under the button, the list updates itself once the library changed
  async function adoptAct(btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const [kind, ...rest] = String(btn.dataset.adopt || '').split(':');
    const name = rest.join(':');
    const key = `${kind}:${name}`.toLowerCase();
    if (adoptState.get(key)?.busy) return;
    adoptState.set(key, { busy: true });
    rerender();
    const r = await runAction({ action: 'library-adopt', items: [{ kind, name }] });
    const copied = (r.result?.copied || 0) + (r.result?.updated || 0);
    const skipped = (r.plan || []).find((p) => p.op === 'skip');
    const msg = !r.ok ? skillErrorText(r) : r.mode === 'dry' ? t('adoptDry') : copied ? t('adoptDone', { name }) : skipped ? t('adoptSkipped', { reason: planRows([skipped])[0]?.reasonText || '' }) : t('adoptNothing');
    adoptState.set(key, { busy: false, ok: r.ok && copied > 0, msg, mode: actionsState().mode });
    rerender();
    announce(msg);
  }

  rerenderUsage = (projectId) => {
    if (current?.type === 'project' && current.id === projectId) render();
  };

  // A project's drawer stays current while it is open: an AI tool that just started gives a new restore point, and
  // the files it changes show in "What changed". Patches redraw only while a Claude Code session writes its log, so
  // a quiet project (or another tool) is redrawn every PROJECT_TICK_MS too; each section asks again once its cache
  // is old (changes.js, restore.js).
  globalThis.addEventListener?.(AI_STARTED_EVENT, (/** @type {CustomEvent} */ e) => {
    const id = e?.detail?.projectId;
    if (!id) return;
    restore.refresh(id);
    changes.refresh(id);
  });
  everyVisible(() => {
    if (current?.type === 'project') render();
  }, PROJECT_TICK_MS);

  // A skill-flow section got its data (the fit): redraw only when that section is on screen
  rerenderFlow = (fkey) => {
    if (!current || flowKeyOf(current) !== fkey) return;
    render();
  };
  canTurnOn = typeof turnActionsOn === 'function';
  fitArrived = (projectId, fit) => {
    try {
      onFit?.(projectId, fit);
    } catch (e) {
      console.error(e);
    }
  };

  // A job given elsewhere (the Building's box) while actions are off: the project's drawer opens with the job in its
  // box and the same one question as its own Start
  function askStart(projectId, text) {
    if (!store.projects.get(projectId)) return;
    job.setText(projectId, text);
    if (canTurnOn) startAsk.add(projectId);
    open({ type: 'project', id: projectId });
    const k = canTurnOn ? 'job:start-on' : 'job:start';
    focusFk(k);
    // While a result waits the box is at the drawer's end (review U07): the question is brought into sight
    body.querySelector(`[data-fk="${k}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }

  // A new project made from an idea (review U05): its drawer opens with the idea in the job box and Start focused;
  // nothing starts until the person presses it (actions off: Start asks its one question as always)
  function openWithJob(projectId, text) {
    if (!store.projects.get(projectId)) return;
    job.setText(projectId, text);
    open({ type: 'project', id: projectId });
    // No Start yet (the AI tools are still being looked for, or none is installed): the box itself
    const k = body.querySelector('[data-fk="job:start"]') ? 'job:start' : 'job:text';
    focusFk(k);
    body.querySelector(`[data-fk="${k}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }

  return { open, close, refresh, rerender, escape, askStart, openWithJob, isOpen: () => !!current };
}

// Clear the temporary parts of the flows (when the actions mode or token changes and when the drawer closes).
// Item and target selections and loaded suggestions stay; the install target project does not: every opening of
// "Install into a project" starts with no project chosen. A running request writes its own result.
export function resetFlows() {
  for (const st of flows.values()) {
    st.preview = null;
    st.out = null;
    st.msg = '';
    st.confirm = '';
    st.proj = null;
  }
}

// ---------- skill flow (project: suggested skills · roster item: install into a project) ----------
// State lives at module level per flow key, so it survives redraws of the drawer.
const flows = new Map();
function flowState(key) {
  let s = flows.get(key);
  if (!s) {
    flows.set(key, (s = { sel: null, targets: null, targetsFor: null, proj: null, busy: '', preview: null, out: null, confirm: '', msg: '', data: null, loading: false, error: false, at: 0, stale: false }));
    // A project's idea: the text in the box (idea), the one to ask for (ideaWanted) and the one the data answers
    // (dataIdea: null until the first answer). It starts from what was typed last time (or ?qa=1&idea=).
    if (key.startsWith('fit:')) {
      s.idea = QA_IDEA ?? loadIdea(key.slice(4));
      s.ideaWanted = cleanIdea(s.idea);
      s.dataIdea = null;
      // ideaTouched: typed in this page (what is on screen then wins over the project's stored idea)
      s.ideaTouched = QA_IDEA !== null;
    }
  }
  return s;
}

// ---------- the project idea (docs/start-flow.md) ----------
// Typing is asked for after this pause
const IDEA_WAIT_MS = 800;
// A project whose folder is gone (moved or deleted; the server checks every minute): said first, with what to do
export function folderMissingHtml(p) {
  if (!p?.path || p.exists !== false) return '';
  return `<div class="dr-missing" role="status"><b>${esc(t('drFolderMissingTitle'))}</b><p>${esc(t('drFolderMissingBody'))}</p></div>`;
}

// How often an open project drawer is redrawn when nothing else redraws it (its sections ask again once their cache is old)
const PROJECT_TICK_MS = 10000;
// The idea goes to the project in the desktop app this long after typing stopped
const HUB_IDEA_WAIT_MS = 1200;
const IDEA_STORE_PREFIX = 'sibersentez.idea.';

// The project's stored idea (project.idea: kept with the project in the desktop app, docs/start-flow.md step 2) and
// the one in this browser: when they differ, the stored one wins, unless the person typed in this page already (what
// is on screen is being saved then). Pure; st: the section state. Returns true when st.idea was replaced.
export function adoptHubIdea(st, hubIdea) {
  const hub = cleanIdea(hubIdea ?? '');
  if (!st || !hub || st.hubIdea === hub) return false;
  st.hubIdea = hub;
  st.hubSent = hub;
  if (st.ideaTouched || cleanIdea(st.idea) === hub) return false;
  st.idea = hub;
  st.ideaWanted = hub;
  return true;
}
// Projects whose idea the desktop app cannot keep with the project: the server answered 'not-in-memory' (the
// project's folder is not in the program's project memory, and an idea never makes an entry there). For the rest of
// this page session their idea is not sent again; it stays in this browser only, and the idea box says so once.
const ideaLocalOnly = new Set();
export const ideaStaysLocal = (projectId) => ideaLocalOnly.has(projectId);

// The answer of keepIdea (window.sibersentezShell.saveProjectIdea) for one project. ok: the text is the one kept with the
// project ('kept'); reason 'not-in-memory': no more tries for this project in this page session and the note under
// the idea box ('local-only'); anything else is quiet and tried again with the next change ('failed').
export function ideaKeptAnswer(projectId, st, text, r) {
  if (r?.ok) {
    st.hubSent = text;
    st.hubIdea = text;
    return 'kept';
  }
  if (r?.reason === 'not-in-memory') {
    ideaLocalOnly.add(projectId);
    st.ideaLocalOnly = true;
    return 'local-only';
  }
  return 'failed';
}

// QA hook: ?qa=1&idea=<text> fills the idea box of every project drawer (never stored)
const QA_IDEA = (() => {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '');
    return q.has('qa') && q.has('idea') ? cleanIdea(q.get('idea')) : null;
  } catch {
    return null;
  }
})();

// Per project in this browser only (localStorage may be missing or refuse: then the idea lives until a reload)
function loadIdea(projectId) {
  try {
    return cleanIdea(globalThis.localStorage?.getItem(IDEA_STORE_PREFIX + projectId) || '');
  } catch {
    return '';
  }
}
function saveIdea(projectId, text) {
  try {
    if (text) globalThis.localStorage?.setItem(IDEA_STORE_PREFIX + projectId, text);
    else globalThis.localStorage?.removeItem(IDEA_STORE_PREFIX + projectId);
  } catch {
    // storage full or blocked: nothing to do
  }
}

// Flow key of the drawer target: a project shows "Skills for this project", a roster item its install section
function flowKeyOf(target) {
  if (target?.type === 'project') return `fit:${target.id}`;
  if (target?.type === 'roster') return `item:${target.id}`;
  return '';
}

// The fit of a project is fetched again after a live install or remove there
function markStale(projectId) {
  const s = flows.get(`fit:${projectId}`);
  if (s) s.stale = true;
}

// GET /api/projects/<id>/fit[?idea=] (read-only; works whatever the actions mode; the server caches it). Fetched once
// a minute at most while the drawer shows it, after a failure again after 30 s, at once after a live install or when
// the idea to ask for changed (one request at a time: a newer idea is asked for when the running one ends, since the
// redraw then calls this again). The idea in the box is always sent, an empty box as an explicit empty ?idea= (no
// ?idea at all would mean the project's saved idea). The section redraws when the answer arrives; the project list
// badge hears a fit asked for with the project's saved idea (its own requests send no ?idea, which the server answers
// with the saved idea, so the two never disagree).
function loadFit(pid, st) {
  if (st.loading) return;
  const idea = st.ideaWanted || '';
  // askedIdea: the idea of the last request that ended (answered or failed)
  const changed = !!st.at && idea !== (st.askedIdea ?? '');
  // The same idea is not asked for again before the wait (a failed one neither: every redraw would send it)
  if (!changed && !st.stale && st.at && Date.now() - st.at < (st.error ? 30000 : 60000)) return;
  st.loading = true;
  st.loadingIdea = idea;
  fetch(`/api/projects/${encodeURIComponent(pid)}/fit?idea=${encodeURIComponent(idea)}`, { cache: 'no-store', credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((d) => {
      // Another idea: the last plan or result and an open confirmation were about another list
      if (st.dataIdea !== null && st.dataIdea !== undefined && st.dataIdea !== idea) {
        st.out = null;
        st.confirm = '';
      }
      st.data = d && typeof d === 'object' ? d : { candidates: [] };
      st.dataIdea = idea;
      st.error = false;
      st.errorIdea = null;
      if (idea === cleanIdea(store.project(pid)?.idea ?? '')) fitArrived(pid, st.data);
    })
    .catch(() => {
      st.error = true;
      st.errorIdea = idea;
    })
    .finally(() => {
      st.loading = false;
      st.loadingIdea = null;
      st.askedIdea = idea;
      st.stale = false;
      st.at = Date.now();
      rerenderFlow(`fit:${pid}`);
    });
}

// Projects an item can be installed into: listed, with an existing local folder, not broad; registered projects
// first (installTargets). None is chosen for the user.
function installProjects() {
  return installTargets(store.projects);
}

// Request of a flow: { key (same selection = same key), projectId, items, targets, label }
function flowRequest(fkey, st) {
  const i = fkey.indexOf(':');
  const kind = fkey.slice(0, i);
  const id = fkey.slice(i + 1);
  const mode = actionsState().mode;
  if (kind === 'item') {
    const r = store.roster.find((x) => x.id === id);
    if (!r) return null;
    const v = itemInstallView(r, installProjects(), st, mode);
    if (!v.proj) return null;
    return { key: v.key, projectId: v.proj, items: [{ kind: r.kind, name: r.name }], targets: r.kind === 'skill' ? v.targets : [], label: v.project?.name || v.proj };
  }
  return null;
}

const ACT_LABEL = { preview: 'skPreview', try: 'skTry', confirm: 'skInstall', 'confirm-remove': 'skRemove' };

function doneText(act, r) {
  const res = r?.result || {};
  if (act === 'confirm') return t('skDone_confirm', { copied: res.copied ?? 0, updated: res.updated ?? 0 });
  if (act === 'confirm-remove') return t('skDone_confirm-remove', { removed: res.removed ?? 0 });
  return t(`skDone_${act}`);
}

// Button: aria-disabled while busy or when its condition does not hold (it keeps focus, the keyboard flow goes on)
function flowBtn(act, label, off, cls = '') {
  // While disabled, a screen reader hears why (only then: an enabled button is not read twice)
  const why = off && ['preview', 'try', 'install', 'remove'].includes(act) ? ' aria-describedby="flowWhy"' : '';
  return `<button type="button" class="act-btn ${cls}" data-flow-act="${act}" data-fk="flow:${act}"${off ? ' aria-disabled="true"' : ''}${why}>${esc(label)}</button>`;
}

function skBadge() {
  return actionsState().mode === 'dry' ? `<span class="cm-badge">${esc(t('skDryBadge'))}</span>` : '';
}

function resultHtml(s, isResult) {
  const r = s.r || {};
  const head = `${esc(isResult ? t('skResultTitle') : t('skPlanTitle'))} · ${esc(s.label || '—')}${s.ok ? '' : ` · <b class="warn-t">${esc(t('skFailed'))}</b>`}${r.mode === 'dry' ? ` · ${esc(t('skDryBadge'))}` : ''}`;
  let inner = s.ok ? '' : `<p class="small">${esc(skillErrorText(r))}</p>`;
  inner += planList(r.plan);
  if (Array.isArray(r.argv)) inner += `<span class="small muted">${esc(t('skCommand'))}</span><pre class="brief" tabindex="0" translate="no">${esc(argvSummary(r.argv, 4000))}</pre>`;
  if (r.result?.trialDir) inner += `<span class="small muted">${esc(t('skTrialFolder'))}: <code translate="no">${esc(r.result.trialDir)}</code></span>`;
  return `<div class="flow-out"><span class="small muted">${head}</span>${inner}</div>`;
}

// Status line, confirmation and the last plan or result of a flow. ask: { install?, remove? } (escaped HTML)
function flowTail(st, ask) {
  const status = st.busy ? `<p class="flow-status small">${esc(t(`skBusy_${st.busy}`))}</p>` : st.msg ? `<p class="flow-status small">${esc(st.msg)}</p>` : '';
  const removing = st.confirm === 'remove';
  const confirm = st.confirm
    ? `<div class="flow-confirm" role="group" aria-labelledby="flowQ"><p id="flowQ">${removing ? ask.remove : ask.install}</p><div class="flow-btns">${flowBtn(removing ? 'confirm-remove' : 'confirm', t(removing ? 'skConfirmRemove' : 'skConfirmInstall'), false, 'danger')}${flowBtn('cancel', t('skCancel'), false)}</div></div>`
    : '';
  const shown = st.out || st.preview;
  return confirm + status + (shown ? resultHtml(shown, !!st.out) : '');
}

// The action row of the session and agent drawer: the same items as the context menu (menuModel), as buttons
// reachable by keyboard. In off mode the menu model gives only client jobs (copy); "Open details" is dropped
// because this is already the detail.
function actionRow(target, title) {
  const mode = actionsState().mode;
  const items = menuModel(target, store, mode).filter((x) => !x.header && !x.sep && x.id !== 'open');
  if (!items.length) return '';
  return `<div class="dr-acts" role="group" aria-label="${esc(title)}">${items
    .map(
      (it) =>
        `<button type="button" class="act-btn${it.id === 'resume' || it.id === 'fork' ? ' primary' : ''}" data-menu-act="${esc(it.id)}" data-menu-type="${esc(target.type)}" data-menu-id="${esc(target.id)}" data-fk="menu:${esc(it.id)}" aria-labelledby="dal-${esc(it.id)}"${it.hint ? ` aria-describedby="dah-${esc(it.id)}"` : ''}${it.disabled ? ' aria-disabled="true"' : ''}><span id="dal-${esc(it.id)}">${esc(it.label)}</span>${it.hint ? `<span class="act-hint" id="dah-${esc(it.id)}">${esc(it.hint)}</span>` : ''}</button>`,
    )
    .join('')}${dryBadge()}</div>`;
}

function dryBadge() {
  return actionsState().mode === 'dry' ? `<span class="cm-badge">${esc(t('shCmDryBadge'))}</span>` : '';
}

// A project's name for the reasons ("installed in <name>"); the id when the project is not listed
const projectName = (id) => store.projects.get(id)?.name || id;

// Project drawer: the section of the open project, its fit loaded (or refreshed) on the way
function fitSection(p) {
  const st = flowState(`fit:${p.id}`);
  // The idea kept with the project wins over this browser's copy (which follows it)
  if (adoptHubIdea(st, p.idea)) saveIdea(p.id, st.idea);
  loadFit(p.id, st);
  if (!st.targets) st.targets = new Set(skillTargets(p.via));
  return fitSectionHtml(p, st, actionsState().mode, projectName, installedTools()[0] || null, { turnOn: canTurnOn });
}

// Roster drawer of a library item, "Install into a project": project and targets; Preview and Install, and Remove
// where it is installed. State comes from the pure itemInstallView (contextmenu.js): no project is chosen for the
// user, so Preview and Install stay disabled until one is picked.
// A skill or agent the AI tools see but the library does not hold yet: copy it into the library from where it lives
// (docs/skills-flow.md §5.1). Only for items the server marked adoptable (it knows their folder); the answer of the
// last try stays under the button while the actions mode stays the same.
const adoptState = new Map(); // kind:name -> { busy, ok, msg }
function adoptSection(r, mode = actionsState().mode, st = adoptState.get(`${r.kind}:${r.name}`.toLowerCase())) {
  if (!r?.adoptable || (r.kind !== 'skill' && r.kind !== 'agent')) return '';
  const off = mode === 'off';
  const busy = !!st?.busy;
  const dis = off || busy ? ' aria-disabled="true"' : '';
  const label = busy ? t('adoptBusy') : mode === 'dry' ? t('adoptPreview') : t('adoptButton');
  // The last answer only while the mode it came in is still on (a Preview note is gone once actions are On)
  const line = st?.msg && st.mode === mode ? `<p class="small flow-status${st.ok ? ' ok' : ''}" role="status">${esc(st.msg)}</p>` : '';
  return `<section class="dr-sec flow adopt" data-sec="adopt" aria-labelledby="adoptH"><h3 id="adoptH">${icon('folder')} ${esc(t('rfLibAdd'))}</h3>
    <p class="muted small">${esc(t(r.kind === 'agent' ? 'adoptIntroAgent' : 'adoptIntroSkill', { name: r.name }))}</p>
    <div class="flow-btns"><button type="button" class="act-btn primary" data-adopt="${esc(`${r.kind}:${r.name}`)}" data-fk="adopt"${dis}>${icon('folder')}<span>${esc(label)}</span></button></div>
    ${off ? `<p class="small muted">${esc(t('adoptOff'))}</p>` : ''}${line}
  </section>`;
}

function itemSection(r) {
  const mode = actionsState().mode;
  if (mode === 'off' || !libraryInstallable(r)) return '';
  const head = `<h3 id="instH">${icon('folder')} ${esc(t('skInstallTitle'))}${skBadge()}</h3>`;
  const projects = installProjects();
  if (!projects.length) return `<section class="dr-sec flow" data-sec="install" aria-labelledby="instH">${head}<p class="muted small">${esc(t('skNoProjects'))}</p></section>`;
  const fkey = `item:${r.id}`;
  const st = flowState(fkey);
  let v = itemInstallView(r, projects, st, mode);
  st.proj = v.proj;
  // Targets follow the chosen project's tools (Claude Code's .claude while none is chosen) until the user picks them
  if (!st.targets || st.targetsFor !== v.proj) {
    st.targets = new Set(skillTargets(v.project?.via));
    st.targetsFor = v.proj;
    v = itemInstallView(r, projects, st, mode);
  }
  const projectName = v.project?.name || v.proj || '';
  const ask = { install: esc(t('skAskInstall', { count: num(1), project: projectName })), remove: esc(t('skAskRemove', { name: r.name, project: projectName })) };
  return `<section class="dr-sec flow" data-sec="install" data-flow="${esc(fkey)}" aria-labelledby="instH">
    ${head}
    <p class="muted small">${esc(t('skInstallIntro', { name: r.name }))}</p>
    ${projectPickerHtml(projects, v)}
    ${r.kind === 'agent' ? `<p class="small muted sk-targets">${esc(t('skAgentsClaudeOnly'))}</p>` : targetPicker(st, v.busy)}
    ${v.here ? `<p class="small muted">${esc(t('skInstalledHere'))}</p>` : ''}
    <div class="flow-btns">${flowBtn('preview', t('skPreview'), v.previewDisabled)}${flowBtn('install', t('skInstall'), !v.installEnabled, 'primary')}${v.here ? flowBtn('remove', t('skRemove'), !v.removeEnabled, 'danger') : ''}</div>
    <p class="small muted flow-why" id="flowWhy">${esc(v.why)}</p>
    ${flowTail(st, ask)}
  </section>`;
}

// Project list of the install section (pure; exported for the tests). A placeholder stays selected until the user
// picks a project; registered projects come first, in their own group, then the folders found in tool records.
// v: itemInstallView's answer ({ proj, installed, busy }).
export function projectPickerHtml(projects, v) {
  const opt = (p) => `<option value="${esc(p.id)}"${p.id === v.proj ? ' selected' : ''}>${esc(p.name)}${v.installed?.has(p.id) ? ` · ${esc(t('skInstalledSiberSentez'))}` : ''}</option>`;
  const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '');
  const registered = projects.filter((p) => p.kind === 'registered');
  const found = projects.filter((p) => p.kind !== 'registered');
  return `<label class="flow-pick"><span>${esc(t('skProject'))}</span><select data-flow-proj data-fk="flow-proj"${v.busy ? ' disabled' : ''}><option value="" disabled${v.proj ? '' : ' selected'}>${esc(t('skPickProject'))}</option>${group(t('skGroupRegistered'), registered)}${group(t('skGroupFound'), found)}</select></label>`;
}

function head(title, sub, color, badge) {
  return `<header class="dr-head" style="--c:${color}"><span class="dr-mark"></span><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${badge || ''}</header>`;
}

function kv(pairs) {
  return `<dl class="kv">${pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}

function stateBadge(key) {
  const s = STATUS[key];
  return s ? `<span class="badge-state" style="--c:${s.c}"><i></i>${esc(s.l)}</span>` : '';
}

// The project's activity tiles of the last 24 hours: tool calls, prompts and running agents (pure; exported for the
// tests). Output tokens are not repeated here: the usage section right below shows them with its period choice
// (docs/usage.md §6). Three tiles in one row, also on a narrow window.
export function projectTilesHtml(p) {
  const s = p?.stats24 || {};
  return `<div class="dr-tiles adv-only" style="grid-template-columns: repeat(3, minmax(0, 1fr))">
      <div><b>${num(s.tools || 0)}</b><span>${esc(t('shTileTools24'))}</span></div>
      <div><b>${num(s.prompts || 0)}</b><span>${esc(t('shTilePrompts24'))}</span></div>
      <div><b>${num(p?.runningAgents || 0)}</b><span>${esc(t('shTileRunningAgents'))}</span></div>
    </div>`;
}

// A web project, as "How to run it" found it: a plain page, or a Node project that prints an address
function isWebRun(data) {
  return !!data?.plans?.some((pl) => pl?.kind === 'static' || (pl?.kind === 'node' && (pl.steps || []).some((s) => s?.id === 'address')));
}

// "This job's result" once the job reached it; its start copy as the job box knows it (asked for after a reload).
// While the result waits (finish) it comes first with the job's steps and the way to the job's AI session (review
// U07, U08): an AI tab of the project in SiberSentez's terminal, or the job's own session (job.js jobSession)
function jobResultSection(p) {
  const d = job.get(p.id).data;
  const jobId = d?.plan?.jobId || null;
  if (jobId) askJobPoint(p.id, jobId);
  const waiting = d?.step === 'finish';
  const session = waiting ? jobSession({ sessions: store.sessions.values(), projectId: p.id, job: { jobId, tool: d.tool || null, updatedAt: d.updatedAt ?? null } }) : null;
  const tab = waiting && (store.dockRunning?.() || []).some((x) => x && x.projectId === p.id);
  // Its AI no longer runs (no tab, its session closed): said before the click, as the job box said it before
  const go = waiting ? { session: session?.id || null, tab, stopped: !tab && !!session && sessionState(session) === 'closed' } : null;
  const cost = jobId ? jobCostText(jobCosts.job(p.id, jobId), { pricedAt: jobCosts.pricedAt(p.id) }) : '';
  // The person's own words for the tip (plan C4): the label of the job's start copy, as the restore list has it
  const startPoint = jobId ? startPointOf(p.id, jobId) : null;
  const label = startPoint?.id && !startPoint.reused ? (restore.get(p.id)?.data?.points || []).find((x) => x?.id === startPoint.id)?.label : '';
  const tips = jobTips(label);
  const rst = restore.ui(p.id).step;
  const backOpts = { mode: actionsState().mode, busy: rst === 'loading' || rst === 'busy' };
  // Try it yourself (acceptGuide.js): the plan's Done-when items, the person's own marks from this browser
  const guide = acceptGuideHtml(d, readMarks(p.id, jobId));
  return jobResult.html(p, d, startPoint, waiting ? { steps: stepsHtml(d, { offline: store.lost }), go, cost, tips, back: backOpts, guide } : { cost, tips, back: backOpts, guide });
}

// The session that can go on with the project's job: the Building's own answer (job.js resumeCandidate)
function drawerResume(projectId) {
  const d = job.get(projectId).data;
  const shown = d && d.step && d.step !== 'none' ? { step: d.step, jobId: d.plan?.jobId || null, tool: d.tool || null, updatedAt: d.updatedAt ?? null } : null;
  return resumeCandidate({ sessions: store.sessions.values(), projectId, job: shown, dock: store.dockRunning?.() || [] });
}

function projectHtml(id) {
  const p = store.projects.get(id);
  if (!p) return `<div class="empty-state">${esc(t('shProjNotFound'))}</div>`;
  const sessions = [...store.sessions.values()].filter((s) => s.projectId === id).sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.lastAt - a.lastAt);
  const agents = [...store.agents.values()].filter((a) => a.projectId === id).sort((a, b) => b.startedAt - a.startedAt);
  const events = store.events.filter((e) => e.projectId === id).slice(-40).reverse();
  const rosterHere = store.roster.filter((r) => (r.installedIn || []).includes(id));
  const st = p.busy ? 'busy' : p.live ? 'idle' : null;
  // Once the job is built (being checked, or done), "How to run it" leaves the Details and stands under the job: the
  // result is something to open (docs/run-hint.md)
  // "How to run it" once the work is built: in the check, at the result (finish) and after
  const built = ['check', 'finish', 'done'].includes(job.get(p.id).data?.step);
  // The result waits (finish): it comes first, the job box is a secondary "New job" at the end (review U07)
  const resultFirst = job.get(p.id).data?.step === 'finish';
  // What the start's copy would hold, only when the start takes one (actions On, or Off with the one-step turn-on)
  const scopeOpts = (id) => {
    if (!(actionsState().mode === 'live' || (actionsState().mode === 'off' && canTurnOn))) return {};
    const sc = scopes.get(id);
    return { backup: scopeHtml(sc, { open: scopeOpen.has(id) }), noCopy: !scopeTakesCopy(sc) };
  };
  const jobBox = job.html(p, { mode: actionsState().mode, turnOn: canTurnOn, asking: startAsk.has(p.id), next: nextFor({ web: isWebRun(runHint.get(p.id).data) }), stopped: drawerResume(p.id), asNew: resultFirst, ...aiNow(p.id), cost: estimateText(jobCosts.estimate(p.id), { tool: preferredTool(installedTools())?.id }), ...scopeOpts(p.id), offline: store.lost });
  return `${head(p.name, `${esc(projectKindText(p))}${p.path ? ` · <code>${esc(p.path)}</code><button type="button" class="icon-btn dr-copy" data-copy data-fk="copy:path" aria-label="${esc(t('shCopyPath'))}" title="${esc(t('shCopyPath'))}">${icon('copy')}</button>` : ''}`, projectColor(id), st ? stateBadge(st) : '')}
    ${folderMissingHtml(p)}
    ${relinkOfferHtml(p, relinkCandidates(store.projects.values(), p), relinkUi.get(p.id), actionsState().mode)}
    ${relinkedHtml(p, actionsState().mode, relinkUi.get(p.id))}
    ${toolsOnlyHtml(p, realTwin(store.projects.values(), p))}
    ${apiErrorHtml(projectApiError(store.sessions.values(), p.id)?.e)}
    ${shownDescription(p.description) ? `<p class="dr-desc">${esc(shownDescription(p.description))}</p>` : ''}
    ${offBannerHtml(actionsState().mode)}
    ${resultFirst ? '' : jobBox}
    ${permModeLine(store.sessions.values(), p.id)}
    ${jobResultSection(p)}
    ${publish.html(p)}
    ${built ? runHint.html(p, { quiet: resultFirst }) : ''}
    ${restore.html(p, { mode: actionsState().mode })}
    ${resultFirst ? jobBox : ''}
    <details class="dr-more" data-more="${esc(p.id)}"${moreOpen.has(p.id) ? ' open' : ''}><summary><b>${esc(t('drMore'))}</b><span class="small muted">${esc(t('drMoreHint'))}</span></summary>
    ${fitSection(p)}
    ${startNextHtml(p, flows.get(`fit:${p.id}`), actionsState().mode)}
    ${job.teamHtml(p, { mode: actionsState().mode, team: teamInstalled(flows.get(`fit:${p.id}`)?.data) })}
    ${built ? '' : runHint.html(p)}
    ${changes.html(p)}
    ${projectTilesHtml(p)}
    ${projectUsage.html(p.id)}
    ${kv([
      [t('shKStatus'), esc(p.status === 'unregistered' ? t('shStatusUnregistered') : p.status)],
      [t('shKPhase'), esc(p.phase)],
      [t('shKLastActivity'), p.lastActivity ? `${ago(p.lastActivity)} · ${dayTime(p.lastActivity)}` : ''],
      ['Git', p.git?.unsafe ? `${icon('branch')} ${esc(t('shGitUnsafe'))}` : p.git ? `${icon('branch')} ${esc(p.git.branch || '—')} · ${p.git.changed == null ? t('shGitUnread') : `${t('shGitChanged', { n: num(p.git.changed) })} · ${t('shGitUntracked', { n: num(p.git.untracked) })}`}` : ''],
      [t('shKStack'), p.stack?.length ? p.stack.map((s) => `<span class="tag">${esc(s)}</span>`).join('') : ''],
      [t('shKPackages'), p.packages?.length ? p.packages.map((s) => `<span class="tag">${esc(s)}</span>`).join('') : ''],
      ['Build', p.build ? `<code>${esc(p.build)}</code>` : ''],
    ])}
    ${planSection(p)}
    ${p.rules?.length ? `<section class="dr-sec"><h3>${icon('check')} ${esc(t('shSecRules'))}</h3><ul class="rules">${p.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}
    <section class="dr-sec"><h3>${icon('prompt')} ${esc(t('shSecSessions'))} <span>${sessions.length}</span></h3>
      <ul class="dlist">${sessions
        .slice(0, 30)
        .map((s) => `<li data-session="${esc(s.id)}" tabindex="0"><i class="sdot s-${s.live ? s.live.status : 'closed'}"${s.live || liveKnown(s) ? '' : ` title="${esc(t('fmtSt_unknown'))}"`}></i>${s.live || liveKnown(s) ? '' : `<span class="sr-only">${esc(t('fmtSt_unknown'))}</span>`}<span class="dl-main">${esc(store.sessionLabel(s))}</span>${sessionToolTag(s)}<span class="dl-meta">${modelName(s.model)} · ${t('shToolsN', { n: num(s.toolCalls) })} · ${ago(s.lastAt)}</span></li>`)
        .join('') || `<li class="muted">${esc(t('shNoSessions'))}</li>`}</ul></section>
    <section class="dr-sec"><h3>${icon('agent')} ${esc(t('shSecAgents'))} <span>${agents.length}</span></h3>
      <ul class="dlist">${agents
        .slice(0, 40)
        .map((a) => `<li data-agent="${esc(a.id)}" tabindex="0"><i class="sdot" style="--c:${(STATUS[a.status] || STATUS.running).c}"></i><span class="dl-main"><em class="atype" style="--c:${agentColor(a.type)}">${esc(a.type)}</em>${esc(a.label || '')}</span><span class="dl-meta">${esc((STATUS[a.status] || {}).l || a.status)} · ${t('shToolsN', { n: num(a.toolCalls) })} · ${ago(a.lastAt)}</span></li>`)
        .join('') || `<li class="muted">${esc(t('shNoAgents'))}</li>`}</ul></section>
    ${p.git?.commits?.length ? `<section class="dr-sec"><h3>${icon('commit')} ${esc(t('shSecCommits'))}</h3><ul class="dlist">${p.git.commits.map((c) => `<li><code>${esc(c.h)}</code><span class="dl-main">${esc(c.s)}</span><span class="dl-meta">${dayTime(c.t)}</span></li>`).join('')}</ul></section>` : ''}
    ${rosterHere.length ? `<section class="dr-sec"><h3>${icon('users')} ${esc(t('shSecRosterHere'))} <span>${rosterHere.length}</span></h3><div class="tagcloud">${rosterHere
      .sort((a, b) => (b.usage?.count || 0) - (a.usage?.count || 0))
      .slice(0, 80)
      .map((r) => `<button class="tag btn ${r.usage ? 'used' : ''}" data-roster="${esc(r.id)}">${esc(r.name)}${r.usage ? ` <b>${num(r.usage.count)}</b>` : ''}</button>`)
      .join('')}</div></section>` : ''}
    <section class="dr-sec"><h3>${icon('list')} ${esc(t('shSecEvents'))}</h3><ol class="feed">${events.map((e) => eventRow(e, { compact: true })).join('') || `<li class="muted">${esc(t('shNoEvents'))}</li>`}</ol></section>
    </details>`;
}

function toolBars(counts) {
  const list = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = Math.max(1, ...list.map((x) => x[1]));
  return list.map(([k, v]) => `<div class="tbar" style="--w:${((v / max) * 100).toFixed(1)}%"><span>${esc(k)}</span><i></i><b>${num(v)}</b></div>`).join('');
}

// A session that waits for the person: what it waits for, and where to answer (the concept's "Needs you" box). No button
// pretends to take the person there: SiberSentez cannot bring another terminal window forward, and resuming would open the
// same session a second time.
function waitingNoteHtml(s, now = Date.now()) {
  if (!s || sessionState(s, now) !== 'waiting') return '';
  const what = waitWhat(s) ? t('attnAsks', { what: waitWhat(s) }) : t('drWaitingTurn');
  return `<div class="dr-waiting" role="note"><b>${esc(t('attnState_waiting'))}</b><p>${esc(what)}</p><p class="small">${esc(t('drWaitingWhere'))}</p></div>`;
}

// The AI tool a session belongs to (server/toolLogs.mjs reads Codex's and Gemini CLI's logs too): its name, and a
// tag for any tool but Claude Code (whose sessions were the only ones before)
// (jobId.js sessionToolName)
const sessionToolTag = (s) => ((s?.tool || 'claude') === 'claude' ? '' : `<span class="tag">${esc(sessionToolName(s))}</span>`);

// Whether an AI works in the project now, as the job box's sentence takes it (job.js aiStateIn)
function aiNow(projectId) {
  const st = aiStateIn({ sessions: store.sessions.values(), projectId, dock: store.dockRunning?.() || [] });
  return { idle: st === 'idle', unknown: st === 'unknown' };
}

function sessionHtml(d) {
  const p = store.projects.get(d.projectId);
  // Another tool's session has no live state: not known, never "Closed" (it may run)
  const st = d.live ? d.live.status : liveKnown(d) ? 'closed' : 'unknown';
  const title = d.title || d.lastPrompt || d.firstPrompt || t('shSessionDefault');
  return `${head(title, `${p ? esc(p.name) + ' · ' : ''}<code>${esc(d.id.slice(0, 8))}</code>${sessionToolTag(d)}${permModeChip(d.permissionMode)}`, projectColor(d.projectId), stateBadge(st))}
    ${waitingNoteHtml(store.sessions.get(d.id))}
    ${apiErrorHtml(liveApiError(store.sessions.get(d.id)))}
    ${actionRow({ type: 'session', id: d.id }, t('shSessionActions'))}
    <div class="dr-tiles">
      <div><b>${num(d.toolCalls)}</b><span>${esc(t('shTileToolCalls'))}</span></div>
      <div><b>${tok(d.tokensOut)}</b><span>${esc(t('shTileTokensOut'))}</span></div>
      <div><b>${tok(d.contextTokens)}</b><span>${esc(t('shTileContext'))}</span></div>
      <div><b>${num(d.agentCount)}</b><span>${esc(t('shTileSubagents'))}</span></div>
    </div>
    ${kv([
      [t('shKNow'), d.live?.status === 'busy' && d.lastAction ? `${actionLine(d.lastAction)} · ${agoTag(d.lastAction.t, 'span')}` : d.lastAction ? `<span class="muted">${t('shLastPrefix', { action: actionLine(d.lastAction) })} · ${agoTag(d.lastAction.t, 'span')}</span>` : ''],
      ['Model', modelName(d.model)],
      [t('shKStarted'), dayTime(d.startedAt)],
      [t('shKLastActivity'), `${ago(d.lastAt)} · ${dayTime(d.lastAt)}`],
      [t('shKDuration'), dur(d.lastAt - d.startedAt)],
      [t('shKFolder'), d.cwd ? `<code>${esc(d.cwd)}</code>` : ''],
      [t('shKBranch'), d.branch ? esc(d.branch) : ''],
      [sessionToolName(d), d.version ? esc(d.version) : ''],
      [t('shKCompactions'), d.compacts ? t('shTimes', { n: num(d.compacts) }) : ''],
      [t('shKSkills'), Object.keys(d.skills || {}).length ? Object.entries(d.skills).map(([k, v]) => `<span class="tag">${esc(k)} <b>${num(v)}</b></span>`).join('') : ''],
    ])}
    <section class="dr-sec"><h3>${icon('prompt')} ${esc(t('shSecPrompts'))} <span>${num(d.promptCount)}</span></h3>
      <ol class="prompts">${(d.prompts || []).slice().reverse().map((x) => `<li><time>${dayTime(x.t)}</time><p>${esc(x.text)}</p></li>`).join('') || `<li class="muted">${esc(t('shNoRecord'))}</li>`}</ol></section>
    <section class="dr-sec"><h3>${icon('agent')} ${esc(t('shSecSubagents'))} <span>${d.agents.length}</span></h3>
      <ul class="dlist">${d.agents
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((a) => `<li data-agent="${esc(a.id)}" tabindex="0"><i class="sdot" style="--c:${(STATUS[a.status] || STATUS.running).c}"></i><span class="dl-main"><em class="atype" style="--c:${agentColor(a.type)}">${esc(a.type)}</em>${esc(a.label || '')}</span><span class="dl-meta">${esc((STATUS[a.status] || {}).l || a.status)} · ${t('shToolsN', { n: num(a.toolCalls) })} · ${dur(a.lastAt - a.startedAt)}</span></li>`)
        .join('') || `<li class="muted">${esc(t('shNoSubagentCalls'))}</li>`}</ul></section>
    ${d.workflowRuns?.length ? `<section class="dr-sec"><h3>${icon('workflow')} ${esc(t('shSecWorkflowRuns'))}</h3><ul class="dlist">${d.workflowRuns.map((w) => `<li><i class="sdot" style="--c:${(STATUS[w.status] || STATUS.running).c}"></i><span class="dl-main">${esc(w.name || w.id)}</span><span class="dl-meta">${t('shAgentsN', { n: num(w.agentCount) })} · ${tok(w.totalTokens)} · ${dur(w.durationMs)}</span></li>`).join('')}</ul></section>` : ''}
    <section class="dr-sec"><h3>${icon('bars')} ${esc(t('shSecToolUse'))}</h3><div class="tbars">${toolBars(d.toolCounts)}</div></section>`;
}

function agentHtml(d) {
  const p = store.projects.get(d.projectId);
  const s = store.sessions.get(d.sessionId);
  return `${head(d.label || d.type, `${esc(d.type)}${p ? ' · ' + esc(p.name) : ''}`, agentColor(d.type), stateBadge(d.status))}
    ${actionRow({ type: 'agent', id: d.id }, t('shAgentActions'))}
    <div class="dr-tiles">
      <div><b>${num(d.toolCalls)}</b><span>${esc(t('shTileToolCalls'))}</span></div>
      <div><b>${tok(d.tokensOut)}</b><span>${esc(t('shTileTokensOut'))}</span></div>
      <div><b>${dur(d.lastAt - d.startedAt)}</b><span>${esc(t('shTileDuration'))}</span></div>
      <div><b>${num(d.depth)}</b><span>${esc(t('shTileDepth'))}</span></div>
    </div>
    ${kv([
      [t('shKType'), `<button class="tag btn" data-roster="agent:${esc(String(d.type).toLowerCase())}">${esc(d.type)}</button>`],
      [t('shKLastAction'), d.lastAction ? `${actionLine(d.lastAction)} · ${agoTag(d.lastAction.t, 'span')}` : ''],
      ['Model', modelName(d.model)],
      [t('shKStarted'), dayTime(d.startedAt)],
      [t('shKLastActivity'), `${ago(d.lastAt)} · ${dayTime(d.lastAt)}`],
      [t('shKMode'), d.workflowRunId ? `${t('shWorkflowWorker')} · <code>${esc(d.workflowRunId)}</code>` : d.background ? t('shBackground') : t('shForeground')],
      [t('shKParent'), s ? `<button class="tag btn" data-session="${esc(s.id)}">${esc(store.sessionLabel(s))}</button>` : ''],
    ])}
    ${d.prompt ? `<section class="dr-sec"><h3>${icon('prompt')} ${esc(t('shSecBrief'))}</h3><pre class="brief">${esc(d.prompt)}</pre></section>` : ''}
    <section class="dr-sec"><h3>${icon('bars')} ${esc(t('shSecToolUse'))}</h3><div class="tbars">${toolBars(d.toolCounts)}</div></section>`;
}

// Local calendar date of a timestamp (ISO text or ms) in the page's language, or '' when it is not a date
function localDate(at) {
  const ms = typeof at === 'number' ? at : Date.parse(typeof at === 'string' ? at : '');
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return dateText(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
}

// Where a library item came from when it was brought from GitHub (docs/github-import.md §7), as one line of its
// drawer page: "Source: owner/repo @ abc1234 · MIT · brought 29.09.2026" (pure; exported for the tests). The roster's
// origin carries the repository, the short commit and the license (never a path); the date shows when the server
// sends one (origin.importedAt). Any other item: ''. The license reads as on the roster row.
export function originLineHtml(r) {
  const o = r?.origin?.type === 'github' && typeof r.origin.repo === 'string' && r.origin.repo && sourcesOf(r).includes('library') ? r.origin : null;
  if (!o) return '';
  const lic = o.license && !['proprietary', 'unknown'].includes(o.license) ? o.license : t(`ghLicense_${o.family === 'proprietary' ? 'proprietary' : o.family === 'unknown' ? 'unknown' : 'none'}`);
  const date = localDate(o.importedAt);
  const tip = `${t('ghOriginTitle', { repo: o.repo, commit: o.commit || '?', license: lic })}. ${t('ghOriginCheckHint')}`;
  return `<p class="dr-desc small dr-origin" data-origin title="${esc(tip)}">${icon('branch')} <span translate="no">${esc(t('ghOrigin', { repo: originRepo(o) }))}</span> · ${esc(lic)}${date ? ` · ${esc(t('ghOriginAt', { date }))}` : ''}</p>`;
}

function rosterHtml(id) {
  const r = store.roster.find((x) => x.id === id);
  if (!r) return `<div class="empty-state">${esc(t('shRosterGone'))}</div>`;
  const u = r.usage;
  const color = r.kind === 'agent' ? agentColor(r.name) : r.kind === 'skill' ? '#ffd66b' : '#8fa3bf';
  const kindL = { skill: t('shKindSkill'), agent: t('shKindAgent'), plugin: t('shKindPlugin') }[r.kind] || r.kind;
  const src = sourcesOf(r);
  const cat = r.category && !isSourceKey(r.category) && r.category !== r.plugin ? ' · ' + esc(r.category) : '';
  const srcChips = src.map((k) => `<span class="rsrc s-${esc(k)}" title="${esc(SOURCE_HINT[k] || '')}">${esc(sourceLabel(k))}</span>`).join('');
  return `${head(r.name, `${esc(kindL)} · ${esc(sourceLabel(src[0]))}${cat}`, color, '')}
    <p class="dr-desc">${esc(kitSummary(r.kind, r.name, r.description, r.source === 'kit') || t('shNoDescription'))}</p>
    ${originLineHtml(r)}
    <div class="dr-tiles">
      <div><b>${num(u?.count || 0)}</b><span>${esc(t('shTileCalls', { days: store.windowDays }))}</span></div>
      <div><b>${u ? ago(u.lastAt) : '—'}</b><span>${esc(t('shTileLastCall'))}</span></div>
      <div><b>${num(u?.projects?.length || 0)}</b><span>${esc(t('shTileUsedIn'))}</span></div>
      <div><b>${everywhere(r) ? esc(t('shTileAll')) : num((r.installedIn || []).length)}</b><span>${esc(t('shTileApplies'))}</span></div>
    </div>
    ${kv([
      [src.length > 1 ? t('shKSources') : t('shKSource'), `<span class="src-chips">${srcChips}</span>`],
      [t('shKAccess'), esc(accessText(r))],
      [t('shKPlugin'), r.plugin && r.kind !== 'plugin' ? `<code translate="no">${esc(r.plugin)}</code>` : ''],
      [t('shKInstalledIn'), (r.installedIn || []).map((pid) => `<button class="tag btn" data-project="${esc(pid)}">${esc(store.projects.get(pid)?.name || pid)}</button>`).join('')],
      [t('shKUsedIn'), (u?.projects || []).map((pid) => `<button class="tag btn" data-project="${esc(pid)}">${esc(store.projects.get(pid)?.name || pid)}</button>`).join('')],
    ])}
    ${adoptSection(r)}
    ${itemSection(r)}
    ${u?.recent?.length ? `<section class="dr-sec"><h3>${icon('list')} ${esc(t('shSecRecentTasks'))}</h3><ul class="dlist">${u.recent.map((x) => `<li ${x.projectId ? `data-project="${esc(x.projectId)}" tabindex="0"` : ''}><span class="dl-main">${esc(x.text || t('shUndescribedCall'))}</span><span class="dl-meta">${esc(store.projects.get(x.projectId)?.name || '')} · ${dayTime(x.t)}</span></li>`).join('')}</ul></section>` : ''}`;
}

// "What is next": from the project's own status file (CCGS production/)
function planSection(p) {
  const pl = p.plan;
  if (!pl) return '';
  return `<section class="dr-sec"><h3>${icon('plan')} Plan <span>${esc(pl.source)} · ${agoTag(pl.updatedAt, 'span')}</span></h3>${kv([
    [t('shKStage'), esc([pl.stage, pl.reviewMode && t('shReview', { mode: pl.reviewMode })].filter(Boolean).join(' · '))],
    [t('shKStatus'), pl.phase ? esc(pl.phase) : ''],
    [t('shKNowPlan'), pl.current ? esc(pl.current) : ''],
    [t('shKNext'), pl.next ? `<b>${esc(pl.next)}</b>` : ''],
    [t('shKOpenItems'), pl.open ? esc(pl.open) : ''],
  ])}</section>`;
}
