# Database schema: reference

Example for a small notes program with users and tags. Rename the things to the user's words.

## 001_create_tables.up.sql

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  body        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

-- many to many: a note has many tags, a tag marks many notes
CREATE TABLE note_tags (
  note_id  INTEGER NOT NULL REFERENCES notes(id),
  tag_id   INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (note_id, tag_id)
);

-- the column the list page filters by
CREATE INDEX idx_notes_user_id ON notes(user_id);
```

## 001_create_tables.down.sql

```sql
DROP INDEX idx_notes_user_id;
DROP TABLE note_tags;
DROP TABLE tags;
DROP TABLE notes;
DROP TABLE users;
```

Dropping tables deletes their rows: run `down` only on a copy or on fake data.

## 002_add_notes_archived: up and down

```sql
-- up: a new column with a default is a safe change
ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- down: older SQLite versions cannot drop a column; newer ones can
ALTER TABLE notes DROP COLUMN archived;
```

If `DROP COLUMN` is not available, the `down` file creates a new table without the column, copies the rows, drops the
old table and renames the new one. Write it out, show it to the user, and test it on a copy.

## Checks that prove the schema

```sql
PRAGMA foreign_keys = ON;
INSERT INTO users (email) VALUES ('test@example.com');
INSERT INTO users (email) VALUES ('test@example.com');   -- must fail: UNIQUE
INSERT INTO notes (user_id, title) VALUES (999, 'x');    -- must fail: no such user
EXPLAIN QUERY PLAN SELECT * FROM notes WHERE user_id = 1; -- should mention the index
```

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `UNIQUE constraint failed: users.email` | Working as intended; show the user a friendly message instead of the raw error. |
| `FOREIGN KEY constraint failed` | The referenced row does not exist, or a row that is still referenced is being deleted. Delete the children first. |
| Foreign keys are never refused | `PRAGMA foreign_keys = ON;` is missing on that connection. |
| `database is locked` | Two programs write at once, or a viewer holds the file open. Close the viewer; keep writes short. |
| `no such table` | The migration did not run, or the program opened another file. Print the path the program uses. |
| `NOT NULL constraint failed` | The code did not give a required value. Give it, or make the column optional on purpose. |
| Prices come out as 19.989999 | Decimals stored as floating point. Store whole cents in an integer. |
| A change broke old rows | The migration edited an applied one. Restore the backup, then write a new numbered migration. |
| Dates sort wrongly | Dates stored in local text formats. Use UTC ISO text. |

## When SQLite is not enough

Several servers writing at the same time, hosting without a persistent disk, or a need for strict users and roles in
the database: look at a server database (PostgreSQL is the usual choice) and keep the same migration files as the
starting point. Read the host's documentation first; hosts differ.
