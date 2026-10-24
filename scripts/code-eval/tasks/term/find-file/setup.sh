#!/bin/sh
# 400 files in nested folders; one of them holds the incident id.
python3 - <<'PY'
import random, os
random.seed(7)
words = "alpha beta gamma delta ledger queue invoice batch retry socket cache shard".split()
target = None
for i in range(400):
    d = os.path.join("logs", random.choice(["eu", "us", "ap"]), random.choice(["web", "api", "worker"]), f"day-{i % 31:02d}")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"run-{i:03d}.log")
    lines = [" ".join(random.choice(words) for _ in range(8)) for _ in range(30)]
    if i == 287:
        lines[17] = "ERROR incident ORCHID-7731 shard rebalance aborted"
        target = path
    elif i % 50 == 0:
        lines[3] = "WARN incident ORCHID-7713 noted"
    with open(path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
PY
