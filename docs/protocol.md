# WebSocket protocol

One gateway, path `/ws`, two kinds of authenticated client. The envelope is
always `{ "type": "...", ...payload }` -- flat JSON, no framing library
needed on either side.

## Authentication

- **Agent**: sent as an HTTP header on the WebSocket upgrade request:
  `Authorization: Machine <machineId>.<machineSecret>` (same `id.secret`
  shape as the enrollment token -- see [enrollment.md](enrollment.md)).
  Verified against the machine's stored credential hash before the upgrade
  completes.
- **Operator** (web dashboard): sent as a query parameter,
  `wss://.../ws?token=<jwt>` -- browsers cannot set custom headers on a
  WebSocket handshake, so this is the only option for that client.

## Agent -> Server

```json
{ "type": "heartbeat", "atMs": 1732000000000 }
```

Sent every ~20 seconds. The server updates the machine's `lastSeenAt` and
acknowledges.

That's the **entire** set of messages the agent ever sends. There is no
"report status", no "request command", nothing else.

## Server -> Agent

Sent immediately on successful authentication, and again every time the
machine's session starts, extends, or ends:

```json
{
  "type": "session_state",
  "session": {
    "id": "...",
    "startedAt": "2026-01-01T10:00:00.000Z",
    "expiresAt": "2026-01-01T18:00:00.000Z",
    "status": "ACTIVE",
    "updatedAt": "2026-01-01T10:00:00.000Z"
  },
  "serverTime": "2026-01-01T10:00:00.100Z"
}
```

`session` is `null` when the machine has no active session. Heartbeats are
acknowledged with:

```json
{ "type": "heartbeat_ack", "serverTime": "2026-01-01T10:00:20.000Z" }
```

and auth/protocol problems with:

```json
{ "type": "error", "code": "...", "message": "..." }
```

**This is the complete set of messages the agent can receive.** There is
deliberately no message type that carries a command, a shell string, or
anything the agent would execute -- only facts about session state. This is
a structural guarantee, not a convention: the agent's message parser
(`agent/src/client.rs`) only knows how to deserialize these three shapes.

### Stale-message protection

Every `session_state` message carries a timestamp: the session's own
`updatedAt` when a session is present, or `serverTime` when it's `null`. The
agent remembers the timestamp of the last message it *applied* and ignores
any incoming message whose timestamp is not strictly newer. This stops a
reordered or duplicate message (possible over a flaky connection, or right
after a reconnect racing a fresh push) from reverting the agent to older
state. See `session::apply_server_message` in the agent and
[offline-expiry.md](offline-expiry.md) for the full reasoning.

## Server -> Operator

Broadcast to every connected, authenticated operator socket (no per-machine
rooms -- self-hosted deployments are small enough that this is simpler and
still cheap):

```json
{ "type": "machine_updated", "machineId": "...", "online": true, "lastSeenAt": "..." }
{ "type": "session_updated", "machineId": "...", "session": { ... } | null }
```

The dashboard applies these directly to its local cache (no refetch), and
computes remaining time client-side from `expiresAt` -- see the "Web
dashboard" section of the README. Nobody polls anybody.
