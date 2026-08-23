//! Keyed places search over the Google Places API (New).
//!
//! The premium provider behind `/v1/web/places`: ratings, review counts and
//! photo references, paid for with the USER'S OWN key. The key never lives in
//! this process's config — it arrives per request (the `provider_credentials`
//! pattern), straight from the app's keychain, so a rotated or removed key is
//! effective on the very next call and nothing has to restart.

use async_trait::async_trait;
use june_domain::{
    DomainError, PlaceResult, PlacesSearchRequest, PlacesSearchResults, PlacesSearcher,
};
use serde::Deserialize;
use std::time::Duration;

pub const GOOGLE_PROVIDER_ID: &str = "google";
const DEFAULT_BASE_URL: &str = "https://places.googleapis.com";
const DEFAULT_LIMIT: u32 = 6;
const MAX_LIMIT: u32 = 8;
/// Radius of the locationBias circle around `near`, meters.
const NEAR_BIAS_RADIUS_M: f64 = 30_000.0;
/// Only the fields the card renders — the field mask is also what Google
/// prices, so asking for more would bill the user's key for nothing.
const FIELD_MASK: &str = "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.primaryTypeDisplayName,places.photos";

pub struct GooglePlaces {
    http: reqwest::Client,
    base_url: String,
}

impl GooglePlaces {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchTextResponse {
    #[serde(default)]
    places: Vec<WirePlace>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePlace {
    #[serde(default)]
    display_name: Option<WireText>,
    #[serde(default)]
    formatted_address: Option<String>,
    #[serde(default)]
    location: Option<WireLocation>,
    #[serde(default)]
    rating: Option<f32>,
    #[serde(default)]
    user_rating_count: Option<u32>,
    #[serde(default)]
    website_uri: Option<String>,
    #[serde(default)]
    primary_type_display_name: Option<WireText>,
    #[serde(default)]
    photos: Vec<WirePhoto>,
}

#[derive(Debug, Deserialize)]
struct WireText {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLocation {
    latitude: f64,
    longitude: f64,
}

#[derive(Debug, Deserialize)]
struct WirePhoto {
    #[serde(default)]
    name: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Pure wire→domain mapping: rows without a name or coordinates drop, only
/// the first photo reference survives (the card shows one thumbnail).
fn map_places(query: &str, wire: SearchTextResponse) -> PlacesSearchResults {
    let places = wire
        .places
        .into_iter()
        .filter_map(|place| {
            let name = non_empty(place.display_name.and_then(|text| text.text))?;
            let location = place.location?;
            if !(-90.0..=90.0).contains(&location.latitude)
                || !(-180.0..=180.0).contains(&location.longitude)
            {
                return None;
            }
            Some(PlaceResult {
                name,
                lat: location.latitude,
                lng: location.longitude,
                address: non_empty(place.formatted_address),
                category: non_empty(place.primary_type_display_name.and_then(|text| text.text)),
                url: non_empty(place.website_uri),
                rating: place.rating.filter(|rating| (0.0..=5.0).contains(rating)),
                reviews: place.user_rating_count,
                photo_ref: place
                    .photos
                    .into_iter()
                    .find_map(|photo| non_empty(photo.name)),
            })
        })
        .collect();
    PlacesSearchResults {
        query: query.to_string(),
        provider: GOOGLE_PROVIDER_ID.to_string(),
        places,
    }
}

#[async_trait]
impl PlacesSearcher for GooglePlaces {
    async fn search_places(
        &self,
        request: PlacesSearchRequest,
    ) -> Result<PlacesSearchResults, DomainError> {
        let Some(key) = request
            .google_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        else {
            // The service routes here only when a key is present; a missing
            // one is a wiring bug, not a user condition.
            tracing::error!("google places: called without a key");
            return Err(DomainError::UpstreamProvider);
        };
        let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let mut body = serde_json::json!({
            "textQuery": request.query,
            "pageSize": limit,
        });
        if let Some(near) = request.near {
            body["locationBias"] = serde_json::json!({
                "circle": {
                    "center": { "latitude": near.lat, "longitude": near.lng },
                    "radius": NEAR_BIAS_RADIUS_M,
                }
            });
        }
        let response = self
            .http
            .post(format!("{}/v1/places:searchText", self.base_url))
            .header("X-Goog-Api-Key", key)
            .header("X-Goog-FieldMask", FIELD_MASK)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "google places: request failed");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(DomainError::UpstreamRateLimited);
        }
        if !status.is_success() {
            // 400/403 usually mean a bad or restricted key; the app surfaces
            // the failure on the card as a plain degraded state.
            tracing::warn!(%status, "google places: non-success response");
            return Err(DomainError::UpstreamProvider);
        }
        let wire: SearchTextResponse = response.json().await.map_err(|error| {
            tracing::warn!(%error, "google places: response JSON parse failed");
            DomainError::UpstreamProvider
        })?;
        Ok(map_places(&request.query, wire))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_wire_shape_with_ratings_and_one_photo() {
        let wire: SearchTextResponse = serde_json::from_value(serde_json::json!({
            "places": [{
                "displayName": { "text": "Sogeca Experts" },
                "formattedAddress": "12 Rue de la Gare, 74100 Annemasse",
                "location": { "latitude": 46.19, "longitude": 6.23 },
                "rating": 5.0,
                "userRatingCount": 8,
                "websiteUri": "https://sogeca.example.com",
                "primaryTypeDisplayName": { "text": "Accountant" },
                "photos": [
                    { "name": "places/abc/photos/one" },
                    { "name": "places/abc/photos/two" }
                ]
            }, {
                "displayName": { "text": "No location" }
            }]
        }))
        .unwrap();
        let results = map_places("expert comptable", wire);
        assert_eq!(results.provider, "google");
        assert_eq!(results.places.len(), 1);
        let place = &results.places[0];
        assert_eq!(place.rating, Some(5.0));
        assert_eq!(place.reviews, Some(8));
        assert_eq!(place.photo_ref.as_deref(), Some("places/abc/photos/one"));
        assert_eq!(place.category.as_deref(), Some("Accountant"));
    }
}
