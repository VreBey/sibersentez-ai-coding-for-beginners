// Writes THIRD_PARTY_NOTICES.md from the license files of what the installer ships (node-pty with winpty and
// Microsoft's ConPTY, xterm.js), so each notice is the exact text the component carries. Electron and Chromium bring
// their own (LICENSE.electron.txt and LICENSES.chromium.html next to the program). Run it again after a version change:
//   node build/make-notices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n').trim();

// Microsoft Terminal's licence (github.com/microsoft/terminal, MIT); node-pty ships its ConPTY build without the file
const CONPTY_LICENSE = `MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export function noticesText() {
  const ptyVersion = JSON.parse(read('node_modules', 'node-pty', 'package.json')).version;
  const xtermVersions = read('public', 'vendor', 'xterm', 'VERSION');
  const block = (title, where, text) => `## ${title}\n\n${where}\n\n\`\`\`\n${text}\n\`\`\`\n`;
  return [
    '# Third-party notices',
    '',
    'SiberSentez is licensed under the GNU GPL version 3 or later (LICENSE.txt). It ships the',
    'components below under their own licences. Electron and Chromium bring their notices next to the program:',
    '`LICENSE.electron.txt` and `LICENSES.chromium.html`.',
    '',
    block(`node-pty ${ptyVersion}`, 'The embedded terminal (resources\\app.asar.unpacked\\node_modules\\node-pty).', read('node_modules', 'node-pty', 'LICENSE')),
    block('winpty', 'Shipped with node-pty (winpty-agent.exe).', read('node_modules', 'node-pty', 'deps', 'winpty', 'LICENSE')),
    block('ConPTY (Microsoft Terminal)', 'Shipped with node-pty (conpty\\OpenConsole.exe, conpty\\conpty.dll).', CONPTY_LICENSE),
    block(xtermVersions.split('\n').join(', '), 'The terminal view (public\\vendor\\xterm).', read('public', 'vendor', 'xterm', 'LICENSE')),
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), noticesText() + '\n');
  console.log('THIRD_PARTY_NOTICES.md written');
}
