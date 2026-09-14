//! WebSocket connection to the Taymna server: authenticates with the
//! machine's credential, sends periodic heartbeats, and forwards parsed
//! `session_state` pushes to the rest of the agent. Reconnects with
//! exponential backoff on any disconnect and keeps retrying forever --
//! there is no notion of "give up", since the whole point of the agent is
//! to keep enforcing locally while disconnected and resync the moment the
//! server is reachable again (docs/offline-expiry.md).
//!
//! Deliberately minimal: the agent only ever sends a heartbeat and (once, on
//! removal) a `decommission_ack`, and the only messages it accepts are
//! `session_state`, `heartbeat_ack`, `decommission` and `error`. The
//! `decommission` message is a bare lifecycle fact -- there is still no generic
//! command channel and nothing the agent would execute; see docs/protocol.md.

use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::session::SessionSnapshot;
use crate::storage::Credentials;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum AgentToServer {
    #[serde(rename = "heartbeat")]
    Heartbeat {
        #[serde(rename = "atMs")]
        at_ms: i64,
        /// This build's version, so the dashboard can show which agent each
        /// machine is running instead of an operator checking `--version` by
        /// hand on every one. A compile-time constant -- the agent reports
        /// what it *is*, and has nothing else to say.
        version: &'static str,
    },
    /// Confirms that the agent has durably un-enrolled and stopped enforcing,
    /// so the server may finalize removal. Sent only after the local
    /// decommissioned state is on disk. Idempotent on the server, so it is
    /// re-sent on every reconnect until the server finalizes (see
    /// docs/enrollment.md "Decommissioning a machine").
    #[serde(rename = "decommission_ack")]
    DecommissionAck,
}

/// Commands from the run loop to this connection task. The run loop owns the
/// durable state file, so it -- not this task -- decides *when* it is safe to
/// acknowledge a decommission (only after persisting it). This channel is how
/// that decision reaches the socket.
#[derive(Debug)]
pub enum ClientCommand {
    /// Begin acknowledging decommission: ack now if connected, and on every
    /// subsequent reconnect, until the server finalizes.
    AckDecommission,
}

/// Custom WebSocket close code the server sends once it has finalized a
/// decommission (deleted the machine). Mirrors the `4003` in
/// RealtimeGateway/MachinesService; tells a decommissioned agent it can stop
/// re-delivering its ack.
const DECOMMISSION_FINALIZED_CODE: u16 = 4003;

/// The server accepts the WebSocket upgrade and only *then* closes with this
/// code if the machine credential is invalid (the gateway cannot 401 the
/// upgrade itself). For a *managed* agent this is just a disconnect to retry
/// (it keeps enforcing meanwhile); for a *decommissioned* agent it means the
/// server already finalized and the row is gone, so it can stop acking.
const INVALID_CREDENTIAL_CODE: u16 = 4001;

/// Stamped from the release tag at build time (see the release workflow);
/// a locally built binary reports the `0.0.0-dev` placeholder.
const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ServerToAgent {
    #[serde(rename = "session_state")]
    SessionState {
        session: Option<SessionSnapshot>,
        #[serde(rename = "serverTime")]
        server_time: DateTime<Utc>,
    },
    #[serde(rename = "heartbeat_ack")]
    HeartbeatAck {
        #[serde(rename = "serverTime")]
        server_time: DateTime<Utc>,
    },
    /// An authenticated instruction to relinquish Taymna control. Carries no
    /// executable payload -- it is a fact, like every other server message.
    /// The server also sends a `serverTime`, but the agent has no use for it
    /// here (decommission is not time-based), so it is simply ignored.
    #[serde(rename = "decommission")]
    Decommission,
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

/// What client.rs hands back to the run loop -- just enough to update state
/// and resync the clock guard; no OS calls happen in here.
#[derive(Debug)]
pub enum ServerEvent {
    SessionState {
        session: Option<SessionSnapshot>,
        message_time: DateTime<Utc>,
    },
    ServerTime(DateTime<Utc>),
    /// The server has instructed this machine to relinquish control. The run
    /// loop must persist the decommissioned state *before* the ack is sent.
    Decommission,
}

/// How a single connection ended, so `run` can tell "the server finalized our
/// decommission, stop" from "the link dropped, reconnect".
enum Outcome {
    /// The connection ended normally (or the stream closed); reconnect.
    Disconnected,
    /// The server closed with the decommission-finalized code: our identity is
    /// gone, there is nothing left to do. Stop.
    Finalized,
}

pub async fn run(
    credentials: Credentials,
    events_tx: mpsc::UnboundedSender<ServerEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<ClientCommand>,
) {
    let ws_url = to_ws_url(&credentials.server_url);
    let mut backoff = MIN_BACKOFF;
    // Once true (the run loop has accepted a decommission and told us to ack),
    // stays true: we ack on this and every future connect until the server
    // finalizes. Retained across reconnects here rather than in the state file
    // -- the *durable* record of decommission is the run loop's job; this is
    // only "keep re-delivering the ack for this process's lifetime".
    let mut ack_decommission = false;

    loop {
        match connect_and_serve(
            &ws_url,
            &credentials,
            &events_tx,
            &mut cmd_rx,
            &mut ack_decommission,
        )
        .await
        {
            Ok(Outcome::Finalized) => {
                info!("decommission finalized by server; connection task stopping");
                return;
            }
            Ok(Outcome::Disconnected) => {
                // Clean close -- still reconnect, the server may just have restarted.
                backoff = MIN_BACKOFF;
            }
            Err(err) => {
                // Any connection/transport error -- DNS, TLS, timeout, a proxy
                // 5xx, the server being down -- is always retried, for managed
                // and decommissioned agents alike. A managed agent keeps
                // enforcing from local state meanwhile, so breaking connectivity
                // can never release a machine; a decommissioned agent simply has
                // not delivered its ack yet. The only signals that stop the loop
                // are the authenticated close codes handled in connect_and_serve.
                warn!(%err, backoff_secs = backoff.as_secs(), "WebSocket connection lost, retrying");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}

async fn connect_and_serve(
    ws_url: &str,
    credentials: &Credentials,
    events_tx: &mpsc::UnboundedSender<ServerEvent>,
    cmd_rx: &mut mpsc::UnboundedReceiver<ClientCommand>,
    ack_decommission: &mut bool,
) -> anyhow::Result<Outcome> {
    let mut request = ws_url.into_client_request()?;
    let auth_value = format!(
        "Machine {}.{}",
        credentials.machine_id, credentials.machine_secret
    );
    request
        .headers_mut()
        .insert("Authorization", HeaderValue::from_str(&auth_value)?);

    let (stream, _response) = tokio_tungstenite::connect_async(request).await?;
    info!("connected to Taymna server");
    let (mut write, mut read) = stream.split();

    // Pick up any ack command that arrived while we were disconnected, so the
    // ack goes out on this connect rather than waiting for the next one.
    while let Ok(cmd) = cmd_rx.try_recv() {
        match cmd {
            ClientCommand::AckDecommission => *ack_decommission = true,
        }
    }
    if *ack_decommission {
        send_decommission_ack(&mut write).await?;
    }

    let mut heartbeat_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat_interval.tick().await; // first tick fires immediately; skip it, we greet below instead

    // The first heartbeat waits for the server's first message instead of
    // going out the instant the socket opens. The server attaches its
    // message listener a tick after the upgrade and buffers nothing, so a
    // heartbeat sent immediately is silently dropped. That used to cost
    // nothing -- the server records a heartbeat on connect anyway -- but the
    // heartbeat now also carries this agent's version, which would otherwise
    // not reach the dashboard for a full interval after every reconnect.
    // `session_state` is pushed on every connect, so this always fires.
    let mut greeted = false;

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                let heartbeat = AgentToServer::Heartbeat {
                    at_ms: Utc::now().timestamp_millis(),
                    version: AGENT_VERSION,
                };
                write.send(Message::text(serde_json::to_string(&heartbeat)?)).await?;
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(ClientCommand::AckDecommission) => {
                        // The run loop has durably recorded the decommission;
                        // only now is it safe to tell the server. Keep acking
                        // on future reconnects until the server finalizes.
                        *ack_decommission = true;
                        send_decommission_ack(&mut write).await?;
                    }
                    // The run loop dropped the command sender -- it is shutting
                    // down, and so are we.
                    None => return Ok(Outcome::Disconnected),
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_message(&text, events_tx);
                        if !greeted {
                            greeted = true;
                            let hello = AgentToServer::Heartbeat {
                                at_ms: Utc::now().timestamp_millis(),
                                version: AGENT_VERSION,
                            };
                            write.send(Message::text(serde_json::to_string(&hello)?)).await?;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        // Finalized: our decommission is complete, the row is
                        // gone -- stop.
                        if code == Some(DECOMMISSION_FINALIZED_CODE) {
                            return Ok(Outcome::Finalized);
                        }
                        // A decommissioned agent whose credential is now rejected
                        // means the server already finalized (we missed the 4003,
                        // e.g. the ack's connection dropped and we reconnected):
                        // stop re-delivering the ack. A *managed* agent seeing
                        // 4001 falls through to reconnect and keeps enforcing --
                        // a rejected credential never releases a managed machine.
                        if *ack_decommission && code == Some(INVALID_CREDENTIAL_CODE) {
                            return Ok(Outcome::Finalized);
                        }
                        warn!(?frame, "server closed the connection");
                        return Ok(Outcome::Disconnected);
                    }
                    Some(Ok(_)) => {} // ping/pong/binary: nothing to do
                    Some(Err(err)) => return Err(err.into()),
                    None => return Ok(Outcome::Disconnected),
                }
            }
        }
    }
}

/// Sends a decommission acknowledgement. Generic over the sink so it does not
/// have to name the split WebSocket write half's concrete type.
async fn send_decommission_ack<S>(write: &mut S) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let ack = AgentToServer::DecommissionAck;
    write
        .send(Message::text(serde_json::to_string(&ack)?))
        .await?;
    Ok(())
}

fn handle_message(text: &str, events_tx: &mpsc::UnboundedSender<ServerEvent>) {
    let message: ServerToAgent = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(err) => {
            warn!(%err, "received a message that doesn't match the protocol, ignoring");
            return;
        }
    };

    let event = match message {
        ServerToAgent::SessionState {
            session,
            server_time,
        } => {
            let message_time = session
                .as_ref()
                .map(|s| s.updated_at)
                .unwrap_or(server_time);
            Some(ServerEvent::SessionState {
                session,
                message_time,
            })
        }
        ServerToAgent::HeartbeatAck { server_time } => Some(ServerEvent::ServerTime(server_time)),
        ServerToAgent::Decommission => Some(ServerEvent::Decommission),
        ServerToAgent::Error { code, message } => {
            warn!(code, message, "server reported an error");
            None
        }
    };

    if let Some(event) = event {
        let _ = events_tx.send(event);
    }
}

fn to_ws_url(server_url: &str) -> String {
    let base = server_url.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}/ws")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}/ws")
    } else {
        format!("wss://{base}/ws")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_decommission_message_into_an_event() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle_message(
            r#"{"type":"decommission","serverTime":"2026-01-01T00:00:00Z"}"#,
            &tx,
        );
        assert!(matches!(rx.try_recv(), Ok(ServerEvent::Decommission)));
    }

    #[test]
    fn decommission_ack_serializes_to_the_expected_wire_shape() {
        let json = serde_json::to_string(&AgentToServer::DecommissionAck).unwrap();
        assert_eq!(json, r#"{"type":"decommission_ack"}"#);
    }

    #[test]
    fn converts_https_to_wss() {
        assert_eq!(
            to_ws_url("https://taymna.example.com"),
            "wss://taymna.example.com/ws"
        );
    }

    #[test]
    fn converts_http_to_ws() {
        assert_eq!(to_ws_url("http://localhost:3000"), "ws://localhost:3000/ws");
    }

    #[test]
    fn strips_a_trailing_slash() {
        assert_eq!(
            to_ws_url("http://localhost:3000/"),
            "ws://localhost:3000/ws"
        );
    }

    #[test]
    fn defaults_to_wss_when_no_scheme_is_given() {
        assert_eq!(
            to_ws_url("taymna.example.com"),
            "wss://taymna.example.com/ws"
        );
    }
}
