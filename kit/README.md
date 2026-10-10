# SiberSentez Kit

SiberSentez's own set of skills and agents, written for SiberSentez from scratch. It helps a person go from an idea in an
empty folder to a running, tested, documented and released project, with any AI coding tool that reads the
[Agent Skills](https://agentskills.io/specification) format.

- 60 skills and 16 agents, each a plain Markdown file.
- Written for beginners: every step is explained, and the AI asks before deleting or overwriting files, installing
  anything, changing system settings or pushing to a remote.
- The files are in English; every skill tells the AI to talk to the user in the user's own language.

## What is inside

| Category | Skills | Agents |
|---|---|---|
| Team and orchestration (`team`) | `handoff-notes`, `next-step`, `orchestrate`, `orchestrate-build`, `orchestrate-plan`, `orchestrate-review`, `orchestrate-wrapup`, `project-memory` | `builder`, `scout`, `task-slicer` |
| Planning (`planning`) | `feature-spec`, `idea-to-plan`, `plan-challenge`, `scope-guard`, `task-breakdown`, `tech-stack-chooser` | `planner` |
| Starters (`starters`) | `api-service-starter`, `browser-extension-starter`, `cli-tool-starter`, `data-analysis-starter`, `desktop-app-starter`, `game-prototype-godot`, `game-prototype-unity`, `landing-page-starter`, `mobile-app-starter`, `project-setup`, `python-bot-starter`, `web-app-starter` | – |
| Quality and testing (`quality`) | `debug-helper`, `dependency-update`, `fix-build-errors`, `performance-check`, `refactor-safely`, `review-changes`, `test-first`, `try-it-in-browser`, `verify-before-done` | `debugger`, `qa-explorer`, `reviewer`, `tester` |
| Security (`security`) | `secrets-cleanup`, `security-check` | `security-auditor` |
| Docs (`docs`) | `agent-rules`, `api-docs`, `architecture-notes`, `docs-writer`, `explain-codebase`, `skill-writer` | `doc-builder` |
| Release (`release`) | `deploy-web`, `docker-basics`, `domain-email`, `env-and-secrets`, `finish-branch`, `git-basics`, `github-actions-setup`, `launch-checklist`, `move-to-new-host`, `release-prep` | `devops-helper`, `launch-checker` |
| Design and UI (`design`) | `ui-check`, `ui-polish`, `multi-language` | `frontend-builder` |
| Backend and data (`backend`) | `auth-flow`, `contact-form`, `database-schema` | `backend-builder`, `data-analyst` |
| AI apps (`ai-apps`) | `llm-app-basics` | – |
| Games (`game`) | – | `game-builder` |

A typical path: `idea-to-plan` → `tech-stack-chooser` → `project-setup` or a starter → `task-breakdown` →
`test-first`, `fix-build-errors`, `debug-helper`, `review-changes` while building → `verify-before-done` →
`security-check` → `docs-writer` → `finish-branch` → `release-prep`. Going online: `deploy-web` → `launch-checklist`
(or the `launch-checker` agent) → `domain-email`; changing hosts later: `move-to-new-host`.

A bigger job with the team: `orchestrate` sizes it, then `orchestrate-plan` (you approve the plan),
`orchestrate-build`, `orchestrate-review` (an independent reviewer gives the verdict) and `orchestrate-wrapup`
(you approve the result). The hand-off files live in the project's `.sibersentez/` folder. `next-step` says what to
do now; `handoff-notes` and `project-memory` keep the thread between sessions.

## Layout

```
<category>/skills/<name>/SKILL.md     a skill (some have a reference.md next to it)
<category>/agents/<name>.md           an agent
catalog.json                          every item with its tags, stage and Turkish keywords
```

Categories: `team`, `planning`, `starters`, `quality`, `security`, `docs`, `release`, `design`, `backend`, `ai-apps`, `game`.

Out of scope for now: programs for small devices and hardware (microcontrollers, sensors, embedded and IoT work). The kit
has no item for them; when an idea needs one, `idea-to-plan` and `tech-stack-chooser` say so honestly and leave you with
`project-setup` and the maker's own guides.

## Installing

**With SiberSentez**: open a project, pick the suggested SiberSentez Kit items and install them; SiberSentez copies them into
the project's tool folders.

**By hand**: copy a skill folder (`<category>/skills/<name>/`) or an agent file into the project. Where each tool
looks (checked 2026-10-09 in each tool's documentation or its installed package):

| Tool | Skills | Agents |
|---|---|---|
| Claude Code | `.claude/skills/<name>/` | `.claude/agents/<name>.md` as it is |
| GitHub Copilot (CLI, VS Code) | `.github/skills/`, `.claude/skills/` or `.agents/skills/` | `.claude/agents/` as it is |
| Cursor | `.agents/skills/`, `.cursor/skills/` or `.claude/skills/` | `.claude/agents/` as it is |
| Codex CLI | `.agents/skills/` | `.codex/agents/<name>.toml` (its own format; read-only sandbox for an agent that only reads) |
| Gemini CLI, Antigravity | `.agents/skills/` | Gemini CLI: `.gemini/agents/<name>.md` (`name`, `description` and `tools` in Gemini names) |
| Qwen Code | `.qwen/skills/` or `.agents/skills/` | `.qwen/agents/<name>.md` (`name`, `description` and `tools` in Qwen names) |
| OpenCode | `.agents/skills/`, `.opencode/skills/` or `.claude/skills/` | `.opencode/agents/<name>.md` (`description`, `mode: subagent`, edit and shell denied when the tools leave them out) |

So `.claude/` serves Claude Code, Copilot and Cursor, and `.agents/skills/` serves every other tool. An agent copied by
hand for Codex, Gemini CLI, Qwen Code or OpenCode needs its frontmatter rewritten in that tool's format; SiberSentez
writes those files itself when it installs an agent for a job run with one of them.

## License

The MIT License (see [LICENSE.md](LICENSE.md)); the SiberSentez app itself is under the GNU GPL version 3 or later. You
may use, change and share the items, in a project or on their own; every copy keeps its notice (a skill's
`LICENSE.md`, an agent's comment lines at the top). What you create with them is yours.
