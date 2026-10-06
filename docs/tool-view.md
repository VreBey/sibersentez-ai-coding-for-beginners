# Tool view

Which AI tools see a project or a skill, agent or plugin (backlog "Tool UI", adapters wave 1; done 2026-09-29).

## Data

The server already tags every project with the adapters that found it (`via`) and every roster item with the adapters
that read it (`tools`); the snapshot's `tools` lists the adapters with `detected` and their counts (`toolsView`,
`server/views.mjs`). The minute roster broadcast now carries `tools` too, so the counts stay fresh; the page keeps them
in `store.tools`.

## What the page shows

`public/js/toolTags.js` (pure, `test/tool-view.test.mjs`):

- **Only when more than one tool left traces here** (`multiTool`): with one tool every card would carry the same tag,
  so neither the tags nor the filter appear.
- **Tags**: short names in a fixed color per tool (no logos, no brand art): Claude, Codex, Gemini, Copilot, Cursor,
  Antigravity; a new adapter shows its own name. At most three and "+N"; the full names are in the title. On the
  project cards (footer) and on the roster rows (after the source and category).
- **Filter**: a select in the Projects and Roster toolbars, "All AI tools" then each tool that tags at least one item
  with its count, the most first. A choice that disappears falls back to all. The roster filter is `f.tool` in
  `matchesFilter` (`rosterModel.js`).
- **AI tools panel**: each tool card says what its own traces show here ("Sees here: N projects · N skills · N
  agents"); an installed tool with nothing found says so; a tool not installed gets the line only when it left traces.
  The start-with-AI tool ids map to the adapter ids in `ADAPTER_OF_TOOL`.

## Open

- Same-named plugins of different tools still merge into one roster item (backlog).
- The drawer does not list the tools yet.
