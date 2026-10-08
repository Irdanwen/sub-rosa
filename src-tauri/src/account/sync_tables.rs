//! The tables that travel, and the columns of each: the explicit codec
//! allowlist a received row is checked against (ADR-0049). A peer can never
//! name a table or a column that is not listed here. `kind` is the routing
//! class the service sees; it never names the table.
pub(super) struct Table {
    pub(super) name: &'static str,
    pub(super) kind: &'static str,
    pub(super) columns: &'static [&'static str],
}
pub(super) const TABLES: &[Table] = &[
    Table {
        name: "assistants",
        kind: "settings",
        columns: &[
            "id",
            "name",
            "description",
            "instructions",
            "model",
            "opening_message",
            "tools_json",
            "allow_notes",
            "allow_memory",
            "avatar_ref",
            "cover_ref",
            "revision",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "assistant_references",
        kind: "artifact",
        columns: &[
            "id",
            "assistant_id",
            "name",
            "format",
            "text",
            "status",
            "error",
            "note_id",
            "file_name",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "ingests",
        kind: "artifact",
        columns: &[
            "id",
            "url",
            "kind",
            "status",
            "title",
            "note_id",
            "folder_id",
            "bytes_done",
            "bytes_total",
            "created_at",
            "updated_at",
        ],
    },
    // The gallery's organisation (ADR-0073). Collections route as folders,
    // marks as artifacts; neither column is a dependency `apply` waits on.
    Table {
        name: "studio_collections",
        kind: "folder",
        columns: &["id", "name", "created_at", "updated_at"],
    },
    Table {
        name: "studio_marks",
        kind: "artifact",
        columns: &[
            "id",
            "file_id",
            "collection_id",
            "favorite",
            "hidden",
            "updated_at",
        ],
    },
    // What a person saved from a chat (ADR-0088). Its id is derived from what
    // was saved, so two devices saving one link make one object; a temporary
    // chat's never leaves (`stays_local`).
    Table {
        name: "saved_items",
        kind: "artifact",
        columns: &[
            "id",
            "kind",
            "source_key",
            "title",
            "payload",
            "conversation_id",
            "created_at",
        ],
    },
    // Health and finances (ADR-0099), each sent only when the person opted
    // in on the device that holds them (`stays_local`): a health measure by
    // measure, finances as a whole. Their ids are derived from what they
    // describe, so two devices reading one day or one statement make one
    // object.
    Table {
        name: "health_days",
        kind: "artifact",
        columns: &[
            "id",
            "metric",
            "day",
            "value",
            "low",
            "high",
            "samples",
            "source",
            "updated_at",
        ],
    },
    Table {
        name: "transactions",
        kind: "artifact",
        columns: &[
            "id",
            "dedup_key",
            "account",
            "booked_on",
            "amount_minor",
            "currency",
            "description",
            "counterparty",
            "reference",
            "balance_minor",
            "category",
            "category_source",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "finance_rules",
        kind: "settings",
        columns: &[
            "id",
            "pattern",
            "is_regex",
            "category",
            "position",
            "created_at",
        ],
    },
    Table {
        name: "account_studio_files",
        kind: "artifact",
        columns: &[
            "id",
            "file_name",
            "format",
            "bytes",
            "created_at",
            "model",
            "prompt",
        ],
    },
    Table {
        name: "account_turn_usage",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "sampled_at",
            "turns",
            "prompt_tokens",
            "completion_tokens",
            "cached_tokens",
            "cost_usdc_micro",
            "cache_saved_usdc_micro",
        ],
    },
    Table {
        name: "account_billing",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "sampled_at",
            "available_credits",
            "escrow_credits",
            "rail",
            "price_multiplier",
        ],
    },
    Table {
        name: "account_note_folders",
        kind: "folder",
        columns: &["id", "note_id", "folder_id", "assigned_at", "deleted"],
    },
    Table {
        name: "account_session_folders",
        kind: "folder",
        columns: &["id", "session_id", "folder_id", "assigned_at", "deleted"],
    },
    Table {
        name: "account_usage",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "day",
            "model",
            "request_count",
            "request_bytes",
            "response_bytes",
        ],
    },
    Table {
        name: "account_file_manifests",
        kind: "artifact",
        columns: &[
            "id",
            "artifact_id",
            "bytes",
            "format",
            "chunks_json",
            "created_at",
            "source_kind",
        ],
    },
    Table {
        name: "folders",
        kind: "folder",
        columns: &[
            "id",
            "name",
            "description",
            "created_at",
            "updated_at",
            "deleted_at",
        ],
    },
    // A project's settings and files (ADR-0085). The settings object's id is
    // its folder's, so two devices editing one project edit one object.
    Table {
        name: "project_settings",
        kind: "folder",
        columns: &[
            "id",
            "folder_id",
            "instructions",
            "memory_mode",
            "updated_at",
        ],
    },
    Table {
        name: "project_files",
        kind: "artifact",
        columns: &[
            "id",
            "folder_id",
            "name",
            "format",
            "text",
            "status",
            "error",
            "file_name",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "notes",
        kind: "note",
        columns: &[
            "id",
            "title",
            "generated_content",
            "edited_content",
            "active_tab",
            "processing_status",
            "created_at",
            "updated_at",
            "calendar_event_id",
            "scheduled_start",
            "attendees_json",
        ],
    },
    Table {
        name: "recording_sessions",
        kind: "artifact",
        columns: &[
            "id",
            "note_id",
            "status",
            "started_at",
            "ended_at",
            "expected_elapsed_ms",
            "source_mode",
        ],
    },
    Table {
        name: "audio_artifacts",
        kind: "artifact",
        columns: &[
            "id",
            "note_id",
            "recording_session_id",
            "format",
            "duration_ms",
            "size_bytes",
            "checksum",
            "created_at",
            "source",
        ],
    },
    Table {
        name: "transcripts",
        kind: "transcript",
        columns: &[
            "id",
            "note_id",
            "audio_artifact_id",
            "text",
            "language",
            "provider",
            "status",
            "created_at",
            "updated_at",
            "recording_session_id",
            "source",
            "start_ms",
            "end_ms",
            "turn_index",
            "source_mode",
        ],
    },
    Table {
        name: "memories",
        kind: "memory",
        columns: &[
            "id",
            "text",
            "source",
            "importance",
            "disabled",
            "created_at",
            "updated_at",
            "scope",
        ],
    },
    Table {
        name: "agent_tasks",
        kind: "conversation",
        columns: &[
            "id",
            "title",
            "prompt",
            "status",
            "safety_profile",
            "progress_summary",
            "created_at",
            "updated_at",
            "completed_at",
            "model",
        ],
    },
    // Assignments and their runs (ADR-0091). The row names the one device
    // that runs it, so it travels as a record: any device can create, pause
    // or review one, and only the named device acts on it, with the errand
    // guards. A run is history wherever it lands: a device only ever closes
    // the runs it started itself.
    Table {
        name: "assignments",
        kind: "settings",
        columns: &[
            "id",
            "kind",
            "title",
            "goal",
            "cadence",
            "at_minute",
            "weekday",
            "every_hours",
            "autonomy",
            "tools",
            "device_id",
            "device_name",
            "origin_device_id",
            "paused",
            "active_since",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "assignment_runs",
        kind: "artifact",
        columns: &[
            "id",
            "assignment_id",
            "slot",
            "late",
            "device_id",
            "device_name",
            "handle",
            "state",
            "result",
            "error",
            "feedback",
            "reviewed_at",
            "started_at",
            "finished_at",
            "updated_at",
        ],
    },
    // Connector and skill pack definitions (ADR-0092). A connector's tokens
    // are in the keychain of each device and never travel; only what it is,
    // where it lives and the person's rules for its tools do.
    Table {
        name: "connectors",
        kind: "settings",
        columns: &[
            "id",
            "name",
            "url",
            "catalog_id",
            "auth",
            "enabled",
            "tool_policy",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "skill_packs",
        kind: "settings",
        columns: &[
            "id",
            "name",
            "description",
            "body",
            "tools",
            "enabled",
            "created_at",
            "updated_at",
        ],
    },
    // An errand travels as an ordinary revision: the service carries it without
    // being able to read the link inside, and the device it names is the only
    // one that acts on it (ADR-0054).
    Table {
        name: "account_errands",
        kind: "errand",
        columns: &[
            "id",
            "device_id",
            "url",
            "folder_id",
            "requested_by",
            "requested_at",
            "state",
            "note_id",
            "message",
            "updated_at",
        ],
    },
    Table {
        name: "agent_messages",
        kind: "conversation",
        columns: &[
            "id",
            "task_id",
            "role",
            "content",
            "created_at",
            "external_id",
        ],
    },
];

/// The routing kind and columns of one travelling table. The web client's
/// codec is exported from here rather than written a second time
/// (`agent_lite::web_client_export`).
#[cfg(test)]
pub(crate) fn columns_of(name: &str) -> Option<(&'static str, &'static [&'static str])> {
    TABLES
        .iter()
        .find(|t| t.name == name)
        .map(|t| (t.kind, t.columns))
}
