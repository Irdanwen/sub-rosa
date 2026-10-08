//! Composition root for the optional Sub Rosa account service.
use anyhow::Context;
use clap::{Parser, Subcommand};
use std::{net::SocketAddr, sync::Arc};
use subrosa_config::Config;
use subrosa_persistence::Repository;
use subrosa_providers::{CarpeDiemPartnerProvider, LedgerProvider, OidcProvider, StorageProvider};
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
    /// Public content (ADR 0097): list the open reports, oldest first, as JSON lines.
    Reports,
    /// Take public content down: `page <slug>`, `site <id>`, `profile <handle>`
    /// or `assistant <id>`. Hidden at once, counted against its owner, and an
    /// identical copy is refused from then on.
    Takedown {
        kind: String,
        target: String,
        #[arg(long)]
        reason: String,
    },
    /// Close the open reports on one target without taking it down.
    Dismiss {
        kind: String,
        id: uuid::Uuid,
    },
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
    match &cli.command {
        Some(Command::Migrate) => {
            repo.migrate().await?;
            return Ok(());
        }
        Some(Command::Reports) => return reports(&repo).await,
        Some(Command::Takedown {
            kind,
            target,
            reason,
        }) => return takedown(&repo, kind, target, reason).await,
        Some(Command::Dismiss { kind, id }) => {
            let closed = repo
                .dismiss_reports(kind, *id)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            tracing::info!(closed, "reports dismissed");
            return Ok(());
        }
        _ => {}
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
    // Built only for serving: the boot replay above must stay usable without
    // Carpe Diem, and a Carpe Diem outage must never keep the account shut.
    let carpe_diem = CarpeDiemPartnerProvider::new(&config)
        .map_err(|_| anyhow::anyhow!("the Carpe Diem partner key does not sign"))?
        .map(|value| Arc::new(value) as Arc<dyn subrosa_domain::CarpeDiemPartner>);
    let addr: SocketAddr = config.bind.parse().context("parse bind address")?;
    let service = Service::new(config, repo, identity, storage)
        .with_deletion_ledger(ledger)
        .with_carpe_diem(carpe_diem);
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

/// One open report per line, as JSON, for the operator to read or pipe.
async fn reports(repo: &Repository) -> anyhow::Result<()> {
    use std::io::Write;
    let open = repo
        .open_reports()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut out = std::io::stdout().lock();
    for report in open {
        writeln!(out, "{}", serde_json::to_string(&report)?)?;
    }
    Ok(())
}
async fn takedown(repo: &Repository, kind: &str, target: &str, reason: &str) -> anyhow::Result<()> {
    use subrosa_persistence::TakedownTarget;
    let reason = reason.trim();
    if reason.is_empty() || reason.chars().count() > 500 {
        anyhow::bail!("give a reason of 1 to 500 characters");
    }
    let id = || uuid::Uuid::parse_str(target).context("this kind is named by its id");
    let target = match kind {
        "page" => TakedownTarget::Page(target),
        "site" => TakedownTarget::Site(id()?),
        "profile" => TakedownTarget::Profile(target),
        "assistant" => TakedownTarget::Assistant(id()?),
        _ => anyhow::bail!("kind is page, site, profile or assistant"),
    };
    repo.take_down(target, reason)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    tracing::info!(kind, "taken down");
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
