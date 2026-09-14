//! Authenticated deletion records in storage independent from database/blob backups.
use super::StorageProvider;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::TryStreamExt;
use hmac::{Hmac, Mac};
use object_store::{ObjectStore, PutMode, PutOptions, path::Path};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{collections::BTreeMap, sync::Arc};
use subrosa_config::Config;
use subrosa_domain::{DeletionLedger, DeletionPage, DeletionRecord, Error, Result, Secret};

pub struct LedgerProvider {
    store: Arc<dyn ObjectStore>,
    active: String,
    keys: BTreeMap<String, Secret>,
}
#[derive(Serialize, Deserialize)]
struct SignedRecord {
    key_id: String,
    record: DeletionRecord,
    mac: String,
}
impl LedgerProvider {
    pub fn new(config: &Config) -> Result<Option<Self>> {
        let Some(ledger) = &config.deletion_ledger else {
            return Ok(None);
        };
        let mut storage_config = config.clone();
        storage_config.storage = ledger.storage.clone();
        let store = StorageProvider::new(&storage_config)?.store;
        for key in ledger.signing_keys.values() {
            if URL_SAFE_NO_PAD
                .decode(key.expose())
                .map_err(|_| Error::Invalid)?
                .len()
                < 32
            {
                return Err(Error::Invalid);
            }
        }
        Ok(Some(Self {
            store,
            active: ledger.active_key_id.clone(),
            keys: ledger.signing_keys.clone(),
        }))
    }
    fn mac(&self, key_id: &str, record: &DeletionRecord) -> Result<Hmac<Sha256>> {
        let key = self.keys.get(key_id).ok_or(Error::Unavailable)?;
        let decoded = zeroize::Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(key.expose())
                .map_err(|_| Error::Unavailable)?,
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&decoded).map_err(|_| Error::Unavailable)?;
        mac.update(b"subrosa:deletion-ledger:v1:");
        mac.update(&serde_json::to_vec(record).map_err(|_| Error::Unavailable)?);
        Ok(mac)
    }
    async fn read(&self, path: &Path) -> Result<DeletionRecord> {
        let response = self.store.get(path).await.map_err(|_| Error::Unavailable)?;
        if response.meta.size > 4096 {
            return Err(Error::Unavailable);
        }
        let bytes = response.bytes().await.map_err(|_| Error::Unavailable)?;
        let signed: SignedRecord =
            serde_json::from_slice(&bytes).map_err(|_| Error::Unavailable)?;
        let tag = URL_SAFE_NO_PAD
            .decode(&signed.mac)
            .map_err(|_| Error::Unavailable)?;
        self.mac(&signed.key_id, &signed.record)?
            .verify_slice(&tag)
            .map_err(|_| Error::Unavailable)?;
        if signed.record.version != 1
            || path.as_ref() != format!("deletions/{}.json", signed.record.account_id)
        {
            return Err(Error::Unavailable);
        }
        Ok(signed.record)
    }
}
#[async_trait]
impl DeletionLedger for LedgerProvider {
    async fn record(&self, record: &DeletionRecord) -> Result<()> {
        let path = Path::from(format!("deletions/{}.json", record.account_id));
        let mac = URL_SAFE_NO_PAD.encode(self.mac(&self.active, record)?.finalize().into_bytes());
        let bytes = serde_json::to_vec(&SignedRecord {
            key_id: self.active.clone(),
            record: record.clone(),
            mac,
        })
        .map_err(|_| Error::Unavailable)?;
        match self
            .store
            .put_opts(
                &path,
                bytes.into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(object_store::Error::AlreadyExists { .. }) => {
                let old = self.read(&path).await?;
                if old.account_id == record.account_id {
                    Ok(())
                } else {
                    Err(Error::Unavailable)
                }
            }
            Err(_) => Err(Error::Unavailable),
        }
    }
    async fn page(&self, after: Option<&str>) -> Result<DeletionPage> {
        // ObjectStore listing order is unspecified. Keep only the first 100 lexical
        // keys after this scan's cursor; memory remains bounded even for large ledgers.
        let prefix = Path::from("deletions");
        let mut listing = self.store.list(Some(&prefix));
        let mut keys = BTreeMap::new();
        while let Some(meta) = listing.try_next().await.map_err(|_| Error::Unavailable)? {
            let name = meta.location.to_string();
            if after.is_some_and(|cursor| name.as_str() <= cursor) {
                continue;
            }
            keys.insert(name, meta.location);
            if keys.len() > 100 {
                keys.pop_last();
            }
        }
        let cursor = keys.last_key_value().map(|(key, _)| key.clone());
        let mut records = Vec::with_capacity(keys.len());
        for path in keys.values() {
            records.push(self.read(path).await?);
        }
        Ok(DeletionPage { records, cursor })
    }
}
