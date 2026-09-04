use sqlx::query::query;
use sqlx_sqlite::SqlitePool;

pub async fn run_migrations(_pool: &SqlitePool) -> Result<(), sqlx::error::Error> {
    for statement in include_str!("../../migrations/001_init.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "recording_sessions",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_sessions", "permission_summary", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "source",
        "TEXT NOT NULL DEFAULT 'microphone'",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "partial_path", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "status",
        "TEXT NOT NULL DEFAULT 'valid'",
    )
    .await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "expected_duration_ms",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "validation_summary", "TEXT").await?;
    ensure_column(_pool, "audio_artifacts", "last_error", "TEXT").await?;
    ensure_column(_pool, "transcripts", "recording_session_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source", "TEXT").await?;
    ensure_column(_pool, "transcripts", "start_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "end_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "turn_index", "INTEGER").await?;
    ensure_column(
        _pool,
        "transcripts",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_checkpoints", "source", "TEXT").await?;
    ensure_column(_pool, "recording_checkpoints", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "folders", "description", "TEXT").await?;
    // Folder names don't need to be unique — each folder has a stable
    // UUID, and the user may legitimately want two "Inbox"es etc.
    drop_index_if_exists(_pool, "idx_folders_active_name").await?;
    for statement in include_str!("../../migrations/002_source_modes.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/003_generation_blocks.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/004_dictionary.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/005_dictation_history.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // The dedupe DELETE in this migration scans `transcripts`, so only run it
    // until the unique index exists. Once present, there is nothing left to
    // dedupe and re-running on every startup would be wasted work.
    if !index_exists(_pool, "idx_transcripts_session_source_turn").await? {
        for statement in
            include_str!("../../migrations/006_transcript_turn_uniqueness.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/007_agent.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(_pool, "agent_tasks", "hermes_session_id", "TEXT").await?;
    // `model` records the chat model this session last ran with, so reopening a
    // mobile (agent-lite) chat restores its model in the picker and a
    // mid-conversation switch is remembered. NULL means "use the app default".
    ensure_column(_pool, "agent_tasks", "model", "TEXT").await?;
    // `external_id` records the Hermes-side identity of hydrated agent
    // messages so concurrent hydrations cannot double-insert the same
    // message. The dedupe DELETE in this migration scans `agent_messages`,
    // so only run it until the unique index exists (matching the pattern
    // used for migration 006 above).
    ensure_column(_pool, "agent_messages", "external_id", "TEXT").await?;
    if !index_exists(_pool, "idx_agent_messages_task_external_id").await? {
        for statement in include_str!("../../migrations/008_agent_message_identity.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/009_session_folders.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/010_memory.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/011_background_jobs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // Shot continuity: a generation can continue an earlier clip, starting from
    // a frame taken near its end. The link belongs on the durable row, not in
    // the webview - the render outlives the session that queued it, so a chain
    // held only in React state loses its parent when the app is closed
    // mid-render (ADR-0018). `parent_handoff_seconds` is where in the parent
    // the frame was taken, so assembly can trim its tail exactly at the seam.
    ensure_column(_pool, "media_jobs", "parent_artifact_id", "TEXT").await?;
    ensure_column(_pool, "media_jobs", "parent_handoff_seconds", "REAL").await?;
    // What the render was quoted at, so a chain can total what it cost without
    // the frontend having to remember prices across restarts.
    ensure_column(_pool, "media_jobs", "cost_credits", "REAL").await?;
    // The HTTP status that killed the job, next to the message. Backends answer
    // several distinct failures with near-identical prose - a job the operator
    // dropped (404) reads much like one whose provider key was revoked (410) -
    // and without the code a failed row cannot be told apart after the fact,
    // which is exactly the hole a real incident fell into.
    ensure_column(_pool, "media_jobs", "error_status", "INTEGER").await?;
    // Who queued the job. NULL or "studio" is a hand-run generation; a
    // workflow run's renders say "workflow" so the Studio surfaces do not
    // file and dismiss a row the run is still waiting on (ADR-0021).
    ensure_column(_pool, "media_jobs", "source", "TEXT").await?;
    // Calendar context lands ON the note, as columns — deliberately not a
    // `meetings` table. The product specs forbid a meeting object and a
    // calendar surface; a table would be exactly that second noun. These
    // three say what a note is called, when it was scheduled, and who was
    // invited. All NULL for every note that has no event, which is what "the
    // app behaves as it always has" means.
    ensure_column(_pool, "notes", "calendar_event_id", "TEXT").await?;
    ensure_column(_pool, "notes", "scheduled_start", "TEXT").await?;
    ensure_column(_pool, "notes", "attendees_json", "TEXT").await?;
    for statement in include_str!("../../migrations/019_council.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/018_shot_lists.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/017_bible.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/016_ingests.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/015_note_summaries.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/014_agent_actions.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/013_briefs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/012_workflow_runs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // What a verdict reads when the work left no trace on disk. Not every
    // mandate produces files: ask for an analysis or a rewrite and the
    // deliverable is what the agent said. The transcript lives in the runtime,
    // so the shell hands the reply in and it is stored here for the reason
    // every long job stores its inputs (ADR-0018) -- a verdict re-driven after
    // a relaunch must still hold the thing it was judging.
    ensure_column(_pool, "council_verdicts", "reply", "TEXT").await?;

    // Settings › Storage can delete the audio of a transcribed note; the row
    // stays (transcripts reference it) and records when its file went.
    ensure_column(_pool, "audio_artifacts", "purged_at", "TEXT").await?;

    // What left the machine: one row per outbound request (shapes, never
    // contents), read by Settings > Privacy.
    for statement in include_str!("../../migrations/021_egress_ledger.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }

    // Full-text search over notes, transcripts, memories and conversations.
    // The file defines triggers, whose bodies carry semicolons, so it goes
    // through the statement-aware splitter rather than `split(';')`.
    for statement in split_sql_statements(include_str!("../../migrations/020_search.sql")) {
        query(&statement).execute(_pool).await?;
    }

    Ok(())
}

/// Split a migration file into statements without cutting a trigger in half.
///
/// The runner has always split files on `;`, which is why migration comments
/// may not contain one. A `CREATE TRIGGER ... BEGIN ... END;` body carries
/// semicolons of its own, so this splitter counts `BEGIN` / `END` nesting
/// (case-insensitively, on word boundaries) and only ends a statement at a
/// `;` that sits outside such a block. Comment lines starting with `--` are
/// dropped first, so a word like END in prose does not count.
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut depth: usize = 0;
    for raw_line in sql.lines() {
        let line = raw_line.trim();
        if line.starts_with("--") {
            continue;
        }
        for token in line.split_inclusive(';') {
            let (body, terminated) = match token.strip_suffix(';') {
                Some(body) => (body, true),
                None => (token, false),
            };
            for word in body.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                if word.eq_ignore_ascii_case("begin") {
                    depth += 1;
                } else if word.eq_ignore_ascii_case("end") {
                    depth = depth.saturating_sub(1);
                }
            }
            current.push_str(body);
            if terminated {
                if depth == 0 {
                    let statement = current.trim().to_string();
                    if !statement.is_empty() {
                        statements.push(statement);
                    }
                    current.clear();
                } else {
                    current.push(';');
                }
            }
        }
        current.push('\n');
    }
    let tail = current.trim().to_string();
    if !tail.is_empty() {
        statements.push(tail);
    }
    statements
}

async fn index_exists(pool: &SqlitePool, index: &str) -> Result<bool, sqlx::error::Error> {
    let row = query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(index)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::error::Error> {
    let pragma = format!("PRAGMA table_info({table})");
    let rows = query(&pragma).fetch_all(pool).await?;
    let exists = rows.iter().any(|row| {
        use sqlx::row::Row;
        row.get::<String, _>("name") == column
    });
    if !exists {
        let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        match query(&alter).execute(pool).await {
            Ok(_) => {}
            Err(error) if is_duplicate_column_error(&error, column) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn is_duplicate_column_error(error: &sqlx::error::Error, column: &str) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("duplicate column name") && message.contains(&column.to_lowercase())
}

async fn drop_index_if_exists(pool: &SqlitePool, index: &str) -> Result<(), sqlx::error::Error> {
    let sql = format!("DROP INDEX IF EXISTS {}", quote_sqlite_identifier(index));
    query(&sql).execute(pool).await?;
    Ok(())
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod split_tests {
    use super::split_sql_statements;

    #[test]
    fn a_trigger_body_stays_in_one_statement() {
        let sql = "-- a comment with a ; in it\n\
                   CREATE TABLE t (id TEXT);\n\
                   CREATE TRIGGER IF NOT EXISTS t_ai AFTER INSERT ON t BEGIN\n\
                     DELETE FROM u WHERE id = new.id;\n\
                     INSERT INTO u(id) VALUES (new.id);\n\
                   END;\n\
                   INSERT INTO t(id) SELECT 'x' WHERE 0;";
        let statements = split_sql_statements(sql);
        assert_eq!(statements.len(), 3, "{statements:#?}");
        assert!(statements[1].starts_with("CREATE TRIGGER"));
        assert!(statements[1].trim_end().ends_with("END"));
        assert_eq!(statements[1].matches(';').count(), 2);
        assert!(statements[2].starts_with("INSERT INTO t"));
    }

    #[test]
    fn the_search_migration_splits_into_whole_statements() {
        let statements = split_sql_statements(include_str!("../../migrations/020_search.sql"));
        let triggers = statements
            .iter()
            .filter(|s| s.starts_with("CREATE TRIGGER"))
            .count();
        let tables = statements
            .iter()
            .filter(|s| s.starts_with("CREATE VIRTUAL TABLE"))
            .count();
        assert_eq!(tables, 4);
        assert_eq!(triggers, 12);
        assert!(statements
            .iter()
            .filter(|s| s.starts_with("CREATE TRIGGER"))
            .all(|s| s.trim_end().ends_with("END")));
    }
}
