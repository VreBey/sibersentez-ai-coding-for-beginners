// Performance baseline (docs/internal/evidence-2026-10-08.md): starts the server on its own port with actions off, and measures
// how long it takes to answer, to finish the first scan of the AI tools' logs, and the snapshot's time and size. It
// only reads the logs; the hub given is used instead of the real one. Three runs.
// Run: node tools/perf-baseline.mjs <repo folder> <an empty hub folder>
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const [repo, hub] = process.argv.slice(2);
const PORT = 47993;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 60000 }, (res) => {
    let n = 0;
    const chunks = [];
    res.on('data', (c) => { n += c.length; chunks.push(c); });
    res.on('end', () => resolve({ status: res.statusCode, bytes: n, ms: performance.now() - t0, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});
// The SSE hello carries the scan state
const scanState = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stream' }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      const m = /event: hello\ndata: (.*)\n/.exec(buf);
      if (m) { req.destroy(); try { resolve(JSON.parse(m[1]).scan); } catch { resolve(null); } }
    });
  });
  req.on('error', () => resolve(null));
});

async function once() {
  const t0 = performance.now();
  const child = spawn(process.execPath, [path.join(repo, 'server', 'index.mjs')], { env: { ...process.env, SIBERSENTEZ_PORT: String(PORT), SIBERSENTEZ_HUB: hub, SIBERSENTEZ_ACTIONS: 'off' }, stdio: 'ignore', windowsHide: true });
  try {
    let up = null;
    for (let i = 0; i < 600 && up === null; i++) {
      try { await get('/api/health'); up = performance.now() - t0; } catch { await sleep(100); }
    }
    let ready = null;
    let last = null;
    for (let i = 0; i < 1200; i++) {
      last = await scanState();
      if (last && (last.state === 'ready' || last.done === true)) { ready = performance.now() - t0; break; }
      await sleep(250);
    }
    const snap = await get('/api/snapshot');
    const snap2 = await get('/api/snapshot');
    let counts = {};
    try { const d = JSON.parse(snap.body); counts = { projects: (d.projects || []).length, sessions: (d.sessions || []).length, agents: (d.agents || []).length, roster: (d.roster || []).length }; } catch {}
    return { upMs: Math.round(up), readyMs: ready && Math.round(ready), scan: last, snapshotMs: Math.round(snap.ms), snapshotMs2: Math.round(snap2.ms), snapshotKB: Math.round(snap.bytes / 1024), counts };
  } finally {
    child.kill();
    await sleep(500);
  }
}

const runs = [];
for (let i = 0; i < 3; i++) runs.push(await once());
console.log(JSON.stringify(runs, null, 1));
