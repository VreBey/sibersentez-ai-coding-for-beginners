---
name: database-schema
description: "Designs the tables a small project needs: what each table holds, how tables relate, keys, indexes and numbered migration files that can be undone, starting on SQLite with a backup before every change. Use when the project must save data, the user asks about a database, tables or a data model, or a data shape has to change."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "database, backend"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "veritabanı tasarla*, veri modeli, veritabanı*, tablo*, sqlite, migration*, şema tasarla*, kayıtları sakla*"
---

# Database schema

Goal: the smallest set of tables that holds what the project must remember, written as migration files, tried on a
local SQLite file and backed up before every change. Example SQL and the common errors are in
[reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Work only on local or fake data. Never run a change against a live database; real data is the user's to touch.

## 1. Find out what is remembered

Read `PLAN.md` and the code that already saves data. Ask one question: "What are the things the program keeps, and
what do you want to know about each?" Write the answers as plain nouns (user, note, order) with their facts (title,
price, date). Do not draw tables yet.

## 2. Draft the tables on paper first

Show the user a small list before any file is written:

| Table | One row is | Columns (required marked *) | Belongs to |
|---|---|---|---|
| notes | one note | id*, title*, body, created_at*, user_id* | users (many notes, one user) |

- Every thing gets a table; every table gets an `id` primary key and a `created_at` column.
- "One has many" (a user has many notes): the many side stores the other table's id (a foreign key).
- "Many to many" (notes have many tags): a third table holding the two ids, with the pair unique.
- One fact per column. A list in one cell ("red,green") means a missing table.
- Money as whole cents in an integer, dates as UTC text such as `2026-10-01T12:00:00Z`, yes/no as 0 or 1.
- Mark a column `NOT NULL` unless "empty" is a real answer. Add `UNIQUE` where duplicates are wrong (an email).
- Ask the user to confirm the draft. Fix it now: changing a table later costs more.

## 3. Indexes

An index is a sorted shortcut: faster reading, slightly slower writing. Add one only for a column that is searched,
joined or sorted often: foreign key columns first, then the columns in your `WHERE` and `ORDER BY`. Not on every
column, and not on a table with a few hundred rows. Check a slow query with `EXPLAIN QUERY PLAN` and say what it
shows in plain words.

## 4. Write migrations (steps that can be undone)

1. Folder `migrations/`. Files in order: `001_create_notes.up.sql` and `001_create_notes.down.sql`.
   `up` applies the change, `down` reverses it.
2. **Never edit a migration that was already applied.** A change is a new file with the next number.
3. Safe changes: add a table; add a column that is nullable or has a default. Renaming or dropping a column or a
   table, or changing a type, loses or breaks data: say what will happen, and ask first.
4. SQLite does not enforce foreign keys unless every connection runs `PRAGMA foreign_keys = ON;`. Put it in the code
   that opens the database.

## 5. Start with SQLite

One file (`data/app.db`) needs no server. Add `data/` to `.gitignore`. Use the project's own database library, or the
`sqlite3` command line tool when it is installed; if neither exists, ask before installing anything. Move to a server
database later only when several programs write at once, or the host has no disk of its own.

## 6. Back up, apply, prove

1. Before every migration copy the file: `Copy-Item data\app.db backups\app-<date-time>.db` (macOS and Linux: `cp`).
   `backups/` is ignored by git too.
2. Apply `up`, then check: list the tables, insert one fake row, read it back.
3. Try `down` on a copy of the file, then `up` again. If either fails, the migration is not done.
4. Test one rule the schema should enforce, for example a duplicate email is refused.

## Do not use for

- Routes and server code: use the `backend-builder` agent or `api-service-starter`.
- Sign-in tables and passwords: use `auth-flow`.
- Keys and connection strings: use `env-and-secrets`.

## Done when

- The user approved the table draft, and the migrations (up and down) are files in the project.
- A backup exists and `up`, `down` and `up` again ran without error (show the commands and output).
- One fake row was written and read back, and one rule (unique, required or foreign key) was seen refusing bad data.
- `data/` and `backups/` are ignored by git (`git check-ignore -v data/app.db` prints the rule).
