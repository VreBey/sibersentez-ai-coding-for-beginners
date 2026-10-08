// Using the built app as a person would (2026-10-08): connects to a running SiberSentez window over the DevTools
// protocol and runs one step. Start the unpacked build with its own hub and data folder (so it runs beside an installed
// copy and touches none of its data) and a debugging port:
//   npx electron-builder --win --dir
//   set SIBERSENTEZ_HUB=<temp>\hub & set SIBERSENTEZ_DATA_DIR=<temp>\data & dist\win-unpacked\SiberSentez.exe --remote-debugging-port=9341
// Then, one step at a time (take a shot after each and look at it):
//   node tools/drive-app.mjs <port> shot <file.png>
//   node tools/drive-app.mjs <port> eval "<js>"
//   node tools/drive-app.mjs <port> click "<css selector>" [n]   (the n-th visible match; a real mouse click at its centre)
//   node tools/drive-app.mjs <port> clicktext "<visible text>"   (the innermost visible clickable element with that text)
//   node tools/drive-app.mjs <port> type "<text>"                (into the focused element)
//   node tools/drive-app.mjs <port> key <Enter|Escape|Tab|ArrowDown|...>
//   node tools/drive-app.mjs <port> text                         (the visible page text, cut short)
// The terminal's raw output: eval "window.sibersentezTerminal.list().then((l) => l.at(-1).buffer)". A real AI job uses
// the person's plan; stop the copy afterwards by the PIDs of dist\win-unpacked\SiberSentez.exe only.
import fs from 'node:fs';

const [port, cmd, arg, arg2] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A value written into the code the page runs: JSON, with the characters that could end a string or a script escaped
const UNSAFE = { '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const literal = (v) => JSON.stringify(String(v)).replace(/[<>/\b\f\n\r\t\0\u2028\u2029]/g, (c) => UNSAFE[c]);
let targets = [];
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.some((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url))) break;
  } catch {}
  await sleep(250);
}
const page = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url));
if (!page) {
  console.log('NO PAGE', JSON.stringify(targets.map((t) => [t.type, t.url])));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? `ERR ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
};
const clickAt = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 };

if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('shot', arg);
} else if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg), null, 1));
} else if (cmd === 'click' || cmd === 'clicktext') {
  const find =
    cmd === 'click'
      ? `(() => { const els = [...document.querySelectorAll(${literal(arg)})].filter((e) => e.getClientRects().length); const e = els[${Number(arg2 || 0)}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: (e.innerText || e.value || e.ariaLabel || e.tagName).slice(0, 60) }; })()`
      : `(() => { const want = ${literal(arg)}; const els = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab], [role=option], label, summary, li, [tabindex]')].filter((e) => e.getClientRects().length && (e.innerText || e.ariaLabel || '').includes(want)); els.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length); const e = els[${Number(arg2 || 0)}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: (e.innerText || e.ariaLabel || e.tagName).slice(0, 60) }; })()`;
  const at = await evaluate(find);
  if (!at || typeof at !== 'object') console.log('NOT FOUND', arg);
  else {
    await clickAt(at.x, at.y);
    console.log('clicked', JSON.stringify(at));
  }
} else if (cmd === 'type') {
  await send('Input.insertText', { text: arg });
  console.log('typed');
} else if (cmd === 'key') {
  const vk = KEYS[arg] || 0;
  const text = arg === 'Enter' ? '\r' : undefined;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: arg, code: arg, windowsVirtualKeyCode: vk, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: arg, code: arg, windowsVirtualKeyCode: vk });
  console.log('key', arg);
} else if (cmd === 'text') {
  console.log(await evaluate(`document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, ${Number(arg || 3000)})`));
}
ws.close();
process.exit(0);
