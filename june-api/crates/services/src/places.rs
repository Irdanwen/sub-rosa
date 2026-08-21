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
    searcher: Arc<dyn PlacesSearcher>,
}

pub struct PlacesSearchParams {
    pub user_id: UserId,
    pub query: String,
    pub limit: Option<u32>,
    pub near: Option<GeoPoint>,
}

impl PlacesService {
    pub fn new(searcher: Arc<dyn PlacesSearcher>) -> Self {
        Self { searcher }
    }

    pub async fn search(
        &self,
        params: PlacesSearchParams,
    ) -> Result<PlacesSearchResults, ServiceError> {
        let results = self
            .searcher
            .search_places(PlacesSearchRequest {
                query: params.query,
                limit: params.limit,
                near: params.near,
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
