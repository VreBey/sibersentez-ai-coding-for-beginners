---
name: github-actions-setup
description: "Sets up a first automatic check on GitHub: a workflow file that installs the project, runs its tests and build on every push and pull request, and shows how to read the result. Use when the user wants tests to run automatically, asks about CI, wants a green check before merging, or wants GitHub to build the project for them."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.2.2"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "devops, git"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "github actions, ci, otomatik test*, her push, testler otomatik, sürekli entegrasyon, yeşil tik"
---

# GitHub Actions setup

A workflow is a small recipe file. Every time someone pushes, GitHub follows it on a clean machine: install, test,
build. If the recipe fails, the change is not safe yet. The ready recipes and the freshness notes are in
[reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check the starting point

1. The project must be a git repository with a GitHub remote: `git remote -v`. If not, use the `git-basics` skill first.
2. The commands must already work on this computer. Find them (the `scripts` of `package.json`, the README, the
   test tool of the language) and run them: for example the test command and the build command. A workflow can only
   repeat what already works here. Show the user the two results.
3. Note the runtime version in use here (`node --version` or the language's equivalent), to use the same one online.
4. Read, never assume: the branch name from `git branch --show-current` (it may be `main`, `master` or another one),
   the test command from the `scripts` in `package.json` or from `pyproject.toml` / the README (for Python, also
   check that the test tool is in the project's requirements). If you cannot find one of these, ask the user.

## 2. Choose the recipe

Use the recipe in the reference that matches the project (Node.js, Python, or Unity for a game with tests), and put in
the branch name and the test command you found in step 1, not the ones written as placeholders in the recipe. The
Unity recipe needs a licence and secrets the user sets up, so go through its notes together before you write it. For
another language or engine, say so and read the official GitHub Actions documentation for it; do not invent steps. Keep
it small: install, test, build. Add lint if the project has it.

## 3. Write the workflow file

Create `.github/workflows/ci.yml` (a new file; if it exists, show it and ask before changing it). Explain the parts in
plain words: when it runs (`on`), where (`runs-on`), what it does (`steps`). Two safety points to keep:

- `permissions: contents: read` at the top: the recipe can read the code and nothing else.
- No secret values in the file. If a test truly needs a secret, the user adds it in the repository settings
  (Settings, Secrets and variables) themselves; the file only refers to its name. Prefer tests that need none.

## 4. Send it and watch (a yes for the commit and again for the push)

1. `git add .github/workflows/ci.yml`, `git commit -m "chore: add CI workflow"`.
2. `git push`. Say what will be sent first.
3. On github.com, open the repository's **Actions** tab, or run `gh run list` if the GitHub CLI is installed. A
   yellow dot is running, a green check is passed, a red cross is failed.

## 5. If it fails

Open the failed run, find the first red step and read its log. The usual causes are in the reference. The most common
one is that it fails online but works here: a different runtime version, a missing lock file, or a test that
depends on your computer's files. Fix it here first (`fix-build-errors` or `debug-helper`), then commit and push again.
Never "fix" it by removing the failing step.

## 6. Explain the result

Tell the user how to read it: every push and pull request shows the check. Suggest making the check required before
merging (GitHub's branch protection settings; the user changes it, see the documentation). Private repositories
have a monthly allowance of free minutes: check GitHub's current documentation before promising anything.

## Do not use for

- Putting the site online: use `deploy-web`.
- Making the build pass on this computer: use `fix-build-errors`.
- Learning to write tests: use `test-first`.
- Committing and pushing basics: use `git-basics`.

## Done when

- The commands were run locally first, and their result is shown.
- `.github/workflows/ci.yml` exists, and the push happened with the user's yes.
- The Actions tab (or `gh run list`) shows a run for that push, and its state is stated (green, or red with the
  first failing step and what was done about it).
- You told the user in one sentence what now runs on every push and where to see it.
