mod client;
mod platform;
mod session;
mod storage;

use clap::{Parser, Subcommand};
use platform::Enforcement;
use session::Desired;
use storage::{Credentials, Store};
use tokio::sync::mpsc;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

/// How often the agent re-checks expiry and, while blocked, re-asserts the
/// lock. Short enough that a user unlocking the machine while the session
/// should be blocked gets re-locked within a couple of seconds; long enough
/// not to be wasteful. See docs/offline-expiry.md.
const TICK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Parser)]
#[command(name = "taymna-agent", version, about = "Taymna machine agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Connect to the Taymna server and enforce the current session (default).
    Run,
    /// Complete enrollment using a one-time token issued by an operator.
    Enroll {
        /// Base URL of the Taymna server, e.g. https://taymna.example.com
        #[arg(long)]
        server: String,
        #[arg(long)]
        token: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let store = Store::new(None)?;

    match cli.command.unwrap_or(Command::Run) {
        Command::Enroll { server, token } => enroll(&store, server, token).await,
        Command::Run => run(store).await,
    }
}

async fn enroll(store: &Store, server: String, token: String) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    struct EnrollResponse {
        #[serde(rename = "machineId")]
        machine_id: String,
        #[serde(rename = "machineSecret")]
        machine_secret: String,
    }

    let url = format!("{}/machines/enroll", server.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "token": token }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("enrollment failed ({status}): {body}");
    }

    let parsed: EnrollResponse = response.json().await?;

    let mut state = store.load()?;
    state.credentials = Some(Credentials {
        server_url: server,
        machine_id: parsed.machine_id.clone(),
        machine_secret: parsed.machine_secret,
    });
    store.save(&state)?;

    println!("Enrolled successfully as machine {}", parsed.machine_id);
    Ok(())
}

async fn run(store: Store) -> anyhow::Result<()> {
    let mut state = store.load()?;
    let Some(credentials) = state.credentials.clone() else {
        anyhow::bail!(
            "this machine is not enrolled yet -- run `taymna-agent enroll --server <url> --token <token>` first"
        );
    };

    let enforcement = platform::current();
    let mut clock = storage::ClockGuard::new(state.trusted_high_water_mark);
    let mut currently_blocked = true; // start pessimistic: assume blocked until proven otherwise

    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    tokio::spawn(client::run(credentials, events_tx));

    let mut ticker = tokio::time::interval(TICK_INTERVAL);
    let mut shutdown = std::pin::pin!(shutdown_signal());

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                info!("shutting down");
                store.save(&state)?;
                return Ok(());
            }
            event = events_rx.recv() => {
                match event {
                    Some(client::ServerEvent::SessionState { session, message_time }) => {
                        let applied = session::apply_server_message(
                            &mut state.session,
                            &mut state.last_applied_at,
                            session,
                            message_time,
                        );
                        if applied {
                            clock.resync_from_server(message_time);
                            state.trusted_high_water_mark = clock.high_water_mark();
                            store.save(&state)?;
                        }
                    }
                    Some(client::ServerEvent::ServerTime(server_time)) => {
                        clock.resync_from_server(server_time);
                        state.trusted_high_water_mark = clock.high_water_mark();
                    }
                    None => {
                        // The client task only exits if the channel sender is
                        // dropped, which only happens if it panics.
                        warn!("connection task ended unexpectedly");
                    }
                }
            }
            _ = ticker.tick() => {
                let trusted_now = clock.now();
                state.trusted_high_water_mark = clock.high_water_mark();
                let desired = session::advance(&mut state.session, trusted_now);

                match desired {
                    Desired::Blocked => {
                        enforcement.disable_usage();
                        currently_blocked = true;
                    }
                    Desired::Allowed if currently_blocked => {
                        enforcement.enable_usage();
                        currently_blocked = false;
                    }
                    Desired::Allowed => {}
                }

                store.save(&state)?;
            }
        }
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
