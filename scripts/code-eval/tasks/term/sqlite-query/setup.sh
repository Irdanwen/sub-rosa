#!/bin/sh
python3 - <<'PY'
import sqlite3, random
random.seed(5)
db = sqlite3.connect("shop.db")
db.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), placed_at TEXT NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL);
""")
names = ["Ada", "Ben", "Chloe", "Dev", "Emil", "Fatou", "Gus", "Hana", "Ivo", "June", "Kofi", "Lea"]
for i, name in enumerate(names, 1):
    db.execute("INSERT INTO customers VALUES (?, ?, ?)", (i, name, random.choice(["CH", "FR", "DE"])))
oid = 1
for cid in range(1, len(names) + 1):
    for _ in range(random.randint(0, 6)):
        year = random.choice([2024, 2025, 2025, 2026])
        db.execute("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", (oid, cid, f"{year}-{random.randint(1,12):02d}-{random.randint(1,28):02d}", random.choice(["paid", "paid", "refunded", "cancelled"]), random.randint(500, 20000)))
        oid += 1
db.commit()
PY
