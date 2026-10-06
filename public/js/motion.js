// Motion helpers (docs/motion.md): the page's few scripted movements, all skipped when the person asks for reduced
// motion. CSS does the rest (public/css/motion.css).

export function reducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// Runs `update` inside a view transition when the browser has one and motion is welcome, else at once. In a
// transition the browser calls it a moment later (after taking the old picture), so everything that depends on the new
// DOM (focus, observers) belongs inside `update`.
export function withTransition(update) {
  if (typeof document.startViewTransition !== 'function' || reducedMotion() || document.hidden) return update();
  document.startViewTransition(update);
}

// Plays a one-off CSS animation class again (the class must end its own animation)
export function replay(el, cls) {
  if (!el || reducedMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

// A short, stable view-transition-name for an id (letters and digits only, so any id is safe in CSS)
export function transitionName(prefix, id) {
  let h = 5381;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(36)}`;
}
