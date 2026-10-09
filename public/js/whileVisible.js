// @ts-check
// What the page does on a timer only for the person's eyes (the clock, "12 s ago", the screens, the tools' wizard
// check) waits while the window is hidden: minimized, covered or in the tray (plan D5). A run that was skipped meanwhile
// happens once, as soon as the window shows again, so nothing is out of date when the person looks. Notifications and
// the usage-limit check are not run through this: they are what a hidden window is for.

// fn wrapped: called at once while visible; while hidden it is only marked, and runs once when the window shows
export function whileVisible(fn, { doc = document } = {}) {
  let missed = false;
  const run = (...args) => {
    if (doc.hidden) {
      missed = true;
      return;
    }
    missed = false;
    fn(...args);
  };
  const onShow = () => {
    if (!doc.hidden && missed) run();
  };
  doc.addEventListener('visibilitychange', onShow);
  run.stop = () => doc.removeEventListener('visibilitychange', onShow);
  run.missed = () => missed;
  return run;
}

// setInterval through whileVisible; the returned function stops both
export function everyVisible(fn, ms, { doc = document, timers = globalThis } = {}) {
  const run = whileVisible(fn, { doc });
  const id = timers.setInterval(run, ms);
  return () => {
    timers.clearInterval(id);
    run.stop();
  };
}
