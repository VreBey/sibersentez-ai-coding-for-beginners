# Live usage tracking: input, output and API-equivalent cost

The panel shows how many tokens Claude Code used and what that would cost at Anthropic API prices, for the last
24 hours, 7 days, this calendar month or 30 days, in total, per project and per model. Code: `server/usage.mjs`
(counting and the ledger), `server/prices.mjs` (the price table), `GET /api/usage` in `server/app.mjs`, the page's
part in `public/js/usage.js` (strings `public/js/strings/usage.js`, styles `public/css/usage.css`). Tests:
`test/usage.test.mjs`.

## 1. What is counted

Every assistant line of a Claude Code log (`~/.claude/projects/**/*.jsonl`, sub-agent logs under
`<session>/subagents/` included) carries `message.usage`:

| Field in the log | Name in SiberSentez | Meaning |
|---|---|---|
| `input_tokens` | input | new input the model read for the first time |
| `cache_creation.ephemeral_5m_input_tokens` | cacheWrite5m | input written to the prompt cache for 5 minutes |
| `cache_creation.ephemeral_1h_input_tokens` | cacheWrite1h | input written to the prompt cache for 1 hour |
| `cache_read_input_tokens` | cacheRead | input read back from the prompt cache |
| `output_tokens` | output | what the model wrote |

A log without the 5-minute/1-hour split books the whole `cache_creation_input_tokens` as a 5-minute write (the
cheaper of the two; it is what the older logs meant).

- **Processed tokens** = input + cache writes + output: what the model really worked through. Cache reads are not
  added: they are usually ~98% of all input and cost a tenth of new input, so one "input" number would mislead.
- **Cache share** = cacheRead / (input + cache writes + cacheRead).
- Lines of the `<synthetic>` model, lines without `message.id` and lines without a valid timestamp are not counted.

### Deduplication

Claude Code writes one response on several lines (one per content block), and a sub-agent's log can repeat a line
of its parent session. Counting lines would inflate everything about 2.3 times. The key of a message is
`<message.id>|<requestId>`, the same in every file; a line without a `requestId` gets `<log file>|<message.id>`
(unique within that file only). For one key every field keeps its **largest** value: older logs start a response
with a small `output_tokens` and grow it on later lines. A message is booked in the hour of its first line and in
the project of the session that wrote it. Because of the largest-value rule, reading a line twice never counts it
twice.

### Projects

A message belongs to the project of its session, by the same rule as the rest of the panel
(`server/ingest.mjs` + `catalog.resolve`): the session's first working directory decides, a sub-folder belongs to
its parent project, and a sub-agent belongs to the project of the session that started it. This is why project
totals differ from a count grouped by the folder name of each line's `cwd` (a session that moved into
`…\yeni party oyunu\Scripts` stays in "yeni party oyunu").

## 2. The ledger

`<hub>/usage/ledger.json` is the program's own memory, like `registry/discovered.json`: it is written whatever the
actions mode is. Without a hub the ledger lives in memory only.

```json
{
  "version": 1,
  "savedAt": "2026-09-29T08:36:00.000Z",
  "pricedAt": "2026-09-25",
  "fields": ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output", "messages"],
  "hours": { "2026-09-29T07": { "<project id>": { "claude-opus-5-5": [2, 1200, 0, 581767, 919, 3] } } },
  "days":  { "2026-08-10":    { "<project id>": { "claude-opus-5":   [0, 0, 0, 0, 0, 0] } } }
}
```

- `hours` are UTC hours (`YYYY-MM-DDTHH`); a day of the page is a **local** day made of its hours. Hours older than
  40 days are folded into `days` (local dates), each hour exactly once.
- Written atomically (temporary file + rename), at most every 15 seconds while numbers change, once when the start-up
  count ends, and on exit. About 60 KB for a month of heavy use.
- A file that is not JSON, not an object or of another `version` is renamed to `ledger.json.broken` and rebuilt
  from the logs; single bad rows (wrong length, negative numbers, a bad hour label) are skipped.
- A file larger than **8 MB** (`LEDGER_MAX_BYTES`) is not read at all (reading and parsing it would hold the start
  up; a real ledger stays far below it): it is set aside the same way and rebuilt.
- A copy set aside before is never written over: the older `ledger.json.broken` moves on to
  `ledger.json.broken-<its time>` (UTC, `:` and `.` as `-`; a `-N` suffix when that name is taken), and at most three
  set-aside copies are kept (`ledger.json.broken` and the two newest time-stamped ones).

### Where the numbers come from, and why a restart never counts twice

On every start the messages of the last **32 days** (the horizon: covers "30 days" and a whole calendar month) are
counted again from the logs:

1. The log reader (`server/ingest.mjs`) reads the files of its own window (14 days by default) and hands every
   assistant line to the ledger (`ingest.ledger.line`), during its first scan and afterwards live.
2. Right after that scan `scanOlderLogs` reads, in the background, the log files of the horizon the reader skipped
   (last changed before its window). It parses only lines that contain `"usage"` (and the first line with a
   `cwd`, for the project). On this machine: 203 files in 1.1 s, after the reader's 3.4 s.

Until both are done the page says the older logs are still being counted.

Lines older than the horizon are ignored: those hours are frozen in the file. For every hour and project the
ledger compares the file with what the logs gave in this run and uses **the side with more messages** (ties: the
logs). It never adds the two. So:

- a restart reads the same messages again and gets the same numbers (nothing is added twice);
- an hour the file saved half-way is replaced by the complete hour from the logs;
- while the start-up count is still running, an hour that is not read yet keeps the file's numbers (no dip);
- when Claude Code deletes old logs (30 days by default), their hours keep the file's numbers.

**Why this and not "byte offset per file + the last N keys".** Offsets would let a restart read only new bytes, but
they are fragile: the reader's line callback has no absolute positions (`server/util.mjs` is shared), a resumed or
rewritten log would need its keys from weeks ago to stay deduplicated, and any drift between the saved totals and
the saved offsets would count lines twice forever. Counting the horizon again is cheap (only `"usage"` lines are
parsed, and the reader reads its window anyway), rebuilds the deduplication state from the logs themselves, and
makes a double count impossible by construction; the file then only has to keep totals.

Keys (about 48,000 for 30 days of heavy use) stay in memory until their hour leaves the horizon; a sweep every 10
minutes forgets them and moves their hours to the file's side.

## 3. Periods

| Period | From | Note |
|---|---|---|
| `24h` | the current hour and the 23 before it | like the panel's other "24 h" numbers |
| `7d` | the current hour and the 167 before it | |
| `month` | local midnight of the 1st | calendar month |
| `30d` | the current hour and the 719 before it | |

The rolling periods move by whole hours (the ledger's unit). In a time zone with a half-hour offset a local day
boundary falls inside an hour; that hour is booked on the day it starts in.

## 4. Prices

`server/prices.mjs`: dollars per million tokens, dated `PRICED_AT` (2026-09-25, the claude-api skill's pricing
reference). A dated id (`claude-haiku-4-5-20251001`) takes the longest table id it starts with, followed by `-`,
`@` or `[`. Cache writes: 5 minutes = input × 1.25, 1 hour = input × 2.

A model that is not in the table is **never priced at $0 silently**: its tokens are counted, the report lists it in
`unpriced`, and `usdPartial` is true (the page says the dollar total is incomplete). Every dollar amount on the page
starts with `~$` and is called an "API equivalent, estimated": on a Claude subscription it is not billed.

The closed strip says so next to the dollars in plain words ("API equivalent · not your bill"): new users took the
number for an extra charge (claude-code #56980). One case turns it into a real bill: `ANTHROPIC_API_KEY` in the
environment, which Claude Code offers to use instead of the subscription. The server passes whether that variable is
set (never its value) to the ledger as `apiKeyEnv`; the summary carries it, and while dollars are shown the strip then
reads "a real cost if an API key pays" and adds a warning with a "Setup check" link (the tools panel,
docs/ai-start.md).

## 5. API

`GET /api/usage?period=24h|7d|month|30d[&project=<id>]`, read-only, under the same rules as every API route
(local host only, same origin, GET only). No period: `24h`. An unknown period or a malformed project id: 400. A
project that is neither listed nor in the ledger: 404.

```json
{
  "period": "7d", "from": 1790000000000, "to": 1790600000000, "ready": true, "scanning": false,
  "pricedAt": "2026-09-25",
  "totals": { "input": 95193, "cacheWrite5m": 75508817, "cacheWrite1h": 64387087, "cacheWrite": 139895904,
              "cacheRead": 6762217561, "output": 22193300, "messages": 19202, "processed": 162184397,
              "cacheShare": 0.98, "usd": 2733.12, "usdPartial": false },
  "projects": [{ "id": "…", "name": "…", "…totals": 0 }],
  "models": [{ "model": "claude-opus-5", "priced": true, "…totals": 0 }],
  "daily": [{ "day": "2026-08-31", "processed": 0, "cacheRead": 0, "output": 0, "messages": 0, "usd": 0 }],
  "unpriced": []
}
```

`projects` only without `project=`; with it the answer carries `projectId` and `name`. `daily` always covers the
last 30 local days. The snapshot and every patch carry `kpi.usage` (the compact totals of the four periods) and each
project's `usage30` (its last 30 days); a patch is sent when a number changes or the hour turns.

## 6. The page

- **Strip.** The former "Output tokens · 24 h" card became a usage row under the activity cards: the period buttons
  (24 hours · 7 days · This month · 30 days), the message count, and four cards: processed tokens, read from the
  cache (with the share), output, and "~$ API equivalent (estimate)" with "not billed on your subscription". Tooltips
  explain each; "Hide $" hides the dollars everywhere (strip, cards, drawer, sort).
- **Project cards.** One line: "30 days ~$X · Y M output" (tokens only while dollars are hidden).
- **Projects tab.** "Sort: By activity / By spend (30 days)"; by spend, the projects with usage come first, most
  first (by processed tokens while dollars are hidden).
- **Drawer.** A usage section for the project: the period buttons, the four numbers, 30 daily bars (dollars, or
  processed tokens while dollars are hidden) and the models; answers are kept 20 seconds.
- The period and the dollar setting are kept in the browser (`sibersentez.usage.period`, `sibersentez.usage.cost`), the
  sort in `sibersentez.projects.sort`; a blocked storage keeps them for the page.
- QA: `?qa=1&usage=30d&cost=0&sort=spend&open=project:<id>`.

## 7. Check against an independent count

On 2026-09-29 the ledger pipeline (reader + ledger + older logs) was compared, on the real logs and for the same
hour-aligned windows, with an independent count that uses the same rules without any SiberSentez code (the main
session's `cost.mjs`):

| Period | Messages (ledger / independent) | ~$ (ledger / independent) | Largest field difference |
|---|---|---|---|
| 24h | 3,014 / 3,014 | 280.91 / 280.91 | 0.000% |
| 7d | 19,395 / 19,394 | 2,752.39 / 2,752.25 | 0.009% |
| month | 39,240 / 39,239 | 8,842.60 / 8,842.45 | 0.004% |
| 30d | 40,193 / 40,192 | 8,985.97 / 8,985.83 | 0.004% |

The one message of difference is a log line that holds the characters U+2028/U+2029 inside a text: Node's
`readline` (used by the independent count) splits lines there and loses that line; the ledger splits only at `\n`
and counts it. A second start from the saved ledger gave the same numbers.

## Other AI tools (2026-10-07)

Codex CLI's, Gemini CLI's and Qwen Code's requests go into the same ledger (`server/ingestForeign.mjs foreignUsage`, from the
logs `server/toolLogs.mjs` reads): Codex's `last_token_usage` per `token_count` event (keyed by the session's running
total, so an event written again counts once), Gemini CLI's `tokens` per message id, Qwen Code's `usageMetadata` per
record uuid. These tools count the cached input inside the input; it is taken out and booked as a cache read, as Claude
Code's logs keep it. Output includes thinking (Gemini's thoughts, Qwen's thoughts; Codex's reasoning is already part
of its output). The model is the tool's own (`gpt-6-astra`, `gemini-3-pro`...): `server/prices.mjs` knows Anthropic's
prices only, so these are counted and listed among the models without a price, never given a made-up dollar amount.
The ledger's older-log scan (`scanOlderLogs`) stays Claude Code's: another tool's history older than the log reader's
window is not counted.

## What a job uses (2026-10-09, plan B5)

`GET /api/usage/jobs[?project=<id>]` (read-only, `server/jobCost.mjs`): for the recent jobs started in SiberSentez, each
job's span runs from its start record (`restore.mjs recordJobPoint`) to the project's next job start, at most three
hours and never past now; its usage is the project's usage in the ledger's hours of that span (`UsageLedger.span`, the
end hour left out). Whole UTC hours: another session in the same project and hour counts too, so the page says
"about". The answer: `{ jobs: [{ projectId, jobId, at, until, messages, processed, output, usd, capped, split,
others }], estimate: { jobs, low, high, median } | null, pricedAt }`; `usd` is null when a model of the job has no price
(Codex, Gemini...: tokens only), and the estimate is the range of the last ten priced jobs that did anything, none below
two. Each job says how its numbers were made (independent review §7.7, 2026-10-10): `split` (an hour shared with
another job, split evenly), `capped` (the span cut at three hours before the next start or now) and `others` (how many
other sessions of the project were open in its whole hours, from their start to their last line, idle or not, from the
log reader: `ingest.otherSessionsIn`, asked for the jobs answered only; null when those hours are older than its window
or it is still reading the logs).

- **Before a job** (the job box, under Start): "Recent jobs on this computer (N): about $low to $high each, API
  equivalent. On a subscription this is not billed; it counts toward your plan's usage." Without a range: where the
  number will show. Nothing with "Hide $".
- **After it** (the job's result): "This job: ~$X API equivalent (estimate), about N tokens processed", or its tokens
  only, then how it was counted: "Counted from this project's usage in the whole hours the job ran", with "an hour
  shared with another job is split evenly", "N other AI sessions of this project were open in those hours, and their
  usage then counts too" (or "any other session ... counts too" when not known) and "only about its first three hours
  are counted" (whole hours) when they hold, and the prices' date when dollars are shown. A job with no usage in its
  hours says so ("its AI tool may not log it": Cursor's logs hold no tokens), or that none is known when its hours are
  out of the logs' reach; never $0.
- Every other dollar figure says it is an API equivalent next to it: the strip, the usage cards, the project card's
  "30 days ~$X API equivalent", the daily chart's title, the drawer's usage footer with the prices' date.
- Not done: suggesting a lighter model or effort for a first job (it would need a launch option per tool).
