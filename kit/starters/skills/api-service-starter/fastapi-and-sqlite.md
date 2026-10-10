# API service starter: Python route and SQLite

Contents: Part A: Python with FastAPI · Part B: SQLite for the Node.js route · Common problems

Part A is the whole Python route with FastAPI (it keeps its items in SQLite from the start). Part B moves the Node.js
route of reference.md from the JSON file to SQLite. Written from the documentation of FastAPI
(https://fastapi.tiangolo.com/), Python's `sqlite3` (https://docs.python.org/3/library/sqlite3.html) and the
`better-sqlite3` package (https://github.com/WiseLibs/better-sqlite3). Package names and versions change: check them
before installing, and ask first.

## Part A: Python with FastAPI

Needs Python 3.11 or newer (3.14 is best) (`py --version`). In a new subfolder `api/`:

1. `py -m venv .venv`; then, after a yes (it downloads packages):
   `.venv\Scripts\python -m pip install fastapi uvicorn python-dotenv pytest httpx`. Write them to `requirements.txt` with a major
   version range each (look up the current ones on pypi.org).
2. `.env.example` with `PORT=8000` and `DB_FILE=data/app.db`; copy it to `.env`. Add `.venv/`, `__pycache__/`,
   `.env` and `data/` to `.gitignore` before `.env` exists.

### main.py

```python
import os
import sqlite3
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

DB_FILE = os.environ.get("DB_FILE", "data/app.db")


def connect():
    Path(DB_FILE).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_FILE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
    return db


class NewItem(BaseModel):
    # Checked on the server: 1 to 80 characters
    title: str = Field(min_length=1, max_length=80)


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/items")
def list_items():
    with connect() as db:
        return [dict(row) for row in db.execute("SELECT id, title FROM items ORDER BY id")]


@app.get("/items/{item_id}")
def read_item(item_id: int):
    with connect() as db:
        row = db.execute("SELECT id, title FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return dict(row)


@app.post("/items", status_code=201)
def add_item(item: NewItem):
    with connect() as db:
        cursor = db.execute("INSERT INTO items (title) VALUES (?)", (item.title.strip(),))
        return {"id": cursor.lastrowid, "title": item.title.strip()}
```

Values go into the query through the `?` marks, never glued into the text: that is what stops SQL injection. FastAPI
answers 422 itself when the body breaks the rules of `NewItem`.

### Run it

`.venv\Scripts\python -m uvicorn main:app --reload --port 8000 --env-file .env`. It prints the address and keeps running until
Ctrl+C. Open http://localhost:8000/docs: FastAPI writes a page where each route can be tried. From another terminal,
in PowerShell:
`curl.exe -X POST -H "Content-Type: application/json" -d "{\"title\":\"First\"}" http://localhost:8000/items`.
On macOS and Linux: `.venv/bin/python` instead of `.venvScriptspython`, and
`curl -X POST -H "Content-Type: application/json" -d '{"title":"First"}' http://localhost:8000/items`.

### test_api.py

```python
import os
import tempfile

# Point the app at a temporary database before it is imported
os.environ["DB_FILE"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_added_item_can_be_read_back():
    created = client.post("/items", json={"title": "First item"})
    assert created.status_code == 201
    item = created.json()
    assert client.get(f"/items/{item['id']}").json()["title"] == "First item"


def test_empty_title_is_refused():
    assert client.post("/items", json={"title": ""}).status_code == 422
```

Run with `.venv\Scripts\python -m pytest`. Show that all three pass.

## Part B: SQLite for the Node.js route

Plan the tables first (`database-schema`); for this example one table is enough.

1. Back up the JSON file (`Copy-Item data\items.json backups\`), and add `backups/` to `.gitignore`.
2. After a yes: `npm install better-sqlite3` (a package with a native part; it normally downloads a ready-made binary).
   Node.js 22 and later also has a built-in SQLite module; its status changes between versions, so read the Node.js
   documentation before choosing it instead.
3. Write `store-sqlite.js` with the same three functions as `store.js`, so `app.js` does not change:

```js
// A store that keeps items in SQLite. Same functions as store.js: list, get, add.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
  return {
    list: () => db.prepare('SELECT id, title FROM items ORDER BY id').all(),
    get: (id) => db.prepare('SELECT id, title FROM items WHERE id = ?').get(id),
    add: (title) => {
      const info = db.prepare('INSERT INTO items (title) VALUES (?)').run(title);
      return { id: Number(info.lastInsertRowid), title };
    },
  };
}
```

4. In `server.js` and the test file import from `./store-sqlite.js` and use `data/app.db` (a temporary file in tests).
5. To keep the old items: a one-time script reads `data/items.json` and inserts each item (try it on a copy of the
   database first). Never delete the JSON file; the user does that when they are sure.
6. Run `npm test` and the three `curl.exe` calls of the main steps. All must still behave the same.

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `ModuleNotFoundError: No module named 'fastapi'` | the packages are in another Python. Use `.venv\Scripts\python -m ...`. |
| `Error loading ASGI app. Could not import module "main"` | the command was run from another folder. Run it where `main.py` is. |
| `422 Unprocessable Entity` | the body breaks the rules: wrong JSON, a missing or too long `title`. The answer names the field. |
| `sqlite3.OperationalError: unable to open database file` | the folder of `DB_FILE` does not exist or is not writable; the code creates `data/`, check the path. |
| `database is locked` | two programs write at once, or a viewer has the file open. Close the viewer. |
| `Cannot find package 'better-sqlite3'` | run `npm install better-sqlite3` in the API folder, after a yes. |
| The install of `better-sqlite3` fails with build tool errors | no ready-made binary for this Node.js version: use the current LTS version, or read the package's installation page. |
| The test changes the real database | the environment variable was set after the import; set it first, as in the example. |
| Old items are missing after the switch | the migration script did not run, or the app opened another database file. Print the path it uses. |
