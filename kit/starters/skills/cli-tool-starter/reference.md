# Command line tool starter: reference

The example tool, `wordcount`, counts the lines and words of a text file. Replace the work function with the user's.
Checked against the documentation of Python's `argparse` (https://docs.python.org/3/library/argparse.html) and Node.js
`util.parseArgs` (https://nodejs.org/api/util.html#utilparseargsconfig); if a call differs in the version in use,
read those pages.

## Python: wordcount.py

```python
import argparse
import sys
from pathlib import Path

__version__ = "0.1.0"


def count(path):
    """The work: returns (lines, words) of a text file."""
    text = Path(path).read_text(encoding="utf-8")
    return len(text.splitlines()), len(text.split())


def build_parser():
    parser = argparse.ArgumentParser(
        prog="wordcount",
        description="Count the lines and words of a text file.",
        epilog="Example: wordcount notes.txt --verbose",
    )
    parser.add_argument("file", help="the text file to read")
    parser.add_argument("--verbose", action="store_true", help="also print the file name")
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)   # a wrong option stops here with exit code 2
    try:
        lines, words = count(args.file)
    except FileNotFoundError:
        print(f"File not found: {args.file}. Check the name and the folder.", file=sys.stderr)
        return 1
    except UnicodeDecodeError:
        print(f"{args.file} is not a UTF-8 text file.", file=sys.stderr)
        return 1
    prefix = f"{args.file}: " if args.verbose else ""
    print(f"{prefix}{lines} lines, {words} words")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run: `.venv\Scripts\python wordcount.py notes.txt`. Test with `main(["notes.txt"])` and `capsys`.

## Python: pyproject.toml for an installable command

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "wordcount"
version = "0.1.0"
description = "Count the lines and words of a text file."
requires-python = ">=3.10"

[project.scripts]
wordcount = "wordcount:main"

[tool.setuptools]
py-modules = ["wordcount"]
```

With a yes: `.venv\Scripts\python -m pip install -e .` puts a `wordcount` command into that environment's
`Scripts` folder. It works from any folder while that environment's `Scripts` folder is on the path, or by calling
`.venv\Scripts\wordcount.exe` with its full path.

## Test file (Python): tests/test_wordcount.py

```python
import wordcount


def test_counts_lines_and_words(tmp_path, capsys):
    f = tmp_path / "a.txt"
    f.write_text("one two\nthree\n", encoding="utf-8")
    assert wordcount.main([str(f)]) == 0
    assert "2 lines, 3 words" in capsys.readouterr().out


def test_missing_file_is_a_clear_error(capsys):
    assert wordcount.main(["nope.txt"]) == 1
    assert "File not found" in capsys.readouterr().err


def test_help_lists_the_options(capsys):
    try:
        wordcount.main(["--help"])
    except SystemExit as stop:
        assert stop.code == 0
    out = capsys.readouterr().out
    assert "--verbose" in out and "--version" in out
```

## Node.js: wordcount.mjs

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const VERSION = '0.1.0';
const HELP = `Usage: wordcount <file> [--verbose]

Count the lines and words of a text file.

Options:
  --verbose   also print the file name
  --version   print the version
  --help      show this text

Example: wordcount notes.txt --verbose`;

export function count(path) {
  const text = readFileSync(path, 'utf8');
  // A final line break does not start another line
  const lines = text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return { lines, words };
}

export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { verbose: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' } } });
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { console.log(HELP); return 0; }
  if (values.version) { console.log(VERSION); return 0; }
  if (positionals.length !== 1) { console.error(`Give exactly one file.\n\n${HELP}`); return 2; }
  try {
    const { lines, words } = count(positionals[0]);
    console.log(`${values.verbose ? positionals[0] + ': ' : ''}${lines} lines, ${words} words`);
    return 0;
  } catch (error) {
    console.error(`Cannot read ${positionals[0]}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`);
    return 1;
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
```

For a command anyone can install, `package.json` gets `"type": "module"` and `"bin": { "wordcount": "wordcount.mjs" }`.
With a yes, `npm link` in the project folder makes `wordcount` available from any folder (it adds a link in the global
folder; `npm unlink` removes it).

## Exit codes and streams

| Code | Meaning | Where the message goes |
|---|---|---|
| 0 | it worked | normal output |
| 1 | it ran but failed (file missing, unreadable data) | the error stream, with what to do |
| 2 | wrong usage (unknown option, missing argument) | the error stream, with the help text |

Results go to normal output so they can be piped to another program; messages about problems go to the error stream.

## Common problems

| Symptom | Cause and fix |
|---|---|
| `'wordcount' is not recognized` | the command is not on the path of that terminal. Open a new terminal after installing; check the `Scripts` folder of the environment is on the path, or use the full path. |
| Works in the project folder, not elsewhere | the code reads files relative to the script. Resolve user paths from the current folder; keep the tool's own files separate. |
| `python` runs a different Python | two installations. `py -0` lists them; use the project's `.venv` Python. |
| `npm link` says permission denied | the global folder needs rights. Do not use elevated rights: use `node wordcount.mjs` or a `.cmd` wrapper instead. |
| The help text is empty or unclear | add `help=` to every argument and an example in the epilog. |
| Non-English letters appear as `?` in the console | the console code page. Try a new terminal or `chcp 65001`; write files as UTF-8. |
| The tool waits forever | it reads from the keyboard when no file is given. Check the arguments first and stop with the usage error. |
| Tests run the real program slowly | test the `main` function with a list of arguments, not a subprocess. |
