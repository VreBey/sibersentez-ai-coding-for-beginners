// Layout decisions of the first screen (docs/direction.md §3.3), pure so node tests can hold them.

// The building on Today: the size the person chose wins ('small' | 'large'); otherwise a band while no session is
// open and the whole building as soon as one is (the owner's decision of 2026-09-30).
export function heroFoldedFor({ stored = null, openSessions = 0 } = {}) {
  if (stored === 'small') return true;
  if (stored === 'large') return false;
  return !(Number(openSessions) > 0);
}

// The pause before the live stream is opened again after it closed: 1, 2, 5, 10, then 30 s for every later attempt
export function reconnectDelay(attempt = 0) {
  const steps = [1000, 2000, 5000, 10000, 30000];
  const i = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return steps[Math.min(i, steps.length - 1)];
}
