//! Places search behind `/v1/web/places`.
//!
//! Deliberately thinner than its `web_augment` siblings: the default provider
//! (OSM/Nominatim) has no upstream cost, so there is no authorize/charge flow
//! here — no estimate to hold, nothing to settle. A keyed provider added
//! behind the same `PlacesSearcher` seam pays its upstream with the user's
//! own key, which is also not this service's ledger to meter. The service
//! layer still exists so the handler stays provider-blind and a future
//! metered provider has a place to grow one.

use crate::error::ServiceError;
use june_domain::{GeoPoint, PlacesSearchRequest, PlacesSearchResults, PlacesSearcher, UserId};
use std::sync::Arc;

pub struct PlacesService {
    /// The no-key default (OSM).
    keyless: Arc<dyn PlacesSearcher>,
    /// The provider a per-request key routes to (Google).
    keyed: Arc<dyn PlacesSearcher>,
}

pub struct PlacesSearchParams {
    pub user_id: UserId,
    pub query: String,
    pub limit: Option<u32>,
    pub near: Option<GeoPoint>,
    /// The user's own Google key, forwarded per request from the app's
    /// keychain. Presence selects the keyed provider.
    pub google_key: Option<String>,
}

impl PlacesService {
    pub fn new(keyless: Arc<dyn PlacesSearcher>, keyed: Arc<dyn PlacesSearcher>) -> Self {
        Self { keyless, keyed }
    }

    pub async fn search(
        &self,
        params: PlacesSearchParams,
    ) -> Result<PlacesSearchResults, ServiceError> {
        let searcher = if params.google_key.is_some() {
            &self.keyed
        } else {
            &self.keyless
        };
        let results = searcher
            .search_places(PlacesSearchRequest {
                query: params.query,
                limit: params.limit,
                near: params.near,
                google_key: params.google_key,
            })
            .await?;
        tracing::info!(
            user = %params.user_id.0,
            provider = %results.provider,
            places = results.places.len(),
            "places search settled"
        );
        Ok(results)
    }
}
