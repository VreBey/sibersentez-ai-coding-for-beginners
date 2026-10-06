// HTTP layer: security headers, access rules, static files, API and SSE routes.
// A separate module so tests can run it on a random port with fake data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, sessionDetail, agentDetail } from './views.mjs';
import { projectSuggestions } from './suggest.mjs';
import { projectRun } from './runhint.mjs';
import { projectChanges, createChangesCache } from './changes.mjs';
import { projectTeam } from './team.mjs';
import { projectRestore } from './restore.mjs';
import { createFit } from './fit.mjs';
import { PERIODS } from './usage.mjs';
import { sharedToolDetector, toolsAnswer } from './tools.mjs';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Scripts only from our own files. Inline styles: attributes (the color variable --c) and <style> elements, which
  // the embedded terminal's screen (xterm.js) creates for its font and colors (docs/embedded-terminal.md); injected
  // CSS could not reach another site anyway (images, fonts and requests stay 'self'). style-src is the fallback for
  // browsers without -elem/-attr.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// Against DNS rebinding: only answer requests that arrive with local names
export function hostAllowed(req, port) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

// Reject requests triggered from another site (or another local port).
// Navigation from the address bar arrives as 'none', requests from our own page as 'same-origin'.
export function fetchSiteAllowed(req) {
  const s = req.headers['sec-fetch-site'];
  if (!s || s === 'none' || s === 'same-origin') return true;
  // Opening the panel from a link on another page is allowed: only a document navigation to the main page.
  // The page is read-only and cannot be framed; the API and other files stay open to the same origin only.
  const u = req.url || '';
  return req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && (u === '/' || u.startsWith('/?'));
}

// What the Settings screen copies for a problem report (docs/shell.md, "Diagnostics"): versions and Windows only; no
// path, no user name, no account. The version is package.json's, read once.
let appVersion;
export function aboutAnswer() {
  if (appVersion === undefined) {
    try {
      const v = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      appVersion = typeof v === 'string' && /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(v) ? v : null;
    } catch {
      appVersion = null;
    }
  }
  return {
    ok: true,
    version: appVersion,
    os: process.platform === 'win32' ? `Windows ${os.release()}` : `${process.platform} ${os.release()}`,
    arch: process.arch,
    electron: process.versions.electron || null,
    node: process.versions.node,
  };
}

export function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(data);
}

function serveStatic(res, urlPath, publicDir) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  } catch {
    return sendJson(res, 400, { error: 'bad-url' });
  }
  rel = path.normalize(rel).replace(/^([/\\])+/, '');
  const abs = path.join(publicDir, rel);
  if (!abs.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  const type = MIME[path.extname(abs).toLowerCase()];
  if (!type) return sendJson(res, 404, { error: 'not-found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not-found' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// GET /api/usage?period=24h|7d|month|30d[&project=<id>] -> { status, body }. No period: 24h. An unknown period or a
// malformed project id: 400. A project id that is neither listed nor in the ledger: 404.
export function usageRoute(usage, catalog, params) {
  if (!usage) return { status: 404, body: { error: 'not-found' } };
  const period = params.has('period') ? params.get('period') : '24h';
  if (!PERIODS.includes(period)) return { status: 400, body: { error: 'bad-period', periods: PERIODS } };
  let projectId = null;
  if (params.has('project')) {
    projectId = params.get('project');
    if (!PROJECT_ID.test(projectId)) return { status: 400, body: { error: 'bad-project' } };
  }
  const nameOf = (id) => (catalog?.getProject ? catalog.getProject(id)?.name || null : null);
  const body = usage.report(period, { projectId, nameOf });
  if (projectId !== null && !catalog?.getProject?.(projectId) && !body.totals.messages) return { status: 404, body: { error: 'project-not-found' } };
  if (projectId !== null) body.name = nameOf(projectId);
  return { status: 200, body };
}

// Action endpoints map to the path exactly (the query string is dropped, no decoding): '/api/%61ction' is not an action endpoint
function actionRoute(url) {
  const u = String(url || '');
  const q = u.indexOf('?');
  const p = q === -1 ? u : u.slice(0, q);
  return p === '/api/actions' || p === '/api/action' ? p : null;
}

// Request handler. A bad request (e.g. "//" or "%") must not crash the server: everything is caught and answered with 400.
// actions (optional, actions.mjs): when given, the /api/actions (GET) and /api/action (POST) routes are opened.
// POST is accepted only on /api/action; everywhere else 405 applies.
// instance (optional): value of the X-SiberSentez-Instance header put on every response (SIBERSENTEZ_INSTANCE).
// fit (optional): the fit service (server/fit.mjs) shared with the actions; one is made on first use when absent.
// usage (optional): the usage ledger (server/usage.mjs) behind GET /api/usage; without it the route answers 404.
// tools (optional): the AI tool detector (server/tools.mjs); default the one the start-ai action shares.
export function createHandler({ ingest, catalog, clients, port, publicDir, actions = null, instance = null, fit = null, usage = null, tools = null }) {
  // "What changed" answers, kept a few seconds per project (server/changes.mjs createChangesCache)
  const changesCache = createChangesCache();
  let fitService = fit;
  // Action endpoints apply their own, stricter rules (404 when off -> Origin -> Sec-Fetch-Site -> ...),
  // so they are split off before the general Sec-Fetch-Site and method checks. The Host check (421) still comes first.
  function routeAction(route, req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (actions.mode === 'off') return sendJson(res, 404, { error: 'actions-off' });
    // Wrong method 405: actions.mjs writes a single log line
    if (route === '/api/actions') {
      if (req.method === 'GET' || req.method === 'HEAD') return actions.handleGet(req, res);
      return actions.rejectMethod(req, res, route);
    }
    if (req.method !== 'POST') return actions.rejectMethod(req, res, route);
    Promise.resolve()
      .then(() => actions.handlePost(req, res))
      .catch((e) => {
        console.error('action error:', e?.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
        else res.end();
      });
  }

  function handle(req, res) {
    // Set first so every response (errors, SSE, static files, action routes) carries it; writeHead merges it
    if (instance) res.setHeader('X-SiberSentez-Instance', instance);
    if (!hostAllowed(req, port)) {
      res.writeHead(421, SECURITY_HEADERS);
      return res.end('Local access only.');
    }
    const route = actions ? actionRoute(req.url) : null;
    if (route) return routeAction(route, req, res);
    if (!fetchSiteAllowed(req)) return sendJson(res, 403, { error: 'cross-site' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'get-only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/api/snapshot') return sendJson(res, 200, snapshot(ingest, catalog));
    if (p === '/api/stream') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ scan: ingest.scan, t: Date.now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let m = /^\/api\/session\/([\w-]{8,64})$/.exec(p);
    if (m) {
      const d = sessionDetail(ingest, m[1]);
      return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'session-not-found' });
    }
    m = /^\/api\/agent\/([\w-]{4,64})$/.exec(p);
    if (m) {
      const d = agentDetail(ingest, m[1]);
      return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'agent-not-found' });
    }
    // Library items ranked for a project (docs/skills-flow.md §3.1): read-only, same rules as every API route
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/suggestions$/.exec(p);
    if (m) {
      const r = projectSuggestions({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // How to run the project (docs/run-hint.md): read-only, no action mode needed, nothing is run
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/run$/.exec(p);
    if (m) {
      const r = projectRun({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // "Do a job" progress from the team's hand-off files (docs/kit-in-app.md): read-only, no action mode needed
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/team$/.exec(p);
    if (m) {
      const r = projectTeam({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // Restore points of the project (docs/restore.md): read-only, no action mode needed
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/restore$/.exec(p);
    if (m) {
      const r = projectRestore({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // What changed in the project (docs/changes.md): read-only, no action mode needed
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/changes$/.exec(p);
    if (m) {
      changesCache.get({ catalog, projectId: m[1] }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { error: 'changes-failed' }),
      );
      return;
    }
    // Automatic skill fit (docs/auto-skills.md §3): read-only, no action mode needed, cached per project. ?idea= adds
    // the tags of what the person wants to build (docs/start-flow.md); the fit reads at most 300 characters of it and
    // it is never logged or written. Without ?idea the project's saved idea is used (the card's badge asks that way);
    // an explicit empty ?idea= asks for the fit without any idea.
    m = /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/fit$/.exec(p);
    if (m) {
      if (!fitService) fitService = createFit({ catalog, ingest });
      const r = fitService.get(m[1], { idea: url.searchParams.has('idea') ? url.searchParams.get('idea') : undefined });
      return sendJson(res, r.status, r.body);
    }
    // Token usage and API-equivalent cost (docs/usage.md §5): read-only, same rules as every API route
    if (p === '/api/usage') {
      const r = usageRoute(usage, catalog, url.searchParams);
      return sendJson(res, r.status, r.body);
    }
    // AI tools on this computer (docs/ai-start.md): read-only, no action mode needed, same access rules as every API
    // route. Detection runs on the first request, is cached for five minutes; ?refresh=1 checks again (throttled).
    // The answer holds no path and no output of any tool.
    if (p === '/api/about') return sendJson(res, 200, aboutAnswer());
    if (p === '/api/tools') {
      toolsAnswer(tools || sharedToolDetector(), { refresh: url.searchParams.get('refresh') === '1' }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { ok: false, error: 'detection-failed' }),
      );
      return;
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not-found' });
    return serveStatic(res, p, publicDir);
  }

  return (req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      console.error('request error:', e.message);
      if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' });
      else res.end();
    }
  };
}
