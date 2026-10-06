# GitHub Actions setup: reference

Checked 2026-10-01 (revisit every six months). Official pages:

- Workflow syntax and quickstart: https://docs.github.com/en/actions
- Node.js recipe: https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs
- Python recipe: https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-python
- Billing and free minutes: https://docs.github.com/en/billing
- The actions used below live at https://github.com/actions/checkout, https://github.com/actions/setup-node and
  https://github.com/actions/setup-python. **Their newest major version can be higher than the one written here
  (`@v7`, `@v6`): open each page, read its README example, and use that version.** These recipes were written from
  the documentation and were not run on GitHub by the author of this kit, so read the first run's log carefully.

## Placeholders

`<your branch>` and `<the project's test command ...>` are not values to copy. Read the branch with
`git branch --show-current` and the test command from `package.json` scripts, `pyproject.toml` or the README; if you
cannot find them, ask the user. A `pytest` command needs pytest in the project's requirements.

## Node.js recipe

Needs a lock file (`package-lock.json`) in the repository, because `npm ci` installs exactly from it. Change
`node-version` to the version the project uses.

```yaml
name: CI

on:
  push:
    branches: [<your branch>]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: <the project's test command, for example npm test>
      - run: npm run build --if-present
```

Add `- run: npm run lint --if-present` before the test step if the project has lint.

## Python recipe

Needs a `requirements.txt` (or use the project's own install command).

```yaml
name: CI

on:
  push:
    branches: [<your branch>]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: <the project's test command, for example python -m pytest>
```

## Python recipe with a package cache and several versions

When the project must work on more than one Python version, or the install step is slow. The test tool must be in
`requirements.txt` (or a `requirements-dev.txt`); read the real file names from the project.

```yaml
name: CI

on:
  push:
    branches: [<your branch>]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: ${{ matrix.python-version }}
          cache: pip
      - run: python -m pip install -r requirements.txt
      - run: <the project's test command, for example python -m pytest>
```

`cache: pip` keeps downloaded packages between runs. The matrix runs the same steps once per version listed: use the
versions the project really supports.

## Unity recipe (tests in the editor, run by a ready-made action)

Unity needs a licence to run, so this is more work than the others and the steps for the licence change: read the
documentation of the action first (https://game-ci.com/docs/github/getting-started and the repository
https://github.com/game-ci/unity-test-runner), follow its licence activation page, and check the current version
numbers of the actions. The first run downloads a large image and can take a long time and many minutes of your
allowance; run it only when the project has Edit Mode or Play Mode tests. `Game` is the folder that holds
`Assets/` and `ProjectSettings/`.

```yaml
name: Unity tests

on:
  push:
    branches: [<your branch>]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/cache@v6
        with:
          path: Game/Library
          key: Library-${{ hashFiles('Game/Assets/**', 'Game/Packages/**', 'Game/ProjectSettings/**') }}
          restore-keys: Library-
      - uses: game-ci/unity-test-runner@v4
        env:
          UNITY_LICENSE: ${{ secrets.UNITY_LICENSE }}
          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
          UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
        with:
          projectPath: Game
```

The secrets are created by the user in the repository settings (never typed into the chat or the file). A Personal
licence needs `UNITY_LICENSE` (the contents of the activated `.ulf` file), `UNITY_EMAIL` and `UNITY_PASSWORD`, as above;
a Professional licence uses `UNITY_EMAIL`, `UNITY_PASSWORD` and `UNITY_SERIAL` instead. Follow the action's page. A Godot or other engine project has its own
ready-made actions: search the engine's documentation and check the action's page before using it.

## Reading the parts

| Part | Meaning |
|---|---|
| `on: push` and `pull_request` | run when someone pushes to the named branch and on every pull request |
| `permissions` | what the run may do with your repository; read-only here |
| `runs-on: ubuntu-latest` | a fresh Linux machine, thrown away after the run |
| `uses: actions/checkout` | downloads your code onto that machine |
| `run:` | a command, exactly as you would type it in a terminal |

## When the run fails

| Symptom in the log | Usual cause and fix |
|---|---|
| `npm ci` says the lock file is missing or out of date | commit `package-lock.json`; regenerate it with `npm install` here (ask first) |
| Tests pass here and fail online | different runtime version, a file that exists only on your computer, a test that needs `.env` or the network |
| `Process completed with exit code 1` | just the summary: read the lines above it |
| `command not found` | a tool the project needs is not installed on the machine: add an install step |
| Windows-only paths or commands | the runner is Linux: use forward slashes and cross-platform commands, or pick `windows-latest` |
| A deprecation warning about an action version | update to the newer major version from the action's page |

## Secrets in a workflow

Add values under the repository's Settings, Secrets and variables, Actions (the user does it in the browser). In the
file, refer to the name only: `${{ secrets.NAME }}`. GitHub hides the value in logs, but do not print it on purpose,
and do not give secrets to workflows started from forks of a public repository.
