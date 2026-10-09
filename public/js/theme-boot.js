// @ts-check
// The theme before the first paint (theme.js owns the choice; this only reads it), so a person who chose the light
// theme never sees the dark page first. A classic script on purpose: it runs before the stylesheets apply, where a
// module would run after. Same key and choices as theme.js (test/theme.test.mjs).
(function () {
  let choice = 'dark';
  try {
    choice = globalThis.localStorage?.getItem('sibersentez.theme') || 'dark';
  } catch {
    // storage blocked: the dark theme
  }
  const light = choice === 'light' || (choice === 'system' && !!globalThis.matchMedia?.('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
})();
