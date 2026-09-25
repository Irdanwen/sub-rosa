CREATE TABLE IF NOT EXISTS account_sync_issues (
 lane TEXT NOT NULL,
 item_id TEXT NOT NULL,
 code TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(lane,item_id)
);
