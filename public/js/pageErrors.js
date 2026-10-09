// @ts-check
// Errors of the page itself (review A4): an exception nobody caught, or a promise nobody waited for. Each different one
// goes to the desktop app's own log (main.log, the home folder masked there), at most PAGE_ERRORS_LOGGED per run, so a
// problem report can carry evidence; nothing leaves the computer. Diagnostics says only how many there were.
export const PAGE_ERRORS_LOGGED = 20;
const STACK_LINES = 4;
const TEXT_MAX = 1000;

const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

// "message @ file:line:col | stack" from an ErrorEvent, an Error or anything thrown
export function errorText(x) {
  const err = x?.error instanceof Error ? x.error : x instanceof Error ? x : null;
  // Something else thrown: a string as it is, an object only by its message (its other contents may be data)
  const message = oneLine(err ? `${err.name}: ${err.message}` : typeof x === 'string' ? x : typeof x?.message === 'string' ? x.message : '');
  const where = x?.filename ? ` @ ${oneLine(x.filename)}:${Number(x.lineno) || 0}:${Number(x.colno) || 0}` : '';
  const stack = err?.stack ? String(err.stack).split('\n').slice(1, 1 + STACK_LINES).map(oneLine).filter(Boolean).join(' | ') : '';
  return `${message || 'unknown error'}${where}${stack ? ` | ${stack}` : ''}`.slice(0, TEXT_MAX);
}

// target: the window; report(text): the shell's bridge (none in a browser: only counted). Returns { count() }: every
// error of this run, the ones not logged too.
export function installPageErrors({ target = globalThis, report = (text) => globalThis.sibersentezShell?.reportError?.(text), max = PAGE_ERRORS_LOGGED } = {}) {
  let count = 0;
  const logged = new Set();
  const take = (text) => {
    count++;
    if (logged.has(text) || logged.size >= max) return;
    logged.add(text);
    try {
      report(text);
    } catch {
      /* the log is evidence, never a new error */
    }
  };
  target.addEventListener?.('error', (e) => take(errorText(e)));
  target.addEventListener?.('unhandledrejection', (e) => take(`unhandled rejection: ${errorText(e?.reason)}`));
  return { count: () => count };
}
