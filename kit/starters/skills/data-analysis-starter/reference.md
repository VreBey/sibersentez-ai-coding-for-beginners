# Data analysis starter: reference

Run commands from the project folder with the project's own Python (`.venv\Scripts\python`). The examples use a file
`data/raw/sales.csv` with the columns `date`, `product` and `amount`; rename them to the user's.

## requirements.txt

```
pandas>=2,<3
matplotlib>=3.8,<4
openpyxl>=3.1,<4
```

Check the current major versions on pypi.org before pinning; `openpyxl` is only needed for `.xlsx` files.

## explore.py

```python
import sys
import pandas as pd

# Usage: python explore.py data/raw/sales.csv
path = sys.argv[1]
df = pd.read_csv(path) if path.endswith(".csv") else pd.read_excel(path)

print("Rows and columns:", df.shape)
print("\nColumn types:\n", df.dtypes)
print("\nFirst rows:\n", df.head())
print("\nMissing values per column:\n", df.isna().sum())
print("\nDuplicate rows:", df.duplicated().sum())
print("\nNumbers at a glance:\n", df.describe())
```

## analyze.py

```python
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

RAW = Path("data/raw/sales.csv")
CLEAN = Path("data/clean/sales_clean.csv")
OUT = Path("output")


def load(path):
    # CSV from a Turkish Windows program often needs sep=";" and decimal=","; see the problem table
    return pd.read_csv(path)


def clean(df):
    before = len(df)
    df = df.copy()
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    df["date"] = pd.to_datetime(df["date"], errors="coerce", dayfirst=True)
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    print("Rows with an unreadable date or amount:", int(df[["date", "amount"]].isna().any(axis=1).sum()))
    df = df.dropna(subset=["date", "amount"])
    print("After dropping unreadable rows:", len(df), "of", before)
    df = df.drop_duplicates()
    print("After dropping duplicate rows:", len(df))
    return df


def answer(df):
    df = df.assign(month=df["date"].dt.to_period("M"))
    by_month = df.groupby("month")["amount"].sum().sort_values(ascending=False)
    print(by_month)
    return by_month


def draw(by_month):
    ordered = by_month.sort_index()
    fig, ax = plt.subplots(figsize=(8, 4))
    ordered.plot(kind="bar", ax=ax)
    ax.set_title("Sales per month")
    ax.set_xlabel("Month")
    ax.set_ylabel("Total amount")
    fig.tight_layout()
    OUT.mkdir(exist_ok=True)
    fig.savefig(OUT / "chart.png", dpi=150)


if __name__ == "__main__":
    df = clean(load(RAW))
    CLEAN.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(CLEAN, index=False)
    by_month = answer(df)
    draw(by_month)
    OUT.mkdir(exist_ok=True)
    by_month.to_csv(OUT / "result.csv")
    # The second check: the group totals add up to the total of all rows
    assert abs(by_month.sum() - df["amount"].sum()) < 0.01
    print("Check passed: the monthly totals add up to", round(df["amount"].sum(), 2))
```

For an Excel file use `pd.read_excel(path, sheet_name=0)` in `load`.

## Cleaning recipes

| Problem in the data | What to do |
|---|---|
| Spaces or capitals in column names | `df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]` |
| Numbers read as text ("1.234,50" or "12 TL") | remove the extra characters, then `pd.to_numeric(..., errors="coerce")`; count the rows that became empty |
| Dates in different forms | `pd.to_datetime(..., errors="coerce", dayfirst=True)` when days come first; check a few results by eye |
| The same row twice | `df.drop_duplicates()`; print how many went |
| Gaps in a number column | decide with the user: leave them out of the average (the default), fill with 0 only if "no entry" means zero, or drop the row |
| Capitals and spelling in categories ("Istanbul", "istanbul ") | `df["city"].str.strip().str.title()`; list the unique values and fix the rest by hand |
| An impossible value (negative age, year 1900) | list them, show the user, ask whether it is a typing mistake; never drop it silently |

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `UnicodeDecodeError` when reading a CSV | the file is not UTF-8. Try `encoding="utf-8-sig"`, then `encoding="cp1254"` for Turkish Windows files. |
| Everything is in one column | the separator is `;` not `,`: `pd.read_csv(path, sep=";")`; with decimal commas add `decimal=","`. |
| `ModuleNotFoundError: No module named 'pandas'` | the packages are not installed in the project's Python. Use `.venv\Scripts\python`, and install after a yes. |
| `ImportError: Missing optional dependency 'openpyxl'` | `.xlsx` files need `openpyxl` in `requirements.txt`. |
| Dates are wrong by month and day | day-first versus month-first. Set `dayfirst=True` and check three rows by hand. |
| `KeyError: 'amount'` | the column name differs (capitals, spaces). Print `df.columns`. |
| The chart window never opens or the script hangs | write the picture with `savefig` and open the file; do not rely on a window. |
| Turkish letters appear as boxes in the chart | the chart font lacks them. Name an installed font in `plt.rcParams["font.family"]`. |
| `SettingWithCopyWarning` | work on `df.copy()` and assign whole columns, as the example does. |
| The numbers differ from the spreadsheet's | the spreadsheet counts rows you removed, or text numbers were read differently. Compare the row counts first. |
| The file is too large to open | read in parts (`chunksize`) or only the columns you need (`usecols`). |

## Good habits

- Keep raw data, cleaned data and results in separate folders; never overwrite the raw file.
- One script that runs top to bottom beats a pile of steps done by hand: the user can run it again next month.
- Say how many rows a step removed. A surprise in those numbers is often the real finding.
