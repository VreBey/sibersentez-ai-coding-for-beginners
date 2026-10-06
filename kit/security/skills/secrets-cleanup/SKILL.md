---
name: secrets-cleanup
description: "Handles a leaked key, token or password step by step: find where it went, get it revoked, replace it, remove it from the current files, and only then decide about cleaning git history, with a separate yes for every step. Use when the user committed or pushed a password or API key, shared a secret by mistake, or found a key in the code."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-tags: "security, git"
  sibersentez-stage: "any"
  sibersentez-keywords-tr: "commit ettim, yanlışlıkla şifre*, yanlışlıkla anahtar*, yanlışlıkla paylaştım, anahtarı paylaştım, github a yükledim, sızdır*, sızdı, geçmişten sil*, anahtarı iptal"
---

# Secrets cleanup

A secret that left the computer (committed, pushed, pasted, screenshotted) must be treated as stolen. The order
matters: **revoke first, clean later**. Staying calm helps: say this to the user in a friendly way, and explain each
step in one sentence. Provider notes and the history-cleanup guide are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- When you show a secret you found, name its kind or public prefix (`sk-`, `wk_live_`, `ghp_`) and its file:line,
  never its characters. Never write a secret into a new file.

## Step 1: find out what happened

Ask, one at a time: which key or password (what kind, which service), where it was seen (file, commit, chat,
screenshot), and whether the project was ever pushed to GitHub or shared, and whether it is public. Then look:

- `git status` and `git remote -v` (is there an online copy?).
- `git log --all --oneline -S"<first characters>"` shows the commits that added or removed the text.
- Search the current files for the first characters.

Say plainly what you found: which files, which commits, whether it left the computer.

## Step 2: revoke it (the user does this, ask for a yes)

If the secret was ever pushed or shared, assume someone has it. Tell the user to open the provider's dashboard, delete
or disable the key, and create a new one. You cannot do this for them. Ask: "Did you revoke the old key? (yes/no)"
and wait. If the user cannot revoke it (a password used elsewhere), list where else that password is used.
Also suggest a look at the provider's usage page for calls the user does not recognize, and at bills.

## Step 3: put the new key in the right place (yes needed)

The new key lives only in a `.env` file the user makes on their own, never in code and never in the chat. Use the
`env-and-secrets` skill to set it up. Then update the running app and check that it works with the new key.

## Step 4: remove it from the current files (yes needed)

1. Replace the value in the code with a read from the environment.
2. Make sure `.gitignore` lists `.env`; check `git check-ignore -v .env`.
3. If `.env` was tracked, `git rm --cached .env` stops tracking it and keeps the file; ask first.
4. Commit the fix after a yes.

## Step 5: decide about the git history (a separate yes)

Explain this clearly before asking:

- **A revoked key in old commits is harmless.** Cleaning history is optional tidiness, not needed for safety.
- Cleaning is worth it when the leak was **personal data or something that cannot be revoked**, or when the
  user simply wants a clean history.
- Cleaning **rewrites history**. Every commit gets a new id, the push has to overwrite the online history, everyone
  who has a copy must start again from a fresh one, and old copies (forks, clones, caches) may still exist. It is
  the riskiest thing in this skill.

If the user still wants it: (1) make a full backup first, for example copy the whole project folder, and check the
copy opens; (2) get a yes for the backup and another yes for the rewrite; (3) do not write the commands from
memory: read GitHub's official guide (see the reference) and use the tool it recommends, whose installation needs a
yes; (4) your tool will ask before the push that overwrites the online history, and the exact command is in
GitHub's guide. If the project has other collaborators, tell them before, not after.

## Step 6: prevent a repeat

Offer, each with a yes: `.env.example` with fake names, a scan of the project for other secrets (the
`security-check` skill), and secret scanning options of the hosting service (check its documentation).

## Do not use for

- A general safety review with nothing leaked: use `security-check`.
- Setting up keys safely in a project without a leak: use `env-and-secrets`.
- A normal git undo: use `git-basics`.

## Done when

- The user confirmed the old secret is revoked or disabled (write down when).
- The new secret works in the app (name the command and what it printed, without the secret).
- A search of the current files for the first characters of the old secret finds nothing (quote the command), and
  `git check-ignore -v .env` prints a rule.
- The history decision is recorded: left as is, or cleaned with a backup and the user's yes.
- You told the user in one sentence what was leaked, what was done, and what remains their job.
