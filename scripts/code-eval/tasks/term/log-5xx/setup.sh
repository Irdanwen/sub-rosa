#!/bin/sh
python3 - <<'PY'
import random
random.seed(11)
ips = [f"10.0.{a}.{b}" for a in range(3) for b in range(1, 9)]
weights = {ip: random.randint(1, 30) for ip in ips}
paths = ["/", "/api/items", "/api/orders", "/login", "/static/app.css"]
with open("access.log", "w") as out:
    for i in range(5000):
        ip = random.choice(ips)
        status = 500 + random.choice([0, 2, 3]) if random.randint(0, 100) < weights[ip] else random.choice([200, 200, 200, 301, 404])
        out.write(f'{ip} - - [12/Oct/2026:10:{i % 60:02d}:{i % 59:02d} +0000] "GET {random.choice(paths)} HTTP/1.1" {status} {random.randint(100, 9000)} "-" "bench/1.0"\n')
PY
