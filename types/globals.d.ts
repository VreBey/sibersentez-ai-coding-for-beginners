// What the desktop shell's preload puts on the page (electron/preload.cjs): for the type check only (plan D7)
interface Window {
  sibersentezShell?: Record<string, (...args: any[]) => any>;
  sibersentezTerminal?: Record<string, (...args: any[]) => any>;
}
