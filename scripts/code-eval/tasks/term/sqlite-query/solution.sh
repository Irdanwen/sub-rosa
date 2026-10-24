#!/bin/sh
cat > query.sql <<'Q'
SELECT c.name AS name, SUM(o.total_cents) AS paid_total_cents
FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid' AND o.placed_at LIKE '2025-%'
GROUP BY c.id
HAVING COUNT(*) > 2
ORDER BY paid_total_cents DESC, name;
Q
