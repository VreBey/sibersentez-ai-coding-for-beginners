---
name: data-analysis-starter
description: "Sets up a first data analysis in Python: load a CSV or Excel file, look at it, clean it, answer one question, draw one chart and save the result, checking every number a second way. Use when the user has a data file, a spreadsheet or a CSV and wants to count, compare, find a trend or make a chart from it."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Python 3.10 or newer and git. Commands are written for Windows; on macOS and Linux use .venv/bin/python."
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "python, data"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "veri analiz*, analiz et*, veri seti*, csv, excel*, pandas, grafik çiz*, veri temizle*, istatistik*, tablo verisi, satış verisi"
---

# Data analysis starter

Goal: from a data file and one question to a written answer, one chart and a saved result, with the numbers checked.
The code, the cleaning recipes and the common problems are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- The original file is never edited. Work on a copy, and never print rows that hold personal data into the chat.

## 1. Check the tools

`py --version` (or `python --version`): 3.10 or newer. If `python` opens the Microsoft Store, Python is not really
installed: the user installs it from python.org (ticking "Add python.exe to PATH"), or you run
`winget install Python.Python.3.13` after a yes. Open a new terminal afterwards. `git --version` too.

## 2. The file and the question

Ask two things, one at a time: "Where is the file?" and "What do you want to know, in one sentence?" (for example
"Which month had the highest sales?"). Copy the file into `data/raw/` and never change that copy. If the data is
personal or private, add `data/raw/` to `.gitignore` before anything else.

## 3. A private Python for the project

1. `py -m venv .venv` (packages go there, not into the system).
2. `requirements.txt` with `pandas`, `matplotlib` and, for `.xlsx` files, `openpyxl`, each with a major version range.
3. After a yes (it downloads packages): `.venv\Scripts\python -m pip install -r requirements.txt`. Call the project's
   Python directly; no need to "activate" anything.
4. Add `.venv/`, `__pycache__/` and `output/` to `.gitignore` if the user does not want results committed.

## 4. Look before you change

Write `explore.py` (the reference has it): rows and columns, the type of each column, the first rows, missing values
per column, duplicate rows, the smallest and largest value of each number column. Run it and explain the output in
plain words: "12,400 rows, 3 columns have gaps, 40 rows appear twice."

## 5. Clean, and say what you changed

Write `analyze.py` with small functions: load, clean, answer, chart. In cleaning: tidy column names, turn text into
numbers and dates, drop exact duplicates, and decide with the user what to do with gaps (leave, fill, or drop the
row). Print how many rows each step removed. Never delete rows silently, and keep the cleaned table in `data/clean/`.

## 6. Answer the question

Compute the answer with the clearest method (a total, an average, a count per group, a change over time). Print the
small result table and write the answer as a sentence: "March had the highest sales: 48,200." Say what the numbers
cannot show (a few months of data is not a trend).

## 7. One chart

Draw one chart that shows the answer: bars to compare groups, a line for time. Title, axis names with units, a readable
size. Save it as `output/chart.png` (and let the user open it): `savefig`, not a window that blocks the script.

## 8. Check the numbers a second way

Before you call it done: add the answer up by a different route (the total of the group totals equals the total of
the cleaned rows; the row count after cleaning equals the count before minus the removed rows); look at three real rows
and compare by hand with the original file. Say what matched. A number that was not checked is not an answer.

## 9. Save

Write the answer table to `output/result.csv`. In the README: where the data goes, how to run
(`.venv\Scripts\python analyze.py`), what the answer was. Commit after a yes (`.env`, raw private data and `.venv` not
listed in `git status`): `git commit -m "feat: first data analysis"`.

## Do not use for

- A bot or a scheduled job: use `python-bot-starter`.
- A web page that shows the data: use `web-app-starter`.
- Fixing a script that crashes: use `debug-helper`.

## Done when

- The question was answered in a sentence, with the table behind it shown.
- The cleaning steps and the number of rows each removed were reported.
- The chart file exists and the user looked at it; the result file exists.
- The second check of step 8 was done and its outcome stated.
- `git status` shows no original private data when the user asked to keep it out.
