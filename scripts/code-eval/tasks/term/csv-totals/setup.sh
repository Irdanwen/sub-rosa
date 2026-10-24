#!/bin/sh
python3 - <<'PY'
import random, csv
random.seed(3)
regions = ["North", "South", "East", "West", "Central"]
with open("sales.csv", "w", newline="") as handle:
    w = csv.writer(handle)
    w.writerow(["date", "region", "product", "quantity", "unit_price"])
    for i in range(800):
        region = random.choice(regions)
        if i % 97 == 0:
            region = f" {region.lower()} "
        w.writerow([f"2026-{random.randint(1, 9):02d}-{random.randint(1, 28):02d}", region, random.choice(["Widget, large", "Gadget", "Bolt"]), random.randint(1, 20), f"{random.uniform(1, 50):.2f}"])
PY
