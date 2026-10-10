// @ts-check
// Stage: a live simulation in the orchestra metaphor (Canvas 2D).
// The conductor's podium at the bottom; projects are sections on two arcs; baton lines go to live sessions;
// sub-agents are musicians seated around their project; every tool call is a colored note.
// In live mode it runs in real time, in replay mode the chosen range is replayed sped up.
import { store } from './store.js';
import { t as tx, language } from './i18n.js';
import { isOtherFolder } from './attention.js';
import { CAT, projectColor, agentColor, hexA, initials, clock, esc, modelName, ago, dur, num, tok, STATUS, actionPlain, actionLine } from './format.js';

const TAU = Math.PI * 2;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FONT = '"Segoe UI Variable Text", "Segoe UI", "Ubuntu Sans", Ubuntu, Cantarell, "Noto Sans", system-ui, sans-serif';
const GLYPH = { write: '♪', shell: '♫', agent: '♬', skill: '✦', workflow: '◆', web: '◦', read: '•', mcp: '•', other: '•' };
const dayName = (i) => tx('stgDays').split(',')[i];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (x) => 1 - Math.pow(1 - x, 3);

export class Stage {
  constructor(canvas, { onSelect, tooltip, clockEl, emptyEl, replayBar }) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.tooltip = tooltip;
    this.clockEl = clockEl;
    this.emptyEl = emptyEl;
    this.replayBar = replayBar;
    this.nodes = new Map();
    this.agentNodes = new Map();
    this.particles = [];
    this.effects = [];
    this.labels = [];
    this.bubbles = [];
    this.pulses = [];
    this.order = [];
    this.orderAt = 0;
    this.orderKey = '';
    this.mode = 'live';
    this.replay = null;
    this.hover = null;
    this.mouse = null;
    this.time = 0;
    this.dust = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), v: 0.003 + Math.random() * 0.008, r: Math.random() * 1.2 + 0.3, a: Math.random() * 0.3 + 0.05 }));
    this.W = 0;
    this.H = 0;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('mouseleave', () => {
      this.mouse = null;
      this.setHover(null);
    });
    canvas.addEventListener('click', () => {
      if (this.hover) this.onSelect?.(this.hover);
    });
    this.last = performance.now();
    this.frameId = requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const wrap = this.cv.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.orderKey = '';
  }

  // ---------------- incoming events ----------------
  // When the page opens, play the notes of the last seconds at short intervals (so the stage does not start empty)
  warmStart() {
    const since = Date.now() - 90000;
    const recent = store.ticks.filter((t) => t[0] >= since).slice(-40);
    recent.forEach((t, i) => setTimeout(() => this.mode === 'live' && this.spawnNote(t), 400 + i * 90));
  }

  onTicks(ticks) {
    if (this.mode !== 'live') return;
    const n = ticks.length;
    const from = Math.max(0, n - 60);
    for (let i = from; i < n; i++) this.spawnNote(ticks[i]);
    this.capEffects();
  }

  onEvents(events) {
    if (this.mode !== 'live') return;
    for (const e of events.slice(-20)) this.eventEffect(e);
    this.capEffects();
  }

  // While the scene is hidden nothing ages its effects, but events keep adding them (docs/internal/backlog.md "Long-running
  // load"): the newest few are kept, which is all a returning eye can see anyway
  capEffects() {
    const cap = (list, max) => (list.length > max ? list.splice(0, list.length - max) : null);
    cap(this.particles, 400);
    cap(this.effects, 200);
    cap(this.pulses, 60);
    cap(this.labels, 60);
    cap(this.bubbles, 3);
  }

  // ---------------- tekrar oynatma ----------------
  startReplay(hours) {
    const end = Date.now();
    const start = end - hours * 3600000;
    const ticks = store.ticks.filter((t) => t[0] >= start);
    const events = store.events.filter((e) => e.t >= start && e.kind !== 'live');
    const count = new Map();
    for (const t of ticks) count.set(t[3], (count.get(t[3]) || 0) + 1);
    for (const e of events) count.set(e.projectId, (count.get(e.projectId) || 0) + 3);
    const spans = new Map();
    for (const s of store.sessions.values()) {
      if (!s.projectId || !s.lastAt || s.lastAt < start) continue;
      if (!spans.has(s.projectId)) spans.set(s.projectId, []);
      spans.get(s.projectId).push([s.startedAt, s.lastAt]);
      if (!count.has(s.projectId)) count.set(s.projectId, 1);
    }
    const agents = [...store.agents.values()].filter((a) => a.lastAt >= start && a.startedAt <= end).sort((a, b) => a.startedAt - b.startedAt);
    const duration = hours <= 6 ? 50000 : hours <= 24 ? 80000 : 110000;
    this.replay = { hours, start, end, duration, elapsed: 0, paused: false, ticks, events, agents, count, spans, ti: 0, ei: 0, T: start, lastTick: new Map(), toolsSoFar: new Map() };
    this.mode = 'replay';
    this.resetScene();
    this.orderKey = '';
  }

  stopReplay() {
    this.replay = null;
    this.mode = 'live';
    this.resetScene();
    this.orderKey = '';
  }

  togglePause() {
    if (this.replay) this.replay.paused = !this.replay.paused;
    return this.replay?.paused;
  }

  seek(frac) {
    const r = this.replay;
    if (!r) return;
    r.elapsed = clamp(frac, 0, 1) * r.duration;
    r.T = r.start + (r.elapsed / r.duration) * (r.end - r.start);
    r.ti = lowerBound(r.ticks, r.T, (t) => t[0]);
    r.ei = lowerBound(r.events, r.T, (e) => e.t);
    r.lastTick.clear();
    r.toolsSoFar.clear();
    for (let i = 0; i < r.ti; i++) {
      const t = r.ticks[i];
      r.toolsSoFar.set(t[3], (r.toolsSoFar.get(t[3]) || 0) + 1);
      r.lastTick.set(t[3], t[0]);
    }
    this.particles.length = 0;
    this.agentNodes.clear();
  }

  resetScene() {
    this.particles.length = 0;
    this.effects.length = 0;
    this.labels.length = 0;
    this.bubbles.length = 0;
    this.pulses.length = 0;
    this.agentNodes.clear();
  }

  // ---------------- stage state ----------------
  now() {
    return this.mode === 'replay' && this.replay ? this.replay.T : Date.now();
  }

  projectState(p) {
    if (this.mode === 'live') return p.busy ? 'busy' : p.live ? 'idle' : 'rest';
    const r = this.replay;
    const lt = r.lastTick.get(p.id) || 0;
    const span = r.end - r.start;
    if (lt && r.T - lt < span * 0.012) return 'busy';
    for (const [a, b] of r.spans.get(p.id) || []) if (a <= r.T && r.T <= b) return 'idle';
    return 'rest';
  }

  visibleProjects() {
    const all = [...store.projects.values()];
    if (this.mode === 'replay') {
      const r = this.replay;
      return all.filter((p) => r.count.has(p.id)).sort((a, b) => (r.count.get(b.id) || 0) - (r.count.get(a.id) || 0));
    }
    const day = Date.now() - 86400000 * 3;
    return all
      // A folder that is not a project (docs/folders.md) takes a place only while a session is open in it
      .filter((p) => (isOtherFolder(p) ? p.live : p.live || p.lastActivity > 0 || p.kind !== 'adhoc'))
      .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || Number(b.lastActivity > day) - Number(a.lastActivity > day) || b.stats24.tools - a.stats24.tools || b.lastActivity - a.lastActivity);
  }

  layout(now) {
    // The ordering is refreshed only now and then; so sections do not keep moving around
    const vis = this.visibleProjects();
    const key = vis.map((p) => p.id).join('|') + `|${this.W}x${this.H}`;
    const sameSet = key.split('|').slice(0, -1).sort().join('|') === this.orderKey.split('|').slice(0, -1).sort().join('|');
    if (!sameSet || now - this.orderAt > 20000 || this.orderKey.split('|').pop() !== `${this.W}x${this.H}`) {
      this.order = vis.map((p) => p.id);
      this.orderKey = key;
      this.orderAt = now;
    }
    const W = this.W;
    const H = this.H;
    const cx = W / 2;
    // The arc is fitted to the width; if the window is tall, the composition is centered vertically
    const R2 = Math.max(120, Math.min(W / 2 - 110, H - 70 - 64));
    const cy = H - 70 - Math.max(0, H - 70 - 64 - R2) / 2;
    const R1 = R2 * 0.6;
    this.geo = { cx, cy, R1, R2 };
    // Inner arc: sections with an open session or worked on in the last 36 hours
    const recentCut = Date.now() - 36 * 3600000;
    // On the outer arc ~100 px per label: quiet sections that do not fit are hidden ("+N quiet" under the clock)
    const outerCap = clamp(Math.floor(((Math.PI - 0.78) * R2) / 100), 5, 14);
    const inner = [];
    const outer = [];
    for (const id of this.order) {
      const p = store.projects.get(id);
      if (!p) continue;
      const hot = this.mode === 'replay' ? inner.length < 6 : (p.live || p.lastActivity > recentCut) && inner.length < 6;
      if (hot) inner.push(p);
      else if (outer.length < outerCap) outer.push(p);
    }
    // The section size scales with the stage size
    this.scale = clamp(Math.min(W, H * 1.6) / 1100, 0.9, 1.5);
    const heavy = (p) => (this.mode === 'replay' ? (this.replay.count.get(p.id) || 0) > 60 : p.live || p.runningAgents > 0);
    const place = (list, R, perItem) => {
      const n = list.length;
      if (!n) return;
      // The lower ends of the arcs are left empty at the sides so they do not collide with the legend and podium
      const full = Math.PI - 0.78;
      // From the middle outwards: the busiest section on top, in the middle
      const slots = [];
      for (let i = 0; i < n; i++) slots.push(i);
      const mid = (n - 1) / 2;
      slots.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
      const seq = new Array(n);
      list.forEach((p, k) => (seq[slots[k]] = p));
      // Big (busy) sections take more room; so that their labels do not run into a neighbor
      const w = seq.map((p) => (heavy(p) ? 1.9 : 1));
      const total = w.reduce((s, x) => s + x, 0);
      const span = Math.min(full, total * perItem);
      let acc = 0;
      seq.forEach((p, i) => {
        const th = 1.5 * Math.PI - span / 2 + ((acc + w[i] / 2) / total) * span;
        acc += w[i];
        this.ensureNode(p, cx + R * Math.cos(th), cy + R * Math.sin(th), R === R1);
      });
    };
    place(inner, R1, 0.5);
    place(outer, R2, 0.3);
    const shown = new Set([...inner, ...outer].map((p) => p.id));
    for (const [id, n] of this.nodes) {
      if (!shown.has(id)) {
        n.gone = true;
        n.alpha -= 0.04;
        if (n.alpha <= 0) this.nodes.delete(id);
      }
    }
    this.hiddenCount = Math.max(0, this.order.length - shown.size);
  }

  ensureNode(p, tx, ty, inner) {
    let n = this.nodes.get(p.id);
    if (!n) {
      n = { id: p.id, x: tx, y: ty - 30, tx, ty, alpha: 0, r: 10, seed: Math.random() * 10 };
      this.nodes.set(p.id, n);
    }
    n.tx = tx;
    n.ty = ty;
    n.gone = false;
    n.inner = inner;
    n.p = p;
    const act = this.mode === 'replay' ? this.replay.toolsSoFar.get(p.id) || 0 : p.stats24.tools;
    const s = this.scale || 1;
    n.tr = (inner ? 18 + Math.min(12, Math.sqrt(act) / 2.4) : 10 + Math.min(6, Math.sqrt(act) / 5)) * s;
    n.state = this.projectState(p);
  }

  visibleAgents(now) {
    const out = new Map();
    if (this.mode === 'live') {
      for (const a of store.agents.values()) {
        const age = now - (a.lastAt || 0);
        if (a.status === 'running' || (a.status === 'done' && age < 60000) || (a.status === 'stopped' && age < 20000)) out.set(a.id, { a, fading: a.status !== 'running', age });
      }
    } else {
      const r = this.replay;
      const fade = (r.end - r.start) * 0.02;
      for (const a of r.agents) {
        if (a.startedAt > r.T) break;
        if (r.T <= a.lastAt) out.set(a.id, { a, fading: false, age: 0 });
        else if (r.T - a.lastAt < fade) out.set(a.id, { a, fading: true, age: ((r.T - a.lastAt) / fade) * 60000 });
      }
    }
    return out;
  }

  seatAgents(now) {
    const vis = this.visibleAgents(now);
    const byProject = new Map();
    for (const v of vis.values()) {
      const pid = v.a.projectId;
      if (!this.nodes.has(pid)) continue;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(v);
    }
    const { cx, cy } = this.geo;
    const seated = new Set();
    this.overflow = new Map();
    this.seatCount = new Map();
    for (const [pid, list] of byProject) {
      const n = this.nodes.get(pid);
      list.sort((x, y) => x.a.startedAt - y.a.startedAt);
      const phi = Math.atan2(n.y - cy, n.x - cx);
      let idx = 0;
      const rows = [8, 11, 14];
      for (let row = 0; row < rows.length && idx < list.length; row++) {
        const cap = rows[row];
        const take = Math.min(cap, list.length - idx);
        const rr = n.r + 22 + row * 15;
        const spread = Math.min(1.55, 0.26 * take);
        for (let k = 0; k < take; k++, idx++) {
          const v = list[idx];
          const th = phi - spread / 2 + (take === 1 ? spread / 2 : (k / (take - 1)) * spread);
          const tx = n.x + rr * Math.cos(th);
          const ty = n.y + rr * Math.sin(th);
          let an = this.agentNodes.get(v.a.id);
          if (!an) {
            an = { id: v.a.id, x: n.x, y: n.y, born: this.time, done: false, doneAt: 0 };
            this.agentNodes.set(v.a.id, an);
          }
          an.tx = tx;
          an.ty = ty;
          an.a = v.a;
          an.pid = pid;
          an.fading = v.fading;
          an.age = v.age;
          if (v.fading && !an.done) {
            an.done = true;
            an.doneAt = this.time;
            if (v.a.status !== 'stopped') this.burst(tx, ty, STATUS.done.c, 18);
          }
          if (!v.fading) an.done = false;
          seated.add(v.a.id);
        }
      }
      if (idx < list.length) this.overflow.set(pid, list.length - idx);
      this.seatCount.set(pid, list.filter((v) => !v.fading).length);
    }
    for (const id of this.agentNodes.keys()) if (!seated.has(id)) this.agentNodes.delete(id);
  }

  // ---------------- efektler ----------------
  emitterFor(actor, pid) {
    if (actor && actor[0] === 'a') {
      const an = this.agentNodes.get(actor.slice(2));
      if (an) return an;
    }
    return this.nodes.get(pid) || null;
  }

  spawnNote(t) {
    if (this.particles.length > 520) return;
    const em = this.emitterFor(t[1], t[3]);
    if (!em) return;
    const cat = t[2];
    const c = (CAT[cat] || CAT.other).c;
    const glyph = GLYPH[cat] || '•';
    const big = glyph !== '•' && glyph !== '◦';
    this.particles.push({
      x: em.x + (Math.random() - 0.5) * 6,
      y: em.y - 4,
      vx: (Math.random() - 0.5) * 18,
      vy: -(32 + Math.random() * 30),
      sway: Math.random() * TAU,
      life: 0,
      max: 1.7 + Math.random() * 0.9,
      c,
      glyph,
      size: big ? 12 + Math.random() * 4 : 3 + Math.random() * 1.5,
      big,
    });
    if (REDUCED) return;
    this.effects.push({ kind: 'ring', x: em.x, y: em.y, c, life: 0, max: 0.5, r0: 3, r1: 12, w: 1.2 });
  }

  burst(x, y, c, r1 = 28) {
    this.effects.push({ kind: 'ring', x, y, c, life: 0, max: 0.9, r0: 4, r1, w: 2 });
    this.effects.push({ kind: 'ring', x, y, c, life: -0.12, max: 0.9, r0: 2, r1: r1 * 0.6, w: 1.2 });
  }

  floatLabel(x, y, text, c) {
    this.labels.push({ x, y, text, c, life: 0, max: 2.6 });
    if (this.labels.length > 14) this.labels.shift();
  }

  eventEffect(e) {
    const n = this.nodes.get(e.projectId);
    if (!n) return;
    switch (e.kind) {
      case 'prompt':
      case 'command':
        this.pulses.push({ pid: e.projectId, u: 0, c: '#ffe39a' });
        this.bubbles.push({ pid: e.projectId, text: e.text, life: 0, max: 5 });
        if (this.bubbles.length > 3) this.bubbles.shift();
        break;
      case 'agent_start':
        this.burst(n.x, n.y, '#ff7ab6', n.r + 16);
        this.floatLabel(n.x, n.y - n.r - 16, '+ ' + (e.meta?.type || tx('stgAgentDefault')), '#ff9ccb');
        break;
      case 'agent_done': {
        const an = this.agentNodes.get(String(e.actor || '').slice(2));
        this.burst(an ? an.x : n.x, an ? an.y : n.y, STATUS.done.c, 20);
        break;
      }
      case 'skill':
        this.burst(n.x, n.y, '#ffd66b', n.r + 22);
        this.floatLabel(n.x, n.y - n.r - 16, '✦ ' + e.text, '#ffd66b');
        break;
      case 'workflow_start':
        this.burst(n.x, n.y, '#3fe0cc', n.r + 40);
        this.floatLabel(n.x, n.y - n.r - 16, '◆ ' + e.text, '#3fe0cc');
        break;
      case 'workflow_done':
        this.burst(n.x, n.y, '#3fe0cc', n.r + 28);
        break;
      case 'commit':
        this.burst(n.x, n.y, '#ffb454', n.r + 20);
        this.floatLabel(n.x, n.y - n.r - 16, '◇ commit', '#ffb454');
        break;
      case 'live':
        if (e.meta?.status === 'busy') this.effects.push({ kind: 'ring', x: n.x, y: n.y, c: STATUS.busy.c, life: 0, max: 0.8, r0: n.r, r1: n.r + 14, w: 1.5 });
        break;
      default:
    }
  }

  // ---------------- loop ----------------
  // For a headless screenshot: when rAF is not running, advance the stage synchronously and draw
  simulate(seconds, fps = 30) {
    this.resize(); // let the layout be computed with the current size
    const dt = 1 / fps;
    for (let i = 0; i < seconds * fps; i++) {
      this.time += dt;
      this.step(dt);
    }
    this.draw();
  }

  // The scene switch (main.js) stops this scene for good: no more frames, no more resizes
  destroy() {
    this.dead = true;
    // The pending frame is cancelled: while no frames run (the window hidden) it kept this whole scene alive
    cancelAnimationFrame(this.frameId);
    this.ro.disconnect();
  }

  frame(ts) {
    if (this.dead) return;
    // On the first frame ts can be smaller than performance.now() at setup: no negative step
    const dt = Math.max(0, Math.min(0.05, (ts - this.last) / 1000));
    this.last = ts;
    this.time += dt;
    // Nothing to draw while the window is hidden or another screen is shown (the canvas then has no layout box)
    if (!document.hidden && this.cv.offsetParent !== null) {
      this.step(dt);
      this.draw();
    }
    this.frameId = requestAnimationFrame((t) => this.frame(t));
  }

  step(dt) {
    const r = this.replay;
    if (this.mode === 'replay' && r) {
      if (!r.paused) {
        r.elapsed = Math.min(r.duration, r.elapsed + dt * 1000);
        const prevT = r.T;
        r.T = r.start + (r.elapsed / r.duration) * (r.end - r.start);
        let spawned = 0;
        while (r.ti < r.ticks.length && r.ticks[r.ti][0] <= r.T) {
          const t = r.ticks[r.ti++];
          r.lastTick.set(t[3], t[0]);
          r.toolsSoFar.set(t[3], (r.toolsSoFar.get(t[3]) || 0) + 1);
          if (spawned++ < 26) this.spawnNote(t);
        }
        while (r.ei < r.events.length && r.events[r.ei].t <= r.T) this.eventEffect(r.events[r.ei++]);
        if (r.elapsed >= r.duration && prevT !== r.T) r.paused = true;
      }
      this.updateReplayBar();
    }
    const now = this.now();
    this.layout(now);
    const k = 1 - Math.pow(0.001, dt);
    for (const n of this.nodes.values()) {
      n.x = lerp(n.x, n.tx, k * 0.9);
      n.y = lerp(n.y, n.ty, k * 0.9);
      n.r = lerp(n.r, n.tr || 10, k);
      if (!n.gone) n.alpha = Math.min(1, n.alpha + dt * 2);
    }
    this.seatAgents(now);
    if (this.mode === 'live') this.computeActions();
    for (const an of this.agentNodes.values()) {
      an.x = lerp(an.x, an.tx, k * 1.2);
      an.y = lerp(an.y, an.ty, k * 1.2);
    }
    for (const p of this.particles) {
      p.life += dt;
      p.vy *= 0.992;
      p.x += (p.vx + Math.sin(p.life * 3 + p.sway) * 10) * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const e of this.effects) e.life += dt;
    this.effects = this.effects.filter((e) => e.life < e.max);
    for (const l of this.labels) l.life += dt;
    this.labels = this.labels.filter((l) => l.life < l.max);
    for (const b of this.bubbles) b.life += dt;
    this.bubbles = this.bubbles.filter((b) => b.life < b.max);
    for (const pu of this.pulses) pu.u += dt / 1.1;
    this.pulses = this.pulses.filter((pu) => pu.u < 1);
    for (const d of this.dust) {
      d.y -= d.v * dt;
      if (d.y < -0.02) {
        d.y = 1.02;
        d.x = Math.random();
      }
    }
    this.pick();
    this.updateOverlay(now);
  }

  // ---------------- drawing ----------------
  draw() {
    const { ctx, W, H, dpr } = this;
    const { cx, cy, R1, R2 } = this.geo;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Background: stage light and steps
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, R2 * 1.35);
    g.addColorStop(0, 'rgba(124,156,255,0.13)');
    g.addColorStop(0.45, 'rgba(124,156,255,0.045)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Soft stage light: an ellipse fading upwards above the podium
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 2.6);
    const spot = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.min(260, R1));
    spot.addColorStop(0, 'rgba(255,227,154,0.10)');
    spot.addColorStop(0.5, 'rgba(255,227,154,0.035)');
    spot.addColorStop(1, 'rgba(255,227,154,0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(260, R1), Math.PI, TAU);
    ctx.fill();
    ctx.restore();
    for (const d of this.dust) {
      ctx.fillStyle = `rgba(200,210,255,${d.a})`;
      ctx.beginPath();
      ctx.arc(d.x * W, d.y * H, d.r, 0, TAU);
      ctx.fill();
    }
    ctx.lineWidth = 1;
    for (const [R, a] of [
      [R1 * 0.55, 0.035],
      [R1, 0.07],
      [(R1 + R2) / 2, 0.035],
      [R2, 0.06],
      [R2 * 1.14, 0.025],
    ]) {
      ctx.strokeStyle = `rgba(160,175,220,${a})`;
      ctx.setLineDash(R === R1 || R === R2 ? [] : [2, 6]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.PI + 0.08, TAU - 0.08);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Batonlar
    for (const n of this.nodes.values()) {
      if (n.state === 'rest') continue;
      this.drawBaton(n);
    }
    for (const pu of this.pulses) {
      const n = this.nodes.get(pu.pid);
      if (!n) continue;
      const u = ease(pu.u);
      const pt = this.batonPoint(n, u);
      for (let i = 0; i < 6; i++) {
        const q = this.batonPoint(n, Math.max(0, u - i * 0.03));
        ctx.fillStyle = hexA(pu.c, 0.5 * (1 - i / 6) * (1 - pu.u * 0.5));
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.2 - i * 0.4, 0, TAU);
        ctx.fill();
      }
      glow(ctx, pt.x, pt.y, 14, pu.c, 0.55);
    }

    // Agent links
    for (const an of this.agentNodes.values()) {
      const n = this.nodes.get(an.pid);
      if (!n) continue;
      const fa = an.fading ? Math.max(0, 1 - an.age / 60000) : 1;
      ctx.strokeStyle = hexA(agentColor(an.a.type), 0.16 * fa * n.alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y);
      ctx.lineTo(an.x, an.y);
      ctx.stroke();
    }

    // Project sections
    for (const n of this.nodes.values()) this.drawProject(n);

    // Ajanlar
    for (const an of this.agentNodes.values()) this.drawAgent(an);
    if (this.overflow) {
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'center';
      for (const [pid, extra] of this.overflow) {
        const n = this.nodes.get(pid);
        if (!n) continue;
        ctx.fillStyle = 'rgba(232,235,242,0.7)';
        ctx.fillText(tx('stgMoreAgents', { n: extra }), n.x, n.y - n.r - 70);
      }
    }

    // Notalar
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.particles) {
      const a = Math.sin(Math.PI * Math.min(1, p.life / p.max)) * 0.95;
      if (p.big) {
        ctx.font = `600 ${p.size}px ${FONT}`;
        ctx.fillStyle = hexA(p.c, a);
        ctx.shadowColor = p.c;
        ctx.shadowBlur = 8;
        ctx.fillText(p.glyph, p.x, p.y);
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = hexA(p.c, a);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, TAU);
        ctx.fill();
      }
    }

    // Halkalar
    for (const e of this.effects) {
      if (e.life < 0) continue;
      const u = e.life / e.max;
      ctx.strokeStyle = hexA(e.c, (1 - u) * 0.8);
      ctx.lineWidth = e.w * (1 - u * 0.5);
      ctx.beginPath();
      ctx.arc(e.x, e.y, lerp(e.r0, e.r1, ease(u)), 0, TAU);
      ctx.stroke();
    }

    // Floating labels
    ctx.font = `600 11px ${FONT}`;
    for (const l of this.labels) {
      const u = l.life / l.max;
      ctx.fillStyle = hexA(l.c, Math.min(1, (1 - u) * 1.6));
      ctx.fillText(truncate(l.text, 34), l.x, l.y - ease(u) * 26);
    }

    this.drawPodium();
    this.drawBubbles();
  }

  batonPoint(n, u) {
    const { cx, cy } = this.geo;
    const x0 = cx;
    const y0 = cy - 14;
    const x1 = n.x;
    const y1 = n.y + n.r * 0.6;
    const qx = cx + (x1 - cx) * 0.18;
    const qy = y1 + (y0 - y1) * 0.62;
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const c = u * u;
    return { x: a * x0 + b * qx + c * x1, y: a * y0 + b * qy + c * y1 };
  }

  drawBaton(n) {
    const { ctx } = this;
    const { cx, cy } = this.geo;
    const col = projectColor(n.id);
    const busy = n.state === 'busy';
    const x1 = n.x;
    const y1 = n.y + n.r * 0.6;
    const grad = ctx.createLinearGradient(cx, cy, x1, y1);
    grad.addColorStop(0, hexA('#ffe39a', busy ? 0.55 : 0.2));
    grad.addColorStop(1, hexA(col, busy ? 0.75 : 0.28));
    ctx.strokeStyle = grad;
    ctx.lineWidth = busy ? 2 : 1.2;
    if (busy && !REDUCED) {
      ctx.setLineDash([7, 9]);
      ctx.lineDashOffset = -this.time * 38;
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - 14);
    ctx.quadraticCurveTo(cx + (x1 - cx) * 0.18, y1 + (cy - 14 - y1) * 0.62, x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawProject(n) {
    const { ctx } = this;
    const p = n.p;
    if (!p) return;
    const col = projectColor(n.id);
    const a = n.alpha;
    const hovered = this.hover?.type === 'project' && this.hover.id === n.id;
    const state = n.state;
    const dim = state === 'rest' ? 0.5 : 1;
    // Glow
    glow(ctx, n.x, n.y, n.r * (state === 'busy' ? 3.4 : 2.4), col, (state === 'busy' ? 0.42 : state === 'idle' ? 0.22 : 0.1) * a);
    // Sound waves
    if (state === 'busy' && !REDUCED) {
      for (let i = 0; i < 3; i++) {
        const u = (this.time * 0.7 + i / 3 + n.seed) % 1;
        ctx.strokeStyle = hexA(col, (1 - u) * 0.5 * a);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 + u * 26, 0, TAU);
        ctx.stroke();
      }
    } else if (state === 'idle') {
      const u = 0.5 + 0.5 * Math.sin(this.time * 1.6 + n.seed);
      ctx.strokeStyle = hexA('#ffcf6b', (0.25 + u * 0.3) * a);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 5 + u * 2, 0, TAU);
      ctx.stroke();
    }
    // Body
    const body = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.4, 1, n.x, n.y, n.r);
    body.addColorStop(0, hexA(col, (state === 'rest' ? 0.4 : 0.85) * a));
    body.addColorStop(0.55, hexA(col, (state === 'rest' ? 0.12 : 0.32) * a));
    body.addColorStop(1, `rgba(12,14,22,${0.95 * a})`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = hexA(col, (hovered ? 1 : 0.85 * dim) * a);
    ctx.lineWidth = hovered ? 2.4 : 1.6;
    ctx.stroke();
    // Initials
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(Math.max(9, n.r * 0.62))}px ${FONT}`;
    ctx.fillStyle = `rgba(240,243,250,${0.92 * a * (state === 'rest' ? 0.7 : 1)})`;
    ctx.fillText(initials(p.name), n.x, n.y + 0.5);
    // Label: a dark outline so it can be read over the batons
    const labelY = n.y + n.r + 14;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(8,9,14,${0.9 * a})`;
    ctx.lineWidth = 4;
    ctx.font = `${n.inner ? 650 : 500} ${n.inner ? 13 : 11}px ${FONT}`;
    const name = truncate(p.name, n.inner ? 21 : 18);
    ctx.strokeText(name, n.x, labelY);
    ctx.fillStyle = `rgba(232,235,242,${(state === 'rest' ? 0.55 : 0.97) * a})`;
    ctx.fillText(name, n.x, labelY);
    const sub = this.subLabel(p, state);
    if (sub && (n.inner || state !== 'rest')) {
      ctx.font = `600 10.5px ${FONT}`;
      ctx.strokeText(sub, n.x, labelY + 14);
      ctx.fillStyle = state === 'busy' ? hexA('#5ee39a', 0.95 * a) : state === 'idle' ? hexA('#ffcf6b', 0.9 * a) : `rgba(150,160,180,${0.75 * a})`;
      ctx.fillText(sub, n.x, labelY + 14);
    }
    // The working section's last action: "editing · stage.js" (in live mode, last 3 minutes)
    if (state === 'busy' && this.mode === 'live') {
      const act = this.projectAction(p.id);
      if (act) {
        const txt = truncate(actionPlain(act), n.inner ? 34 : 24);
        ctx.font = `500 10px ${FONT}`;
        ctx.strokeText(txt, n.x, labelY + 27);
        ctx.fillStyle = `rgba(190,200,220,${0.8 * a})`;
        ctx.fillText(txt, n.x, labelY + 27);
      }
    }
  }

  // The newest last action per project: once per frame (instead of a separate scan for each section)
  computeActions() {
    const m = new Map();
    const take = (pid, act) => {
      if (!pid || !act) return;
      const cur = m.get(pid);
      if (!cur || act.t > cur.t) m.set(pid, act);
    };
    for (const s of store.sessions.values()) if (s.live?.status === 'busy') take(s.projectId, s.lastAction);
    for (const a of store.agents.values()) if (a.status === 'running') take(a.projectId, a.lastAction);
    this.actions = m;
  }

  projectAction(pid) {
    const best = this.actions?.get(pid);
    return best && Date.now() - best.t < 180000 ? best : null;
  }


  subLabel(p, state) {
    if (this.mode === 'replay') {
      const c = this.replay.toolsSoFar.get(p.id) || 0;
      return state === 'busy' ? tx('stgReplayBusy', { n: num(c) }) : c ? tx('stgNotes', { n: num(c) }) : '';
    }
    const ag = p.runningAgents ? tx('stgAgentsSuffix', { n: p.runningAgents }) : '';
    if (state === 'busy') return `${tx('stgBusy')}${ag}`;
    if (state === 'idle') return `${tx('stgWaiting')}${ag}`;
    return p.lastActivity ? ago(p.lastActivity) : tx('stgQuiet');
  }

  drawAgent(an) {
    const { ctx } = this;
    const n = this.nodes.get(an.pid);
    const a = n ? n.alpha : 1;
    const col = agentColor(an.a.type);
    const fa = an.fading ? Math.max(0, 1 - an.age / 60000) : 1;
    const wf = !!an.a.workflowRunId;
    const r = wf ? 3.6 : 5;
    const hovered = this.hover?.type === 'agent' && this.hover.id === an.id;
    if (!an.fading) {
      const u = 0.5 + 0.5 * Math.sin(this.time * 3 + an.born * 7);
      glow(ctx, an.x, an.y, r * 3.2, col, (0.25 + u * 0.2) * a);
    }
    ctx.fillStyle = an.fading ? hexA(an.a.status === 'stopped' ? '#ff7a7a' : '#5ee39a', 0.75 * fa * a) : hexA(col, 0.95 * a);
    ctx.beginPath();
    ctx.arc(an.x, an.y, hovered ? r + 1.8 : r, 0, TAU);
    ctx.fill();
    if (hovered) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // If the section has few agents, write the type beside it (who does what at a glance)
    if (!an.fading && (this.seatCount?.get(an.pid) || 0) <= 3 && n) {
      const dx = an.x - n.x;
      const dy = an.y - n.y;
      const len = Math.hypot(dx, dy) || 1;
      const lx = an.x + (dx / len) * 9;
      const ly = an.y + (dy / len) * 9;
      ctx.font = `600 9.5px ${FONT}`;
      ctx.textAlign = dx >= 0 ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(8,9,14,0.85)';
      ctx.lineWidth = 3;
      const label = truncate(an.a.type, 16);
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = hexA(col, 0.95 * a);
      ctx.fillText(label, lx, ly);
      ctx.textAlign = 'center';
    }
    if (an.fading && an.a.status !== 'stopped' && an.age < 8000) {
      ctx.strokeStyle = hexA('#0b0d12', 0.9 * fa);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(an.x - 2.2, an.y + 0.2);
      ctx.lineTo(an.x - 0.6, an.y + 1.8);
      ctx.lineTo(an.x + 2.4, an.y - 1.8);
      ctx.stroke();
    }
  }

  drawPodium() {
    const { ctx } = this;
    const { cx, cy } = this.geo;
    const anyBusy = [...this.nodes.values()].some((n) => n.state === 'busy');
    const u = 0.5 + 0.5 * Math.sin(this.time * 2);
    glow(ctx, cx, cy, 70, '#ffe39a', anyBusy ? 0.22 + u * 0.08 : 0.12);
    ctx.fillStyle = 'rgba(14,16,24,0.95)';
    ctx.strokeStyle = anyBusy ? 'rgba(255,227,154,0.8)' : 'rgba(255,227,154,0.45)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 10, 62, 20, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, 40, 12, 0, 0, TAU);
    ctx.strokeStyle = 'rgba(255,227,154,0.3)';
    ctx.stroke();
    const hovered = this.hover?.type === 'podium';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 12px ${FONT}`;
    ctx.fillStyle = hovered ? '#fff4d1' : '#ffe39a';
    ctx.fillText(tx('stgPodium'), cx, cy + 5);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = 'rgba(232,235,242,0.6)';
    ctx.fillText(tx('stgYouClaude'), cx, cy + 40);
  }

  drawBubbles() {
    const { ctx } = this;
    let i = 0;
    for (const b of this.bubbles) {
      const n = this.nodes.get(b.pid);
      if (!n) continue;
      const u = b.life / b.max;
      const a = Math.min(1, b.life * 4) * Math.min(1, (1 - u) * 4);
      const text = truncate(b.text, 56);
      ctx.font = `500 11.5px ${FONT}`;
      const w = Math.min(320, ctx.measureText(text).width + 20);
      const side = n.x < this.geo.cx ? -1 : 1;
      let x = n.x + side * (n.r + 16) - (side < 0 ? w : 0);
      x = clamp(x, 8, this.W - w - 8);
      const y = clamp(n.y - n.r - 44 - i * 30, 8, this.H - 40);
      ctx.fillStyle = `rgba(22,26,38,${0.92 * a})`;
      ctx.strokeStyle = `rgba(255,227,154,${0.5 * a})`;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, 24, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `rgba(245,240,225,${a})`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 10, y + 12.5, w - 20);
      i++;
    }
    ctx.textAlign = 'center';
  }

  // ---------------- interaction ----------------
  pick() {
    if (!this.mouse) return;
    this.setHover(this.hitTest(this.mouse.x, this.mouse.y));
  }

  // The node at canvas coordinates (agent > project > conductor podium) or null
  hitTest(x, y) {
    let best = null;
    let bd = 1e9;
    for (const an of this.agentNodes.values()) {
      const d = Math.hypot(an.x - x, an.y - y);
      if (d < 9 && d < bd) {
        bd = d;
        best = { type: 'agent', id: an.id };
      }
    }
    if (!best) {
      for (const n of this.nodes.values()) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 8 && d < bd) {
          bd = d;
          best = { type: 'project', id: n.id };
        }
      }
    }
    if (!best && this.geo && Math.hypot(this.geo.cx - x, this.geo.cy + 8 - y) < 60) best = { type: 'podium', id: 'podium' };
    return best;
  }

  // For the right-click menu: the project/agent node at screen (client) coordinates. The podium is not a target.
  hitAt(clientX, clientY) {
    const r = this.cv.getBoundingClientRect();
    const h = this.hitTest(clientX - r.left, clientY - r.top);
    return h && h.type !== 'podium' ? h : null;
  }

  // The node's screen position (the QA hook opens the menu bound to the node); null if not visible
  clientPosOf(type, id) {
    const n = type === 'agent' ? this.agentNodes.get(id) : type === 'project' ? this.nodes.get(id) : null;
    if (!n || n.gone || (n.alpha != null && n.alpha < 0.2)) return null;
    const r = this.cv.getBoundingClientRect();
    if (n.x < 0 || n.y < 0 || n.x > r.width || n.y > r.height) return null;
    return { x: r.left + n.x, y: r.top + n.y, r: n.r || 6 };
  }

  setHover(h) {
    const same = h && this.hover && h.type === this.hover.type && h.id === this.hover.id;
    this.hover = h;
    this.cv.style.cursor = h && h.type !== 'podium' ? 'pointer' : 'default';
    const tip = this.tooltip;
    if (!h) {
      tip.hidden = true;
      return;
    }
    if (!same) tip.innerHTML = this.tooltipHtml(h);
    tip.hidden = false;
    const r = this.cv.parentElement.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = this.mouse.x + 16;
    let top = this.mouse.y + 14;
    if (left + tw > r.width - 8) left = this.mouse.x - tw - 16;
    if (top + th > r.height - 8) top = this.mouse.y - th - 14;
    tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  tooltipHtml(h) {
    if (h.type === 'project') {
      const p = store.projects.get(h.id);
      if (!p) return '';
      const st = this.nodes.get(h.id)?.state;
      const stLabel = st === 'busy' ? tx('stgStBusy') : st === 'idle' ? tx('stgStWaiting') : tx('stgStQuiet');
      const live = [...store.sessions.values()].filter((s) => s.projectId === p.id && s.live);
      return `<div class="tt-head"><i class="dot" style="--c:${projectColor(p.id)}"></i><b>${esc(p.name)}</b><span class="tt-state s-${st}">${stLabel}</span></div>
        ${live
          .map(
            (s) =>
              `<div class="tt-row">${esc(truncate(store.sessionLabel(s), 60))}<span>${modelName(s.model)}</span></div>${
                s.live.status === 'busy' && s.lastAction ? `<div class="tt-act">${actionLine(s.lastAction)}</div>` : ''
              }`,
          )
          .join('')}
        <div class="tt-grid"><span>${tx('stgTipTools24')}</span><b>${num(p.stats24.tools)}</b><span>${tx('stgTipTokens')}</span><b>${tok(p.stats24.tokens)}</b><span>${tx('stgTipRunAgents')}</span><b>${p.runningAgents}</b><span>${tx('stgTipLast')}</span><b>${ago(p.lastActivity)}</b></div>
        <div class="tt-foot">${tx('stgTipMore')}</div>`;
    }
    if (h.type === 'agent') {
      const a = store.agents.get(h.id);
      if (!a) return '';
      const s = STATUS[a.status] || STATUS.running;
      return `<div class="tt-head"><i class="dot" style="--c:${agentColor(a.type)}"></i><b>${esc(a.type)}</b><span class="tt-state" style="--c:${s.c}">${s.l}</span></div>
        <div class="tt-row wrap">${esc(a.label || tx('stgNoTask'))}</div>
        ${a.status === 'running' && a.lastAction ? `<div class="tt-act">${actionLine(a.lastAction)}</div>` : ''}
        <div class="tt-grid"><span>${tx('stgTipToolCalls')}</span><b>${num(a.toolCalls)}</b><span>${tx('stgTipDuration')}</span><b>${dur((a.lastAt || 0) - (a.startedAt || 0))}</b><span>model</span><b>${modelName(a.model)}</b><span>${tx('stgTipProject')}</span><b>${esc(store.projects.get(a.projectId)?.name || '—')}</b></div>
        <div class="tt-foot">${a.workflowRunId ? tx('stgWorkflowWorker') : ''}${tx('stgTipMore')}</div>`;
    }
    const k = store.kpi || {};
    return `<div class="tt-head"><b>${tx('stgConductor')}</b></div><div class="tt-row wrap">${tx('stgConductorBody')}</div>
      <div class="tt-grid"><span>${tx('stgTipOpenSessions')}</span><b>${k.live || 0}</b><span>${tx('stgTipWorking')}</span><b>${k.busy || 0}</b><span>${tx('stgTipRunAgents')}</span><b>${k.runningAgents || 0}</b></div>`;
  }

  // ---------------- overlay (clock, empty state, replay bar) ----------------
  updateOverlay(now) {
    if (this.mode === 'replay' && this.replay) {
      const d = new Date(this.replay.T);
      this.clockEl.innerHTML = `<span class="sc-mode replay">${tx('stgModeReplay')}</span><b>${dayName(d.getDay())} ${clock(this.replay.T)}</b><span>${d.toLocaleDateString(language() === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'long' })}</span>`;
      this.emptyEl.hidden = true;
      return;
    }
    this.clockEl.innerHTML = `<span class="sc-mode live">${tx('stgModeLive')}</span><b>${clock(now)}</b><span>${tx('stgSections', { n: this.nodes.size })}${this.hiddenCount ? tx('stgHiddenQuiet', { n: this.hiddenCount }) : ''}</span>`;
    const anyLive = [...store.projects.values()].some((p) => p.live);
    this.emptyEl.hidden = anyLive || !store.loaded;
  }

  updateReplayBar() {
    const r = this.replay;
    if (!r || !this.replayBar) return;
    const frac = r.elapsed / r.duration;
    this.replayBar.style.setProperty('--p', (frac * 100).toFixed(2) + '%');
  }
}

function glow(ctx, x, y, r, c, a) {
  if (a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(c, a));
  g.addColorStop(1, hexA(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function lowerBound(arr, v, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
