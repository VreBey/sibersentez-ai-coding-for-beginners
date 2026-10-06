# Restore points

Status: built 2026-09-30 (docs/direction.md §3.4 "see, try, undo"). A beginner lets an AI tool change their project
and needs one safe way back that does not depend on git (most of them have none) and never asks them to learn a new
word first.

## 1. What a point is

- A plain copy of the project's files in the hub: `<hub>/restore/<project key>/<point id>/files/...` and
  `manifest.json` (`version`, `id`, `projectId`, `at`, `reason`, and per file `rel`, `size`, `mtimeMs`, `sha1`). The
  project key is a digest of the project id (an id may end in dots, which Windows strips from a folder name).
- Point id: `R` + UTC `YYYYMMDDHHmmss` + four hex digits (`POINT_ID_RE`); ids sort by time.
- Reasons: `ai-start` (taken by start-ai), `before-restore` (the present, taken before going back), `manual`.
- Left out: at any depth, package caches, version control and virtual environments (`RESTORE_SKIP`: `.git`,
  `node_modules`, `.venv`, `__pycache__`, `.next`, ...); at the project's top only, build output, the AI tools' set-up
  and Unity's generated folders (`RESTORE_SKIP_TOP`: `.claude`, `.agents`, `dist`, `build`, `out`, `bin`, `obj`,
  `target`, `Library`, `Temp`, `Logs`, ...; `assets/out` deeper down is the person's and is kept); links and junctions
  (never followed, never copied); the hub itself when it lies inside the project. What is left out is never removed by
  going back either (it is not in the plan). A manifest naming a left-out folder, a device name (`CON`, `nul.txt`) or
  an unsafe path is not read.
- Limits (`RESTORE_LIMITS`): 3,000 files, 50 MB in all, 16 MB per file, 16 folders deep. Over them there is no point
  and the reason says why (`too-many-files`, `too-large`, `file-too-large`, `too-deep`); git is the way for such
  projects.
- An unchanged project (same paths, sizes and times as the newest point) reuses that point; no second copy.
- Five points are kept per project (`RESTORE_KEEP`); the point a restore goes back to is never pruned by it, and a
  copy interrupted by a crash (`<id>.tmp-<hex>`) is swept.

## 2. When a point is taken

`start-ai` in live mode, before the first message is written and before the tool starts, for the project of the
start (a session's project for a session). It never stops the start: the reply carries `restorePoint: { id, reused }`
or `{ problem }` (null when there is no project or no hub).

## 3. Going back

- `restore-preview { projectId, pointId }` (any mode, writes nothing): `changed` (differ now; a new time with the
  same content is no change, the sha1 decides), `missing` (deleted since), `added` (came later), each list cut at 50
  names, `counts` whole, `planId` (the digest the apply checks).
- `restore-apply { projectId, pointId, planId? }` (a writing action: live only, one at a time; dry answers the plan
  with `result.executed: false`). **The rule that never breaks: a file is removed or overwritten only when a point of
  the present, taken for this restore, holds its current bytes (sha1); anything else is left as it is and reported
  (`not-backed-up`).** In order:
  1. `planId` (the preview's digest) differs from the plan now: `plan-changed`, nothing touched (the page always
     sends it, so going back never does more than the person was shown). An AI session still working in the project:
     `ai-working`.
  2. Every copy to be written is read and checked against its sha1: one damaged copy and nothing changes
     (`point-damaged`).
  3. A `before-restore` point of the present, always a new copy (never a reused one); if it cannot be taken, nothing
     changes (`backup-failed`).
  4. Added files are removed (with folders left empty), then changed and missing files are written; removing first
     lets a file take a folder's place and the other way round. Each write goes to a temporary file renamed into place
     (atomic, and it breaks a hard link instead of writing through it); never through a link or junction
     (`link-in-path`).
  Reply: `before` (the new point: going back to it undoes the restore) and `result: { executed, restored, removed,
  failed: [{ rel, error }] }`.
- Point ids grow even when the clock goes back or two points fall in one second, so their order is the order they were
  taken; pruning never removes the point being gone back to or the one just taken.
- The project is resolved like every skill action (`resolveProject`: listed, local, not broad, not in the hub); the
  page sends ids only.
- `GET /api/projects/<id>/restore` (read-only, no mode): `{ project, points: [{ id, at, reason, files, bytes }], keep }`.

## 4. In the drawer

**Restore points**, under "What changed": one line on what the points are; the points with a plain reason ("Before
the AI started", "Before going back"), the time to the second and the file count; **Go back to this** asks for the
preview (nothing changes), which shows three short lists (put back, brought back, removed) and, in live mode, **Yes,
go back**. Preview mode shows the plan only; off disables the buttons (they open the actions chooser). The result
line says how to undo it.

## 5. Tests

`test/restore.test.mjs` (the module and the section), `test/install.test.mjs` (the actions, the read route),
`test/ai-start.test.mjs` (the point of a live start).

## 6. Known limits

- A file whose name only changed case (`A.js` → `a.js`) is not put back under its old name: the present name is kept
  and reported `not-backed-up` (nothing is lost).
- Audit: two rounds by an independent reviewer (2026-09-30); round 1 found two blockers (a removal could happen
  without a backup; a damaged point was applied half-way), both fixed, round 2 approved.

## 7. Big projects: lean points (2026-10-01)

A project over the limits (a Unity game with art and logs measured 2,729 files and 116 MB, of which the code, scenes,
prefabs and styles were 2,341 files and 21 MB) used to get no point at all. Now `createPoint` first tries a full point;
when the scan is over a limit (`too-many-files`, `too-large`, `file-too-large`) it takes a **lean** one: files over
`LEAN.fileBytes` (2 MB) and logs (`.log`) are left out and counted (`leftOut`). The manifest carries `scope: 'lean'`
and `leftOut`; the list shows "N big files and logs not included".

A lean point scans with limits of its own (`LEAN.files` 6,000, `LEAN.bytes` 150 MB, `limitsFor`).

The same measurement showed why a game was over the limits at all: its Unity project sat in a subfolder, so its
1.4 GB `Library` was scanned (the regenerated folders were only left out at the top). Now a folder holding both
`Assets` and `ProjectSettings` is a Unity project wherever it sits, and its `Library`, `Temp`, `Logs`, `obj`,
`UserSettings`, `Build` and `Builds` are left out (`UNITY_SKIP`); `builds` joined the top-level list and Godot's
`.godot` the everywhere list. That project's lean point: 3,063 files, 97 MB, 270 big files and logs left out.

A lean point is planned and gone back to with the same scope (`planRestore`, and the restore's point of the present is
lean too), so what it left out is neither "added" nor "changed": going back never touches it, as with a skipped
folder. A file that was small at the point and grew past the size later is reported `not-backed-up`, never
overwritten. Tests: the lean case in `test/restore.test.mjs`.

**Not holding the server.** The first lean point of that project took 9 s (an unchanged one: 0.2 s). start-ai now
copies with `createPointAsync` (the same scan, id and manifest as `createPoint`, the reads and writes awaited), so the
live view and other requests keep moving; going back stays synchronous.

## Points named after their job (2026-10-02)

Replit and Lovable tie each version to the request that made it. A point taken by a job's Start keeps the job's first
words (`label` in the manifest, one line, at most `LABEL_MAX` = 80 characters; start-ai passes `ctx.job`), and the list
says "Before “Add a menu page”" instead of "Before the AI started". A point taken without a job, a reused point (nothing
changed since the last one: it keeps its first label) and the points of older versions show as before.
