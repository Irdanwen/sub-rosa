-- Local discovery checkpoints, never synchronized or included in archives
CREATE TABLE IF NOT EXISTS assistant_reference_progress (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 upload_cursor TEXT NOT NULL DEFAULT '',
 extraction_cursor TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO assistant_reference_progress(id) VALUES (1);
