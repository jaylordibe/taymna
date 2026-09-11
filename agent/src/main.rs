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

// Not `#[tokio::main]`: a Windows service must call the synchronous,
// blocking StartServiceCtrlDispatcherW handshake on its own thread *before*
// any tokio runtime exists (see windows_service_support below), so main()
// stays plain and only starts a runtime once it knows which path it's on.
fn main() -> anyhow::Result<()> {
    match Cli::parse().command.unwrap_or(Command::Run) {
        Command::Enroll { server, token } => {
            init_stdout_tracing();
            let store = Store::new(None)?;
            tokio::runtime::Runtime::new()?.block_on(enroll(&store, server, token))
        }
        Command::Run => {
            #[cfg(windows)]
            {
                // Succeeds only when this process was actually launched *by*
                // the Service Control Manager (e.g. `sc.exe start`), and
                // doesn't return until the service has fully stopped. Fails
                // immediately otherwise -- interactively, `cargo run`,
                // double-click -- so we fall through to running in the
                // foreground below, keeping that usage unchanged. Tracing
                // is deliberately not initialized until we're past this
                // branch: the service path needs a file writer (no console
                // is attached to a service), which windows_service_support
                // sets up itself once it's certain that's the path taken.
                if windows_service_support::try_run_as_service().is_ok() {
                    return Ok(());
                }
            }
            init_stdout_tracing();
            let store = Store::new(None)?;
            tokio::runtime::Runtime::new()?.block_on(run(store, None))
        }
    }
}

fn init_stdout_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

#[cfg(windows)]
mod windows_service_support {
    //! Windows Service Control Manager integration. `sc.exe start` blocks
    //! waiting for the process to report SERVICE_RUNNING via this exact
    //! handshake; without it, start fails with error 1053 ("service did not
    //! respond in a timely fashion") even though the process is running
    //! fine -- it's just not running fine *as a service*.
    use super::{run, Store};
    use std::ffi::OsString;
    use std::time::Duration;
    use tokio::sync::oneshot;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    /// Must match the name `sc.exe create` registers (docs/agent-install.md).
    const SERVICE_NAME: &str = "TaymnaAgent";
    const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

    pub fn try_run_as_service() -> windows_service::Result<()> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
    }

    /// Same resolution `Store` uses (TAYMNA_STATE_DIR, or the OS-appropriate
    /// data dir) so the log file lands next to state.json -- one place to
    /// look, not two.
    fn init_file_tracing() {
        let dir = crate::storage::default_state_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return; // nowhere to log to; better to keep running than panic
        }
        let file_appender = tracing_appender::rolling::never(&dir, "agent.log");
        // A logging setup failure shouldn't take the whole service down --
        // the agent's actual job (enforcing the session) doesn't depend on
        // it, so this is intentionally swallowed rather than `?`/unwrap'd.
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                super::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| super::EnvFilter::new("info")),
            )
            .with_writer(file_appender)
            .with_ansi(false)
            .try_init();
    }

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_arguments: Vec<OsString>) {
        if let Err(err) = run_service() {
            tracing::error!(?err, "windows service exited with an error");
        }
    }

    fn run_service() -> windows_service::Result<()> {
        init_file_tracing();

        let (stop_tx, stop_rx) = oneshot::channel();
        let mut stop_tx = Some(stop_tx);

        let event_handler = move |control_event| -> ServiceControlHandlerResult {
            match control_event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    // SCM may deliver more than one stop-ish event; the
                    // channel can only be sent on once.
                    if let Some(tx) = stop_tx.take() {
                        let _ = tx.send(());
                    }
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };

        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;
        status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })?;

        let result = tokio::runtime::Runtime::new()
            .expect("failed to start tokio runtime")
            .block_on(async {
                let store = Store::new(None)?;
                run(store, Some(stop_rx)).await
            });

        if let Err(err) = &result {
            tracing::error!(?err, "agent loop exited with an error");
        }

        status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })?;

        Ok(())
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

async fn run(
    store: Store,
    external_stop: Option<tokio::sync::oneshot::Receiver<()>>,
) -> anyhow::Result<()> {
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
    let mut shutdown = std::pin::pin!(wait_for_shutdown(external_stop));

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

/// Waits for whichever comes first: Ctrl+C/SIGTERM, or (only when running as
/// a Windows service) SCM asking us to stop -- either way resolving through
/// the same graceful path in `run()`'s select loop, so state is always
/// saved before exit regardless of who asked.
async fn wait_for_shutdown(external_stop: Option<tokio::sync::oneshot::Receiver<()>>) {
    match external_stop {
        Some(rx) => {
            tokio::select! {
                _ = shutdown_signal() => {}
                _ = rx => {}
            }
        }
        None => shutdown_signal().await,
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
