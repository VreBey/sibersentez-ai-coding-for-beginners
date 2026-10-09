// @ts-check
// What went wrong when Claude Code wrote an error in place of an answer (docs/attention.md, "When the AI stops on an
// error"). Claude Code logs such a turn as an assistant record with isApiErrorMessage: true, an `error` code and, for a
// limit, quotaLimits { rateLimitType, resetsAt (seconds) }. Seen on the owner's machine (2026-10-02, 185 records):
// rate_limit "You've hit your session limit · resets 2pm" (429), "...weekly limit...", server_error "API Error:
// Connection lost mid-response", invalid_request "Prompt is too long", authentication_failed "Not logged in · Please run
// /login" / "OAuth session expired", oauth_org_not_allowed "Your organization has disabled Claude subscription access".
// Pure: the page words each kind in its own language; only 'other' carries Claude Code's text (short, redacted).
import { truncate, redact } from './util.mjs';

export const API_ERROR_KINDS = Object.freeze(['limit-session', 'limit-week', 'login', 'org', 'connection', 'too-long', 'other']);

// o: the log record; t: its time (ms). Returns { kind, t, resetsAt? (ms), text? } or null when the record is no error.
export function apiErrorOf(o, t) {
  if (!o || o.isApiErrorMessage !== true) return null;
  const code = typeof o.error === 'string' ? o.error : '';
  const m = o.message;
  const text = Array.isArray(m?.content) ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ') : typeof m?.content === 'string' ? m.content : '';
  const q = o.quotaLimits && typeof o.quotaLimits === 'object' ? o.quotaLimits : null;
  let kind = 'other';
  if (code === 'rate_limit' || /hit your (session|weekly) limit/i.test(text)) {
    const week = /week|seven_day|7_day/i.test(String(q?.rateLimitType || '')) || /weekly limit/i.test(text);
    kind = week ? 'limit-week' : 'limit-session';
  } else if (code === 'authentication_failed' || /not logged in|please run \/login|oauth session expired/i.test(text)) kind = 'login';
  else if (code === 'oauth_org_not_allowed') kind = 'org';
  else if (code === 'invalid_request' && /prompt is too long/i.test(text)) kind = 'too-long';
  else if (code === 'server_error' || /^API Error: (Connection|Unable to connect|Can't reach|The response stopped)/i.test(text)) kind = 'connection';
  const out = { kind, t };
  const resets = Number(q?.resetsAt);
  if (kind.startsWith('limit') && Number.isFinite(resets) && resets > 0) out.resetsAt = resets < 1e12 ? resets * 1000 : resets;
  if (kind === 'other' && text) out.text = truncate(redact(text), 160);
  return out;
}
