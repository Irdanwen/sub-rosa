#!/bin/sh
set -e
git diff --quiet HEAD -- shop.db
python3 - <<'PY'
import sqlite3
db = sqlite3.connect("file:shop.db?mode=ro", uri=True)
expected = db.execute("""
SELECT c.name, SUM(o.total_cents) FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid' AND o.placed_at >= '2025-01-01' AND o.placed_at < '2026-01-01'
GROUP BY c.id HAVING COUNT(*) > 2 ORDER BY 2 DESC, 1
""").fetchall()
assert expected, "fixture has no answer"
cursor = db.execute(open("query.sql").read())
names = [d[0] for d in cursor.description]
assert names == ["name", "paid_total_cents"], names
got = cursor.fetchall()
assert got == expected, (got, expected)
PY
