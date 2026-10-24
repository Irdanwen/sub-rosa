#!/bin/sh
python3 - <<'PY'
import csv, collections
from decimal import Decimal, ROUND_HALF_UP
totals = collections.defaultdict(Decimal)
for row in csv.DictReader(open("sales.csv", newline="")):
    totals[row["region"].strip().capitalize()] += int(row["quantity"]) * Decimal(row["unit_price"])
with open("totals.csv", "w", newline="") as out:
    w = csv.writer(out)
    w.writerow(["region", "revenue"])
    for region, value in sorted(totals.items(), key=lambda kv: -kv[1]):
        w.writerow([region, str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))])
PY
