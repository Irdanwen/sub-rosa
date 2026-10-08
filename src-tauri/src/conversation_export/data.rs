//! A chart or a table saved out of a reply (ADR-0086): PNG, SVG or CSV. The
//! webview draws the file, because only it holds the rendered chart in its
//! resolved theme; this side checks it is what it claims to be and delivers
//! it the way a conversation export is delivered (save dialog on desktop,
//! share sheet on the phone), so no path crosses IPC.

use base64::Engine;
use serde::Deserialize;

use super::{deliver, ExportConversationResult};
use crate::domain::types::AppError;

/// A chart or a 500-row table is far below this; anything near it is not one.
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataFormat {
    Png,
    Svg,
    Csv,
}

impl DataFormat {
    fn extension(self) -> &'static str {
        match self {
            DataFormat::Png => "png",
            DataFormat::Svg => "svg",
            DataFormat::Csv => "csv",
        }
    }

    fn filter(self) -> &'static str {
        match self {
            DataFormat::Png => "PNG image",
            DataFormat::Svg => "SVG image",
            DataFormat::Csv => "CSV",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChatDataRequest {
    pub name: String,
    pub format: DataFormat,
    /// Text for svg and csv, base64 for png.
    pub data: String,
}

fn refused() -> AppError {
    AppError::new("chat_data_export_invalid", "This file could not be saved.")
}

/// The file's bytes, or a refusal for anything that is not the format named.
pub fn file_bytes(request: &ExportChatDataRequest) -> Result<Vec<u8>, AppError> {
    if request.data.len() > MAX_BYTES * 4 / 3 + 4 {
        return Err(refused());
    }
    let bytes = match request.format {
        DataFormat::Png => base64::engine::general_purpose::STANDARD
            .decode(request.data.trim())
            .map_err(|_| refused())?,
        DataFormat::Svg | DataFormat::Csv => request.data.clone().into_bytes(),
    };
    let valid = match request.format {
        DataFormat::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        DataFormat::Svg => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_string();
            head.trim_start().starts_with("<svg")
        }
        DataFormat::Csv => true,
    };
    if !valid || bytes.len() > MAX_BYTES {
        return Err(refused());
    }
    Ok(bytes)
}

pub fn file_name(name: &str, format: DataFormat) -> String {
    format!(
        "{}.{}",
        crate::note_export::safe_file_stem(name, "Chart"),
        format.extension()
    )
}

#[tauri::command]
pub async fn export_chat_data(
    app: tauri::AppHandle,
    request: ExportChatDataRequest,
) -> Result<ExportConversationResult, AppError> {
    let bytes = file_bytes(&request)?;
    let name = file_name(&request.name, request.format);
    let format = request.format;
    deliver(&app, &name, (format.filter(), format.extension()), bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(format: &str, data: &str) -> ExportChatDataRequest {
        serde_json::from_value(serde_json::json!({
            "name": "Sales: Q4 / 2026", "format": format, "data": data
        }))
        .unwrap()
    }

    #[test]
    fn each_format_is_checked_for_what_it_claims_to_be() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        assert!(file_bytes(&request("png", &png)).is_ok());
        assert!(file_bytes(&request("png", "bm90IGEgcG5n")).is_err());
        assert!(file_bytes(&request("png", "%%%")).is_err());
        assert!(file_bytes(&request("svg", " <svg xmlns=\"x\"></svg>")).is_ok());
        assert!(file_bytes(&request("svg", "<html></html>")).is_err());
        assert_eq!(file_bytes(&request("csv", "a,b\r\n")).unwrap(), b"a,b\r\n");
    }

    #[test]
    fn an_oversized_file_is_refused_and_the_name_is_safe() {
        let big = "x".repeat(MAX_BYTES + 1);
        assert!(file_bytes(&request("csv", &big)).is_err());
        assert_eq!(
            file_name("Sales: Q4 / 2026", DataFormat::Png),
            "Sales Q4 2026.png"
        );
        assert_eq!(file_name("  ", DataFormat::Csv), "Chart.csv");
    }
}
