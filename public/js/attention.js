// What needs the person: the state of each open session and project, and the order that puts "waiting for you" first
// (docs/attention.md). Pure functions over the store's sessions and projects, so the header, the rail, the project
// list and the scene use the same four states and the tests can check them without a page.
import { isHiddenProject } from './hiddenProjects.js';

// An open session that finished its turn this long ago or less is waiting for the person; one that has sat idle
// longer was left open (a terminal nobody is looking at): 'left', not waiting.
export const WAIT_FRESH_MS = 6 * 3600 * 1000;

// The four states, most urgent first. Each has one word in the UI (attnState_<state>) and one color class (s-<state>).
export const STATES = Object.freeze(['waiting', 'busy', 'left', 'closed']);

// A session's state: busy while its tool runs; waiting when it finished a turn within WAIT_FRESH_MS; left when it has
// been open and quiet longer (the raw live status says 'idle' for both); closed when no process runs it.
export function sessionState(s, now = Date.now()) {
  if (!s?.live) return 'closed';
  if (s.live.status === 'busy') return 'busy';
  // Claude Code itself says the session waits for the person (a permission, a question): waiting however long ago
  if (s.live.status === 'waiting') return 'waiting';
  const since = Number(s.live.since) || 0;
  return since && now - since <= WAIT_FRESH_MS ? 'waiting' : 'left';
}

// The sessions waiting for the person, the one that finished last first
export function waitingSessions(sessions, now = Date.now()) {
  return [...sessions]
    .filter((s) => sessionState(s, now) === 'waiting')
    .sort((a, b) => (Number(b.live.since) || 0) - (Number(a.live.since) || 0));
}

// Counts of the open sessions by state: { waiting, busy, left }
export function sessionCounts(sessions, now = Date.now()) {
  const out = { waiting: 0, busy: 0, left: 0 };
  for (const s of sessions) {
    const st = sessionState(s, now);
    if (st !== 'closed') out[st]++;
  }
  return out;
}

// A project's state from its open sessions and running agents: waiting when any session waits (the person is needed
// even while another session works), busy when a session or an agent works, left when a session is open and quiet,
// closed otherwise. byProject: Map(projectId -> sessions) (see groupSessions).
export function projectState(p, byProject, now = Date.now()) {
  let busy = (p?.runningAgents || 0) > 0;
  let left = false;
  for (const s of byProject?.get(p?.id) || []) {
    const st = sessionState(s, now);
    if (st === 'waiting') return 'waiting';
    if (st === 'busy') busy = true;
    else if (st === 'left') left = true;
  }
  return busy ? 'busy' : left ? 'left' : 'closed';
}

export function groupSessions(sessions) {
  const m = new Map();
  for (const s of sessions) {
    if (!s?.live) continue;
    if (!m.has(s.projectId)) m.set(s.projectId, []);
    m.get(s.projectId).push(s);
  }
  return m;
}

// Sort weight of a project: the state first (waiting, busy, left, closed), running agents break a tie
export function attentionRank(p, byProject, now = Date.now()) {
  const w = { waiting: 8, busy: 4, left: 2, closed: 0 }[projectState(p, byProject, now)];
  return w + ((p?.runningAgents || 0) > 0 ? 1 : 0);
}

// A folder that is not a project (docs/folders.md): an unregistered folder the server placed as broad, temporary or a
// chat folder. It stays out of the project list's groups, the project count and the building's floors.
export function isOtherFolder(p) {
  if (!p) return false;
  // A project the person hid from the lists (hiddenProjects.js) is treated as one of these folders
  if (isHiddenProject(p.id)) return true;
  return p.kind === 'adhoc' && (p.broad || p.place === 'broad' || p.place === 'temp' || p.place === 'chat');
}

// Stable order: while the person points at or works in a list, its items keep their places and new items go to the
// end, so a live update never moves the row under the cursor. held: false -> the fresh order as it is.
export function holdOrder(fresh, previousIds, held, idOf = (x) => x.id) {
  if (!held || !previousIds?.length) return fresh;
  const byId = new Map(fresh.map((x) => [idOf(x), x]));
  const kept = previousIds.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const seen = new Set(previousIds);
  return kept.concat(fresh.filter((x) => !seen.has(idOf(x))));
}
