//! Thin CLI over the shared composition root in `june-embed`. The wiring
//! (providers, services, router) lives there so the desktop sidecar binary
//! and the embedded in-process server (Sub Rosa mobile) cannot drift.

use clap::{Parser, Subcommand};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug, Parser)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    init_tracing();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
    }
}

async fn serve() -> anyhow::Result<()> {
    let config = june_config::load()?;
    june_embed::serve_config(&config, std::future::pending()).await
}

fn init_tracing() {
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "june=info,june_api=info,june_services=info,june_providers=info,tower_http=info"
                    .into()
            }),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .try_init();
}
