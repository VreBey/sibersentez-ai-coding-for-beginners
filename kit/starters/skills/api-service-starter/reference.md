# API service starter: reference

Contents: package.json · .env.example · store.js · app.js · server.js · test/api.test.js · .gitignore lines · Calling
the API by hand · Common problems

Checked 2026-10-09 against the official documentation (revisit every six months): Node.js
(https://nodejs.org/docs/latest/api/cli.html for `--env-file`, https://nodejs.org/docs/latest/api/test.html for
the test runner) and Express (https://expressjs.com/). If a command below fails, check those pages first: the code
was run on Node.js 24 with Express 5 and its three tests passed.

Run everything from the API folder (for example `api/`).

## package.json

```json
{
  "name": "my-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=.env server.js",
    "dev": "node --watch --env-file-if-exists=.env server.js",
    "test": "node --test"
  }
}
```

`npm install express` adds the `dependencies` block. `npm run dev` restarts the server when a file changes.

## .env.example

```
# Copy this file to .env and change the values. .env is never committed.
PORT=3000
# Example only: a real service key would go here, never in the code.
API_TOKEN=token_EXAMPLE_change_me
```

## store.js

```js
// A tiny data store: items live in a JSON file so they survive a restart.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const save = (items) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(items, null, 2));
  };
  return {
    list: () => load(),
    get: (id) => load().find((item) => item.id === id),
    add: (title) => {
      const items = load();
      const item = { id: items.reduce((max, i) => Math.max(max, i.id), 0) + 1, title };
      items.push(item);
      save(items);
      return item;
    },
  };
}
```

A JSON file is fine for learning and for one user. Two people writing at the same time can overwrite each other:
a real database is the next step when that matters.

## app.js

```js
// The routes. Kept apart from server.js so a test can use them without opening a port.
import express from 'express';

export function createApp(store) {
  const app = express();
  app.use(express.json());

  // Health check: "is the service alive?"
  app.get('/health', (req, res) => res.json({ ok: true }));

  // List all items
  app.get('/items', (req, res) => res.json(store.list()));

  // Read one item
  app.get('/items/:id', (req, res) => {
    const item = store.get(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  });

  // Add an item: the body must be JSON like {"title": "Buy milk"}
  app.post('/items', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (title.length < 1 || title.length > 80) {
      return res.status(400).json({ error: 'title must be 1 to 80 characters' });
    }
    res.status(201).json(store.add(title));
  });

  return app;
}
```

The input is checked on the server (type and length), never trusted as it arrives.

## server.js

```js
// Starts the service. Settings come from the environment (.env), never from the code.
import { createApp } from './app.js';
import { createStore } from './store.js';

const port = Number(process.env.PORT) || 3000;
const app = createApp(createStore('data/items.json'));

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
```

## test/api.test.js

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { createStore } from '../store.js';

// Each test run uses its own temporary data file, so it never touches real data.
function start() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-')), 'items.json');
  const server = createApp(createStore(file)).listen(0);
  return { server, url: `http://localhost:${server.address().port}` };
}

test('health check answers ok', async () => {
  const { server, url } = start();
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('an added item can be read back', async () => {
  const { server, url } = start();
  const created = await fetch(`${url}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'First item' }),
  });
  assert.equal(created.status, 201);
  const item = await created.json();
  const read = await fetch(`${url}/items/${item.id}`);
  assert.equal((await read.json()).title, 'First item');
  server.close();
});

test('an empty title is refused', async () => {
  const { server, url } = start();
  const res = await fetch(`${url}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  });
  assert.equal(res.status, 400);
  server.close();
});
```

## .gitignore lines

```
node_modules/
.env
data/
```

## Calling the API by hand

| System | Add an item |
|---|---|
| Windows PowerShell | `curl.exe -X POST -H "Content-Type: application/json" -d "{\"title\":\"First\"}" http://localhost:3000/items` |
| macOS, Linux | `curl -X POST -H "Content-Type: application/json" -d '{"title":"First"}' http://localhost:3000/items` |

In PowerShell `curl` alone is an alias of another command, so always write `curl.exe`.

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `.env: not found` (printed after the path of node) | `.env` is missing: copy `.env.example` to `.env` |
| `bad option: --env-file-if-exists` | Node.js is older than 22.9: install the current LTS version |
| `EADDRINUSE` (port already in use) | another copy is still running, or another program uses the port: stop it, or change `PORT` in `.env` |
| `Cannot find package 'express'` | run `npm install express` in the API folder |
| POST answers 400 although the body looks right | the header `Content-Type: application/json` is missing, or the JSON quotes were changed by the terminal |
| `Cannot use import statement outside a module` | `"type": "module"` is missing from `package.json` |
| The list is empty after a restart | the server was started from another folder: `data/items.json` is relative to where it starts |
