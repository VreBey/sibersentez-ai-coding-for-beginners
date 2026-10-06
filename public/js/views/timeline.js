// Timeline: one strip per project. Session spans, the real activity density (tool calls),
// agents, commands given and commits on the same time axis.
import { store } from '../store.js';
import { esc, projectColor, agentColor, dayTime, dur, num, clock, locale, eventText, replaceHtml } from '../format.js';
import { t as tx } from '../i18n.js';

const RANGES = [
  [6, 'tlRange_6'],
  [24, 'tlRange_24'],
  [72, 'tlRange_72'],
  [168, 'tlRange_168'],
  [336, 'tlRange_336'],
];
const ROW = 50;
const LEFT = 190;
const TOP = 30;

export function createTimelineView(root, openDrawer) {
  let hours = 24;
  root.innerHTML = `
    <div class="toolbar">
      <div class="seg" data-k="range" role="group" aria-label="${esc(tx('tlRangeAria'))}">${RANGES.map(([h, l]) => `<button data-v="${h}" class="${h === hours ? 'on' : ''}">${esc(tx(l))}</button>`).join('')}</div>
      <div class="tl-legend">
        <span><i class="lg-session"></i>${esc(tx('tlLgSession'))}</span><span><i class="lg-heat"></i>${esc(tx('tlLgHeat'))}</span><span><i class="lg-agent"></i>${esc(tx('tlLgAgent'))}</span><span><i class="lg-prompt"></i>${esc(tx('tlLgPrompt'))}</span><span><i class="lg-commit"></i>commit</span>
      </div>
    </div>
    <div class="tl-wrap" data-k="wrap"></div>`;
  const wrap = root.querySelector('[data-k=wrap]');
  root.querySelector('[data-k=range]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    hours = Number(b.dataset.v);
    for (const x of b.parentElement.children) x.classList.toggle('on', x === b);
    render();
  });
  wrap.addEventListener('click', (e) => {
    const s = e.target.closest('[data-session]');
    if (s) return openDrawer({ type: 'session', id: s.dataset.session });
    const a = e.target.closest('[data-agent]');
    if (a) return openDrawer({ type: 'agent', id: a.dataset.agent });
    const p = e.target.closest('[data-project]');
    if (p) openDrawer({ type: 'project', id: p.dataset.project });
  });

  function render() {
    const W = Math.max(640, wrap.clientWidth);
    const end = Date.now();
    const start = end - hours * 3600000;
    const plotW = W - LEFT - 18;
    const x = (t) => LEFT + ((Math.max(start, Math.min(end, t)) - start) / (end - start)) * plotW;

    // Rows: projects with activity in the range
    const rows = new Map();
    const row = (pid) => {
      if (!pid) return null;
      if (!rows.has(pid)) rows.set(pid, { pid, sessions: [], agents: [], prompts: [], commits: [], heat: new Map(), score: 0, last: 0 });
      return rows.get(pid);
    };
    for (const s of store.sessions.values()) {
      const e2 = s.live ? end : s.lastAt;
      if (!s.startedAt || e2 < start || s.startedAt > end) continue;
      const r = row(s.projectId);
      if (!r) continue;
      r.sessions.push(s);
      r.last = Math.max(r.last, e2);
    }
    for (const a of store.agents.values()) {
      if (!a.startedAt || a.lastAt < start) continue;
      const r = row(a.projectId);
      if (!r) continue;
      r.agents.push(a);
      r.score += 2;
    }
    for (const e of store.events) {
      if (e.t < start) continue;
      if (e.kind === 'prompt' || e.kind === 'command') {
        const r = row(e.projectId);
        if (r) {
          r.prompts.push(e);
          r.score += 3;
        }
      } else if (e.kind === 'commit') {
        const r = row(e.projectId);
        if (r) r.commits.push(e);
      }
    }
    const bin = Math.max(2, Math.round(plotW / 260));
    let tickFloor = Infinity;
    for (const t of store.ticks) {
      if (t[0] < tickFloor) tickFloor = t[0];
      if (t[0] < start) continue;
      const r = row(t[3]);
      if (!r) continue;
      const col = Math.floor((x(t[0]) - LEFT) / bin);
      r.heat.set(col, (r.heat.get(col) || 0) + 1);
      r.score++;
      r.last = Math.max(r.last, t[0]);
    }
    const list = [...rows.values()].filter((r) => store.projects.has(r.pid)).sort((a, b) => b.last - a.last || b.score - a.score);
    const H = TOP + list.length * ROW + 12;

    // Time axis
    const stepH = hours <= 6 ? 1 : hours <= 24 ? 2 : hours <= 72 ? 6 : 24;
    const first = Math.ceil(start / (stepH * 3600000)) * stepH * 3600000;
    let axis = '';
    for (let t = first; t <= end; t += stepH * 3600000) {
      const xx = x(t);
      const d = new Date(t);
      const dayEdge = d.getHours() === 0;
      const label = hours > 24 && (dayEdge || stepH === 24) ? d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : clock(t);
      axis += `<line x1="${xx}" x2="${xx}" y1="${TOP - 6}" y2="${H}" class="${dayEdge ? 'grid day' : 'grid'}"/><text x="${xx}" y="${TOP - 12}" class="axis">${esc(label)}</text>`;
    }
    const nowX = x(end);
    axis += `<line x1="${nowX}" x2="${nowX}" y1="${TOP - 6}" y2="${H}" class="now-line"/><text x="${nowX - 4}" y="${TOP - 12}" class="axis now" text-anchor="end">${esc(tx('tlNow'))}</text>`;
    // The older part the tool ticks do not cover (ticks keep the last N calls)
    if (tickFloor > start && tickFloor < end) {
      axis += `<rect x="${LEFT}" y="${TOP - 4}" width="${Math.max(0, x(tickFloor) - LEFT)}" height="${H - TOP}" class="no-heat"><title>${esc(tx('tlNoHeat'))}</title></rect>`;
    }

    let body = '';
    list.forEach((r, i) => {
      const p = store.projects.get(r.pid);
      const c = projectColor(r.pid);
      const y = TOP + i * ROW;
      body += `<g class="tl-row">
        <rect x="0" y="${y}" width="${W}" height="${ROW}" class="row-bg ${i % 2 ? 'odd' : ''}"/>
        <g data-project="${esc(r.pid)}" class="row-label"><circle cx="16" cy="${y + ROW / 2}" r="5" fill="${c}"/><text x="30" y="${y + ROW / 2 - 3}" class="rl-name">${esc(trunc(p.name, 22))}</text><text x="30" y="${y + ROW / 2 + 12}" class="rl-sub">${esc(tx('tlRowSub', { s: r.sessions.length, a: r.agents.length, p: r.prompts.length }))}</text></g>`;
      for (const s of r.sessions) {
        const x1 = x(s.startedAt);
        const e2 = s.live ? end : s.lastAt;
        const x2 = Math.max(x1 + 3, x(e2));
        body += `<rect data-session="${esc(s.id)}" x="${x1}" y="${y + 7}" width="${x2 - x1}" height="9" rx="4" fill="${c}" class="sess ${s.live ? 'live ' + s.live.status : ''}"><title>${esc(store.sessionLabel(s))}
${tx('tlSessTip', { from: dayTime(s.startedAt), to: s.live ? tx('tlNowOpen') : dayTime(s.lastAt), tools: num(s.toolCalls), agents: num(s.agentCount) })}</title></rect>`;
      }
      const maxHeat = Math.max(1, ...r.heat.values());
      for (const [col, n] of r.heat) {
        const a = 0.18 + 0.82 * Math.sqrt(n / maxHeat);
        body += `<rect x="${LEFT + col * bin}" y="${y + 19}" width="${bin}" height="12" fill="${c}" fill-opacity="${a.toFixed(2)}" class="heat"/>`;
      }
      for (const a of r.agents) {
        const x1 = x(a.startedAt);
        const x2 = Math.max(x1 + 2, x(a.status === 'running' ? end : a.lastAt));
        body += `<rect data-agent="${esc(a.id)}" x="${x1}" y="${y + 35}" width="${x2 - x1}" height="5" rx="2" fill="${agentColor(a.type)}" class="ag ${a.status}"><title>${esc(a.type)} · ${esc(a.label || '')}
${tx('tlAgentTip', { from: dayTime(a.startedAt), dur: dur(a.lastAt - a.startedAt), tools: num(a.toolCalls) })}</title></rect>`;
      }
      for (const e of r.prompts) {
        const xx = x(e.t);
        body += `<line data-session="${esc(e.sessionId || '')}" x1="${xx}" x2="${xx}" y1="${y + 4}" y2="${y + 33}" class="pmark"><title>${esc(dayTime(e.t))} · ${esc(eventText(e))}</title></line>`;
      }
      for (const e of r.commits) {
        const xx = x(e.t);
        body += `<path d="M${xx} ${y + 2}l5 5-5 5-5-5z" class="cmark"><title>commit · ${esc(e.text)}</title></path>`;
      }
      body += '</g>';
    });

    replaceHtml(wrap, list.length
      ? `<svg class="timeline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tx('tlAria'))}">${axis}${body}</svg>`
      : `<div class="empty-state">${esc(tx('tlEmpty'))}</div>`);
  }

  return { render };
}

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
