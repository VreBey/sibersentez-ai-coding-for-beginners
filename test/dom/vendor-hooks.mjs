// Module hooks for the DOM tests (registered by test/dom/env.mjs): the page imports xterm.js from the server's own
// address (/vendor/xterm/...); in node those imports go to the stand-in beside this file.
const FAKE = new URL('./fake-xterm.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '/vendor/xterm/xterm.mjs' || specifier === '/vendor/xterm/addon-fit.mjs') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
}
