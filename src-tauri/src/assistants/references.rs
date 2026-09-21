use super::*;
use base64::Engine;
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::OnceLock,
};

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT: usize = 240_000;
static EXTRACTION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssistantReference {
    pub id: String,
    pub assistant_id: String,
    pub name: String,
    pub format: String,
    pub text: String,
    pub status: String,
    pub error: Option<String>,
    pub note_id: Option<String>,
    pub file_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
fn decode(row: SqliteRow) -> AssistantReference {
    AssistantReference {
        id: row.get("id"),
        assistant_id: row.get("assistant_id"),
        name: row.get("name"),
        format: row.get("format"),
        text: row.get("text"),
        status: row.get("status"),
        error: row.get("error"),
        note_id: row.get("note_id"),
        file_name: row.get("file_name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}
pub fn references_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = crate::app_paths::app_data_dir(app)
        .map_err(|_| error("assistant_reference_unavailable"))?
        .join("assistant-references");
    std::fs::create_dir_all(&root).map_err(|_| error("assistant_reference_unavailable"))?;
    Ok(root)
}
pub fn reference_extension(value: &str) -> Result<&str, AppError> {
    match value {
        "txt" | "md" | "pdf" | "docx" | "xlsx" | "pptx" | "png" | "jpg" | "jpeg" | "webp"
        | "gif" => Ok(value),
        _ => Err(error("assistant_reference_format")),
    }
}
pub fn reference_file(root: &Path, name: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(name);
    if path.components().count() != 1 {
        return Err(error("assistant_reference_invalid"));
    }
    uuid::Uuid::parse_str(
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default(),
    )
    .map_err(|_| error("assistant_reference_invalid"))?;
    reference_extension(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default(),
    )?;
    let full = root.join(path);
    if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(error("assistant_reference_invalid"));
    }
    Ok(full)
}
pub async fn list_references(
    pool: &SqlitePool,
    id: &str,
) -> Result<Vec<AssistantReference>, AppError> {
    Ok(
        query("SELECT * FROM assistant_references WHERE assistant_id=? ORDER BY created_at")
            .bind(id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(decode)
            .collect(),
    )
}
async fn get(pool: &SqlitePool, id: &str) -> Result<AssistantReference, AppError> {
    Ok(decode(
        query("SELECT * FROM assistant_references WHERE id=?")
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| error("assistant_reference_missing"))?,
    ))
}
#[tauri::command]
pub async fn assistant_reference_list(
    app: AppHandle,
    assistant_id: String,
) -> Result<Vec<AssistantReference>, AppError> {
    list_references(&pool(&app).await?, &assistant_id).await
}
#[tauri::command]
pub async fn assistant_reference_from_artifact(
    app: AppHandle,
    assistant_id: String,
    file_name: String,
) -> Result<AssistantReference, AppError> {
    let pool = pool(&app).await?;
    snapshot(&pool, &assistant_id).await?;
    if Path::new(&file_name).components().count() != 1 {
        return Err(error("assistant_image_invalid"));
    }
    let gallery = crate::carpe_diem::media::artifacts_dir(&app)?;
    let path = crate::path_confinement::confine_existing(
        std::slice::from_ref(&gallery),
        &gallery.join(&file_name),
        "assistant_image_invalid",
        "Choose an image from your gallery.",
    )?;
    let format = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !matches!(format.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Err(error("assistant_image_invalid"));
    }
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?;
    if meta.len() > MAX_BYTES {
        return Err(error("assistant_reference_too_large"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = format!("{id}.{format}");
    tokio::fs::copy(path, reference_file(&references_dir(&app)?, &name)?)
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?;
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO assistant_references(id,assistant_id,name,format,file_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(assistant_id).bind(file_name).bind(format).bind(name).bind(&now).bind(&now).execute(&pool).await?;
    resume_unfinished(&app).await;
    get(&pool, &id).await
}
#[tauri::command]
pub async fn assistant_reference_import(
    app: AppHandle,
    assistant_id: String,
) -> Result<Option<AssistantReference>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let pool = pool(&app).await?;
    snapshot(&pool, &assistant_id).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Documents",
            &[
                "txt", "md", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "webp", "gif",
            ],
        )
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| error("assistant_reference_unavailable"))?;
    let format = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_lowercase();
    reference_extension(&format)?;
    let mut input = tokio::fs::File::open(&path)
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?;
    use tokio::io::AsyncReadExt;
    if input
        .metadata()
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?
        .len()
        > MAX_BYTES
    {
        return Err(error("assistant_reference_too_large"));
    }
    let mut bytes = Vec::new();
    (&mut input)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("assistant_reference_too_large"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = format!("{id}.{format}");
    let target = reference_file(&references_dir(&app)?, &name)?;
    tokio::fs::write(&target, bytes)
        .await
        .map_err(|_| error("assistant_reference_unavailable"))?;
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO assistant_references(id,assistant_id,name,format,file_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(assistant_id).bind(path.file_name().and_then(|v|v.to_str()).unwrap_or("Reference")).bind(format).bind(name).bind(&now).bind(&now).execute(&pool).await?;
    // The queued row survives termination, and the common sweep re-drives it.
    resume_unfinished(&app).await;
    Ok(Some(get(&pool, &id).await?))
}
#[tauri::command]
pub async fn assistant_reference_add_note(
    app: AppHandle,
    assistant_id: String,
    note_id: String,
) -> Result<AssistantReference, AppError> {
    let pool = pool(&app).await?;
    snapshot(&pool, &assistant_id).await?;
    let row = query(
        "SELECT title,COALESCE(edited_content,generated_content,'') AS body FROM notes WHERE id=?",
    )
    .bind(&note_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| error("note_not_found"))?;
    let text: String = row.get("body");
    if text.len() > MAX_TEXT {
        return Err(error("assistant_reference_too_large"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO assistant_references(id,assistant_id,name,format,text,status,note_id,created_at,updated_at) VALUES(?,?,?,'md',?,'ready',?,?,?)")
        .bind(&id).bind(assistant_id).bind(row.get::<String,_>("title")).bind(text).bind(note_id).bind(&now).bind(&now).execute(&pool).await?;
    get(&pool, &id).await
}
#[tauri::command]
pub async fn assistant_reference_refresh_note(
    app: AppHandle,
    id: String,
) -> Result<AssistantReference, AppError> {
    let pool = pool(&app).await?;
    let old = get(&pool, &id).await?;
    let note = old
        .note_id
        .ok_or_else(|| error("assistant_reference_invalid"))?;
    let row = query(
        "SELECT title,COALESCE(edited_content,generated_content,'') AS body FROM notes WHERE id=?",
    )
    .bind(note)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| error("note_not_found"))?;
    let text: String = row.get("body");
    if text.len() > MAX_TEXT {
        return Err(error("assistant_reference_too_large"));
    }
    query("UPDATE assistant_references SET name=?,text=?,updated_at=? WHERE id=?")
        .bind(row.get::<String, _>("title"))
        .bind(text)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&id)
        .execute(&pool)
        .await?;
    get(&pool, &id).await
}
#[tauri::command]
pub async fn assistant_reference_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    let mut tx = pool.begin().await?;
    query("UPDATE assistants SET avatar_ref=CASE WHEN avatar_ref=? THEN NULL ELSE avatar_ref END,cover_ref=CASE WHEN cover_ref=? THEN NULL ELSE cover_ref END,revision=revision+1,updated_at=? WHERE avatar_ref=? OR cover_ref=?")
        .bind(&id).bind(&id).bind(chrono::Utc::now().to_rfc3339()).bind(&id).bind(&id).execute(&mut *tx).await?;
    query("DELETE FROM assistant_references WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn image_data_url(
    app: &AppHandle,
    assistant_id: &str,
    reference_id: &str,
) -> Result<String, AppError> {
    let reference = get(&pool(app).await?, reference_id).await?;
    if reference.assistant_id != assistant_id || reference.status != "ready" {
        return Err(error("assistant_image_invalid"));
    }
    let mime = match reference.format.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(error("assistant_image_invalid")),
    };
    let file = reference
        .file_name
        .ok_or_else(|| error("assistant_reference_missing"))?;
    let bytes = tokio::fs::read(reference_file(&references_dir(app)?, &file)?)
        .await
        .map_err(|_| error("assistant_reference_missing"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("assistant_reference_too_large"));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
pub async fn assistant_reference_read(app: AppHandle, id: String) -> Result<String, AppError> {
    let reference = get(&pool(&app).await?, &id).await?;
    image_data_url(&app, &reference.assistant_id, &id).await
}

pub async fn resume_unfinished(app: &AppHandle) {
    let _claim = EXTRACTION
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let _background = crate::ios_background::BackgroundTask::begin("assistant-references");
    let Ok(pool) = pool(app).await else {
        return;
    };
    let Ok(root) = references_dir(app) else {
        return;
    };
    let Ok(rows) = query("SELECT * FROM assistant_references WHERE status='queued' LIMIT 8")
        .fetch_all(&pool)
        .await
    else {
        return;
    };
    for row in rows {
        let reference = decode(row);
        let Some(name) = reference.file_name else {
            continue;
        };
        let Ok(path) = reference_file(&root, &name) else {
            continue;
        };
        // A remote queued row can arrive before its authenticated file chunks.
        if !path.is_file() {
            continue;
        }
        let format = reference.format;
        let outcome = tokio::task::spawn_blocking(move || extract(&path, &format)).await;
        let (status, text, err) = match outcome {
            Ok(Ok(text)) => ("ready", text, None),
            Ok(Err(err)) => ("failed", String::new(), Some(err.message)),
            Err(_) => (
                "failed",
                String::new(),
                Some(error("assistant_reference_invalid").message),
            ),
        };
        let _=query("UPDATE assistant_references SET status=?,text=?,error=?,updated_at=? WHERE id=? AND status='queued'")
            .bind(status).bind(text).bind(err).bind(chrono::Utc::now().to_rfc3339()).bind(reference.id).execute(&pool).await;
    }
}
fn extract(path: &Path, format: &str) -> Result<String, AppError> {
    let mut file =
        std::fs::File::open(path).map_err(|_| error("assistant_reference_unavailable"))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("assistant_reference_invalid"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("assistant_reference_too_large"));
    }
    let text = match format {
        "txt" | "md" => {
            String::from_utf8(bytes).map_err(|_| error("assistant_reference_encoding"))?
        }
        "png" | "jpg" | "jpeg" | "webp" | "gif" => {
            let reader = image::ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| error("assistant_image_invalid"))?;
            let (w, h) = reader
                .into_dimensions()
                .map_err(|_| error("assistant_image_invalid"))?;
            if w as u64 * h as u64 > 40_000_000 {
                return Err(error("assistant_reference_too_large"));
            }
            String::new()
        }
        "pdf" => {
            let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
                .map_err(|_| error("assistant_reference_invalid"))?;
            if pages.is_empty() {
                return Err(error("assistant_reference_invalid"));
            }
            if pages.iter().all(|v| v.trim().is_empty()) {
                return Err(error("assistant_reference_needs_ocr"));
            }
            pages
                .iter()
                .enumerate()
                .map(|(i, text)| format!("[Page {}]\n{text}\n", i + 1))
                .collect()
        }
        "docx" | "xlsx" | "pptx" => extract_office(&bytes, format)?,
        _ => return Err(error("assistant_reference_format")),
    };
    if text.len() > MAX_TEXT {
        return Err(error("assistant_reference_too_large"));
    }
    Ok(text)
}
fn entity_text(entity: quick_xml::events::BytesRef<'_>) -> Result<String, AppError> {
    if let Some(ch) = entity
        .resolve_char_ref()
        .map_err(|_| error("assistant_reference_invalid"))?
    {
        return Ok(ch.to_string());
    }
    let decoded = entity
        .decode()
        .map_err(|_| error("assistant_reference_invalid"))?;
    match decoded.as_ref() {
        "amp" => Ok("&".into()),
        "lt" => Ok("<".into()),
        "gt" => Ok(">".into()),
        "quot" => Ok("\"".into()),
        "apos" => Ok("'".into()),
        _ => Err(error("assistant_reference_invalid")),
    }
}
fn xml_text(xml: &str) -> Result<String, AppError> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(error("assistant_reference_invalid")),
            Ok(Event::Text(text)) => {
                out.push_str(
                    &quick_xml::escape::unescape(
                        &text
                            .decode()
                            .map_err(|_| error("assistant_reference_invalid"))?,
                    )
                    .map_err(|_| error("assistant_reference_invalid"))?,
                );
            }
            Ok(Event::GeneralRef(entity)) => out.push_str(&entity_text(entity)?),
            Ok(Event::End(tag)) if matches!(tag.local_name().as_ref(), b"p" | b"row" | b"si") => {
                out.push('\n')
            }
            Err(_) => return Err(error("assistant_reference_invalid")),
            _ => {}
        }
    }
    Ok(out)
}
fn extract_office(bytes: &[u8], format: &str) -> Result<String, AppError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("assistant_reference_invalid"))?;
    if archive.len() > 4096 {
        return Err(error("assistant_reference_too_large"));
    }
    let mut parts = Vec::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|_| error("assistant_reference_invalid"))?;
        let name = file.name().to_owned();
        let selected = match format {
            "docx" => name == "word/document.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            "xlsx" => {
                name == "xl/sharedStrings.xml"
                    || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
            }
            _ => false,
        };
        if !selected {
            continue;
        }
        let remaining = 4 * 1024 * 1024 - total;
        if file.size() > remaining {
            return Err(error("assistant_reference_too_large"));
        }
        let mut text = String::new();
        file.by_ref()
            .take(remaining + 1)
            .read_to_string(&mut text)
            .map_err(|_| error("assistant_reference_invalid"))?;
        if text.len() as u64 > remaining {
            return Err(error("assistant_reference_too_large"));
        }
        total += text.len() as u64;
        parts.push((name, text));
    }
    let part_number = |name: &str| {
        name.rsplit('/')
            .next()
            .unwrap_or_default()
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    };
    parts.sort_by_key(|(name, _)| part_number(name));
    if parts.is_empty() {
        return Err(error("assistant_reference_invalid"));
    }
    if format == "xlsx" {
        let strings = parts
            .iter()
            .find(|(name, _)| name == "xl/sharedStrings.xml")
            .map(|(_, xml)| shared_strings(xml))
            .transpose()?
            .unwrap_or_default();
        return parts
            .iter()
            .filter(|(name, _)| name.starts_with("xl/worksheets/"))
            .map(|(name, xml)| {
                sheet_text(xml, &strings)
                    .map(|text| format!("[Sheet {}]\n{text}\n", part_number(name)))
            })
            .collect();
    }
    parts
        .into_iter()
        .map(|(name, text)| {
            xml_text(&text).map(|text| {
                if format == "pptx" {
                    format!("[Slide {}]\n{text}\n", part_number(&name))
                } else {
                    format!("[Document]\n{text}\n")
                }
            })
        })
        .collect()
}
fn shared_strings(xml: &str) -> Result<Vec<String>, AppError> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(error("assistant_reference_invalid")),
            Ok(Event::Start(tag)) => {
                if tag.local_name().as_ref() == b"si" {
                    current.clear();
                }
                in_text = tag.local_name().as_ref() == b"t";
            }
            Ok(Event::End(tag)) => {
                if tag.local_name().as_ref() == b"si" {
                    strings.push(current.clone());
                }
                in_text = false;
            }
            Ok(Event::Text(text)) if in_text => current.push_str(
                &quick_xml::escape::unescape(
                    &text
                        .decode()
                        .map_err(|_| error("assistant_reference_invalid"))?,
                )
                .map_err(|_| error("assistant_reference_invalid"))?,
            ),
            Ok(Event::GeneralRef(entity)) if in_text => current.push_str(&entity_text(entity)?),
            Err(_) => return Err(error("assistant_reference_invalid")),
            _ => {}
        }
    }
    Ok(strings)
}
fn sheet_text(xml: &str, strings: &[String]) -> Result<String, AppError> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut cell = String::new();
    let mut shared = false;
    let mut reading = false;
    let mut value = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(error("assistant_reference_invalid")),
            Ok(Event::Start(tag)) => {
                if tag.local_name().as_ref() == b"c" {
                    cell.clear();
                    value.clear();
                    shared = false;
                    for attr in tag.attributes() {
                        let attr = attr.map_err(|_| error("assistant_reference_invalid"))?;
                        let val = attr
                            .decoded_and_normalized_value(
                                quick_xml::XmlVersion::default(),
                                reader.decoder(),
                            )
                            .map_err(|_| error("assistant_reference_invalid"))?;
                        match attr.key.as_ref() {
                            b"r" => cell = val.into_owned(),
                            b"t" => shared = val == "s",
                            _ => {}
                        }
                    }
                }
                reading = matches!(tag.local_name().as_ref(), b"v" | b"t");
            }
            Ok(Event::Text(text)) if reading => value.push_str(
                &quick_xml::escape::unescape(
                    &text
                        .decode()
                        .map_err(|_| error("assistant_reference_invalid"))?,
                )
                .map_err(|_| error("assistant_reference_invalid"))?,
            ),
            Ok(Event::GeneralRef(entity)) if reading => value.push_str(&entity_text(entity)?),
            Ok(Event::End(tag)) => {
                reading = false;
                if tag.local_name().as_ref() == b"c" {
                    let resolved = if shared {
                        strings
                            .get(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| error("assistant_reference_invalid"))?,
                            )
                            .ok_or_else(|| error("assistant_reference_invalid"))?
                    } else {
                        &value
                    };
                    out.push_str(&format!("{cell}: {resolved}\n"));
                }
            }
            Err(_) => return Err(error("assistant_reference_invalid")),
            _ => {}
        }
    }
    Ok(out)
}
pub async fn reference_context(
    pool: &SqlitePool,
    assistant_id: &str,
    query_text: &str,
) -> Result<String, AppError> {
    let refs = list_references(pool, assistant_id).await?;
    Ok(select_reference_context(&refs, query_text))
}
pub fn select_reference_context(refs: &[AssistantReference], query_text: &str) -> String {
    let words: Vec<_> = query_text
        .split_whitespace()
        .filter(|s| s.len() > 2)
        .map(str::to_lowercase)
        .collect();
    let mut passages = Vec::new();
    for reference in refs.iter().filter(|r| r.status == "ready") {
        let chars: Vec<_> = reference.text.chars().collect();
        for (index, chunk) in chars.chunks(1600).enumerate() {
            let text: String = chunk.iter().collect();
            let lower = text.to_lowercase();
            let score = words
                .iter()
                .filter(|word| lower.contains(word.as_str()))
                .count();
            if words.is_empty() || score > 0 {
                passages.push((
                    score,
                    format!(
                        "[Reference: {}; passage {}; id: {}]\n{}",
                        reference.name,
                        index + 1,
                        reference.id,
                        text
                    ),
                ));
            }
        }
    }
    passages.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    passages
        .into_iter()
        .take(6)
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pdf(catalog_extra: &str) -> Vec<u8> {
        let content = "BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET";
        let objects = [
            format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        bytes
    }
    #[test]
    fn pdf_extracts_page_text_and_rejects_advisory_nested_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reference.pdf");
        std::fs::write(&path, pdf("")).unwrap();
        let text = extract(&path, "pdf").unwrap();
        assert!(text.contains("[Page 1]"));
        assert!(text.contains("Hello PDF"));

        // RUSTSEC-2026-0187: a small PDF must not exhaust the native process stack.
        let nested = format!("/X {}{}", "[".repeat(10_380), "]".repeat(10_380));
        std::fs::write(&path, pdf(&nested)).unwrap();
        assert_eq!(
            extract(&path, "pdf").unwrap_err().code,
            "assistant_reference_invalid"
        );
    }
    fn office(name: &str, body: &str) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn office_extraction_is_local_and_rejects_corruption_and_expansion() {
        let doc = office(
            "word/document.xml",
            "<w:document><w:p><w:t>Useful passage</w:t></w:p></w:document>",
        );
        assert!(extract_office(&doc, "docx")
            .unwrap()
            .contains("Useful passage"));
        assert!(extract_office(b"not a zip", "docx").is_err());
        let bomb = office("word/document.xml", &"x".repeat(4 * 1024 * 1024 + 1));
        assert_eq!(
            extract_office(&bomb, "docx").unwrap_err().code,
            "assistant_reference_too_large"
        );
        let paths = office("../../word/document.xml", "sensitive");
        assert!(extract_office(&paths, "docx").is_err());
    }
    #[test]
    fn extraction_rejects_bad_encoding_and_corrupt_pdf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert_eq!(
            extract(&path, "txt").unwrap_err().code,
            "assistant_reference_encoding"
        );
        assert_eq!(
            extract(&path, "pdf").unwrap_err().code,
            "assistant_reference_invalid"
        );
        std::fs::write(&path, "A readable passage").unwrap();
        assert_eq!(extract(&path, "md").unwrap(), "A readable passage");
    }
    #[test]
    fn files_are_confined_and_xml_never_expands_entities() {
        assert!(reference_file(Path::new("/tmp"), "../secret.txt").is_err());
        assert!(reference_file(
            Path::new("/tmp"),
            "00000000-0000-4000-8000-000000000001.txt"
        )
        .is_ok());
        assert!(xml_text("<!DOCTYPE foo SYSTEM 'file:///etc/passwd'><x>&foo;</x>").is_err());
        assert_eq!(
            xml_text("<w:p><w:t>Hello &amp; world</w:t></w:p>").unwrap(),
            "Hello & world\n"
        );
    }
    #[test]
    fn spreadsheet_shared_strings_resolve_to_cells() {
        let strings = shared_strings(
            "<sst><si><t>Alpha</t></si><si><r><t>Two </t></r><r><t>words</t></r></si></sst>",
        )
        .unwrap();
        assert_eq!(strings, vec!["Alpha", "Two words"]);
        assert_eq!(sheet_text("<worksheet><row><c r=\"A1\" t=\"s\"><v>1</v></c><c r=\"B1\"><v>42</v></c></row></worksheet>",&strings).unwrap(),"A1: Two words\nB1: 42\n");
    }
}
