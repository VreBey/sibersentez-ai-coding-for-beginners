// @ts-check
// Anthropic API prices used for the "API equivalent" estimate of live usage tracking (docs/usage.md §4).
// Dollars per million tokens. The table is dated: PRICED_AT is shown next to every dollar amount, and a model that is
// not in the table is never priced at $0 — it is reported as "price unknown" and the total says it is incomplete.
// Cache writes are priced from the input price: 5-minute writes at 1.25x, 1-hour writes at 2x.
// Source: the claude-api skill's pricing reference, read on 2026-09-25.

export const PRICED_AT = '2026-09-25';
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

// Model id -> { input, output, cacheRead } in $ / million tokens. Dated ids (claude-haiku-4-5-20251001) are matched by
// the longest id here that they start with, followed by '-', '@' or '[' (see priceOf).
const PRICES = Object.freeze({
  'claude-fable-5-1': Object.freeze({ input: 10, output: 50, cacheRead: 0.25 }),
  'claude-fable-5': Object.freeze({ input: 10, output: 50, cacheRead: 1 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheRead: 0.2 }),
  'claude-opus-5': Object.freeze({ input: 5, output: 25, cacheRead: 0.5 }),
  'claude-opus-4-8': Object.freeze({ input: 5, output: 25, cacheRead: 0.5 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.2 }),
  'claude-sonnet-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.2 }),
  'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15, cacheRead: 0.3 }),
  'claude-haiku-4-5': Object.freeze({ input: 1, output: 5, cacheRead: 0.1 }),
});

const IDS_LONGEST_FIRST = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const cache = new Map();

// Price row of a model id, or null when the model is not in the table. An exact id wins; otherwise the longest table
// id that the model starts with, when the rest begins with '-' (a date or a variant), '@' or '[' (a context marker).
// 'claude-opus-5-5-20260901' is claude-opus-5-5, never claude-opus-5; 'claude-opus-50' matches nothing.
export function priceOf(model) {
  if (typeof model !== 'string' || !model) return null;
  if (cache.has(model)) return cache.get(model);
  let hit = PRICES[model] || null;
  if (!hit) {
    for (const id of IDS_LONGEST_FIRST) {
      if (model.startsWith(id) && /^[-@[]/.test(model.slice(id.length))) {
        hit = PRICES[id];
        break;
      }
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(model, hit);
  return hit;
}

// Dollars for one set of token counts of one model, or null when the model has no price.
// c: { input, cacheWrite5m, cacheWrite1h, cacheRead, output } (missing fields count as 0).
export function costOf(model, c) {
  const p = priceOf(model);
  if (!p) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return (
    (n(c?.input) * p.input +
      n(c?.cacheWrite5m) * p.input * CACHE_WRITE_5M +
      n(c?.cacheWrite1h) * p.input * CACHE_WRITE_1H +
      n(c?.cacheRead) * p.cacheRead +
      n(c?.output) * p.output) /
    1e6
  );
}
