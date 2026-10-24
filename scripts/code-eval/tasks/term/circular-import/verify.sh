#!/bin/sh
set -e
git diff --quiet HEAD -- main.py
[ "$(python3 main.py)" = "22.62" ]
python3 -c "import shop.pricing as p; import shop; o = shop.Order(); o.add('x', 1, 10.0); assert p.price_order(o) == 10.77"
python3 -c "import shop.orders as o; assert o.Order().tax_rate() == 0.077"
