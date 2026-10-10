---
name: llm-app-basics
description: "Adds a call to an AI language model to an app: key kept in .env, a first small request, handling of errors and rate limits, a cost ceiling, tested prompts, privacy rules and tests that need no network. Use when an app should summarize, classify, answer or write text with an AI model, or the user asks how to connect to one."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "ai, backend"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "yapay zekâ modeli, yapay zekâ ekle*, yapay zekâ özelliği, yapay zekâ entegre*, yapay zekâ uygulama*, yapay zekâ çağır*, dil modeli, llm, prompt*, chatgpt, openai, claude api"
---

# AI model in an app

Goal: one feature of the app asks an AI model a question and uses the answer, safely, with a known maximum cost,
and with tests that do not spend money. Prompt templates and the error table are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never ask the user to paste an API key into the chat. They type it into the `.env` file themselves.
- Every request costs money or quota. Say so before the first live request and keep the first ones tiny.

## 1. Decide the one job

Read `PLAN.md`. Ask: "What goes in, what should come out, and who sees it?" Write one sentence such as "a customer
message goes in, a one-word topic comes out". One job per feature; a chat that does everything is a later step.

## 2. Pick a provider and a model

The user needs an account and billing set up with a provider. Name two or three options, recommend one, and read the
provider's official documentation for the current model names, prices and limits: they change often, so never rely
on memory and say when you could not check. A small, cheap model is the right start for most jobs.

## 3. The key

Follow `env-and-secrets`: the key lives in `.env` (ignored by git), `.env.example` holds the name only. The call is
made from **server code or a script**, never from a web page or an app that users can open: whoever can read the
code can read the key. If the app has no server, add the smallest one that forwards the request.

## 4. The first request

Write a ten-line script that sends one short fixed text and prints the answer and the token counts the provider
reports. Run it once (the user says yes to the cost). Show the output. Only then build the feature around it.

## 5. Errors and limits

Handle every row of the table in the reference: bad key, rate limit, overload, timeout, empty or cut-off answer. Retry
only the ones that can pass (rate limit, overload), at most three times, waiting longer each time. Show the person
a plain message ("the assistant is busy, try again in a minute"), never the raw error.

## 6. A cost ceiling

- Limit the length of the input and set a maximum length for the answer in every request.
- Limit requests per person per day, and in total per day; refuse politely past the limit.
- Log the token counts of each request (no personal text), and ask the user to set a spending limit in the
  provider's dashboard: only they can.
- Cache answers to identical questions when the job allows it.

## 7. Prompts

Write the instruction once, in a template file: the role, the task, the output format, what to do when the input
is unclear, and one or two examples. Keep the person's text apart from the instruction, between clear markers. Try
the prompt on five to ten real sample inputs, keep them in a file, and note which answers were good. Change one
thing at a time and compare. Templates are in the reference.

## 8. Privacy and trust

- Tell users that their text is sent to an outside provider, in the app, in plain words.
- Send only what the job needs: no passwords, keys, health or payment data, and no other person's data without a
  reason. Read the provider's data policy and tell the user what it says about storing and training.
- The answer is untrusted text: escape it before showing it in a page, never run it as code or a command, and check
  a structured answer (for example JSON) before using it.

## 9. Tests

Tests never call the provider: put the call behind one small function and replace it with a fake that returns fixed
answers and fixed errors (`test-first`). Test the parts you own: building the prompt, reading the answer, the
retry rule, the daily limit. Add one manual live check, with a tiny input, and write down its result.

## Do not use for

- Keeping keys safe in general: use `env-and-secrets`.
- Scripts and bots that need no model: use `python-bot-starter`.
- Auditing the finished app: use `security-check`.

## Done when

- The key is only in `.env`, and `git status` does not list it; the call runs on the server side.
- The first live request worked, with its answer and token counts shown.
- Each error row of the table is handled and tested with the fake; the limits and the length caps exist.
- The user knows what each request costs roughly (from the provider's current price page) and set a spending limit.
- The test suite passes without network access (show the summary).
