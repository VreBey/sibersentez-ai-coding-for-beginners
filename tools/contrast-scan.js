// Contrast scan (docs/internal/evidence-2026-10-08.md): run in the page (DevTools console, or a headless browser's
// Runtime.evaluate). Every visible text's colour against its background (the first opaque one up the ancestors, with the
// translucent ones over it; gradients and images are not measured), WCAG 2.2: 4.5:1, or 3:1 for large text. Answers how
// many texts were measured, the lowest ratio, and every one below its threshold, grouped by class.
(() => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  function bgOf(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 15, g: 22, b: 36, a: 1 }; // --bg
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  }
  const out = new Map();
  let measured = 0; let minR = 99; let minWhat = '';
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (text.length < 2) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
    if (el.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    let fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    if (fg.a < 1) fg = over(fg, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    measured++;
    if (ratio < minR) { minR = ratio; minWhat = `${(el.className || el.tagName).toString().slice(0, 30)} ${size}px :: ${text.slice(0, 30)}`; }
    if (ratio >= need) continue;
    const disabled = el.closest('[disabled],[aria-disabled="true"]');
    const key = `${(el.className || el.tagName).toString().trim().split(/\s+/).slice(0, 2).join('.') || el.tagName}${disabled ? ' (disabled)' : ''}`;
    const prev = out.get(key);
    if (!prev || ratio < prev.ratio) out.set(key, { ratio: Math.round(ratio * 100) / 100, size, text: text.slice(0, 40), need });
  }
  const head = `measured=${measured} min=${Math.round(minR * 100) / 100}:1 (${minWhat})
`;
  return head + [...out].sort((a, b) => a[1].ratio - b[1].ratio).map(([k, v]) => `${v.ratio}:1 (need ${v.need}) ${v.size}px ${k} :: ${v.text}`).join('\n') || 'none';
})()
