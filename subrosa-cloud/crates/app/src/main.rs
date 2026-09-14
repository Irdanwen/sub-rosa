//! Composition root for the optional Sub Rosa account service.
use anyhow::Context;
use clap::{Parser, Subcommand};
use std::{net::SocketAddr, sync::Arc};
use subrosa_config::Config;
use subrosa_persistence::Repository;
use subrosa_providers::{LedgerProvider, OidcProvider, StorageProvider};
use subrosa_services::Service;
#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    Serve,
    Migrate,
    Maintenance,
    /// Invalidate every restored session and replay independent deletion intent before reopening traffic.
    RestoreSanitize,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();
    let cli = Cli::parse();
    let config = Config::load().context("load typed configuration")?;
    config.validate().map_err(anyhow::Error::msg)?;
    let repo = Repository::connect(config.database_url.expose()).await?;
    if matches!(cli.command, Some(Command::Migrate)) {
        repo.migrate().await?;
        return Ok(());
    }
    let storage = Arc::new(StorageProvider::new(&config)?);
    let ledger = LedgerProvider::new(&config)?
        .map(|value| Arc::new(value) as Arc<dyn subrosa_domain::DeletionLedger>);
    if matches!(cli.command, Some(Command::RestoreSanitize)) {
        repo.invalidate_restored_sessions().await?;
    }
    // A restored database is never exposed before independent deletion replay succeeds.
    // This path remains usable during an identity-provider outage.
    subrosa_services::maintain(&repo, storage.as_ref(), ledger.as_deref()).await?;
    if matches!(
        cli.command,
        Some(Command::Maintenance | Command::RestoreSanitize)
    ) {
        return Ok(());
    }
    let identity = Arc::new(OidcProvider::discover(config.clone()).await?);
    let addr: SocketAddr = config.bind.parse().context("parse bind address")?;
    let service = Service::new(config, repo, identity, storage).with_deletion_ledger(ledger);
    let worker = service.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_mins(1));
        loop {
            tick.tick().await;
            if worker.maintenance().await.is_err() {
                tracing::warn!("maintenance will retry from durable rows");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr,"Sub Rosa account service ready");
    axum::serve(
        listener,
        subrosa_api::router(service).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = terminate.recv()=>{}};
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}
