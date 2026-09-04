//! Semantic memory recall: embeddings + hybrid search (the Venice Memoria
//! retrieval recipe, adapted to local SQLite).
//!
//! Embeddings come straight from Carpe Diem's OpenAI-compatible
//! `/embeddings` endpoint with the user's stored key — the same
//! direct-call pattern as `carpe_diem::media`, deliberately NOT routed
//! through the june-api sidecar: June never priced embedding models, so the
//! sidecar's authorize/charge pipeline has no lane for them, and the direct
//! call works identically on desktop and iOS.
//!
//! Vectors are stored in the `memories.embedding` BLOB as little-endian f32
//! and backfilled best-effort (after each extraction pass and on manual
//! adds). Recall merges two rankings with Reciprocal Rank Fusion:
//! keyword LIKE matching (exact words, names) and cosine similarity over the
//! stored vectors (paraphrases, cross-language matches). A memory with no
//! vector yet still surfaces through the keyword half.

use crate::{
    db::repositories::Repositories,
    domain::types::{AppError, MemoryDto},
};
use std::time::Duration;

/// BGE-M3, the embedding model served through Carpe Diem's Venice catalog
/// (1024 dimensions — the same family Venice's own Memoria uses).
const EMBEDDING_MODEL: &str = "text-embedding-bge-m3";
const EMBEDDING_TIMEOUT: Duration = Duration::from_secs(30);
/// Memories embedded per backfill pass; extraction adds at most 5 per pass,
/// so one batch clears the backlog plus stragglers from failed attempts.
const BACKFILL_BATCH: i64 = 16;
/// Standard RRF dampening constant (from the original TREC formulation).
const RRF_K: f64 = 60.0;

/// Hybrid recall over enabled memories: keyword LIKE + cosine over stored
/// vectors, merged with RRF. Falls back to pure keyword results when the
/// query embedding cannot be produced (offline, no key, model missing).
pub async fn recall(
    repos: &Repositories,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryDto>, AppError> {
    if !super::settings().enabled {
        return Ok(Vec::new());
    }
    let keyword = repos.search_memories(query, limit as i64).await?;

    let semantic = match embed(&[query.to_string()]).await {
        Ok(mut vectors) if !vectors.is_empty() => {
            let query_vector = vectors.remove(0);
            let rows = repos.memories_with_embeddings().await?;
            let mut scored: Vec<(f32, MemoryDto)> = rows
                .into_iter()
                .filter_map(|row| {
                    let embedding = decode_embedding(&row.embedding?);
                    let score = cosine_similarity(&query_vector, &embedding)?;
                    Some((score, row.memory))
                })
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            scored
                .into_iter()
                .take(limit)
                .map(|(_, memory)| memory)
                .collect()
        }
        _ => Vec::new(),
    };

    Ok(reciprocal_rank_fusion(keyword, semantic, limit))
}

/// Embeds every stored memory that still lacks a vector. Best-effort by
/// design: callers spawn it detached and a failure just leaves the memory on
/// the keyword-only path until the next pass.
pub async fn backfill_embeddings(repos: &Repositories) -> Result<usize, AppError> {
    if !super::settings().enabled {
        return Ok(0);
    }
    // Unconfigured install (first-run gate): nothing to do, not an error.
    if crate::carpe_diem::settings::api_key().is_none() {
        return Ok(0);
    }
    let pending = repos.memories_missing_embedding(BACKFILL_BATCH).await?;
    if pending.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = pending.iter().map(|memory| memory.text.clone()).collect();
    let vectors = embed(&texts).await?;
    let mut stored = 0;
    for (memory, vector) in pending.iter().zip(vectors.iter()) {
        repos
            .set_memory_embedding(&memory.id, &encode_embedding(vector))
            .await?;
        stored += 1;
    }
    Ok(stored)
}

/// Detached backfill for fire-and-forget call sites (post-extraction, manual
/// adds). Errors only log — memory embedding is an enrichment, never a
/// user-visible failure.
pub fn spawn_backfill(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let repos = crate::commands::repositories(&app).await?;
            backfill_embeddings(&repos).await
        }
        .await;
        if let Err(error) = result {
            eprintln!("memory embedding backfill failed: {error:?}");
        }
    });
}

/// One `/embeddings` call for a batch of inputs, in input order.
pub(crate) async fn embed(texts: &[String]) -> Result<Vec<Vec<f32>>, AppError> {
    let Some(key) = crate::carpe_diem::settings::api_key() else {
        return Err(AppError::new(
            "memory_embeddings_no_key",
            "No Carpe Diem API key is stored yet.",
        ));
    };
    let base = crate::carpe_diem::settings::base_url();
    let client = crate::http_client::credentialed(EMBEDDING_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("memory_embeddings_client", error.to_string()))?;
    let body = serde_json::json!({
        "model": EMBEDDING_MODEL,
        "input": texts,
        "encoding_format": "float",
    });
    let request_bytes = body.to_string().len() as u64;
    let started = std::time::Instant::now();
    let sent = client
        .post(format!("{base}/embeddings"))
        .bearer_auth(key.expose_str())
        .json(&body)
        .send()
        .await;
    // A direct call, so it joins the egress ledger here (ADR-0043): the
    // shape of the request, never the passages it carried.
    let status = sent
        .as_ref()
        .ok()
        .map(|response| response.status().as_u16());
    let response_bytes = sent
        .as_ref()
        .ok()
        .and_then(|response| response.content_length())
        .unwrap_or(0);
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(&base)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "(unconfigured)".to_string()),
        purpose: "embeddings".to_string(),
        method: "POST".to_string(),
        request_bytes,
        response_bytes,
        status,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        model: Some(EMBEDDING_MODEL.to_string()),
        note_id: None,
    });
    let response =
        sent.map_err(|error| AppError::new("memory_embeddings_unreachable", error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "memory_embeddings_failed",
            format!(
                "The embeddings endpoint returned status {}.",
                response.status()
            ),
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AppError::new("memory_embeddings_invalid", error.to_string()))?;
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppError::new(
                "memory_embeddings_invalid",
                "The embeddings response is missing data.",
            )
        })?;
    // `data` entries carry an `index`; sort by it so vectors line up with
    // inputs even if the provider reorders them.
    let mut indexed: Vec<(usize, Vec<f32>)> = data
        .iter()
        .filter_map(|entry| {
            let index = entry.get("index").and_then(serde_json::Value::as_u64)? as usize;
            let vector = entry
                .get("embedding")
                .and_then(serde_json::Value::as_array)?
                .iter()
                .filter_map(|component| component.as_f64().map(|value| value as f32))
                .collect::<Vec<f32>>();
            (!vector.is_empty()).then_some((index, vector))
        })
        .collect();
    indexed.sort_by_key(|(index, _)| *index);
    Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
}

/// Little-endian f32 encoding for the `memories.embedding` BLOB.
pub(crate) fn encode_embedding(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

pub(crate) fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Cosine similarity; `None` on dimension mismatch or zero vectors so broken
/// rows drop out of the ranking instead of poisoning it.
pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return None;
    }
    Some(dot / (norm_a.sqrt() * norm_b.sqrt()))
}

/// Reciprocal Rank Fusion over the keyword and semantic rankings: score(m) =
/// Σ 1/(k + rank). A memory present in both lists beats one present in
/// either, without needing the two score scales to be comparable.
fn reciprocal_rank_fusion(
    keyword: Vec<MemoryDto>,
    semantic: Vec<MemoryDto>,
    limit: usize,
) -> Vec<MemoryDto> {
    let mut scores: Vec<(f64, MemoryDto)> = Vec::new();
    for list in [keyword, semantic] {
        for (rank, memory) in list.into_iter().enumerate() {
            let score = 1.0 / (RRF_K + rank as f64 + 1.0);
            if let Some(existing) = scores.iter_mut().find(|(_, m)| m.id == memory.id) {
                existing.0 += score;
            } else {
                scores.push((score, memory));
            }
        }
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scores
        .into_iter()
        .take(limit)
        .map(|(_, memory)| memory)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::MemorySource;

    fn memory(id: &str) -> MemoryDto {
        MemoryDto {
            id: id.to_string(),
            text: format!("fact {id}"),
            source: MemorySource::Auto,
            importance: 5,
            disabled: false,
            has_embedding: true,
            created_at: "2026-07-10T00:00:00.000Z".to_string(),
            updated_at: "2026-07-10T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn embedding_bytes_round_trip() {
        let vector = vec![0.25f32, -1.5, 3.75, 0.0];
        let bytes = encode_embedding(&vector);
        assert_eq!(bytes.len(), 16);
        assert_eq!(decode_embedding(&bytes), vector);
    }

    #[test]
    fn cosine_similarity_behaves() {
        let a = vec![1.0f32, 0.0];
        let b = vec![1.0f32, 0.0];
        let c = vec![0.0f32, 1.0];
        assert!((cosine_similarity(&a, &b).unwrap() - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&a, &c).unwrap().abs() < 1e-6);
        assert_eq!(cosine_similarity(&a, &[1.0]), None, "dimension mismatch");
        assert_eq!(cosine_similarity(&a, &[0.0, 0.0]), None, "zero vector");
    }

    #[test]
    fn rrf_prefers_memories_ranked_by_both_lists() {
        let keyword = vec![memory("a"), memory("b"), memory("c")];
        let semantic = vec![memory("c"), memory("d")];
        let merged = reciprocal_rank_fusion(keyword, semantic, 10);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        // "c" appears in both rankings (rank 3 + rank 1) and beats every
        // single-list entry; "a" (keyword rank 1) beats "d" (semantic rank 2).
        assert_eq!(ids, vec!["c", "a", "b", "d"]);
    }

    #[test]
    fn rrf_respects_the_limit() {
        let merged = reciprocal_rank_fusion(vec![memory("a"), memory("b")], vec![memory("c")], 2);
        assert_eq!(merged.len(), 2);
    }
}
