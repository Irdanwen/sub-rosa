//! The archive: everything a person made here, in one file they can carry.
//!
//! There was no way to take your notes off the machine except one note at a
//! time (PDF on the desktop, Markdown on the phone), and no way to bring them
//! back at all. Desktop and phone share the code and the schema, not the
//! data. ADR-0042 records the decision this module implements: **the archive
//! is the bridge between devices, not a synchronisation**. It is written on
//! purpose, restored on purpose, and can be sealed with a passphrase so that
//! the one copy of your notes that leaves the disk is the one ADR-0039 said
//! deserved encryption.
//!
//! The format is boring on purpose: a tar stream holding `manifest.json`, one
//! JSON-lines file per table (`tables/<name>.jsonl`, every column, blobs as
//! base64), one Markdown file per note for a person to read without this
//! app, and optionally the recordings. With a passphrase the whole stream is
//! wrapped in age (scrypt), the format `rage`/`age` open. Restoring is an
//! upsert by primary key over the same tables, so importing an archive twice
//! changes nothing, and importing into a fuller database adds without
//! removing.
//!
//! Runtime state is not in it: what the app is doing right now (jobs,
//! ingests, briefs, council sittings, checkpoints) belongs to the process
//! that started it, not to the person's corpus.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx::value::ValueRef as _;
use sqlx_sqlite::SqlitePool;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::domain::types::AppError;

pub const ARCHIVE_FORMAT_VERSION: u32 = 1;

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new("archive_invalid", error.to_string())
}

/// The tables that are the person's corpus, in an order that restores
/// cleanly whether or not foreign keys are enforced.
pub const ARCHIVED_TABLES: &[&str] = &[
    "folders",
    "notes",
    "note_folders",
    "session_folders",
    "recording_sessions",
    "audio_artifacts",
    "transcripts",
    "generation_results",
    "note_generation_blocks",
    "note_summaries",
    "dictionary_entries",
    "dictation_history",
    "memories",
    "agent_tasks",
    "agent_messages",
    "agent_tool_events",
    "bible_entries",
    "bible_refs",
    "shot_lists",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub created_at: String,
    pub tables: Vec<String>,
    pub includes_recordings: bool,
}

/// A row as JSON: NULL → null, INTEGER → number, REAL → number, TEXT →
/// string, BLOB → {"$base64": "…"}.
pub type ArchiveRow = BTreeMap<String, serde_json::Value>;

async fn columns(pool: &SqlitePool, table: &str) -> Result<Vec<String>, sqlx::error::Error> {
    let rows = query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect())
}

/// Every row of a table, column by column, in a form that survives JSON.
pub async fn dump_table(
    pool: &SqlitePool,
    table: &str,
) -> Result<Vec<ArchiveRow>, sqlx::error::Error> {
    let names = columns(pool, table).await?;
    let rows = query(&format!("SELECT * FROM {table}"))
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut map = ArchiveRow::new();
        for (index, name) in names.iter().enumerate() {
            let raw = row.try_get_raw(index)?;
            let value = if raw.is_null() {
                serde_json::Value::Null
            } else {
                match raw.type_info().to_string().as_str() {
                    "INTEGER" | "BOOLEAN" => row
                        .try_get::<i64, _>(index)
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                    "REAL" => row
                        .try_get::<f64, _>(index)
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                    "BLOB" => row
                        .try_get::<Vec<u8>, _>(index)
                        .map(|bytes| {
                            use base64::Engine as _;
                            serde_json::json!({
                                "$base64": base64::engine::general_purpose::STANDARD.encode(bytes)
                            })
                        })
                        .unwrap_or(serde_json::Value::Null),
                    _ => row
                        .try_get::<String, _>(index)
                        .map(serde_json::Value::from)
                        .or_else(|_| row.try_get::<i64, _>(index).map(serde_json::Value::from))
                        .or_else(|_| row.try_get::<f64, _>(index).map(serde_json::Value::from))
                        .unwrap_or(serde_json::Value::Null),
                }
            };
            map.insert(name.clone(), value);
        }
        out.push(map);
    }
    Ok(out)
}

/// Upsert rows into a table, keeping only the columns the table has today,
/// so an archive from a newer or older version restores what it can.
pub async fn restore_table(
    pool: &SqlitePool,
    table: &str,
    rows: &[ArchiveRow],
) -> Result<usize, sqlx::error::Error> {
    if rows.is_empty() {
        return Ok(0);
    }
    let present = columns(pool, table).await?;
    let mut restored = 0usize;
    for row in rows {
        let cols: Vec<&String> = present.iter().filter(|c| row.contains_key(*c)).collect();
        if cols.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; cols.len()].join(", ");
        let names = cols
            .iter()
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("INSERT OR REPLACE INTO {table} ({names}) VALUES ({placeholders})");
        let mut statement = query(&sql);
        for col in &cols {
            statement = match &row[*col] {
                serde_json::Value::Null => statement.bind(Option::<String>::None),
                serde_json::Value::Bool(b) => statement.bind(i64::from(*b)),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        statement.bind(i)
                    } else {
                        statement.bind(n.as_f64().unwrap_or(0.0))
                    }
                }
                serde_json::Value::String(s) => statement.bind(s.clone()),
                serde_json::Value::Object(map) => match map.get("$base64").and_then(|v| v.as_str())
                {
                    Some(encoded) => {
                        use base64::Engine as _;
                        statement.bind(
                            base64::engine::general_purpose::STANDARD
                                .decode(encoded)
                                .unwrap_or_default(),
                        )
                    }
                    None => statement.bind(serde_json::Value::Object(map.clone()).to_string()),
                },
                other => statement.bind(other.to_string()),
            };
        }
        statement.execute(pool).await?;
        restored += 1;
    }
    Ok(restored)
}

/// What goes into the archive besides the tables.
pub struct ExportOptions {
    pub app_version: String,
    /// Copy the recording files under `recordings/` (large).
    pub include_recordings: bool,
    /// The recordings directory, so the copies can be found.
    pub recordings_dir: Option<PathBuf>,
}

/// Write the whole archive as a tar stream into `out`.
pub async fn write_tar<W: Write>(
    pool: &SqlitePool,
    options: &ExportOptions,
    out: W,
) -> Result<Manifest, AppError> {
    let mut builder = tar::Builder::new(out);
    let manifest = Manifest {
        format: ARCHIVE_FORMAT_VERSION,
        app_version: options.app_version.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        tables: ARCHIVED_TABLES.iter().map(|t| t.to_string()).collect(),
        includes_recordings: options.include_recordings && options.recordings_dir.is_some(),
    };
    append(
        &mut builder,
        "manifest.json",
        serde_json::to_vec_pretty(&manifest)
            .map_err(json_error)?
            .as_slice(),
    )?;

    for table in ARCHIVED_TABLES {
        let rows = dump_table(pool, table).await?;
        let mut body = Vec::new();
        for row in &rows {
            serde_json::to_writer(&mut body, row).map_err(json_error)?;
            body.push(b'\n');
        }
        append(&mut builder, &format!("tables/{table}.jsonl"), &body)?;
        if *table == "notes" {
            for row in &rows {
                let id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                let title = row.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let body_text = row
                    .get("edited_content")
                    .and_then(|v| v.as_str())
                    .or_else(|| row.get("generated_content").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let created = row.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
                let markdown = format!(
                    "---\ntitle: {}\ncreated: {created}\nid: {id}\n---\n\n{body_text}\n",
                    title.replace('\n', " ")
                );
                append(&mut builder, &format!("notes/{id}.md"), markdown.as_bytes())?;
            }
        }
    }

    if manifest.includes_recordings {
        if let Some(dir) = &options.recordings_dir {
            append_dir(&mut builder, dir, Path::new("recordings"))?;
        }
    }
    builder
        .finish()
        .map_err(|error| AppError::new("archive_write_failed", error.to_string()))?;
    Ok(manifest)
}

fn append<W: Write>(
    builder: &mut tar::Builder<W>,
    path: &str,
    data: &[u8],
) -> Result<(), AppError> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(chrono::Utc::now().timestamp().max(0) as u64);
    header.set_cksum();
    builder
        .append_data(&mut header, path, data)
        .map_err(|error| AppError::new("archive_write_failed", error.to_string()))
}

fn append_dir<W: Write>(
    builder: &mut tar::Builder<W>,
    dir: &Path,
    prefix: &Path,
) -> Result<(), AppError> {
    if !dir.is_dir() {
        return Ok(());
    }
    builder
        .append_dir_all(prefix, dir)
        .map_err(|error| AppError::new("archive_write_failed", error.to_string()))
}

/// The parsed contents of an archive.
pub struct Archive {
    pub manifest: Manifest,
    pub tables: BTreeMap<String, Vec<ArchiveRow>>,
    /// Recording files, path under `recordings/` → bytes.
    pub recordings: Vec<(PathBuf, Vec<u8>)>,
}

/// Read a tar stream produced by [`write_tar`].
pub fn read_tar<R: Read>(input: R) -> Result<Archive, AppError> {
    let mut archive = tar::Archive::new(input);
    let mut manifest: Option<Manifest> = None;
    let mut tables: BTreeMap<String, Vec<ArchiveRow>> = BTreeMap::new();
    let mut recordings = Vec::new();
    let entries = archive
        .entries()
        .map_err(|error| AppError::new("archive_read_failed", error.to_string()))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| AppError::new("archive_read_failed", error.to_string()))?;
        let path = entry
            .path()
            .map_err(|error| AppError::new("archive_read_failed", error.to_string()))?
            .to_path_buf();
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| AppError::new("archive_read_failed", error.to_string()))?;
        let text = || String::from_utf8_lossy(&bytes).to_string();
        if path == Path::new("manifest.json") {
            manifest = Some(serde_json::from_slice(&bytes).map_err(json_error)?);
        } else if let Ok(rest) = path.strip_prefix("tables") {
            let name = rest
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if !ARCHIVED_TABLES.contains(&name.as_str()) {
                continue;
            }
            let mut rows = Vec::new();
            for line in text().lines() {
                if line.trim().is_empty() {
                    continue;
                }
                rows.push(serde_json::from_str::<ArchiveRow>(line).map_err(json_error)?);
            }
            tables.insert(name, rows);
        } else if let Ok(rest) = path.strip_prefix("recordings") {
            if !bytes.is_empty() {
                recordings.push((rest.to_path_buf(), bytes));
            }
        }
    }
    let manifest = manifest.ok_or_else(|| {
        AppError::new(
            "archive_invalid",
            "That file is not a Sub Rosa archive (no manifest).",
        )
    })?;
    if manifest.format > ARCHIVE_FORMAT_VERSION {
        return Err(AppError::new(
            "archive_newer",
            "That archive was written by a newer version of Sub Rosa. Update, then import it.",
        ));
    }
    Ok(Archive {
        manifest,
        tables,
        recordings,
    })
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub notes: usize,
    pub rows: usize,
    pub recordings: usize,
    pub app_version: String,
}

/// Upsert every table of the archive, then copy recordings that are not
/// already there. Confined: a recording lands under the recordings
/// directory or not at all.
pub async fn apply(
    pool: &SqlitePool,
    archive: &Archive,
    recordings_dir: Option<&Path>,
) -> Result<ImportSummary, AppError> {
    let mut summary = ImportSummary {
        app_version: archive.manifest.app_version.clone(),
        ..ImportSummary::default()
    };
    for table in ARCHIVED_TABLES {
        if let Some(rows) = archive.tables.get(*table) {
            let restored = restore_table(pool, table, rows).await?;
            summary.rows += restored;
            if *table == "notes" {
                summary.notes = restored;
            }
        }
    }
    if let Some(dir) = recordings_dir {
        for (relative, bytes) in &archive.recordings {
            if relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                continue;
            }
            let target = dir.join(relative);
            if target.exists() {
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| AppError::new("archive_restore_failed", error.to_string()))?;
            }
            std::fs::write(&target, bytes)
                .map_err(|error| AppError::new("archive_restore_failed", error.to_string()))?;
            summary.recordings += 1;
        }
    }
    Ok(summary)
}

/// Seal bytes with a passphrase (age, scrypt).
pub fn seal(plain: &[u8], passphrase: &str) -> Result<Vec<u8>, AppError> {
    let recipient =
        age::scrypt::Recipient::new(age::secrecy::SecretString::from(passphrase.to_string()));
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|error| AppError::new("archive_seal_failed", error.to_string()))?;
    let mut sealed = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut sealed)
        .map_err(|error| AppError::new("archive_seal_failed", error.to_string()))?;
    writer
        .write_all(plain)
        .and_then(|()| writer.finish().map(|_| ()))
        .map_err(|error| AppError::new("archive_seal_failed", error.to_string()))?;
    Ok(sealed)
}

/// Open bytes sealed by [`seal`]. A wrong passphrase is an error that says so.
pub fn unseal(sealed: &[u8], passphrase: &str) -> Result<Vec<u8>, AppError> {
    let decryptor = age::Decryptor::new(sealed)
        .map_err(|error| AppError::new("archive_unseal_failed", error.to_string()))?;
    let identity =
        age::scrypt::Identity::new(age::secrecy::SecretString::from(passphrase.to_string()));
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| {
            AppError::new(
                "archive_wrong_passphrase",
                "That passphrase does not open this archive.",
            )
        })?;
    let mut plain = Vec::new();
    reader.read_to_end(&mut plain).map_err(|_| {
        AppError::new(
            "archive_wrong_passphrase",
            "That passphrase does not open this archive.",
        )
    })?;
    Ok(plain)
}

/// Whether bytes are an age stream (sealed) rather than a bare tar.
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(b"age-encryption.org/")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArchiveRequest {
    #[serde(default)]
    pub include_recordings: bool,
    /// Empty or absent: the archive is written in the clear.
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArchiveResult {
    /// Where it went; `None` when the dialog was cancelled.
    pub path: Option<String>,
    pub bytes: u64,
    pub sealed: bool,
}

/// Desktop: the user names the file in the native save dialog; nothing else
/// decides where the archive goes (see `tests/ipc_write_paths.rs`).
#[cfg(desktop)]
#[tauri::command]
pub async fn export_archive(
    app: AppHandle,
    request: ExportArchiveRequest,
) -> Result<ExportArchiveResult, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let passphrase = request
        .passphrase
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let stamp = chrono::Utc::now().format("%Y-%m-%d");
    let suggested = if passphrase.is_some() {
        format!("Sub Rosa {stamp}.subrosa.age")
    } else {
        format!("Sub Rosa {stamp}.subrosa")
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&suggested)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|error| AppError::new("archive_export_failed", error.to_string()))?;
    let Some(target) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(ExportArchiveResult {
            path: None,
            bytes: 0,
            sealed: false,
        });
    };

    let repos = crate::commands::repositories(&app).await?;
    let paths = crate::commands::app_paths(&app)?;
    let options = ExportOptions {
        app_version: app.package_info().version.to_string(),
        include_recordings: request.include_recordings,
        recordings_dir: Some(paths.recordings_dir.clone()),
    };
    let mut tar_bytes = Vec::new();
    write_tar(&repos.pool, &options, &mut tar_bytes).await?;
    let (bytes, sealed) = match &passphrase {
        Some(passphrase) => (seal(&tar_bytes, passphrase)?, true),
        None => (tar_bytes, false),
    };
    let size = bytes.len() as u64;
    std::fs::write(&target, bytes)
        .map_err(|error| AppError::new("archive_export_failed", error.to_string()))?;
    Ok(ExportArchiveResult {
        path: Some(target.display().to_string()),
        bytes: size,
        sealed,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArchiveRequest {
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArchiveResult {
    /// `None` when the dialog was cancelled.
    pub summary: Option<ImportSummary>,
    /// The archive is sealed and no passphrase was given: ask, then call again.
    pub needs_passphrase: bool,
}

/// Both shells: the user picks the file in the native dialog. A sealed
/// archive without a passphrase answers `needs_passphrase` rather than
/// failing, so the screen can ask for one and call again.
#[tauri::command]
pub async fn import_archive(
    app: AppHandle,
    request: ImportArchiveRequest,
) -> Result<ImportArchiveResult, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx
        .await
        .map_err(|error| AppError::new("archive_import_failed", error.to_string()))?;
    let Some(source) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(ImportArchiveResult {
            summary: None,
            needs_passphrase: false,
        });
    };
    let bytes = std::fs::read(&source)
        .map_err(|error| AppError::new("archive_import_failed", error.to_string()))?;
    let passphrase = request
        .passphrase
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let plain = if is_sealed(&bytes) {
        let Some(passphrase) = passphrase else {
            return Ok(ImportArchiveResult {
                summary: None,
                needs_passphrase: true,
            });
        };
        unseal(&bytes, passphrase)?
    } else {
        bytes
    };
    let archive = read_tar(plain.as_slice())?;
    let repos = crate::commands::repositories(&app).await?;
    let paths = crate::commands::app_paths(&app)?;
    let summary = apply(&repos.pool, &archive, Some(&paths.recordings_dir)).await?;
    // The list and the open note learn about what arrived the same way they
    // learn about a note the agent wrote.
    let ids: Vec<String> = archive
        .tables
        .get("notes")
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    crate::agent_notes::announce(&app, &ids);
    Ok(ImportArchiveResult {
        summary: Some(summary),
        needs_passphrase: false,
    })
}
