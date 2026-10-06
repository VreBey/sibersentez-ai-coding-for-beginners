// Generates the app icons; no external tool or browser needed. Since the brand (2026-09-30) they come from the
// design package's PNGs: node build/make-icon.mjs --from qa/chatgpt-tasarim/teslim/1-marka. Without --from it draws
// public/favicon.svg, which only works for a favicon made of the simple elements below (the brand S uses curves).
// Outputs: build/icon.png (512), build/icon.ico (16-256, embedded PNG), electron/assets/icon.png (256),
// electron/assets/tray.png (16) and tray@2x.png (32).
// Only the elements used by the favicon are supported: rect (rx), path ("M x y L x y", round-capped line), circle;
// any other element raises an error instead of being drawn wrong silently.
// Usage: node build/make-icon.mjs
//        node build/make-icon.mjs --from <folder>   the brand's own PNGs (the design package, qa/chatgpt-tasarim): each
//        file is recognised by its size, not its name; 16, 32, 48, 256 and 512 must be there (24, 64, 128 are made
//        from nothing: the ICO simply leaves them out; Windows scales the nearest one)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'public', 'favicon.svg');
const SUPERSAMPLE = 4; // 4x4 samples per pixel (anti-aliasing)

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) throw new Error(`unsupported color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function parseFavicon(svg) {
  for (const m of svg.matchAll(/<([a-zA-Z]+)/g)) {
    if (!['svg', 'rect', 'path', 'circle'].includes(m[1])) throw new Error(`unsupported element: <${m[1]}>`);
  }
  const vb = /viewBox="([^"]+)"/.exec(svg);
  if (!vb) throw new Error('missing viewBox');
  const [minX, minY, width, height] = vb[1].trim().split(/[\s,]+/).map(Number);
  const shapes = [];
  for (const m of svg.matchAll(/<(rect|path|circle)\b([^>]*?)\/?>/g)) {
    const a = attrs(m[2]);
    if (m[1] === 'rect') {
      shapes.push({ type: 'rect', x: +(a.x || 0), y: +(a.y || 0), w: +a.width, h: +a.height, r: +(a.rx || 0), color: rgb(a.fill) });
    } else if (m[1] === 'circle') {
      shapes.push({ type: 'circle', cx: +a.cx, cy: +a.cy, r: +a.r, color: rgb(a.fill) });
    } else {
      const d = /^M\s*([\d.]+)[\s,]+([\d.]+)\s*L\s*([\d.]+)[\s,]+([\d.]+)$/.exec((a.d || '').trim());
      if (!d || a['stroke-linecap'] !== 'round' || (a.fill && a.fill !== 'none')) throw new Error(`unsupported path: ${a.d}`);
      shapes.push({ type: 'line', x1: +d[1], y1: +d[2], x2: +d[3], y2: +d[4], hw: +a['stroke-width'] / 2, color: rgb(a.stroke) });
    }
  }
  if (!shapes.length) throw new Error('nothing to draw');
  return { minX, minY, width, height, shapes };
}

function inside(s, x, y) {
  if (s.type === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
  if (s.type === 'rect') {
    if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
    const r = Math.min(s.r, s.w / 2, s.h / 2);
    const cx = Math.min(Math.max(x, s.x + r), s.x + s.w - r);
    const cy = Math.min(Math.max(y, s.y + r), s.y + s.h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
  }
  // Distance to the line segment (round caps included)
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)));
  return (x - (s.x1 + t * dx)) ** 2 + (y - (s.y1 + t * dy)) ** 2 <= s.hw ** 2;
}

// RGBA pixel buffer (straight alpha)
export function render(icon, size) {
  const out = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = icon.minX + ((px + (sx + 0.5) / SUPERSAMPLE) * icon.width) / size;
          const y = icon.minY + ((py + (sy + 0.5) / SUPERSAMPLE) * icon.height) / size;
          let c = null;
          for (const s of icon.shapes) if (inside(s, x, y)) c = s.color; // all opaque: the topmost wins
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); // filter 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with embedded PNGs (Windows Vista and later)
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// Width and height of a PNG from its IHDR, or null when the bytes are not a PNG (pure)
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !sig.every((b, i) => buf[i] === b) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export const BRAND_SIZES = Object.freeze([16, 32, 48, 256, 512]);

// The brand PNGs by size (pure over their bytes): { ok, bySize: Map(size -> png), missing, notSquare }. A file that is
// not square is no icon (a preview, an installer banner) and is left out, named in notSquare; ok is false only when a
// needed size is missing. A second file of the same size is ignored.
export function brandPngs(files) {
  const bySize = new Map();
  const notSquare = [];
  for (const { name, data } of files) {
    const d = pngSize(data);
    if (!d) continue;
    if (d.width !== d.height) {
      notSquare.push(name);
      continue;
    }
    if (!bySize.has(d.width)) bySize.set(d.width, data);
  }
  const missing = BRAND_SIZES.filter((n) => !bySize.has(n));
  return { ok: missing.length === 0, bySize, missing, notSquare };
}

function fromBrandFolder(dir, write) {
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.png'))
    .map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }));
  const r = brandPngs(files);
  if (!r.ok) throw new Error(`brand PNGs incomplete: missing ${r.missing.join(', ')}`);
  if (r.notSquare.length) console.log(`left out (not square): ${r.notSquare.join(', ')}`);
  const png = (n) => r.bySize.get(n);
  write('build/icon.png', png(512));
  write('build/icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256].filter((n) => r.bySize.has(n)).map((size) => ({ size, png: png(size) }))));
  write('electron/assets/icon.png', png(256));
  write('electron/assets/tray.png', png(16));
  write('electron/assets/tray@2x.png', png(32));
}

function main() {
  const png = (size) => encodePng(size, render(parseFavicon(fs.readFileSync(SOURCE, 'utf8')), size));
  const write = (rel, data) => {
    const file = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    console.log(`${rel} (${data.length} bytes)`);
  };
  const from = process.argv.indexOf('--from');
  if (from > 0) return fromBrandFolder(path.resolve(process.argv[from + 1] || ''), write);
  write('build/icon.png', png(512));
  write('build/icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) }))));
  write('electron/assets/icon.png', png(256));
  write('electron/assets/tray.png', png(16));
  write('electron/assets/tray@2x.png', png(32));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
