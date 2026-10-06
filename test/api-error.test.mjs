// When the AI stops on an error (server/apierror.mjs, public/js/apiError.js, docs/attention.md): Claude Code's error
// records are told apart, kept on the lead session until a real answer, said once as they happen, and worded for the
// person in the page's language. Record shapes are the ones seen in the owner's logs (2026-10-02).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Ingest } from '../server/ingest.mjs';
import { sessionView } from '../server/views.mjs';
import { apiErrorOf, API_ERROR_KINDS } from '../server/apierror.mjs';
import { liveApiError, projectApiError, apiErrorWords, apiErrorHtml } from '../public/js/apiError.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
setLanguage('en');

// An error record as Claude Code writes it
const errRec = (text, error, t = '2026-10-02T09:00:00Z', extra = {}) => ({
  parentUuid: 'x',
  isSidechain: false,
  type: 'assistant',
  uuid: 'u-' + t,
  timestamp: t,
  message: { id: 'm-' + t, container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] },
  error,
  isApiErrorMessage: true,
  cwd: 'C:\\p1',
  ...extra,
});
const answer = (t) => ({ parentUuid: 'x', isSidechain: false, type: 'assistant', timestamp: t, message: { model: 'claude-opus-5-5', id: 'a-' + t, role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { output_tokens: 3, input_tokens: 1 } }, cwd: 'C:\\p1' });
const fakeCatalog = () => ({ resolve: () => 'p1', getProject: () => null, allProjects: () => [], roster: new Map() });
function feed(ing, ctx, st, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  ing.line(ctx, st, buf, 0, buf.length);
}

test('the kinds Claude Code writes are told apart; a limit keeps when it opens again; an unknown one keeps its text, short', () => {
  const t = 1;
  const limit = apiErrorOf(errRec("You've hit your session limit · resets 2pm (Europe/Istanbul)", 'rate_limit', undefined, { quotaLimits: { status: 'rejected', resetsAt: 1790089800, rateLimitType: 'five_hour' } }), t);
  assert.deepEqual(limit, { kind: 'limit-session', t, resetsAt: 1790089800000 });
  assert.equal(apiErrorOf(errRec("You've hit your weekly limit · resets Sep 5, 3pm", 'rate_limit'), t).kind, 'limit-week');
  assert.equal(apiErrorOf(errRec('Not logged in · Please run /login', 'authentication_failed'), t).kind, 'login');
  assert.equal(apiErrorOf(errRec('Failed to authenticate: OAuth session expired and could not be refreshed', 'authentication_failed'), t).kind, 'login');
  assert.equal(apiErrorOf(errRec('Your organization has disabled Claude subscription access for Claude Code', 'oauth_org_not_allowed'), t).kind, 'org');
  assert.equal(apiErrorOf(errRec('API Error: Connection lost mid-response. The response above may be incomplete.', 'server_error'), t).kind, 'connection');
  assert.equal(apiErrorOf(errRec('Prompt is too long', 'invalid_request'), t).kind, 'too-long');
  const other = apiErrorOf(errRec('Something new ' + 'x'.repeat(400), 'mystery'), t);
  assert.equal(other.kind, 'other');
  assert.ok(other.text.length <= 161);
  assert.equal(apiErrorOf(answer('2026-10-02T09:00:00Z'), t), null, 'a real answer is no error');
  for (const k of API_ERROR_KINDS) assert.ok(apiErrorWords({ kind: k, t }), k);
});

test('ingest: the lead keeps its newest error until a real answer; said once as it happens, never for the logs read at start; an agent\'s is not kept', () => {
  const ing = new Ingest(fakeCatalog());
  ing.cutoff = 0;
  ing.initial = true;
  const s = ing.getSession('s1', null);
  const st = {};
  feed(ing, s, st, errRec('Not logged in · Please run /login', 'authentication_failed', '2026-10-02T08:00:00Z'));
  assert.equal(s.apiError.kind, 'login');
  assert.ok(!ing.events.some((e) => e.kind === 'ai_error'), 'read at start: no notice');
  ing.initial = false;
  feed(ing, s, st, errRec("You've hit your session limit · resets 2pm", 'rate_limit', '2026-10-02T09:00:00Z'));
  assert.equal(s.apiError.kind, 'limit-session');
  assert.equal(ing.events.filter((e) => e.kind === 'ai_error').length, 1, 'said once');
  feed(ing, s, st, errRec("You've hit your session limit · resets 2pm", 'rate_limit', '2026-10-02T09:00:00Z'));
  assert.equal(ing.events.filter((e) => e.kind === 'ai_error').length, 1, 'the same line read again is not said again');
  feed(ing, s, st, answer('2026-10-02T08:30:00Z'));
  assert.equal(s.apiError?.kind, 'limit-session', 'an older answer does not clear a newer error');
  assert.equal(sessionView(ing, s).apiError.kind, 'limit-session', 'the page gets it');
  feed(ing, s, st, answer('2026-10-02T14:05:00Z'));
  assert.equal(s.apiError, null, 'a real answer after it clears it');
  const ag = ing.getAgent({ agentId: 'a1', sessionId: 's1', slug: 'x', workflowRunId: null }, 'C:\\none\\agent-a1.jsonl');
  feed(ing, ag, {}, errRec('Prompt is too long', 'invalid_request', '2026-10-02T15:00:00Z'));
  assert.ok(!ag.apiError, 'only the lead');
});

test('the page: an error counts for a day, a limit until an hour after it opened; the newest of a project; words in both languages', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const s = (id, apiError, projectId = 'p') => ({ id, projectId, apiError });
  assert.equal(liveApiError(s('a', { kind: 'login', t: now - 25 * 3600000 }), now), null, 'older than a day');
  assert.equal(liveApiError(s('a', { kind: 'limit-session', t: now - 3 * 3600000, resetsAt: now - 2 * 3600000 }), now), null, 'opened long ago');
  assert.equal(liveApiError(s('a', { kind: 'nonsense', t: now }), now), null, 'unknown kind');
  const list = [s('a', { kind: 'connection', t: now - 60000 }), s('b', { kind: 'login', t: now - 1000 }), s('c', { kind: 'too-long', t: now }, 'other')];
  assert.equal(projectApiError(list, 'p', now).s.id, 'b');
  assert.equal(projectApiError([], 'p', now), null);
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const S = STRINGS[lang];
    const waiting = apiErrorWords({ kind: 'limit-session', t: now - 60000, resetsAt: now + 3600000 }, now);
    assert.equal(waiting.title, S['aeTitle_limit-session']);
    assert.ok(waiting.body.startsWith(S['aeBody_limit-session']) && waiting.tone === 'stop', lang);
    assert.ok(waiting.body.includes(S.aeOpensAt.split('{time}')[0].trim()), 'when it opens again');
    const opened = apiErrorWords({ kind: 'limit-session', t: now - 3600000, resetsAt: now - 60000 }, now);
    assert.equal(opened.title, S.aeOpened);
    assert.equal(opened.tone, 'warn');
    assert.equal(apiErrorWords({ kind: 'login', t: now }, now).body, S.aeBody_login);
    assert.ok(apiErrorWords({ kind: 'other', t: now, text: 'odd <b>' }, now).body.includes('odd <b>'));
  }
  setLanguage('en');
  const h = apiErrorHtml({ kind: 'other', t: now, text: '<script>' }, now);
  assert.ok(h.includes('&lt;script&gt;') && h.includes('data-ai-error="other"'), 'escaped');
  assert.equal(apiErrorHtml(null, now), '');
});

test('wiring: the drawer (project and session), the Building\'s job box, the notice', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const drawer = read('public/js/views/drawer.js');
  assert.ok(drawer.includes('${apiErrorHtml(projectApiError(store.sessions.values(), p.id)?.e)}') && drawer.includes('${apiErrorHtml(liveApiError(store.sessions.get(d.id)))}'));
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes('box.hidden = !job && !err;') && ws.includes('errKey()]);'), 'shown without a job, redrawn when it changes');
  const notify = read('public/js/notify.js');
  assert.ok(notify.includes("e.kind === 'ai_error'"));
  assert.ok(read('server/views.mjs').includes('apiError: s.apiError || null,'));
});

test('wiring: a stopped session waits in the Building\'s inbox over every project; an opened limit is said once, never for one that opened before the page looked', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes("items.push({ p, s: err.s, kind: 'error', text: apiErrorWords(err.e, now)?.title || '' })"));
  const dash = ws.slice(ws.indexOf('function renderDashboard()'), ws.indexOf('renderJobBox();', ws.indexOf('function renderDashboard()')));
  assert.ok(dash.indexOf('renderInbox();') < dash.indexOf('if (sig === keys.dash) return;'), 'asked on every draw');
  const notify = read('public/js/notify.js');
  assert.ok(notify.includes('if (firstLook || now - e.resetsAt > 10 * 60000) continue;') && notify.includes('opened.add(key);'));
});
