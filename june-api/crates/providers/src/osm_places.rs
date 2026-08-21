//! Keyless places search over OpenStreetMap's Nominatim.
//!
//! The default provider behind `/v1/web/places`: no account, no key, no
//! metering — names, coordinates, addresses and categories, but no ratings
//! (a richer keyed provider fills those in through the same `PlacesSearcher`
//! trait). Two obligations come with the free endpoint and are enforced
//! here rather than left to callers: an identifying User-Agent and at most
//! one request per second (<https://operations.osmfoundation.org/policies/nominatim/>).
//! Results are cached for a day so repeated agent turns cost OSM nothing.

use async_trait::async_trait;
use june_domain::{
    DomainError, PlaceResult, PlacesSearchRequest, PlacesSearchResults, PlacesSearcher,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const OSM_PROVIDER_ID: &str = "osm";
const DEFAULT_BASE_URL: &str = "https://nominatim.openstreetmap.org";
const DEFAULT_LIMIT: u32 = 6;
const MAX_LIMIT: u32 = 8;
/// Nominatim's public instance allows one request per second.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(1);
const CACHE_TTL: Duration = Duration::from_hours(24);
const CACHE_CAP: usize = 128;
/// Half-width in degrees of the bias viewbox around `near` (unbounded, so it
/// prefers the area without excluding the rest of the world).
const NEAR_BIAS_DEGREES: f64 = 0.15;

pub struct NominatimPlaces {
    http: reqwest::Client,
    base_url: String,
    throttle: Mutex<Option<Instant>>,
    cache: Mutex<HashMap<String, (Instant, PlacesSearchResults)>>,
}

impl NominatimPlaces {
    pub fn new(base_url: Option<String>, user_agent: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(user_agent.to_string())
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            throttle: Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
        }
    }

    async fn respect_rate_limit(&self) {
        let mut last = self.throttle.lock().await;
        if let Some(previous) = *last {
            let elapsed = previous.elapsed();
            if let Some(remaining) = MIN_REQUEST_INTERVAL.checked_sub(elapsed) {
                tokio::time::sleep(remaining).await;
            }
        }
        *last = Some(Instant::now());
    }
}

#[derive(Debug, Deserialize)]
struct NominatimEntry {
    lat: String,
    lon: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    /// e.g. "amenity", "office", "shop".
    #[serde(default)]
    category: Option<String>,
    /// e.g. "restaurant", "accountant".
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// "accountant" -> "Accountant"; Nominatim types are `snake_case` tokens.
fn humanize(kind: &str) -> String {
    let spaced = kind.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Pure wire→domain mapping, split out so it is testable without HTTP: name
/// falls back to the first display-name segment, the rest of the display name
/// becomes the address, and unparsable coordinates drop the row.
fn map_entries(query: &str, entries: Vec<NominatimEntry>) -> PlacesSearchResults {
    let places = entries
        .into_iter()
        .filter_map(|entry| {
            let lat: f64 = entry.lat.trim().parse().ok()?;
            let lng: f64 = entry.lon.trim().parse().ok()?;
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
                return None;
            }
            let display = non_empty(entry.display_name);
            let (display_head, display_rest) = match &display {
                Some(value) => match value.split_once(',') {
                    Some((head, rest)) => (Some(head.trim().to_string()), {
                        let rest = rest.trim();
                        (!rest.is_empty()).then(|| rest.to_string())
                    }),
                    None => (Some(value.clone()), None),
                },
                None => (None, None),
            };
            let name = non_empty(entry.name).or(display_head)?;
            let category = non_empty(entry.kind)
                .map(|kind| humanize(&kind))
                .or_else(|| non_empty(entry.category).map(|c| humanize(&c)));
            Some(PlaceResult {
                name,
                lat,
                lng,
                address: display_rest,
                category,
                url: None,
                rating: None,
                reviews: None,
                photo_ref: None,
            })
        })
        .collect();
    PlacesSearchResults {
        query: query.to_string(),
        provider: OSM_PROVIDER_ID.to_string(),
        places,
    }
}

#[async_trait]
impl PlacesSearcher for NominatimPlaces {
    async fn search_places(
        &self,
        request: PlacesSearchRequest,
    ) -> Result<PlacesSearchResults, DomainError> {
        let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let cache_key = format!(
            "{}|{}|{}",
            request.query.to_lowercase(),
            limit,
            request
                .near
                .map(|near| format!("{:.3},{:.3}", near.lat, near.lng))
                .unwrap_or_default()
        );
        {
            let cache = self.cache.lock().await;
            if let Some((stored_at, results)) = cache.get(&cache_key)
                && stored_at.elapsed() < CACHE_TTL
            {
                return Ok(results.clone());
            }
        }

        self.respect_rate_limit().await;
        let mut params: Vec<(&str, String)> = vec![
            ("q", request.query.clone()),
            ("format", "jsonv2".to_string()),
            ("limit", limit.to_string()),
        ];
        if let Some(near) = request.near {
            // viewbox WITHOUT bounded=1: a preference, not a fence.
            params.push((
                "viewbox",
                format!(
                    "{},{},{},{}",
                    near.lng - NEAR_BIAS_DEGREES,
                    near.lat + NEAR_BIAS_DEGREES,
                    near.lng + NEAR_BIAS_DEGREES,
                    near.lat - NEAR_BIAS_DEGREES
                ),
            ));
        }
        let response = self
            .http
            .get(format!("{}/search", self.base_url))
            .query(&params)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "nominatim: request failed");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(DomainError::UpstreamRateLimited);
        }
        if !status.is_success() {
            tracing::warn!(%status, "nominatim: non-success response");
            return Err(DomainError::UpstreamProvider);
        }
        let entries: Vec<NominatimEntry> = response.json().await.map_err(|error| {
            tracing::warn!(%error, "nominatim: response JSON parse failed");
            DomainError::UpstreamProvider
        })?;
        let results = map_entries(&request.query, entries);

        let mut cache = self.cache.lock().await;
        if cache.len() >= CACHE_CAP {
            // Cheap pressure valve; a day-long TTL makes eviction order moot.
            cache.clear();
        }
        cache.insert(cache_key, (Instant::now(), results.clone()));
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(lat: &str, lon: &str, name: Option<&str>, display: Option<&str>) -> NominatimEntry {
        NominatimEntry {
            lat: lat.to_string(),
            lon: lon.to_string(),
            name: name.map(String::from),
            display_name: display.map(String::from),
            category: Some("office".to_string()),
            kind: Some("accountant".to_string()),
        }
    }

    #[test]
    fn maps_the_wire_shape_into_places() {
        let results = map_entries(
            "expert comptable annemasse",
            vec![entry(
                "46.19",
                "6.23",
                Some("Sogeca"),
                Some("Sogeca, Rue de la Gare, Annemasse, France"),
            )],
        );
        assert_eq!(results.provider, "osm");
        let place = &results.places[0];
        assert_eq!(place.name, "Sogeca");
        assert_eq!(
            place.address.as_deref(),
            Some("Rue de la Gare, Annemasse, France")
        );
        assert_eq!(place.category.as_deref(), Some("Accountant"));
        assert!(place.rating.is_none());
    }

    #[test]
    fn falls_back_to_the_display_name_head_and_drops_bad_rows() {
        let results = map_entries(
            "q",
            vec![
                entry("46.19", "6.23", None, Some("Majexperts, Annemasse")),
                entry("not-a-number", "6.23", Some("Broken"), None),
                entry("95.0", "6.23", Some("Off the globe"), None),
                entry("46.19", "6.23", None, None),
            ],
        );
        assert_eq!(results.places.len(), 1);
        assert_eq!(results.places[0].name, "Majexperts");
        assert_eq!(results.places[0].address.as_deref(), Some("Annemasse"));
    }
}
