// Copies the embedded terminal's screen library (xterm.js and its fit add-on, MIT) from node_modules into
// public/vendor/xterm, where the page loads it from its own server (the page's CSP allows scripts from 'self' only).
// Run after changing the pinned @xterm versions in package.json: node tools/vendor-xterm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor', 'xterm');
fs.mkdirSync(out, { recursive: true });
const copy = (from, to) => fs.copyFileSync(path.join(root, 'node_modules', from), path.join(out, to));
copy('@xterm/xterm/lib/xterm.mjs', 'xterm.mjs');
copy('@xterm/xterm/css/xterm.css', 'xterm.css');
copy('@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs');
copy('@xterm/xterm/LICENSE', 'LICENSE');
const v = (p) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', p, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(out, 'VERSION'), `@xterm/xterm ${v('@xterm/xterm')}\n@xterm/addon-fit ${v('@xterm/addon-fit')}\n`);
console.log(`vendored into ${path.relative(root, out)}`);
