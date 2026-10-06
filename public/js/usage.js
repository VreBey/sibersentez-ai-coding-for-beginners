// Live usage tracking in the page (docs/usage.md §6): the period and dollar preferences, number and dollar formats,
// the strip's cards, the project card's line and the drawer's usage section with its data. Numbers come from the
// snapshot (kpi.usage, project.usage30) and from GET /api/usage. Every dollar amount starts with "~$" and is called an
// API equivalent, an estimate. The module touches neither the DOM nor the network while loading (node tests import it).
import { t, language } from './i18n.js';
import { esc, modelName } from './format.js';
import { icon } from './icons.js';
import { hintHtml } from './hints.js';

export const USAGE_PERIODS = Object.freeze(['24h', '7d', 'month', '30d']);
export const PERIOD_KEY = 'sibersentez.usage.period';
// '1': the dollars are shown; otherwise (the default since docs/direction.md §3.3) they are hidden everywhere, so a
// newcomer is not met by a price for work their subscription already pays
export const COST_KEY = 'sibersentez.usage.cost';
// '1': the advanced views (docs/direction.md §3.3): the numbers of the Feed, the timeline, the orchestra scene, the
// project drawer's tiles and the most used charts; otherwise (the default) they stay out of sight, nothing is deleted
export const ADVANCED_KEY = 'sibersentez.advanced';
// '1': the strip shows its cards; otherwise (the default) it is one line with the main numbers, so the tabs stay on
// the first screen
export const OPEN_KEY = 'sibersentez.usage.open';

// ---------- preferences (localStorage; a blocked storage keeps them for this page only) ----------

let period = null;
let showCost = null;
let open = null;
let advanced = null;
const listeners = new Set();

function readPref(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writePref(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // storage blocked: kept until a reload
  }
}
function changed() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

export function getPeriod() {
  if (period === null) {
    const p = readPref(PERIOD_KEY);
    period = USAGE_PERIODS.includes(p) ? p : '24h';
  }
  return period;
}
export function setPeriod(p) {
  if (!USAGE_PERIODS.includes(p) || p === getPeriod()) return false;
  period = p;
  writePref(PERIOD_KEY, p);
  changed();
  return true;
}
export function costShown() {
  if (showCost === null) showCost = readPref(COST_KEY) === '1';
  return showCost;
}
export function setCostShown(on) {
  const v = !!on;
  if (v === costShown()) return false;
  showCost = v;
  writePref(COST_KEY, v ? '1' : '0');
  changed();
  return true;
}
export function advancedShown() {
  if (advanced === null) advanced = readPref(ADVANCED_KEY) === '1';
  return advanced;
}
export function setAdvancedShown(on) {
  const v = !!on;
  if (v === advancedShown()) return false;
  advanced = v;
  writePref(ADVANCED_KEY, v ? '1' : '0');
  changed();
  return true;
}
export function stripOpen() {
  if (open === null) open = readPref(OPEN_KEY) === '1';
  return open;
}
// Only the strip changes with it, so the listeners of onPrefs are not called; the caller redraws the strip
export function setStripOpen(on) {
  const v = !!on;
  if (v === stripOpen()) return false;
  open = v;
  writePref(OPEN_KEY, v ? '1' : '0');
  return true;
}
// fn() runs after the period or the dollar setting changed; returns the unsubscribe function
export function onPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// Tests: forget the cached preferences (they are read again from storage)
export function resetPrefs() {
  period = null;
  showCost = null;
  open = null;
  advanced = null;
}

// ---------- formats ----------

const locale = () => (language() === 'tr' ? 'tr-TR' : 'en-US');
const fixed = (v, d) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });

// Whole count in the page's language: 40.193 / 40,193
export function count(n) {
  return Math.round(Number(n) || 0).toLocaleString(locale());
}

// Token amount: 5,7 bin · 14,9 milyon · 15,98 milyar (tr) / 5.7K · 14.9M · 15.98B (en)
export function amount(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return t('usageUnitB', { n: fixed(v / 1e9, 2) });
  if (v >= 1e6) return t('usageUnitM', { n: fixed(v / 1e6, 1) });
  if (v >= 1e3) return t('usageUnitK', { n: fixed(v / 1e3, 1) });
  return count(v);
}

// Short millions for one line (20,2 M); small amounts as amount()
export function millions(n) {
  const v = Number(n) || 0;
  return v >= 1e5 ? t('usageUnitMShort', { n: fixed(v / 1e6, 1) }) : amount(v);
}

// API-equivalent dollars, always with "~": ~$2.733 / ~$2,733; under $10 with cents; unknown: ~$—
export function usd(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '~$—';
  if (v === 0) return '~$0';
  return '~$' + fixed(v, v < 10 ? 2 : 0);
}

// Share 0..1 as a whole percent (98); a non-zero share under 1% reads as <1
export function percent(share) {
  const v = Number(share) || 0;
  if (v > 0 && v < 0.005) return '<1';
  return String(Math.round(v * 100));
}

// '2026-09-25' -> 25.09.2026 (tr) / 09/25/2026 (en)
export function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}
// '2026-09-25' -> 25 Eyl / Sep 25
function shortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

// ---------- shared pieces ----------

// The period buttons (the strip and the drawer): data-usage-period, the chosen one pressed
export function periodSegHtml(current) {
  return `<div class="seg us-seg" role="group" aria-label="${esc(t('usagePeriods'))}">${USAGE_PERIODS.map(
    (p) => `<button type="button" data-usage-period="${p}" data-fk="usage:${p}" class="${p === current ? 'on' : ''}" aria-pressed="${p === current}">${esc(t(`usagePeriod_${p}`))}</button>`,
  ).join('')}</div>`;
}

function card(cls, label, value, sub, tip) {
  return `<div class="us-card ${cls}" title="${esc(tip)}"><span class="us-l">${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub)}</small></div>`;
}

// The four cards of one totals object (the strip and the drawer). s: { input, cacheWrite, cacheRead, output,
// processed, cacheShare, usd, usdPartial }; unpriced: model ids without a price; pricedAt: the price table's date.
export function cardsHtml(s, { showCost = costShown(), unpriced = [], pricedAt = '', apiKeyEnv = false } = {}) {
  const x = s || {};
  const out = [
    card('proc', t('usageProcessed'), amount(x.processed), t('usageProcessedSub'), t('usageProcessedTip', { input: amount(x.input), write: amount(x.cacheWrite), output: amount(x.output) })),
    card('read', t('usageCacheRead'), amount(x.cacheRead), t('usageCacheShare', { pct: percent(x.cacheShare) }), t('usageCacheTip')),
    card('out', t('usageOutput'), amount(x.output), t('usageOutputSub'), t('usageOutputSub')),
  ];
  if (showCost) {
    const partial = !!x.usdPartial;
    const tip = t('usageCostTip', { date: dateText(pricedAt) }) + (partial && unpriced.length ? ' ' + t('usageUnpriced', { models: unpriced.join(', ') }) : '');
    out.push(card(`cost${partial ? ' partial' : ''}`, t('usageCost'), usd(x.usd), partial ? t('usageCostPartial') : t(apiKeyEnv ? 'usageMaybeBill' : 'usageCostSub'), tip));
  }
  return out.join('');
}

// ---------- the strip ----------

// Closed strip: the processed tokens and the dollars in one line, with the same tips as their cards
function summaryHtml(s, { showCost, unpriced, pricedAt, apiKeyEnv = false }) {
  const proc = `<b title="${esc(t('usageProcessedTip', { input: amount(s.input), write: amount(s.cacheWrite), output: amount(s.output) }))}">${esc(t('usageSummary', { processed: amount(s.processed) }))}</b>`;
  if (!showCost) return `<span class="us-sum">${proc}</span>`;
  const partial = !!s.usdPartial;
  const tip = t('usageCostTip', { date: dateText(pricedAt) }) + (partial && unpriced.length ? ' ' + t('usageUnpriced', { models: unpriced.join(', ') }) : '');
  return `<span class="us-sum">${proc}<b class="us-sum-cost${partial ? ' partial' : ''}" title="${esc(tip)}">${esc(usd(s.usd))}</b><small class="us-sum-bill">${esc(t(apiKeyEnv ? 'usageMaybeBill' : 'usageNotBill'))}</small></span>`;
}

// ANTHROPIC_API_KEY is set: the ~$ may be a real bill (Claude Code bills that key when the user accepts it)
function apiKeyWarnHtml() {
  return `<p class="us-warn" role="note">${icon('bell')}<span>${esc(t('usageApiKeyWarn'))}</span><button type="button" class="ai-link" data-usage-setup data-fk="usage:setup">${esc(t('usageApiKeyOpen'))}</button></p>`;
}

// The usage row of the strip: period buttons, message count, the dollar switch, the details switch and, when open,
// the cards; closed, the main numbers stand in one line. summary: kpi.usage from the snapshot (null: nothing is drawn).
export function stripHtml(summary, { period: p = getPeriod(), showCost: cost = costShown(), open: isOpen = stripOpen() } = {}) {
  if (!summary || !summary.periods) return '';
  const s = summary.periods[p] || summary.periods['24h'] || {};
  const apiKeyEnv = summary.apiKeyEnv === true;
  const opts = { showCost: cost, unpriced: summary.unpriced || [], pricedAt: summary.pricedAt, apiKeyEnv };
  const note = [t('usageMessages', { count: count(s.messages) }), summary.scanning ? t('usageScanning') : ''].filter(Boolean).join(' · ');
  const toggle = `<button type="button" class="us-cost-toggle" data-usage-cost data-fk="usage:cost" aria-pressed="${cost}" title="${esc(t('usageCostToggleTip'))}">${esc(cost ? t('usageHideCost') : t('usageShowCost'))}</button>`;
  const more = `<button type="button" class="us-more" data-usage-open data-fk="usage:open" aria-expanded="${isOpen}"${isOpen ? ' aria-controls="usageCards"' : ''}>${esc(isOpen ? t('usageLess') : t('usageMore'))}</button>`;
  const head = `<div class="us-head"><span class="us-title">${icon('cpu')}${esc(t('usageTitle'))}${hintHtml(t(cost ? 'usageHint' : 'usageHintNoCost'))}</span>${periodSegHtml(p)}${isOpen ? '' : summaryHtml(s, opts)}<span class="us-note">${esc(note)}</span>${toggle}${more}</div>`;
  const warn = apiKeyEnv && cost ? apiKeyWarnHtml() : '';
  return isOpen ? `${head}${warn}<div class="us-cards${cost ? '' : ' no-cost'}" id="usageCards">${cardsHtml(s, opts)}</div>` : head + warn;
}

// ---------- the project card ----------

// One line under the card's numbers: "30 days ~$2,231 · 20.2 M output" (without dollars only the tokens); nothing
// when the project has no usage in the last 30 days
export function cardLineHtml(u, cost = costShown()) {
  if (!u || !u.messages) return '';
  const output = millions(u.output);
  const text = cost ? t('usageCardLine', { cost: usd(u.usd), output }) : t('usageCardLineTokens', { output });
  const tip = t('usageCardTip', { processed: amount(u.processed), read: amount(u.cacheRead), output: amount(u.output) });
  return `<p class="pusage" title="${esc(tip)}">${icon('cpu')}<span>${esc(text)}</span></p>`;
}

// Sort key of "by spend": dollars, or processed tokens while dollars are hidden
export function spendOf(p, cost = costShown()) {
  const u = p?.usage30;
  if (!u) return 0;
  return cost ? u.usd || 0 : u.processed || 0;
}

// Projects by spend, most first (ties: processed tokens, then name). Returns [used, unused]; unused keeps its order.
export function bySpend(projects, cost = costShown()) {
  const used = [];
  const unused = [];
  for (const p of projects) (p?.usage30?.messages ? used : unused).push(p);
  used.sort((a, b) => spendOf(b, cost) - spendOf(a, cost) || (b.usage30.processed || 0) - (a.usage30.processed || 0) || String(a.name).localeCompare(String(b.name), 'tr'));
  return [used, unused];
}

// ---------- the drawer's usage section ----------

// Daily bars of the last 30 days: dollars, or processed tokens while dollars are hidden
export function chartHtml(daily, cost = costShown()) {
  const days = Array.isArray(daily) ? daily : [];
  if (!days.length) return '';
  const val = (d) => (cost ? d.usd || 0 : d.processed || 0);
  const max = Math.max(0, ...days.map(val));
  const total = days.reduce((s, d) => s + val(d), 0);
  const title = cost ? t('usageDailyCost') : t('usageDailyTokens');
  const bars = days
    .map((d) => {
      const v = val(d);
      const h = max > 0 && v > 0 ? Math.max(2, (v / max) * 100) : 0;
      const tip = t('usageDayTip', { day: dateText(d.day), processed: amount(d.processed), read: amount(d.cacheRead), output: amount(d.output) }) + (cost ? ` · ${usd(d.usd)}` : '');
      return `<span class="us-bar${v ? '' : ' zero'}" style="height:${h.toFixed(1)}%" title="${esc(tip)}"></span>`;
    })
    .join('');
  return `<figure class="us-chart"><figcaption>${esc(title)} · ${esc(t('usageDaily'))}</figcaption><div class="us-bars" role="img" aria-label="${esc(`${title}: ${cost ? usd(total) : amount(total)}`)}">${bars}</div><div class="us-axis"><span>${esc(shortDay(days[0].day))}</span><span>${esc(shortDay(days[days.length - 1].day))}</span></div></figure>`;
}

function modelsHtml(models, cost) {
  const rows = (models || []).filter((m) => m.messages);
  if (!rows.length) return '';
  return `<h4 class="us-sub">${esc(t('usageModels'))}</h4><ul class="us-models">${rows
    .map((m) => {
      const right = cost ? (m.priced ? usd(m.usd) : t('usagePriceUnknown')) : amount(m.processed);
      return `<li><span class="us-model">${modelName(m.model)}</span><span class="us-mnums">${esc(t('usageModelNums', { processed: amount(m.processed), output: amount(m.output) }))}</span><b${m.priced ? '' : ' class="unpriced"'}>${esc(right)}</b></li>`;
    })
    .join('')}</ul>`;
}

// The section (pure). entry: { data, error, pending } of GET /api/usage?period=&project= (or null before the first
// answer). The head and the period buttons are always there, so a period change keeps the focus.
export function sectionHtml(entry, { period: p = getPeriod(), showCost: cost = costShown() } = {}) {
  const d = entry?.data || null;
  const msgs = d ? ` · ${t('usageMessages', { count: count(d.totals?.messages) })}` : '';
  const head = `<h3 id="usageH">${icon('cpu')} ${esc(t('usageTitle'))} <span>${esc(t(`usagePeriod_${p}`) + msgs)}</span></h3>${periodSegHtml(p)}`;
  let body;
  if (!d) body = `<p class="muted small">${esc(entry?.error ? t('usageLoadFailed') : t('usageLoading'))}</p>`;
  else {
    // A period without messages says so instead of four zeros; the 30 days below still show the project's history
    const numbers = d.totals?.messages ? `<div class="us-cards${cost ? '' : ' no-cost'}">${cardsHtml(d.totals, { showCost: cost, unpriced: d.unpriced || [], pricedAt: d.pricedAt })}</div>` : `<p class="muted small">${esc(t('usageNone'))}</p>`;
    body = `${numbers}${chartHtml(d.daily, cost)}${modelsHtml(d.models, cost)}${
      cost ? `<p class="small muted us-foot">${esc(t('usagePricedAt', { date: dateText(d.pricedAt) }))}</p>` : ''
    }${d.scanning ? `<p class="small muted us-foot">${esc(t('usageScanning'))}</p>` : ''}`;
  }
  return `<section class="dr-sec usage-sec" data-sec="usage" aria-labelledby="usageH">${head}${body}</section>`;
}

async function fetchUsage(projectId, p) {
  const res = await fetch(`/api/usage?period=${encodeURIComponent(p)}&project=${encodeURIComponent(projectId)}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Per project and period, the answer of GET /api/usage, kept for ttl ms; an older one is asked for again when the
// section is drawn (the drawer redraws with the live updates, so an open drawer stays current). onData(projectId)
// runs when an answer arrived. fetchJson and now are injected in tests.
export function createProjectUsage({ fetchJson = fetchUsage, onData = () => {}, now = () => Date.now(), ttl = 20000 } = {}) {
  const cache = new Map();
  function get(projectId, p) {
    const key = `${projectId}|${p}`;
    const e = cache.get(key);
    if (e && (e.pending || now() - e.at < ttl)) return e;
    const next = { at: e?.at || 0, data: e?.data || null, error: false, pending: true };
    cache.set(key, next);
    Promise.resolve()
      .then(() => fetchJson(projectId, p))
      .then(
        (data) => cache.set(key, { at: now(), data, error: false, pending: false }),
        () => cache.set(key, { at: now(), data: next.data, error: true, pending: false }),
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
    html: (projectId, opts = {}) => sectionHtml(get(projectId, opts.period || getPeriod()), opts),
    clear: () => cache.clear(),
  };
}
