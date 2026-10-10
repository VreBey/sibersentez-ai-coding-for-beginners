---
name: skill-writer
description: "Turns a job the user keeps explaining to the AI into their own skill or agent file in the project, in the format their tool reads, then proves the tool picks it for the right requests and not for others. Use when the user wants to write their own skill, make an agent for the project, or stop repeating the same instructions."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "docs, workflow"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "kendi skill*, skill yaz*, skill oluştur*, skill dosyası, beceri yaz*, beceri oluştur*, beceriye çevir*, kendi ajan*, ajan yaz*, agent yaz*, subagent yaz*"
---

# Skill writer

Goal: something the user explains to the AI again and again becomes one small file the tool loads by itself when it
is needed. The result is a working skill (or agent) in the project, tried with real requests, committed.

Do not use for: rules the AI must follow in every session (that is `agent-rules`, the project's `AGENTS.md`), or
facts and decisions to remember (`project-memory`).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Is a skill the right shape?

Ask what the user wants the AI to do, then pick one shape and say why in one sentence:

| The need | Shape |
|---|---|
| A job done now and then, with steps (release a version, add a page in our style) | a skill |
| A rule for every session (language, folders not to touch) | `AGENTS.md` through `agent-rules`, not a skill |
| A helper that works on its own, with fewer rights, and reports back (a reviewer that only reads) | an agent |
| The same command every time, no judgement | a script or a package.json command, not a skill |

## 2. Collect the job

Ask one question at a time and write the answers down:

1. The job in one sentence, and what "done" looks like.
2. The steps the user does by hand today, in order, with the real commands and file names.
3. Three things the user would type when they need it, in their own words.
4. Two requests that sound close but belong elsewhere (they must not start it).
5. What it must never do (delete data, push, touch certain folders).

## 3. Name and place

- The name: lowercase letters, digits and single hyphens, at most 64 characters, the same as its folder. Not
  `claude` or `anthropic` in it, and not a name the tool already uses for a built-in command (`code-review`,
  `simplify`, `init`, `review`, `test`, `docs` and the like): a clash hides one of them.
- The folder the user's tool reads (the SiberSentez kit README has the table): `.claude/skills/<name>/` for Claude
  Code, Copilot and Cursor; `.agents/skills/<name>/` for Codex, Gemini CLI, Antigravity, Qwen Code and OpenCode. For an
  agent: `.claude/agents/<name>.md` (other tools need their own format, see the same table).
- If the name or the file exists, show it and ask before changing anything.

## 4. Write the skill

`SKILL.md` starts with a frontmatter block, then the instructions:

```markdown
---
name: <name>
description: "<What it does, in the third person.> Use when <the three phrases from step 2, in the user's words>."
---

# <Title>

Goal: <one sentence>.

## Steps
1. ...

## Done when
- <the check that proves it, and what to tell the user>
```

- The description decides whether the tool ever picks it: what it does first, then "Use when" with the user's own
  phrases. Keep it under about 350 characters (the limit is 1024; tools shorten long lists).
- Put an ask-first line in every skill that changes things, and a "Done when" list with a real check.
- Keep `SKILL.md` short (well under 150 lines). Long tables, full code or error lists go to `reference.md` next to
  it, linked from `SKILL.md`; a file over about 100 lines opens with a one-line list of its sections.
- Never write a key, a password, `.env` content or personal data into it; example values are plainly fake.

## 5. Write an agent instead (when step 1 chose it)

`.claude/agents/<name>.md` with `name`, `description` (when to hand work to it) and `tools`: only what it needs
(`Read, Grep, Glob` for a reader; add `Bash` to run checks; `Edit, Write` only if it changes files). The body says
its job, what it gets, the steps, and a fixed last line the caller can read (for example `DONE` or `BLOCKED`).

## 6. Try it

1. Start a new session in the project: tools read skills when a session starts.
2. Ask the tool which skills it has (Claude Code: "What skills are available?") and check the new one is listed. Not
   listed: the frontmatter is broken or the folder is wrong; fix that first.
3. Type each of the three phrases from step 2 in a fresh session. It should start the skill. Then the two "belongs
   elsewhere" requests: it should not.
4. If it is not picked, call it by name once (Claude Code: `/<name>`). Works by name but not by itself: rewrite the
   description with the user's words. Does not work by name either: fix the steps.
5. At most three rounds. Show the user a small table: request, picked or not, what you changed.

## 7. Using someone else's skill as a start

Read every file in it before it goes into the project, scripts first: a skill can tell the AI to run commands. Keep
its license file and notice; if it has no license, do not copy it, write your own. Take ideas, not their text.

## 8. Keep it

Commit after a yes (`git add <folder>`, `git commit -m "feat: <name> skill"`). If the user works with others, add one
line about it to `AGENTS.md` (ask first).

## Done when

- The file path is shown, and the tool listed the skill (or agent) in a new session.
- The table of step 6 shows the three phrases picking it and the two others not, or says plainly what still fails.
- You told the user in one sentence how to start it by hand when it is not picked by itself.
