// What the desktop shell's preload puts on the page (electron/preload.cjs): for the type check only (plan D7)
interface Window {
  sibersentezShell?: Record<string, (...args: any[]) => any>;
  sibersentezTerminal?: Record<string, (...args: any[]) => any>;
  // What the page puts on window for the desktop shell and the QA runs (public/js/main.js)
  sibersentezActionsPanel?: Readonly<{ confirmLive: () => any }>;
  sibersentezNewProject?: Readonly<{ start: () => boolean }>;
  __sibersentezQa?: Record<string, any>;
}
