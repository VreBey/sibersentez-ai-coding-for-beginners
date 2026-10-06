---
name: plan-challenge
description: "Questions a plan or an idea with at most five sharp questions before any code is written: the riskiest assumption, the first real user, the smallest test, what could go wrong, and what we will not do. Use when the user says test my plan, find the weak spots, is this a good idea, or before building something big."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "planning"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "zayıf yer*, planı sorgula*, planımı sorgula*, fikri sorgula*, planı zorla*, ön ölüm, en riskli varsayım, iyi bir fikir mi, vazgeçmeli miyim, fikrimi test et"
---

# Plan challenge

A short, friendly cross-examination of a plan before it turns into code. Five questions can save weeks: they show
the weak spot while changing the plan is still cheap. "Stop" is a good result, not a failure.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Read the plan first

Read `PLAN.md` or `.sibersentez/PLAN.md` if one exists, or take the idea from the chat. Say it back in one sentence
("So you want ..., for ..."). If the user corrects you, fix that sentence before any question.

## 2. Ask, one question at a time

Ask at most five, in this order, and wait for each answer. Offer your own guess as a suggestion the user can accept
or change, but never answer for them. Skip a question the plan already answers well and say so.

1. **Riskiest assumption.** "What must be true for this to work, and which of those things are you least sure of?"
2. **First user.** "Who is the very first person who will use it, and what do they do today instead?" A real person or
   a clear kind of person, not "everyone".
3. **Smallest test.** "What is the smallest thing we could try in a day or two that would show whether question 1 is
   true?" A paper sketch, a fake screen or one script all count.
4. **Pre-mortem.** "Imagine it is three months later and this failed. What is the most likely reason?"
5. **Not doing.** "What will we deliberately NOT build in the first version?" At least one thing, by name.

If an answer is vague ("it depends", "people will like it"), ask once for an example, then write "unknown".

## 3. Give a result

Show a short summary: one line per question with the answer, then a result in plain words:

| Result | When | What happens next |
|---|---|---|
| **Go** (`devam`) | The riskiest assumption has a cheap test and nothing fatal appeared | Continue with the plan or `task-breakdown` |
| **Change** (`değiştir`) | A weak spot needs a different scope, user or first step | Name the change; update the plan with the user's yes |
| **Stop** (`vazgeç`) | The core assumption is false, or the smallest test is not worth the cost | Say so kindly; nothing gets built |

Never push toward "go". If the honest answer is "stop" or "change", say that first.

## 4. Write it down (only with a yes)

Ask: "Shall I add a short note to the plan?" Only after a yes, append this to `PLAN.md` (or `.sibersentez/PLAN.md`); if
no plan file exists, offer to create one but do not create it without a yes. Never rewrite the user's own lines.

```markdown
## Challenged
Date: <today> · Result: go | change | stop
- Riskiest assumption: ...
- First user: ...
- Smallest test: ...
- Pre-mortem: ...
- Not doing: ...
```

## With a team

In the `orchestrate` flow this skill may also be called after two review rounds that still ended in `REVISE`: the
plan itself may be the problem, so run the five questions on the plan, then report the result to the user.

## Do not use for

- Turning a rough idea into a plan: use `idea-to-plan`.
- Guarding a plan that keeps growing: use `scope-guard`.
- Checking finished code: use `review-changes`.
- Choosing a language or framework: use `tech-stack-chooser`.

## Done when

- The user answered (or marked unknown) each question that was asked, one at a time.
- A result of go, change or stop was said in plain words.
- The "Challenged" note was added only after a yes, or the user said no note is wanted.
- You told the user in one sentence what happens next.
