mod client;
mod platform;
mod session;
mod storage;
mod warning;

use clap::{Parser, Subcommand};
use platform::{Enforcement, UserNotifier};
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
                match windows_service_support::try_run_as_service() {
                    Ok(()) => return Ok(()),
                    // This is the *expected* path for an interactive run
                    // (cargo run, double-click) -- but if it's unexpectedly
                    // hit for a real `sc.exe start`, this is exactly why
                    // SCM sees nothing and times out ("waiting for the
                    // service to connect"), so it's worth a permanent
                    // record of *why* the handshake never happened rather
                    // than silently falling through.
                    Err(err) => windows_service_support::log_dispatch_failure(&err),
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

    /// Independent of tracing (nothing is initialized yet at the call site
    /// in main()) -- a raw, best-effort record of why the SCM handshake
    /// itself never happened, for the one case that actually matters: a
    /// real `sc.exe start` where this shouldn't have failed at all.
    pub fn log_dispatch_failure(err: &windows_service::Error) {
        let dir = crate::storage::default_state_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("service_dispatch.log"))
        {
            use std::io::Write;
            let _ = writeln!(
                file,
                "{} -- did not connect to the Service Control Manager: {err}",
                chrono::Utc::now()
            );
        }
    }

    /// Writes any panic, from anywhere in the process, to panic.log -- set
    /// up before anything else in run_service() so that even a panic during
    /// early setup (before tracing itself is ready) leaves a real trace on
    /// disk instead of a bare, undiagnosable SCM timeout. Independent of
    /// the tracing subscriber on purpose: this must not depend on the thing
    /// it exists to catch failures in.
    fn install_panic_log(dir: &std::path::Path) {
        let path = dir.join("panic.log");
        std::panic::set_hook(Box::new(move |info| {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = writeln!(file, "{} -- {info}", chrono::Utc::now());
            }
        }));
    }

    /// Same resolution `Store` uses (TAYMNA_STATE_DIR, or the OS-appropriate
    /// data dir) so the log file lands next to state.json -- one place to
    /// look, not two.
    fn init_file_tracing(dir: &std::path::Path) {
        let file_appender = tracing_appender::rolling::never(dir, "agent.log");
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
        let dir = crate::storage::default_state_dir();
        let _ = std::fs::create_dir_all(&dir);
        install_panic_log(&dir);
        init_file_tracing(&dir);
        tracing::info!("windows service starting");

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
        tracing::info!("registered service control handler");

        status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })?;
        tracing::info!("reported SERVICE_RUNNING to the Service Control Manager");

        let result: anyhow::Result<()> = (|| {
            let rt = tokio::runtime::Runtime::new()?;
            let store = Store::new(None)?;
            rt.block_on(run(store, Some(stop_rx)))
        })();

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

    use anyhow::Context as _;

    let url = format!("{}/machines/enroll", server.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "token": token }))
        .send()
        .await
        .with_context(|| {
            format!(
                "could not reach {server} -- is the API running and reachable from this machine?"
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        // The API answers with a JSON envelope whose `message` is the
        // human-readable reason (e.g. "Enrollment token is invalid, used, or
        // expired"); surface that alone rather than the whole envelope.
        let reason = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str().map(str::to_owned)))
            .unwrap_or(body);
        anyhow::bail!("enrollment rejected by {server} ({status}): {reason}");
    }

    let parsed: EnrollResponse = response.json().await?;

    let mut state = store.load()?;
    state.credentials = Some(Credentials {
        server_url: server,
        machine_id: parsed.machine_id.clone(),
        machine_secret: parsed.machine_secret,
    });
    // A fresh enrollment is a clean slate: a previously decommissioned machine
    // becomes managed again, and no stale session from a prior identity carries
    // over. The anti-rollback high-water mark is intentionally preserved (it
    // must never move backward, even across re-enrollment).
    state.decommissioned = false;
    state.session = None;
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
        if state.decommissioned {
            // Decommissioned with no credential left to acknowledge with:
            // nothing to do but stay inert. Critically, this path never
            // enforces -- a service restart after decommission does not lock.
            info!("machine is decommissioned; agent is inert");
            wait_for_shutdown(external_stop).await;
            return Ok(());
        }
        anyhow::bail!(
            "this machine is not enrolled yet -- run `taymna-agent enroll --server <url> --token <token>` first"
        );
    };

    let enforcement = platform::current();
    let mut clock = storage::ClockGuard::new(state.trusted_high_water_mark);
    let mut currently_blocked = true; // start pessimistic: assume blocked until proven otherwise

    // Expiry warnings are decided in the tick below and *delivered* here,
    // on a thread of their own. Putting a channel in between is what makes
    // "a warning failure can never delay locking" structural rather than
    // careful: showing a notification means launching a process in somebody
    // else's desktop session, which can block for seconds, fail, or panic,
    // and none of that can reach the loop that enforces expiry. If this
    // thread dies, sends simply stop being delivered. See
    // docs/expiry-warnings.md.
    let (warnings_tx, warnings_rx) = std::sync::mpsc::channel::<warning::WarningEffect>();
    let warnings_thread = std::thread::spawn(move || {
        let notifier = platform::notifier();
        for effect in warnings_rx {
            warning::apply(&notifier, &effect);
        }
        // The channel closing means the agent is stopping: never leave a
        // countdown on screen for a session nothing is watching any more.
        notifier.dismiss_final_warning();
    });
    let mut warnings = warning::ExpiryWarnings::new();

    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    // Lets the run loop tell the client *when* it is safe to acknowledge a
    // decommission -- only after this loop has persisted it (see
    // accept_decommission). The run loop owns the state file; the client owns
    // the socket.
    let (client_cmd_tx, client_cmd_rx) = mpsc::unbounded_channel();
    tokio::spawn(client::run(credentials, events_tx, client_cmd_rx));

    // Once true, this enrollment has relinquished control and must never
    // enforce again. Seeded from the persisted flag (the ack-lost-then-restart
    // race: we accepted a decommission, restarted before finalization, and
    // must not lock while re-delivering the ack) and set when a decommission
    // arrives mid-run.
    let mut decommissioned = state.decommissioned;
    if decommissioned {
        info!("machine is decommissioned; agent will not enforce, re-delivering acknowledgement");
        let _ = client_cmd_tx.send(client::ClientCommand::AckDecommission);
    }
    // The client task can now legitimately end (once the server finalizes),
    // so the events branch is disabled rather than spun on when it does.
    let mut events_closed = false;

    let mut ticker = tokio::time::interval(TICK_INTERVAL);
    let mut shutdown = std::pin::pin!(wait_for_shutdown(external_stop));

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                info!("shutting down");
                store.save(&state)?;
                break;
            }
            event = events_rx.recv(), if !events_closed => {
                match event {
                    Some(client::ServerEvent::Decommission) => {
                        // Idempotent: a duplicate decommission (a reconnect
                        // re-delivery, say) is a no-op once already accepted;
                        // the client re-acks on its own.
                        if !decommissioned {
                            accept_decommission(&store, &mut state, &warnings_tx, &client_cmd_tx)?;
                            decommissioned = true;
                        }
                    }
                    // Once decommissioned, the local state is the gate: no
                    // session message belonging to the old enrollment may
                    // restore management, so these are ignored outright.
                    Some(client::ServerEvent::SessionState { session, message_time })
                        if !decommissioned =>
                    {
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
                    Some(client::ServerEvent::ServerTime(server_time)) if !decommissioned => {
                        clock.resync_from_server(server_time);
                        state.trusted_high_water_mark = clock.high_water_mark();
                    }
                    // A stale session/time event arriving after decommission.
                    Some(_) => {}
                    None => {
                        events_closed = true;
                        if decommissioned {
                            info!("connection task ended after decommission");
                        } else {
                            // The client only exits if its sender is dropped,
                            // which (outside decommission) means it panicked.
                            warn!("connection task ended unexpectedly");
                        }
                    }
                }
            }
            _ = ticker.tick() => {
                if decommissioned {
                    // Inert: enforcement has been relinquished. Deliberately no
                    // disable_usage() (never re-lock), no enable_usage(), no
                    // warnings, nothing to persist.
                    continue;
                }
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

                // Only now, with enforcement already applied, is the user
                // told anything -- from the same session snapshot and the
                // same trusted clock reading the decision above used, so
                // there is no second timing authority and nothing to keep
                // in sync.
                for effect in warnings.reconcile(state.session.as_ref(), trusted_now) {
                    // A handful of lines per session, and the only record
                    // that the user was (meant to be) warned -- worth having
                    // when someone reports "it locked with no warning".
                    info!(?effect, "expiry warning");
                    let _ = warnings_tx.send(effect);
                }

                store.save(&state)?;
            }
        }
    }

    drop(warnings_tx);
    let _ = warnings_thread.join();
    Ok(())
}

/// Accepts an authenticated decommission: durably records the terminal state
/// and stops enforcement, *then* clears the acknowledgement to be sent.
///
/// The ordering is the crux of the whole design. The decommissioned flag and
/// the cleared session are persisted BEFORE the server is acknowledged, so a
/// crash, reboot or network loss in the gap between accepting and the ack
/// reaching the server can never resurrect enforcement: the agent that comes
/// back up reads `decommissioned = true` and stays inert, and the ack is
/// re-delivered safely on the next connect.
fn accept_decommission(
    store: &Store,
    state: &mut storage::AgentState,
    warnings_tx: &std::sync::mpsc::Sender<warning::WarningEffect>,
    client_cmd_tx: &mpsc::UnboundedSender<client::ClientCommand>,
) -> anyhow::Result<()> {
    state.decommissioned = true;
    state.session = None;
    store.save(state)?;
    info!("decommission accepted; Taymna will no longer manage this machine");

    // Take down any final-warning countdown that may be on screen, and stop
    // warning. A notification failure here cannot block anything -- it is a
    // fire-and-forget send to the (isolated, fallible) warnings thread.
    let _ = warnings_tx.send(warning::WarningEffect::DismissFinalWarning);

    // Only now is it safe to let the server finalize removal.
    let _ = client_cmd_tx.send(client::ClientCommand::AckDecommission);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use session::{SessionSnapshot, SessionStatus};
    use storage::AgentState;

    #[test]
    fn accept_decommission_persists_the_terminal_state_before_acking() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(Some(dir.path().to_path_buf())).unwrap();

        let mut state = AgentState {
            credentials: Some(Credentials {
                server_url: "https://example.com".into(),
                machine_id: "m1".into(),
                machine_secret: "s".into(),
            }),
            session: Some(SessionSnapshot {
                id: "session-1".into(),
                started_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::minutes(30),
                status: SessionStatus::Active,
                updated_at: Utc::now(),
            }),
            ..AgentState::default()
        };
        store.save(&state).unwrap();

        let (warnings_tx, warnings_rx) = std::sync::mpsc::channel();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();

        accept_decommission(&store, &mut state, &warnings_tx, &cmd_tx).unwrap();

        // The terminal state is durable on disk -- readable independently of
        // the ack, which is exactly what the restart-before-finalize path
        // relies on: the fact is written before the server is ever told.
        let persisted = store.load().unwrap();
        assert!(persisted.decommissioned, "decommissioned must be persisted");
        assert!(
            persisted.session.is_none(),
            "session must be cleared on disk"
        );
        // The credential is retained, solely so the ack can be re-delivered.
        assert!(persisted.credentials.is_some());

        // In-memory state matches, enforcement can no longer key off a session.
        assert!(state.decommissioned);
        assert!(state.session.is_none());

        // A final-warning dismissal was emitted, and the ack was queued for the
        // client to deliver (after -- not before -- the persist above).
        assert_eq!(
            warnings_rx.try_recv(),
            Ok(warning::WarningEffect::DismissFinalWarning),
        );
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(client::ClientCommand::AckDecommission),
        ));
    }
}
