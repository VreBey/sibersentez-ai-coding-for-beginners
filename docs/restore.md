# Restore points

Status: built 2026-09-30 (docs/direction.md §3.4 "see, try, undo"). A beginner lets an AI tool change their project
and needs one safe way back that does not depend on git (most of them have none) and never asks them to learn a new
word first.

## 1. What a point is

- A plain copy of the project's files in the hub: `<hub>/restore/<project key>/<point id>/files/...` and
  `manifest.json` (`version`, `id`, `projectId`, `at`, `reason`, and per file `rel`, `size`, `mtimeMs`, `sha256`; points taken before 2026-10-06 carry `sha1` instead and are still read). The
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
  same content is no change, the digest decides), `missing` (deleted since), `added` (came later), each list cut at 50
  names, `counts` whole, `planId` (the digest the apply checks).
- `restore-apply { projectId, pointId, planId? }` (a writing action: live only, one at a time; dry answers the plan
  with `result.executed: false`). **The rule that never breaks: a file is removed or overwritten only when a point of
  the present, taken for this restore, holds its current bytes (by digest); anything else is left as it is and reported
  (`not-backed-up`).** In order:
  1. `planId` (the preview's digest) differs from the plan now: `plan-changed`, nothing touched (the page always
     sends it, so going back never does more than the person was shown). An AI tool still at work in the project:
     `ai-working` (a live Claude Code session, or any AI start of the app still running in its embedded terminal,
     whatever the tool; a tool typed into a plain shell or started in Windows Terminal is not seen).
  2. Every copy to be written is read and checked against its digest: one damaged copy and nothing changes
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
the AI started", "Before going back"), the time to the second and the file count; **Review going back** asks for the
preview (nothing changes), which shows three short lists (put back, brought back, removed), what it never touches
(node_modules, .git, build folders, and a lean point's big files and logs) and, in live mode, **Go back to this
point** (2026-10-07, review U17: the review first, no "one click" promise). Preview mode shows the plan only; off disables the buttons (they open the actions chooser). The result
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

## 8. What a job's start kept (2026-10-06)

The start notice says whether the start's copy is full, lean or missing, but a notice is gone after a reload. Each app
job's start now also records what it kept, in the hub next to the points: `restore/<project key>/start-points.json`,
`{ version: 1, jobs: [{ jobId, at, id, reused, scope, leftOut, files, bytes }` or `{ jobId, at, problem }] }`, newest
first, one record per job id (every app start gets a new id), at most `JOB_POINTS_KEEP` = 20, written whole
and renamed (`recordJobPoint`). Never in the project folder, where an AI writes. `GET /api/projects/<id>/restore`
answers it as `jobs` (only known fields of known shapes are read back). The job box takes its own start's answer, else
asks the server once for the shown job (`askJobPoint`: again after 30 s, at most four times, since a job started
outside the app or before this version has no record) and says it next to the job. A start without an app job (an
idea, a session resumed) records nothing. Tests: `test/restore-coverage.test.mjs`.

**Present, not only past (2026-10-07, docs/development-plan-2026-10-07.md F2).** A start record is history: only the
newest `RESTORE_KEEP` points are kept, so a newer point (a resume, going back) could push a job's start copy out while
the job box still promised it. Now:

- The `/restore` answer marks each job record with `available`: whether its point is among the points listed now (a
  pushed-out point, or one whose manifest cannot be read, is not).
- The page keeps the project's points as last listed (by the job box's own check, at most every 30 s while it shows a
  copy, or by the drawer's restore section) and forgets them after a start or going back, so the next frame asks
  again. A copy that is no longer there (pushed out, or its manifest unreadable) says so (`rstStartGone`): "a copy
  was kept, but it is no longer there", with the way to the points that remain; it never promises a return.
- The current job's start copy (the project's marker names the job; its record names the point) is kept past
  `RESTORE_KEEP` while that job is the current one: one point more at most. Every point taken (a start, going back)
  prunes with it protected.

Tests: `test/restore-coverage.test.mjs` (F2 reproduced, the same open page).

## 9. What a job changed (2026-10-07, review package 3)

`GET /api/projects/<id>/job-changes?job=<Job-ID>` (read-only, no action mode; `projectJobChanges`) compares the project
with that job's start copy (its record, §8): the files changed, added and deleted since the job started, at most 200
names per list (`more` says when there are more), the team's own notes under `.sibersentez/` counted apart (`notes`).
A file of the same size is read and its digest decides (review Z1: a file rewritten with its size and time kept is a
change; the size and time only pick what to read); a file that cannot be read now is listed apart (`unknown`), never
counted as unchanged or changed; a name whose case alone changed is a change. The comparison is async (one file after
the other; measured 2026-10-07 on this repository, 856 files, 80 MB lean: about 0.4 s). `counts` are the whole lists' (the names
are cut). A lean copy's limits do not turn sizes into deletions: a file in the copy that grew past them is still there,
so it changed; a file left out then (born before the job started) that shrank under them changed too, it is not new.
One comparison per project and job is kept 10 s on the server (`createJobChangesCache`); a broad folder is not read.
Nothing is written. `basis` says how far it holds: `start` (compared; changes the
person made meanwhile are in it too, no file is attributed to the AI for certain; a lean copy's left-out files are
never listed, `leftOut`), `no-record` (started outside the app or before records), `no-copy`, `gone`, `unreadable`.

The drawer's "This job's result" (`public/js/jobResult.js`) shows it once the job reached its result or was accepted:
what was asked (the plan's title), these changes, the checks apart (the AI reviewer's own report; SiberSentez itself
ran no test; whether the person accepted), how to open it ("How to run it" right below, now also at the result step)
and going back (the job box's sentence, never a copy that is gone). Without a start copy of its own it says so and
points to "What changed" further down, which shows the recent changes, earlier work included. Tests:
`test/job-changes.test.mjs`, `test/job-result.test.mjs`. Checked in a window on a job at its result (Turkish and
English): the strip's "Open the result" opens the drawer at it.

**The result first (2026-10-07, review U07, U08).** While the result waits (`finish`) it is the drawer's first section
and carries the job's steps; the job box comes after "How to run it" and the restore points as a plain "New job"
without the steps and with a secondary Start, so it never reads as the way to answer the job. "Tell the lead in its
terminal" became one button, "Go to this job's AI session": an AI tab of the project in SiberSentez's terminal comes
forward, else the job's own Claude Code session (`job.js jobSession`: the one that names the job, else an unnamed one
at work around the job's last change) goes on where it stopped, else its drawer opens and says where it runs: the
Building's result card's own path (`main.js` `open-ai-terminal`). With neither a tab nor a session the section says
so and points to a new job instead of a button that leads nowhere. When the job's AI no longer runs (no tab, its
session closed) the section says so above the button, as the job box did. Known limits: an AI tab of the project that
runs another job is brought forward too (the Building's card does the same; the tab knows its job id, a later step
can pick by it), and going on with the job's closed session does not look for another Claude Code session of the
project running outside SiberSentez, so a click then starts a second one in the same folder. Accepting stays the person's word to the AI; there
is no accept button in the app (the owner's choice, 2026-10-07).

**Reusing the newest point (2026-10-07, review Z1).** A start answers the newest point again when nothing changed.
The same paths, sizes and times only make it a candidate: every file's bytes are compared with its digest (SHA-256,
or SHA-1 for older points) before it is answered again; one that differs, or cannot be read, makes a new copy. The
start's own way reads them without holding the server (`createPointAsync`; about 0.45 s on the repository above).
A file another program keeps locked (an IDE's open database) can no longer hide behind a reused point: its bytes cannot
be read, so a new copy is tried, and while the lock lasts that copy fails (`copy-failed`) and the job box says no copy
was kept. That is the honest answer: no copy of that file could be made.
Tests: `test/job-changes.test.mjs` (Z1 reproduced).
