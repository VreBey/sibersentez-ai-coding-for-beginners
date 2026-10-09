// @ts-check
// The project's "what it will do" layer. For projects with a CCGS layout:
//   production/stage.txt                 → stage (e.g. "Systems Design")
//   production/review-mode.txt           → review mode (full / lean)
//   production/session-state/active.md   → the status block at its top (<!-- STATUS --> … <!-- /STATUS -->)
//                                          or, if missing, the first "*Son güncelleme: …*" paragraph
// active.md can be hundreds of KB; only the first 16 KB is read.
import fs from 'node:fs';
import path from 'node:path';
import { truncate, redact } from './util.mjs';

const HEAD_BYTES = 16384;

function readText(file, limit) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      let s = buf.toString('utf8', 0, n);
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      return s;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Strip Markdown decoration: bold, italic, code, links; simplify emoji and whitespace
export function plainText(md) {
  return String(md || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseActive(head) {
  if (!head) return {};
  const out = {};
  const block = /<!--\s*STATUS\s*-->([\s\S]*?)<!--\s*\/STATUS\s*-->/.exec(head);
  if (block) {
    for (const line of block[1].split(/\r?\n/)) {
      const m = /^\s*\*\*([^*:]+):\*\*\s*(.+)$/.exec(line);
      if (m) out[m[1].trim().toLocaleLowerCase('tr-TR')] = m[2].trim();
    }
    return {
      phase: out['aşama'] ? plainText(out['aşama']) : null,
      current: out['aktif görev'] ? plainText(out['aktif görev']) : null,
      next: out['sıradaki'] ? plainText(out['sıradaki']) : null,
      open: out['açık'] ? plainText(out['açık']) : null,
    };
  }
  // No status block: the update paragraph at the very top (what follows the date)
  const para = /^\*Son güncelleme:\s*([^\n]*?)\*\s*$/m.exec(head) || /^\*Son güncelleme:\s*([\s\S]*?)\*\s*\n\s*\n/m.exec(head);
  if (!para) return {};
  // What follows the date: the separator is an em dash (—); do not trip on the date's own dashes
  const body = para[1].includes('—') ? para[1].replace(/^[^—]*—\s*/, '') : para[1];
  const nx = /\*\*Sıradaki[^*]*?\*\*:?\s*([^*]+)/.exec(body) || /Sıradaki[^:]*:\s*([^.*]+)/.exec(body);
  return { phase: null, current: plainText(body), next: nx ? plainText(nx[1]) : null, open: null };
}

export function readPlan(projectPath) {
  if (!projectPath) return null;
  const prod = path.join(projectPath, 'production');
  let stat;
  try {
    stat = fs.statSync(prod);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const stage = (readText(path.join(prod, 'stage.txt'), 200) || '').trim() || null;
  const reviewMode = (readText(path.join(prod, 'review-mode.txt'), 100) || '').trim() || null;
  const activeFile = path.join(prod, 'session-state', 'active.md');
  const parsed = parseActive(readText(activeFile, HEAD_BYTES));
  let updatedAt = 0;
  try {
    updatedAt = fs.statSync(activeFile).mtimeMs;
  } catch {
    /* no file */
  }
  if (!stage && !parsed.current && !parsed.next) return null;
  return {
    stage,
    reviewMode,
    phase: parsed.phase ? truncate(redact(parsed.phase), 160) : null,
    current: parsed.current ? truncate(redact(parsed.current), 420) : null,
    next: parsed.next ? truncate(redact(parsed.next), 320) : null,
    open: parsed.open ? truncate(redact(parsed.open), 320) : null,
    updatedAt,
    source: 'production/session-state/active.md',
  };
}
