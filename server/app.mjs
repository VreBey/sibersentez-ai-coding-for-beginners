// @ts-check
// HTTP layer: security headers, access rules, static files, API and SSE routes.
// A separate module so tests can run it on a random port with fake data.
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, sessionDetail, agentDetail } from './views.mjs';
import { projectSuggestions } from './suggest.mjs';
import { projectRun } from './runhint.mjs';
import { createChangesCache } from './changes.mjs';
import { projectTeam } from './team.mjs';
import { projectRestoreWithDisk, createJobChangesCache } from './restore.mjs';
import { projectPublishCheck } from './publishCheck.mjs';
import { createFit } from './fit.mjs';
import { PERIODS } from './usage.mjs';
import { jobCostsRoute } from './jobCost.mjs';
import { PROJECT_ID_RE, PROJECT_ID_SRC } from './util.mjs';
import { sharedToolDetector, toolsAnswer } from './tools.mjs';
import { createUpdateChecker, UPDATE_CHECK_FILE } from './update.mjs';

const MIME = {
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
function hostAllowed(req, port) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

// The session key (review A1): the desktop shell makes a fresh secret every launch, gives it to the server
// (SIBERSENTEZ_SESSION_KEY) and adds it to every request its own window sends (electron/helpers.mjs withSessionKey).
// Every /api route then needs it: another program on this computer, or another Windows account, can no longer read the
// sessions or fetch the action token by copying the headers a browser would send. The page never sees the key. Without
// a key (the server started on its own, for development and headless screenshots) nothing changes. Static files stay
// open: they are the app's own code. A URL that cannot be read is treated as an /api one.
export const SESSION_KEY_HEADER = 'x-sibersentez-key';
// Open live streams (/api/stream) at most
export const STREAM_MAX = 16;
export function sessionKeyAllowed(req, key) {
  if (!key) return true;
  let p;
  try {
    p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  if (p !== '/api' && !p.startsWith('/api/')) return true;
  const given = req.headers[SESSION_KEY_HEADER];
  if (typeof given !== 'string' || given.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

// Reject requests triggered from another site (or another local port).
// Navigation from the address bar arrives as 'none', requests from our own page as 'same-origin'.
function fetchSiteAllowed(req) {
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

// /api/projects/<id>/<what>: the id and the what, or null (one id rule: util.mjs)
const PROJECT_ROUTE = new RegExp(`^/api/projects/(${PROJECT_ID_SRC})/([a-z-]{1,40})$`);
const projectRoute = (p, what) => {
  const m = PROJECT_ROUTE.exec(p);
  return m && m[2] === what ? m : null;
};

// GET /api/usage?period=24h|7d|month|30d[&project=<id>] -> { status, body }. No period: 24h. An unknown period or a
// malformed project id: 400. A project id that is neither listed nor in the ledger: 404.
export function usageRoute(usage, catalog, params) {
  if (!usage) return { status: 404, body: { error: 'not-found' } };
  const period = params.has('period') ? params.get('period') : '24h';
  if (!PERIODS.includes(period)) return { status: 400, body: { error: 'bad-period', periods: PERIODS } };
  let projectId = null;
  if (params.has('project')) {
    projectId = params.get('project');
    if (!PROJECT_ID_RE.test(projectId)) return { status: 400, body: { error: 'bad-project' } };
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
// sessionKey (optional): when set, every /api route answers 401 without it (sessionKeyAllowed, SIBERSENTEZ_SESSION_KEY).
export function createHandler({ ingest, catalog, clients, port, publicDir, actions = null, instance = null, fit = null, usage = null, tools = null, updates = null, sessionKey = null }) {
  // "A new version is out" (server/update.mjs): asked by the page only when the person turned it on in Settings
  let updateChecker = updates;
  // "What changed" answers, kept a few seconds per project (server/changes.mjs createChangesCache)
  const changesCache = createChangesCache();
  // "This job's result": one comparison per project and job for a few seconds (restore.mjs createJobChangesCache)
  const jobChangesCache = createJobChangesCache();
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
    if (!sessionKeyAllowed(req, sessionKey)) return sendJson(res, 401, { error: 'session-key' });
    const route = actions ? actionRoute(req.url) : null;
    if (route) return routeAction(route, req, res);
    if (!fetchSiteAllowed(req)) return sendJson(res, 403, { error: 'cross-site' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'get-only' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/api/snapshot') return sendJson(res, 200, snapshot(ingest, catalog));
    if (p === '/api/stream') {
      // The window holds one stream; a few more for a reload in between. More is a page stuck reconnecting or a
      // program holding the server open (review A7): refused, the page's EventSource tries again later
      if (clients.size >= STREAM_MAX) return sendJson(res, 503, { error: 'too-many-streams' });
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
    m = projectRoute(p, 'suggestions');
    if (m) {
      const r = projectSuggestions({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // How to run the project (docs/run-hint.md): read-only, no action mode needed, nothing is run
    m = projectRoute(p, 'run');
    if (m) {
      const r = projectRun({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // "Do a job" progress from the team's hand-off files (docs/kit-in-app.md): read-only, no action mode needed
    m = projectRoute(p, 'team');
    if (m) {
      const r = projectTeam({ catalog, projectId: m[1] });
      return sendJson(res, r.status, r.body);
    }
    // Restore points of the project (docs/restore.md): read-only, no action mode needed
    m = projectRoute(p, 'restore');
    if (m) {
      projectRestoreWithDisk({ catalog, projectId: m[1] }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { error: 'restore-failed' }),
      );
      return;
    }
    // What changed since a job's start copy (docs/restore.md §9): read-only, no action mode needed
    m = projectRoute(p, 'job-changes');
    if (m) {
      jobChangesCache({ catalog, projectId: m[1], jobId: url.searchParams.get('job') || '' }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { error: 'job-changes-failed' }),
      );
      return;
    }
    // What changed in the project (docs/changes.md): read-only, no action mode needed
    m = projectRoute(p, 'changes');
    if (m) {
      changesCache.get({ catalog, projectId: m[1] }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { error: 'changes-failed' }),
      );
      return;
    }
    // Before publishing (plan E1): what in the project should not go online (read-only, no account, no network)
    m = projectRoute(p, 'publish-check');
    if (m) {
      projectPublishCheck({ catalog, projectId: m[1] }).then(
        (r) => sendJson(res, r.status, r.body),
        () => sendJson(res, 500, { error: 'publish-check-failed' }),
      );
      return;
    }
    // Automatic skill fit (docs/auto-skills.md §3): read-only, no action mode needed, cached per project. ?idea= adds
    // the tags of what the person wants to build (docs/start-flow.md); the fit reads at most 300 characters of it and
    // it is never logged or written. Without ?idea the project's saved idea is used (the card's badge asks that way);
    // an explicit empty ?idea= asks for the fit without any idea.
    m = projectRoute(p, 'fit');
    if (m) {
      if (!fitService) fitService = createFit({ catalog, ingest });
      const r = fitService.get(m[1], { idea: url.searchParams.has('idea') ? url.searchParams.get('idea') : undefined });
      return sendJson(res, r.status, r.body);
    }
    // Token usage and API-equivalent cost (docs/usage.md §5): read-only, same rules as every API route
    // What the recent jobs cost and what the next may (plan B5): read-only, the ledger and the jobs' start records
    if (p === '/api/usage/jobs') {
      const pid = url.searchParams.get('project');
      if (pid !== null && !PROJECT_ID_RE.test(pid)) return sendJson(res, 400, { error: 'bad-project' });
      const r = jobCostsRoute({ ledger: usage, catalog, projectId: pid });
      return sendJson(res, r.status, r.body);
    }
    if (p === '/api/usage') {
      const r = usageRoute(usage, catalog, url.searchParams);
      return sendJson(res, r.status, r.body);
    }
    // AI tools on this computer (docs/ai-start.md): read-only, no action mode needed, same access rules as every API
    // route. Detection runs on the first request, is cached for five minutes; ?refresh=1 checks again (throttled).
    // The answer holds no path and no output of any tool.
    if (p === '/api/about') return sendJson(res, 200, aboutAnswer());
    // The one request SiberSentez makes outside this computer for itself, and only when the person turned it on: the
    // latest release of its own repository, at most once a day (server/update.mjs). The answer: versions and the
    // release page's link. The last answer is kept in the hub (update-check.json), so starting again does not ask again.
    // The switch lives in the page (its browser storage): a local program that calls this route itself makes the
    // same single request a day at most, nothing more (review 2026-10-08).
    if (p === '/api/update') {
      if (!updateChecker) updateChecker = createUpdateChecker({ current: aboutAnswer().version, file: typeof catalog?.hubDir === 'string' && catalog.hubDir ? path.join(catalog.hubDir, UPDATE_CHECK_FILE) : null });
      updateChecker.check().then(
        (a) => sendJson(res, 200, a),
        () => sendJson(res, 200, { ok: false, reason: 'network' }),
      );
      return;
    }
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
