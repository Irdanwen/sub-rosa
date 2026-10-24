#!/bin/sh
set -e
python3 - <<'PY'
import csv, collections
from decimal import Decimal, ROUND_HALF_UP
totals = collections.defaultdict(Decimal)
for row in csv.DictReader(open("sales.csv", newline="")):
    totals[row["region"].strip().capitalize()] += int(row["quantity"]) * Decimal(row["unit_price"])
rows = sorted(totals.items(), key=lambda kv: -kv[1])
got = list(csv.reader(open("totals.csv", newline="")))
assert got[0] == ["region", "revenue"], got[0]
assert len(got) == len(rows) + 1, got
for (region, value), line in zip(rows, got[1:]):
    assert line[0] == region, (line, region)
    assert line[1] == str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)), (line, value)
PY
