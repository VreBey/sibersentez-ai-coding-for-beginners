// The brand's own icon (build/make-icon.mjs --from): PNGs recognised by their size, then packed into the ICO
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pngSize, brandPngs, encodeIco, encodePng, BRAND_SIZES } from '../build/make-icon.mjs';

const png = (w, h = w) => {
  const p = encodePng(w, Buffer.alloc(w * w * 4, 255));
  if (h === w) return p;
  const out = Buffer.from(p);
  out.writeUInt32BE(h, 20);
  return out;
};

test('the brand PNGs are recognised by their size, whatever their names; a missing size or a file that is not square is named', () => {
  assert.deepEqual(pngSize(png(48)), { width: 48, height: 48 });
  assert.equal(pngSize(Buffer.from('not a png at all, not at all')), null);
  const all = BRAND_SIZES.map((n, i) => ({ name: `logo-final-v${i}.png`, data: png(n) }));
  const ok = brandPngs([...all, { name: 'notes.png', data: Buffer.from('x') }]);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.bySize.keys()].sort((a, b) => a - b), [16, 32, 48, 256, 512]);
  const bad = brandPngs([...all.slice(1), { name: 'wide.png', data: png(64, 32) }]);
  assert.equal(bad.ok, false);
  assert.deepEqual([bad.missing, bad.notSquare], [[16], ['wide.png']]);
  // A preview or a banner beside the icons is left out, not an error
  const withBanner = brandPngs([...all, { name: 'banner.png', data: png(150, 57) }]);
  assert.equal(withBanner.ok, true);
  assert.deepEqual(withBanner.notSquare, ['banner.png']);
  // The ICO: one entry per given size, 256 written as 0 in the directory
  const ico = encodeIco([16, 256].map((size) => ({ size, png: png(size) })));
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0);
});
