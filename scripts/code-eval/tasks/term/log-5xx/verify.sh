#!/bin/sh
set -e
python3 - <<'PY'
import collections
counts = collections.Counter()
for line in open("access.log"):
    parts = line.split('"')
    status = parts[2].split()[0]
    if status.startswith("5"):
        counts[line.split()[0]] += 1
top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
expected = "".join(f"{ip} {n}\n" for ip, n in top)
got = open("report.txt").read()
assert got.strip() == expected.strip(), (got, expected)
PY
