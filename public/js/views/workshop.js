// The Workshop screen (docs/hq.md): one project's building with its team at work, from the approved "SiberSentez Bina
// Onayli" design of 2026-10-01. The counts over it, the building with its sign, the room tabs under it, the rewind
// ("What happened?": the last 15 minutes), the team, the shared work, the recent activity, the quota, and a card for
// whatever is chosen (an actor, a room, a piece of furniture, the lift). "Play" runs the three-minute example.
// The scene comes from hq-scene.js, the drawing from hq-render.js, the live data from hq-live.js. The card's actions
// go out as a window event (hq-action, docs/hq.md) that main.js carries out.
import { esc } from '../format.js';
import { t, language } from '../i18n.js';
import { FLOORS, ROOMS, HISTORY_MS, DEMO_MS, TOOL_CATS, sceneFrom, createDemo, roomKindFor, countByCategory, eventLabel, frameInterval } from '../hq-scene.js';
import { HqRenderer } from '../hq-render.js';
import { projectsInOrder, projectNames, pastSnapshots, liveSnapshot, liveEvents, liveTicks, KindCache, LiveHistory, TeamCache } from '../hq-live.js';
import { jobNowText, stepsHtml, stoppedSession } from './job.js';
import { sessionState } from '../attention.js';
import { apiErrorHtml, projectApiError, apiErrorWords } from '../apiError.js';
import { permModeChip } from '../permMode.js';

const GUIDE_KEY = 'sibersentez.hq.guide';
const ROOM_KEYS = ['dev', 'library', 'server', 'design', 'meeting', 'lounge'];
// The example's moments that show each room at work (the room list in the toolbar)
const PREVIEWS = { dev: 25000, library: 25000, server: 47000, design: 128000, meeting: 110000, lounge: 150000 };

// A ws* string (strings/workshop.js)
export const word = (key, vars) => t(`ws${key[0].toUpperCase()}${key.slice(1)}`, vars);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
// A moment on the rewind: the clock for live data, minutes and seconds for the example
export function formatTime(ms) {
  if (ms > 86400000) return new Date(ms).toLocaleTimeString(language() === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}
const titleOf = (a) => a?.data?.fullTitle || a?.title || word('unknown');
// The job box's examples, each a sentence for a kit skill (debug-helper, next-step, ui-polish)
export const GIVE_EXAMPLES = Object.freeze(['fix', 'next', 'polish']);

const TEMPLATE = () => `
<div class="ws-head">
  <form class="ws-give" data-ws="give"><label class="sr-only" for="wsGiveText">${esc(word('giveLabel'))}</label><input id="wsGiveText" data-ws="give-text" type="text" maxlength="300" autocomplete="off" placeholder="${esc(word('givePlaceholder'))}"><button type="submit" data-ws="give-go">${esc(word('giveGo'))}</button><div class="ws-give-ex" data-ws="give-ex" role="group" aria-label="${esc(word('exTitle'))}"></div></form>
  <div class="ws-head-side">
    <label class="ws-project"><span>${esc(word('chooseProject'))}</span><select data-ws="project"></select></label>
    <button type="button" data-ws="help">${esc(word('help'))}</button>
  </div>
</div>
<section class="ws-stats" data-ws="stats" aria-label="${esc(word('teamTitle'))}">
  <div class="ws-stat work"><strong data-ws="active">0</strong><div><span>${esc(word('activeAgents'))}</span><small>${esc(word('activeHint'))}</small></div></div>
  <div class="ws-stat wait"><strong data-ws="waiting">0</strong><div><span>${esc(word('waitingCount'))}</span><small>${esc(word('waitingHint'))}</small></div></div>
  <div class="ws-stat"><strong data-ws="completed">0</strong><div><span>${esc(word('completedCount'))}</span><small>${esc(word('completedHint'))}</small></div></div>
</section>
<div class="ws-layout" data-ws="layout">
  <div class="ws-scene">
    <div class="ws-toolbar">
      <button type="button" data-ws="play"></button>
      <button type="button" data-ws="step">${esc(word('step'))}</button>
      <select data-ws="speed" aria-label="${esc(word('speed'))}">${[1, 2, 4].map((n) => `<option value="${n}">${n}×</option>`).join('')}</select>
      <select data-ws="room" aria-label="${esc(word('room'))}">${['', ...ROOM_KEYS].map((k) => `<option value="${k}">${esc(word(k || 'room'))}</option>`).join('')}</select>
      <button type="button" data-ws="fit">${esc(word('fit'))}</button>
      <small data-ws="label"></small>
    </div>
    <section class="ws-stage" data-ws="stage">
      <canvas data-ws="canvas" tabindex="-1" aria-label="${esc(word('canvasLabel'))}"></canvas>
      <button type="button" class="ws-sign" data-ws="sign"></button>
      <div class="ws-nav" data-ws="nav"></div>
      <div class="ws-empty" data-ws="empty" hidden></div>
      <div class="ws-guide" data-ws="guide" hidden><article role="dialog" aria-modal="true" aria-labelledby="wsGuideTitle"><h2 id="wsGuideTitle">${esc(word('guideTitle'))}</h2><p>${esc(word('guideBody'))}</p><button type="button" data-ws="guide-close">${esc(word('understood'))}</button></article></div>
      <div class="ws-hint">${esc(word('hint'))}</div>
    </section>
    <nav class="ws-rooms" data-ws="rooms" aria-label="${esc(word('room'))}"></nav>
    <section class="ws-timeline">
      <div class="ws-timeline-head"><strong>${esc(word('what'))}</strong><time data-ws="clock"></time><span data-ws="event-text"></span><button type="button" data-ws="live">${esc(word('live'))}</button></div>
      <div class="ws-track" data-ws="track"></div>
      <input data-ws="rewind" type="range" min="0" max="0" value="0" step="100" aria-label="${esc(word('rewind'))}">
      <div class="ws-timeline-labels"><span data-ws="range-start"></span><span>${esc(word('timelineHint'))}</span><span data-ws="range-end"></span></div>
    </section>
  </div>
  <div class="ws-inspector">
    <aside class="ws-overview">
      <section class="ws-jobbox" data-ws="jobbox" hidden><h2>${esc(word('jobBoxTitle'))}</h2><div data-ws="jobbox-body"></div></section>
      <section class="ws-inbox" data-ws="inbox" hidden><h2>${esc(word('inboxTitle'))}</h2><div class="ws-inbox-list" data-ws="inbox-list"></div></section>
      <h2>${esc(word('teamTitle'))}</h2><p class="ws-subtle">${esc(word('teamHint'))}</p>
      <div class="ws-roster" data-ws="roster"></div>
      <section class="ws-side" data-ws="workflow-section"><h3>${esc(word('workflowHeading'))}</h3><div data-ws="workflow"></div></section>
      <section class="ws-side"><h3>${esc(word('recentActivity'))}</h3><div class="ws-feed" data-ws="feed"></div></section>
      <section class="ws-side" data-ws="quota-section" hidden><h3>${esc(word('quota'))}</h3><div data-ws="quota"></div></section>
    </aside>
    <aside class="ws-card" data-ws="card" hidden></aside>
  </div>
</div>
<div class="ws-tooltip" data-ws="tooltip" hidden></div>
<div class="sr-only" data-ws="summary" aria-live="polite" aria-atomic="true"></div>`;

// root: the screen's body; store: the app's store; toast(text): a short notice; label(s): a session's title;
// autoGuide: the guide opens by itself the first time (not on QA pages)
export function createWorkshop(root, { store, toast = () => {}, label = (s) => s.title || '', autoGuide = true, giveJob = null }) {
  root.classList.add('ws');
  root.innerHTML = TEMPLATE();
  const $ = (name) => root.querySelector(`[data-ws="${name}"]`);
  const canvas = $('canvas');
  const kinds = new KindCache(() => (dirty = true));
  const teams = new TeamCache(() => (dirty = true));
  const history = new LiveHistory();
  const r = new HqRenderer(canvas, { word, onChange: () => (dirty = true) });
  const view = r.view;
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

  let mode = 'live'; // live | demo
  let chosen = null; // the project picked in the list (null: the most urgent one)
  let demo = null;
  let current = 0; // the moment shown
  let liveNow = 0; // the newest moment
  let liveMode = true; // the rewind follows the newest moment
  let playing = false; // the example plays
  let speed = 1;
  let loop = 1;
  let scene = null;
  let data = null; // { snapshot, events, ticks, history } of the moment
  let selected = null;
  let dirty = true;
  let lastPaint = 0;
  let lastFrame = performance.now();
  let lastSummary = -Infinity;
  let frame = 0;
  let dead = false;
  const keys = { dash: '', nav: '', track: '', card: '', projects: '' };

  // ---------- data ----------
  function liveProject(now) {
    const list = store.loaded ? projectsInOrder(store, now) : [];
    const p = (chosen && store.projects.get(chosen)) || (list.find((x) => !x.p.toolsOnly) || list[0])?.p || null;
    if (chosen && store.loaded && !store.projects.get(chosen)) chosen = null;
    return { p, list };
  }
  function liveData(now) {
    const { p } = liveProject(now);
    if (!p) {
      const snapshot = { now, project: { id: '', name: '', state: 'closed', mainRoomKind: 'dev' }, sessions: [], agents: [], workflows: [], tools: [], quota: null };
      return { snapshot, events: [], ticks: [], history: [] };
    }
    const snapshot = liveSnapshot(store, p, { now, mainRoomKind: kinds.kindOf(p.id), label, job: teams.jobOf(p.id) });
    // The minutes before the app started, rebuilt from the logs once, so the rewind is not empty when it opens
    history.seed(p.id, () => pastSnapshots(store, p, { from: now - HISTORY_MS, to: now, mainRoomKind: kinds.kindOf(p.id), label }));
    return { snapshot, events: liveEvents(store, p.id, now), ticks: liveTicks(store, p.id, now), history: history.record(snapshot) };
  }
  // Every project with something open keeps its history while the app runs, so the rewind has a past when it opens
  function recordAll() {
    if (!store.loaded) return;
    const now = Date.now();
    for (const { p, state } of projectsInOrder(store, now)) {
      if (state === 'closed' && !history.byProject.has(p.id)) continue;
      history.record(liveSnapshot(store, p, { now, mainRoomKind: kinds.kindOf(p.id), label }));
    }
  }

  function build() {
    if (mode === 'demo') {
      data = demo;
      scene = sceneFrom(demo.snapshot, demo.events, demo.ticks, current, demo.history);
    } else {
      data = liveData(liveNow);
      scene = sceneFrom(data.snapshot, data.events, data.ticks, current, data.history);
    }
  }

  // ---------- the card's actions ----------
  function dispatch(action, actor = null, anchor = null) {
    const sessionId = actor?.sessionId ?? undefined;
    const agentId = actor?.kind === 'agent' ? actor.a.id : undefined;
    if (mode === 'demo') return toast(word('externalPlayback'));
    const box = anchor?.getBoundingClientRect?.();
    window.dispatchEvent(new CustomEvent('hq-action', { detail: { action, sessionId, agentId, projectId: scene.project.id, x: box ? box.left + box.width / 2 : undefined, y: box ? box.bottom : undefined } }));
  }
  function button(key, fn, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = word(key);
    if (cls) b.className = cls;
    b.addEventListener('click', (e) => fn(e.currentTarget));
    return b;
  }

  // ---------- the card ----------
  function closeCard() {
    selected = null;
    view.selected = null;
    $('card').hidden = true;
    $('layout').classList.remove('selected');
    dirty = true;
  }
  function selectActor(id) {
    selected = { kind: 'actor', id };
    view.selected = selected;
    const actor = scene.actors.find((a) => a.id === id);
    if (view.floor != null && actor) {
      view.floor = actor.room.floor;
      if (view.room) view.room = actor.room.id;
    }
    view.focus = id;
    renderCard();
    dirty = true;
  }
  function select(kind, id) {
    selected = { kind, id };
    view.selected = selected;
    renderCard();
    dirty = true;
  }
  function renderCard() {
    if (!selected || !scene) return;
    const card = $('card');
    const scroll = card.scrollTop;
    card.hidden = false;
    card.classList.toggle('room-card', selected.kind !== 'actor');
    $('layout').classList.add('selected');
    card.replaceChildren(button('close', closeCard, 'close'));
    const html = (s) => card.insertAdjacentHTML('beforeend', s);
    if (selected.kind === 'lift') {
      html(`<h2>${esc(word('lift'))}</h2><p>${esc(word('chooseFloor'))}</p>`);
      FLOORS.forEach((f, i) => {
        const b = button('fit', () => {
          view.room = null;
          view.floor = i;
          dirty = true;
          closeCard();
        });
        b.textContent = word('floorLabel', { n: FLOORS.length - i });
        card.append(b);
      });
    } else if (selected.kind === 'fixture') {
      const fx = scene.fixtures.find((f) => f.id === selected.id);
      if (fx) {
        html(`<h2>${esc(word(`${fx.activity}Fixture`))}</h2><span class="ws-chip">${esc(word(fx.room.kind))}</span><p>${esc(word('emptyStation'))}</p>`);
        const b = button('room', () => select('room', fx.room.id));
        b.textContent = word(fx.room.kind);
        card.append(b);
      }
    } else if (selected.kind === 'room') {
      const room = ROOMS.find((x) => x.id === selected.id);
      const main = scene.project.mainRoomKind;
      const inKind = scene.allActors.filter((a) => roomKindFor(a, main) === room.kind || (room.kind === 'dev' && roomKindFor(a, main) === 'gamedev'));
      html(`<h2>${esc(word(room.kind))}</h2><p class="ws-room-text">${esc(word(`${room.kind}Purpose`))}</p><span class="ws-chip">${esc(word('floorLabel', { n: FLOORS.length - room.floor }))}</span><h3>${esc(word('rooms'))}</h3>`);
      const seated = scene.actors.filter((a) => a.room.id === room.id);
      const hidden = inKind.filter((a) => !scene.actors.some((x) => x.id === a.id));
      for (const a of [...seated, ...hidden]) {
        const b = button('go', () => selectActor(a.id), 'ws-occupant');
        b.innerHTML = `${esc(titleOf(a))}<small>${esc([a.model, word(a.state)].filter(Boolean).join(' · '))}</small>`;
        card.append(b);
      }
      if (!seated.length && !hidden.length) card.append(document.createTextNode(word('none')));
    } else {
      const a = scene.allActors.find((x) => x.id === selected.id);
      if (!a) {
        html(`<h2>${esc(word('done'))}</h2>`);
      } else {
        // The lead's plan waiting for approval, or the job's result: first, with the way to answer
        if (scene.planPending === a.id) {
          html(`<section class="ws-plan"><h3>${esc(word('planTitle'))}</h3><pre class="ws-plan-text">${esc(a.data.plan?.text || '')}</pre><p class="ws-note">${esc(word('planHint'))}</p></section>`);
          const row = document.createElement('div');
          row.className = 'ws-actions';
          row.append(button('planApprove', (el) => dispatch('open-ai-terminal', a, el)));
          card.append(row);
        } else if (scene.resultReady === a.id) {
          const r = scene.job?.review;
          html(`<section class="ws-result"><h3>${esc(word('resultTitle'))}</h3><p>${esc(jobNowText(scene.job))}</p>${r?.verdict ? `<p class="ws-note">${esc(word('resultReview', { verdict: r.verdict }))}</p>` : ''}<p class="ws-note">${esc(word('resultHint'))}</p></section>`);
          const row = document.createElement('div');
          row.className = 'ws-actions';
          // Open / run it first among the ways to look (docs/run-hint.md): the person sees the result before saying yes
          row.append(button('resultAnswer', (el) => dispatch('open-ai-terminal', a, el)), button('resultRun', () => dispatch('open-run', a)), button('resultChanges', () => dispatch('open-changes', a)), button('resultUndo', () => dispatch('open-restore', a)));
          card.append(row);
        }
        const parent = scene.allActors.find((x) => x.id === a.parentId);
        const children = scene.allActors.filter((x) => x.parentId === a.id);
        const d = a.data;
        const end = d.status === 'done' ? d.lastAt : current;
        const start = d.startedAt ?? d.since ?? current;
        html(
          `<h2>${esc(titleOf(a))}</h2><span class="ws-chip">${esc(word(a.kind))}</span>${a.model ? `<span class="ws-chip">${esc(a.model)}</span>` : ''}${a.kind === 'session' ? permModeChip(a.data?.permissionMode, 'ws-chip perm-chip') : ''}` +
            `<p>${esc(d.lastAction?.text || word(a.state))}</p><h3>${esc(word('task'))}</h3><p>${esc(d.description || (a.kind === 'session' ? word('chiefTask') : word('unknown')))}</p>` +
            `<h3>${esc(word('parent'))}</h3><p>${esc(parent ? titleOf(parent) : a.kind === 'agent' ? word('unknown') : word('none'))}</p><h3>${esc(word('children'))}</h3>`,
        );
        for (const child of children) {
          const b = button('go', () => selectActor(child.id));
          b.textContent = titleOf(child);
          card.append(b);
        }
        if (!children.length) card.append(document.createTextNode(word('none')));
        html(`<h3>${esc(word('counts'))}</h3>`);
        const counts = countByCategory(d.toolCounts);
        const max = Math.max(1, ...Object.values(counts));
        for (const cat of TOOL_CATS) if (counts[cat]) html(`<div class="ws-bar"><span>${esc(word(cat))}</span><i style="width:${(counts[cat] / max) * 100}%"></i><span>${counts[cat]}</span></div>`);
        if (!Object.keys(counts).length) card.append(document.createTextNode(word('none')));
        html(`<p>${esc(word('duration'))}: ${Math.max(0, Math.floor((end - start) / 1000))} ${esc(word('seconds'))}<br>${esc(word('tokens'))}: ${esc(d.tokensOut ?? word('unknown'))}</p>`);
        const actions = document.createElement('div');
        actions.className = 'ws-actions';
        if (a.sessionId) {
          actions.append(
            button('go', () => dispatch('open-session', a)),
            button('terminal', (el) => dispatch('open-terminal', a, el)),
          );
        }
        actions.append(button('project', () => dispatch('open-project', a)));
        if (a.sessionId) {
          actions.append(
            button(view.highlight === a.sessionId ? 'clear' : 'highlight', () => {
              view.highlight = view.highlight === a.sessionId ? null : a.sessionId;
              dirty = true;
              renderCard();
            }),
          );
        }
        card.append(actions);
      }
    }
    requestAnimationFrame(() => (card.scrollTop = scroll));
  }

  // ---------- the canvas: pointer and keyboard ----------
  const tip = $('tooltip');
  canvas.addEventListener('pointermove', (e) => {
    if (!scene) return;
    const target = r.hitTarget(scene, r.pointerWorld(e.clientX, e.clientY));
    const hover = target ? (target.kind === 'room' ? `room:${target.id}` : target.id) : null;
    if (view.hover !== hover) {
      view.hover = hover;
      dirty = true;
    }
    canvas.style.cursor = target ? 'pointer' : 'default';
    if (!target) {
      tip.hidden = true;
      return;
    }
    let text = '';
    if (target.kind === 'actor') {
      const a = target.data;
      const d = a.data;
      const since = Math.max(0, Math.floor((current - (d.lastAction?.t ?? d.startedAt ?? d.since ?? current)) / 1000));
      text = `${titleOf(a)}${a.model ? ` · ${a.model}` : ''}\n${d.lastAction?.text || word(a.state)}\n${word('since', { seconds: since })}`;
    } else if (target.kind === 'fixture') {
      const f = target.data;
      text = `${word(`${f.activity}Fixture`)}\n${word(f.room.kind)}\n${f.actorId ? titleOf(scene.actors.find((a) => a.id === f.actorId)) : word('emptyStation')}`;
    } else if (target.kind === 'room') text = word('stationSummary', { name: word(target.data.kind), count: scene.actors.filter((a) => a.room.id === target.id).length });
    else if (target.kind === 'door') text = word(view.manualDoors.has(target.id) ? 'closeDoor' : 'openDoor');
    else text = word('chooseFloor');
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(e.clientX + 12, innerWidth - 325))}px`;
    tip.style.top = `${Math.min(e.clientY + 12, innerHeight - 110)}px`;
  });
  canvas.addEventListener('pointerleave', () => {
    tip.hidden = true;
    view.hover = null;
    dirty = true;
  });
  function toggleDoor(id) {
    if (view.manualDoors.has(id)) view.manualDoors.delete(id);
    else view.manualDoors.add(id);
    toast(word(view.manualDoors.has(id) ? 'openDoor' : 'closeDoor'));
    dirty = true;
  }
  canvas.addEventListener('click', (e) => {
    if (!scene) return;
    const target = r.hitTarget(scene, r.pointerWorld(e.clientX, e.clientY));
    if (!target) return;
    if (target.kind === 'actor') return selectActor(target.id);
    if (target.kind === 'door') return toggleDoor(target.id);
    if (target.kind === 'fixture' && target.data.actorId) return selectActor(target.data.actorId);
    select(target.kind, target.id);
  });
  canvas.addEventListener('dblclick', (e) => {
    const floor = r.floorAt(r.pointerWorld(e.clientX, e.clientY));
    if (floor < 0) return;
    view.room = null;
    view.floor = floor;
    dirty = true;
  });
  // The keyboard walks hidden buttons laid over the drawing: actors, rooms, furniture, doors and the lift
  function navigateActor(id, e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      selectActor(id);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const a = scene.actors.find((x) => x.id === id);
      const list = scene.actors.filter((x) => x.room.floor === a?.room.floor).sort((x, y) => x.destination.x - y.destination.x);
      const i = list.findIndex((x) => x.id === id);
      const next = list[(i + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) + list.length) % list.length];
      if (next) $('nav').querySelector(`[data-actor="${CSS.escape(next.id)}"]`)?.focus();
    }
  }
  function renderNavigation() {
    const sig = scene.actors.map((a) => `${a.id}:${a.state}`).join('|');
    if (sig === keys.nav) return;
    keys.nav = sig;
    const nav = $('nav');
    const active = document.activeElement;
    const focusKey = ['actor', 'room', 'fixture', 'door', 'lift'].find((k) => nav.contains(active) && active?.dataset?.[k]);
    const focusId = focusKey ? active.dataset[focusKey] : null;
    nav.replaceChildren();
    const physical = (b, id, floor) => {
      b.addEventListener('focus', () => {
        view.hover = id;
        if (view.floor != null && floor != null) view.floor = floor;
        dirty = true;
      });
      b.addEventListener('blur', () => {
        view.hover = null;
        dirty = true;
      });
    };
    const add = (data, text, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      Object.assign(b.dataset, data);
      b.textContent = text;
      b.addEventListener('click', onClick);
      nav.append(b);
      return b;
    };
    for (const a of scene.actors) {
      const b = add({ actor: a.id }, word('label', { title: titleOf(a), state: word(a.state) }), () => selectActor(a.id));
      b.addEventListener('focus', () => {
        view.focus = a.id;
        if (view.floor != null) view.floor = a.room.floor;
        if (view.room) view.room = a.room.id;
        dirty = true;
      });
      b.addEventListener('blur', () => {
        view.focus = null;
        dirty = true;
      });
      b.addEventListener('keydown', (e) => navigateActor(a.id, e));
    }
    for (const room of ROOMS) physical(add({ room: room.id }, word(room.kind), () => select('room', room.id)), `room:${room.id}`, room.floor);
    for (const fx of scene.fixtures) {
      physical(
        add({ fixture: fx.id }, `${word(fx.room.kind)} · ${word(`${fx.activity}Fixture`)} ${fx.seat + 1}`, () => (fx.actorId ? selectActor(fx.actorId) : select('fixture', fx.id))),
        fx.id,
        fx.room.floor,
      );
    }
    for (const door of scene.doors) physical(add({ door: door.id }, `${word('door')} · ${word('floorLabel', { n: FLOORS.length - door.floor })}`, () => toggleDoor(door.id)), door.id, door.floor);
    physical(add({ lift: 'lift' }, word('lift'), () => select('lift', 'lift')), 'lift', null);
    if (focusId) nav.querySelector(`[data-${focusKey}="${CSS.escape(focusId)}"]`)?.focus();
  }

  // ---------- the guide ----------
  function showGuide() {
    $('guide').hidden = false;
    $('guide-close').focus();
  }
  function closeGuide() {
    $('guide').hidden = true;
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      /* not kept: it opens again next time */
    }
    $('help').focus();
  }
  $('guide').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      $('guide-close').focus();
    }
  });
  $('help').addEventListener('click', showGuide);
  $('guide-close').addEventListener('click', closeGuide);

  // ---------- the toolbar and the rewind ----------
  // The sign: a plan or a result opens its lead's card; someone waiting opens the session; else the project
  $('sign').addEventListener('click', (e) => {
    const lead = scene?.planPending || scene?.resultReady;
    if (lead) return selectActor(lead);
    const a = scene?.waiting[0];
    dispatch(a ? 'open-session' : 'open-project', a, e.currentTarget);
  });
  function startDemo() {
    if (!demo) demo = createDemo(word);
    mode = 'demo';
    current = liveNow = 47000;
    liveMode = true;
    loop = 1;
    closeCard();
    view.highlight = view.eventActor = view.focus = null;
    keys.dash = keys.track = '';
  }
  function backToLive() {
    mode = 'live';
    playing = false;
    liveNow = current = Date.now();
    liveMode = true;
    closeCard();
    view.highlight = view.eventActor = view.focus = null;
    keys.dash = keys.track = '';
    dirty = true;
  }
  $('play').addEventListener('click', () => {
    if (mode !== 'demo') startDemo();
    playing = !playing;
    if (playing) {
      liveNow = current;
      liveMode = true;
    }
    dirty = true;
    renderToolbar();
  });
  $('speed').addEventListener('change', (e) => (speed = Number(e.target.value) || 1));
  $('room').addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    if (mode === 'demo') {
      playing = false;
      current = PREVIEWS[key];
      liveMode = false;
    }
    const room = ROOMS.find((x) => x.kind === key);
    view.room = room.id;
    view.floor = room.floor;
    view.focus = view.eventActor = null;
    select('room', room.id);
    keys.dash = keys.track = '';
  });
  $('step').addEventListener('click', () => {
    playing = false;
    const events = (data?.events || []).filter((e) => eventLabel(e));
    const next = events.find((e) => e.t > current)?.t ?? Math.min(liveNow, current + 1000);
    current = next;
    if (mode === 'demo') liveNow = Math.max(liveNow, next);
    liveMode = current >= liveNow;
    dirty = true;
    renderToolbar();
  });
  $('fit').addEventListener('click', () => {
    view.room = null;
    view.floor = null;
    $('room').value = '';
    closeCard();
  });
  $('rewind').addEventListener('input', (e) => {
    current = Number(e.target.value);
    liveMode = false;
    playing = false;
    dirty = true;
    keys.track = '';
  });
  $('live').addEventListener('click', () => {
    if (mode === 'demo' && !playing && current >= liveNow) return backToLive();
    liveMode = true;
    current = liveNow;
    view.eventActor = null;
    dirty = true;
    keys.track = '';
  });
  $('project').addEventListener('change', (e) => {
    chosen = e.target.value || null;
    if (mode === 'demo') backToLive();
    closeCard();
    view.room = view.floor = view.highlight = null;
    keys.dash = keys.track = keys.nav = '';
    dirty = true;
  });

  // ---------- giving a job (docs/simplify.md) ----------
  // The box at the top of the screen, beside the project it goes to (above the fold on a laptop, 2026-10-02); its
  // card rides the lift up to the main room
  $('give').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('give-text');
    const text = input.value.trim();
    if (mode === 'demo') return toast(word('externalPlayback'));
    if (!text) {
      input.focus();
      return toast(word('giveEmpty'));
    }
    const id = scene?.project.id;
    if (!id || !giveJob) return toast(word('giveNoProject'));
    const go = $('give-go');
    go.disabled = true;
    // The job card rides up only when the job can go (a folder with no project files opens its drawer instead)
    if (!store.projects.get(id)?.toolsOnly) view.jobCard = { at: Date.now() };
    dirty = true;
    try {
      const r = await giveJob(id, text);
      if (r?.ok && r.mode === 'live') input.value = '';
    } finally {
      go.disabled = false;
    }
  });

  // ---------- the panels ----------
  function renderProjects() {
    const sel = $('project');
    if (mode === 'demo') {
      const k = 'demo' + language();
      if (keys.projects !== k) {
        keys.projects = k;
        sel.innerHTML = `<option value="">${esc(word('projectDemo'))}</option>`;
        sel.disabled = true;
      }
      return;
    }
    const { p, list } = liveProject(liveNow);
    const k = JSON.stringify([chosen, p?.id, list.map((x) => [x.p.id, x.p.name, x.state])]);
    if (keys.projects === k) return;
    keys.projects = k;
    sel.disabled = !list.length;
    const auto = list[0]?.p;
    // Two folders with one name say where they are (a project moved to another drive)
    const names = projectNames(list.map((x) => x.p));
    sel.innerHTML = list.length
      ? `<option value="">${esc(word('auto', { name: (auto && names.get(auto.id)) || '—' }))}</option>` + list.map((x) => `<option value="${esc(x.p.id)}"${x.p.id === chosen ? ' selected' : ''}>${esc(names.get(x.p.id))} · ${esc(t(`attnState_${x.state}`))}</option>`).join('')
      : `<option value="">${esc(word('noProject'))}</option>`;
  }
  function renderToolbar() {
    $('play').textContent = word(playing ? 'pause' : 'play');
    $('play').setAttribute('aria-pressed', String(playing));
    $('label').textContent = mode === 'demo' ? word('demo', { n: loop }) : '';
  }
  function renderDashboard() {
    const snap = scene.snapshot;
    const active = (snap.agents || []).filter((a) => a.status === 'running').length;
    const done = new Set(scene.events.filter((e) => e.kind === 'agent_done').map((e) => e.actor)).size;
    $('active').textContent = active;
    $('waiting').textContent = scene.waiting.length;
    $('completed').textContent = done;
    // Three zeros say nothing: the numbers show once something happens in the shown project (the example always)
    $('stats').hidden = mode !== 'demo' && !active && !scene.waiting.length && !done;
    $('range-start').textContent = formatTime(Math.max(mode === 'demo' ? 0 : liveNow - HISTORY_MS, liveNow - HISTORY_MS));
    $('range-end').textContent = formatTime(liveNow);
    const shownEvents = scene.events.filter((e) => eventLabel(e));
    const sig = JSON.stringify([scene.allActors.map((a) => [a.id, a.state, a.model, a.goneAt, a.data.lastAction?.text]), scene.workflows, scene.quota, shownEvents.slice(-4).map((e) => e.id ?? e.t), view.floor, view.room, mode, scene.job, scene.project.id && stoppedLead(scene.project.id)?.id, errKey()]);
    // The inbox is over every project, so it is asked on every draw (its own signature keeps it cheap); before, a
    // session of another project waiting showed only once something changed in the shown one (2026-10-02). At most
    // once a second while the scene moves (12 frames a second over many projects), at once when the mode changes
    const inboxNow = Date.now();
    if (inboxNow - inboxAt >= 1000 || inboxMode !== mode) {
      inboxAt = inboxNow;
      inboxMode = mode;
      renderInbox();
    }
    if (sig === keys.dash) return;
    keys.dash = sig;
    renderJobBox();
    const main = scene.project.mainRoomKind;
    const roster = $('roster');
    roster.replaceChildren();
    for (const a of scene.allActors.filter((x) => x.goneAt == null)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.roster = a.id;
      b.innerHTML = `<span class="ws-avatar${a.kind === 'agent' ? ' robot' : ''}">${esc(word(`${a.kind}Symbol`))}</span><span class="ws-identity"><b>${esc(titleOf(a))}</b><small>${esc([a.model, word(roomKindFor(a, main))].filter(Boolean).join(' · '))}</small></span><i class="ws-dot ${esc(a.state)}"></i>`;
      b.addEventListener('click', () => selectActor(a.id));
      roster.append(b);
    }
    if (!roster.children.length) roster.textContent = word('empty');
    const tabs = $('rooms');
    tabs.replaceChildren();
    for (const room of ROOMS) {
      const b = document.createElement('button');
      b.type = 'button';
      const n = scene.allActors.filter((a) => a.goneAt == null && (roomKindFor(a, main) === room.kind || (room.kind === 'dev' && roomKindFor(a, main) === 'gamedev'))).length;
      b.innerHTML = `${esc(word(room.kind))}<span>${n}</span>`;
      b.setAttribute('aria-pressed', String(view.room ? view.room === room.id : view.floor === room.floor));
      b.addEventListener('click', () => {
        view.room = room.id;
        view.floor = room.floor;
        select('room', room.id);
      });
      tabs.append(b);
    }
    $('workflow-section').hidden = !scene.workflows.length;
    $('workflow').innerHTML = scene.workflows.map((w) => `<div class="ws-wf-name">${esc(w.name || word('workflowHeading'))}</div>${w.phases.length ? `<div class="ws-wf-phases">${esc(w.phases.join(' → '))}</div>` : ''}<div class="ws-wf-count">${esc(word('progress', w))}</div>`).join('');
    const feed = $('feed');
    feed.replaceChildren();
    for (const e of shownEvents.slice(-4).reverse()) {
      const b = document.createElement('button');
      b.type = 'button';
      // Live events carry the server's English words (and the person's own message): the line says what happened in
      // the page's language, with the task or the message after it
      const what = word(eventLabel(e).key);
      const own = (e.kind === 'agent_start' || e.kind === 'prompt') && e.text;
      const line = mode === 'demo' ? e.text || what : own ? `${what}: ${e.text}` : what;
      b.innerHTML = `<time>${esc(formatTime(e.t))}</time><span>${esc(line)}</span>`;
      b.addEventListener('click', () => {
        current = e.t;
        playing = false;
        liveMode = false;
        view.eventActor = e.actor;
        dirty = true;
        keys.track = '';
      });
      feed.append(b);
    }
    if (!feed.children.length) feed.textContent = word('noActivity');
    const q = scene.quota;
    $('quota-section').hidden = !q;
    if (q) {
      const top = Math.max(q.fiveHourPct, q.weeklyPct);
      $('quota').innerHTML =
        [q.fiveHourPct, q.weeklyPct].map((v, i) => `<div class="ws-quota ${v >= 95 ? 'danger' : v >= 80 ? 'warn' : ''}"><span>${esc(word(i ? 'week' : 'five'))}</span><progress max="100" value="${clamp(v, 0, 100)}" aria-label="${esc(word(i ? 'week' : 'five'))}"></progress><span>${Math.round(v)}%</span></div>`).join('') +
        (top >= 80 ? `<p class="ws-quota-note">${esc(word(top >= 95 ? 'noNew' : 'single'))}</p>` : '');
    }
  }
  // Waiting for you, over every project (docs/simplify.md): a plan to approve, a result, or a question; a click shows
  // that project's building with its lead's card
  // The job of the shown project in words (docs/simplify.md): the lamps of the sign named, the plan's title, where it
  // stands. Hidden when the project has no team job.
  // Examples under the job box (Bolt and v0 offer them under their input): each fills the box with a sentence that
  // reaches a kit skill (test/kit.test.mjs IDEAS); a project with no job yet also gets its own idea. Nothing starts.
  function renderExamples() {
    const el = $('give-ex');
    const p = mode === 'live' && scene.project.id ? store.projects.get(scene.project.id) : null;
    const idea = !scene.job && p ? String(p.idea || '').trim() : '';
    const keys = mode === 'live' && p ? [...(idea ? ['idea'] : []), ...GIVE_EXAMPLES] : [];
    const k = JSON.stringify([keys, idea, language()]);
    if (el._k === k) return;
    el._k = k;
    el.hidden = !keys.length;
    el.innerHTML = keys.map((x) => `<button type="button" class="ws-ex" data-ex="${x}">${esc(word(`ex_${x}`))}</button>`).join('');
    el._idea = idea;
  }
  $('give-ex').addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-ex]');
    if (!b) return;
    const input = $('give-text');
    const x = b.dataset.ex;
    input.value = x === 'idea' ? $('give-ex')._idea || '' : GIVE_EXAMPLES.includes(x) ? word(`exText_${x}`) : '';
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  });

  // What the job box's error card depends on: the error and whether its limit opened again (redrawn when it changes)
  function errKey() {
    const e = mode === 'live' && store.loaded && scene.project.id ? projectApiError(store.sessions.values(), scene.project.id)?.e : null;
    return e ? [e.kind, e.t, Number.isFinite(e.resetsAt) && Date.now() >= e.resetsAt] : null;
  }
  function renderJobBox() {
    renderExamples();
    const box = $('jobbox');
    const job = scene.job;
    // The AI stopped on an error (a limit, sign-in, the connection: apiError.js): said first, even without a team job
    const err = mode === 'live' && store.loaded ? projectApiError(store.sessions.values(), scene.project.id)?.e : null;
    box.hidden = !job && !err;
    if (!job && !err) return;
    const body = $('jobbox-body');
    body.innerHTML = `${apiErrorHtml(err)}${job?.title ? `<p class="ws-job-title">${esc(job.title)}</p>` : ''}${job ? stepsHtml(job) : ''}`;
    if (!job) return;
    // A finished job: the result is one click away (the drawer's "How to run it")
    if (job.step === 'done') body.append(button('resultRun', () => dispatch('open-run')));
    // The job is not finished and no AI of the project runs any more (its terminal was closed, seen 2026-10-01): the
    // last session goes on where it stopped, in the terminal below, when the person asks
    const last = mode === 'live' && job.step !== 'done' ? stoppedLead(scene.project.id) : null;
    if (!last) return;
    const note = document.createElement('p');
    note.className = 'ws-note';
    // The sentence that says what is being worked on is not true any more: where it stopped instead
    body.querySelector('.job-now')?.remove();
    note.textContent = job.tasks?.total ? `${word('jobStopped')} ${word('jobStoppedAt', { done: job.tasks.done || 0, total: job.tasks.total })}` : word('jobStopped');
    body.append(note, button('jobResume', (el) => dispatch('resume-session', { sessionId: last.id }, el)));
  }

  // The project's last session when none of its sessions runs (job.js, shared with the drawer)
  const stoppedLead = (projectId) => stoppedSession(store.sessions.values(), projectId, Date.now(), scene?.job?.updatedAt);

  let inboxAt = 0;
  let inboxMode = null;
  function renderInbox() {
    const box = $('inbox');
    if (mode === 'demo' || !store.loaded) {
      box.hidden = true;
      return;
    }
    const now = Date.now();
    const items = [];
    for (const { p } of projectsInOrder(store, now)) {
      for (const s of store.sessions.values()) {
        if (s.projectId !== p.id || sessionState(s, now) !== 'waiting') continue;
        const plan = s.lastAction?.tool === 'ExitPlanMode' && !!s.plan?.text;
        const result = !plan && p.id === scene.project.id && !!scene.resultReady;
        items.push({ p, s, kind: plan ? 'plan' : result ? 'result' : 'wait' });
      }
      // A session stopped on an error (a limit, sign-in, the connection: apiError.js) waits for the person too
      const err = projectApiError(store.sessions.values(), p.id, now);
      if (err && !items.some((x) => x.s.id === err.s.id)) items.push({ p, s: err.s, kind: 'error', text: apiErrorWords(err.e, now)?.title || '' });
    }
    const sig = JSON.stringify(items.map((x) => [x.p.id, x.s.id, x.kind, x.text || '']));
    if (box._sig === sig) return;
    box._sig = sig;
    box.hidden = false;
    const list = $('inbox-list');
    list.replaceChildren();
    const names = projectNames(projectsInOrder(store, now).map((x) => x.p));
    for (const x of items.slice(0, 8)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ws-inbox-item ${x.kind}`;
      b.innerHTML = `<b>${esc(names.get(x.p.id) || x.p.name)}</b><span>${esc(x.kind === 'error' ? x.text : word(`inbox_${x.kind}`))}</span>`;
      b.addEventListener('click', () => {
        if (mode === 'demo') backToLive();
        chosen = x.p.id;
        keys.projects = keys.dash = keys.nav = '';
        build();
        const lead = `s:${x.s.id}`;
        if (scene.actors.some((a) => a.id === lead)) selectActor(lead);
        dirty = true;
      });
      list.append(b);
    }
    if (!items.length) list.textContent = word('inboxNone');
  }

  function renderTrack() {
    const from = liveNow - HISTORY_MS;
    const events = (data?.events || []).filter((e) => e.t <= liveNow && e.t >= from && eventLabel(e));
    const sig = events.map((e) => `${e.t}${e.kind}${e.actor}`).join('|') + Math.floor(liveNow / 1000) + mode;
    if (sig === keys.track) return;
    keys.track = sig;
    const track = $('track');
    track.replaceChildren();
    const span = mode === 'demo' ? Math.max(1, Math.min(liveNow, HISTORY_MS)) : HISTORY_MS;
    const start = mode === 'demo' ? Math.max(0, from) : from;
    for (const e of events) {
      const b = document.createElement('button');
      b.type = 'button';
      const lab = eventLabel(e);
      b.className = `ws-event ${lab.dot}`;
      b.style.left = `${clamp(((e.t - start) / span) * 100, 0, 100)}%`;
      b.title = `${formatTime(e.t)} · ${e.text && e.kind === 'agent_start' ? `${word(lab.key)}: ${e.text}` : word(lab.key)}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        playing = false;
        liveMode = false;
        current = e.t;
        view.eventActor = e.actor;
        view.focus = e.actor;
        $('event-text').textContent = word(lab.key);
        dirty = true;
      });
      track.append(b);
    }
  }
  function renderUi() {
    const stage = $('stage');
    stage.classList.toggle('zoomed', view.floor != null);
    stage.classList.toggle('room-zoom', !!view.room);
    renderProjects();
    renderToolbar();
    renderDashboard();
    $('clock').textContent = `${formatTime(current)} · ${word(liveMode ? 'live' : 'past')}`;
    $('live').setAttribute('aria-pressed', String(liveMode));
    $('live').textContent = word(mode === 'demo' && !playing && liveMode ? 'back' : 'live');
    const sign = $('sign');
    sign.textContent = word(scene.planPending ? 'signPlan' : scene.resultReady ? 'signResult' : scene.waiting.length ? 'waiting' : scene.closed ? 'closed' : scene.actors.some((a) => a.state === 'busy') ? 'working' : 'resting');
    sign.classList.toggle('waiting', scene.waiting.length > 0 && !scene.resultReady);
    sign.title = scene.job ? `${word('lamps')}: ${jobNowText(scene.job)}` : '';
    const empty = $('empty');
    empty.hidden = !scene.closed;
    empty.textContent = scene.project.id || mode === 'demo' ? word('empty') : word('noProject');
    const rw = $('rewind');
    rw.min = mode === 'demo' ? Math.max(0, liveNow - HISTORY_MS) : liveNow - HISTORY_MS;
    rw.max = liveNow;
    rw.value = current;
    renderTrack();
    renderNavigation();
    const cardKey = JSON.stringify(selected) + Math.floor(current / 1000);
    if (selected && cardKey !== keys.card && !$('card').contains(document.activeElement)) {
      keys.card = cardKey;
      renderCard();
    }
    if (performance.now() - lastSummary >= 5000) {
      lastSummary = performance.now();
      $('summary').textContent = word('summary', { agents: (scene.snapshot.agents || []).filter((a) => a.status === 'running').length, waiting: scene.waiting.length });
    }
  }

  // ---------- the loop ----------
  const visible = () => !dead && !document.hidden && root.offsetParent !== null;
  function animate(time) {
    if (dead) return;
    frame = requestAnimationFrame(animate);
    const delta = Math.min(1000, time - lastFrame);
    lastFrame = time;
    if (!visible()) return;
    if (r.resize()) dirty = true;
    if (mode === 'demo') {
      if (playing && liveMode) {
        liveNow += delta * speed;
        if (liveNow >= DEMO_MS) {
          liveNow %= DEMO_MS;
          loop++;
          lastSummary = -Infinity;
          view.eventActor = view.focus = null;
          closeCard();
        }
        current = liveNow;
      }
    } else {
      liveNow = Date.now();
      if (liveMode) current = liveNow;
    }
    view.still = reducedQuery.matches || (mode === 'demo' && !playing);
    if (view.jobCard) dirty = true; // a job card on its way draws every frame
    const interval = frameInterval({ reduced: reducedQuery.matches, moving: !!scene?.moving && !(mode === 'demo' && !playing) });
    if ((dirty && time - lastPaint >= 1000 / 12) || time - lastPaint >= interval) {
      build();
      r.draw(scene, current);
      renderUi();
      lastPaint = time;
      dirty = false;
    }
  }
  const onMotion = () => (dirty = true);
  reducedQuery.addEventListener('change', onMotion);
  liveNow = current = Date.now();
  frame = requestAnimationFrame(animate);

  let recordAt = 0;
  const api = {
    // A store change: the history of every open project grows (at most once a second), the building draws again
    update() {
      const now = Date.now();
      if (now - recordAt >= 1000) {
        recordAt = now;
        recordAll();
      }
      dirty = true;
    },
    // The screen was opened: the guide the first time, and one frame at once
    shown() {
      dirty = true;
      lastPaint = 0;
      try {
        if (autoGuide && localStorage.getItem(GUIDE_KEY) !== '1') showGuide();
      } catch {
        /* storage blocked: no guide */
      }
    },
    // Show a project (and choose one of its actors): Today's building opens the workshop this way
    showProject(projectId, actorId = null) {
      if (mode === 'demo') backToLive();
      chosen = projectId || null;
      keys.projects = keys.dash = keys.nav = keys.track = '';
      view.room = view.floor = view.highlight = null;
      closeCard();
      // The screen may have been hidden: the clock moves to now before the scene is built
      liveNow = Date.now();
      liveMode = true;
      current = liveNow;
      build();
      if (actorId && scene.actors.some((a) => a.id === actorId)) selectActor(actorId);
      dirty = true;
    },
    // Esc on this screen: the guide, the card, then out of a room or floor; false when there was nothing to close
    escape() {
      if (!$('guide').hidden) {
        closeGuide();
        return true;
      }
      if (selected) {
        closeCard();
        return true;
      }
      if (view.room || view.floor != null || view.highlight || view.eventActor) {
        view.room = view.floor = view.highlight = view.eventActor = null;
        $('room').value = '';
        dirty = true;
        return true;
      }
      return false;
    },
    // The full tour explains the Building itself: its own first-time note is closed and counted as seen
    quietGuide() {
      if (!$('guide').hidden) closeGuide();
      else {
        try {
          localStorage.setItem(GUIDE_KEY, '1');
        } catch {
          /* storage blocked */
        }
      }
    },
    // The full tour (tour.js): the example held still at a moment, the lead's card open when asked; live() goes back.
    // Nothing reaches the server: the example is the page's own data (createDemo).
    example(at, { lead = false } = {}) {
      if (mode !== 'demo') startDemo();
      playing = false;
      current = liveNow = clamp(at, 0, DEMO_MS - 1);
      liveMode = true;
      closeCard();
      // Drawn now, not at the next frame: the tour's step must show its moment at once (and a page in the background
      // gets no frames)
      r.resize();
      view.still = true;
      build();
      r.draw(scene, current);
      renderUi();
      if (lead) selectActor('s:chief');
      dirty = true;
    },
    live() {
      if (mode !== 'demo') return;
      backToLive();
      r.resize();
      view.still = reducedQuery.matches;
      build();
      r.draw(scene, current);
      renderUi();
    },
    // QA (headless pages get no frames): draw now; at: a moment of the example
    simulate({ demoAt } = {}) {
      if (demoAt != null) {
        startDemo();
        current = liveNow = clamp(demoAt, 0, DEMO_MS - 1);
      }
      r.resize();
      view.still = reducedQuery.matches || mode === 'demo';
      build();
      r.draw(scene, current);
      renderUi();
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(frame);
      reducedQuery.removeEventListener('change', onMotion);
      offStore();
      r.destroy();
    },
  };
  const offStore = store.on(() => api.update());
  return api;
}
