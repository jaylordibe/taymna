//! WebSocket connection to the Taymna server: authenticates with the
//! machine's credential, sends periodic heartbeats, and forwards parsed
//! `session_state` pushes to the rest of the agent. Reconnects with
//! exponential backoff on any disconnect and keeps retrying forever --
//! there is no notion of "give up", since the whole point of the agent is
//! to keep enforcing locally while disconnected and resync the moment the
//! server is reachable again (docs/offline-expiry.md).
//!
//! Deliberately minimal: the only message the agent ever sends is a
//! heartbeat, and the only messages it accepts are `session_state`,
//! `heartbeat_ack` and `error` -- there is no generic command channel here.

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
}

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
}

pub async fn run(credentials: Credentials, events_tx: mpsc::UnboundedSender<ServerEvent>) {
    let ws_url = to_ws_url(&credentials.server_url);
    let mut backoff = MIN_BACKOFF;

    loop {
        match connect_and_serve(&ws_url, &credentials, &events_tx).await {
            Ok(()) => {
                // Clean close -- still reconnect, the server may just have restarted.
                backoff = MIN_BACKOFF;
            }
            Err(err) => {
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
) -> anyhow::Result<()> {
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
                        warn!(?frame, "server closed the connection");
                        return Ok(());
                    }
                    Some(Ok(_)) => {} // ping/pong/binary: nothing to do
                    Some(Err(err)) => return Err(err.into()),
                    None => return Ok(()),
                }
            }
        }
    }
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
