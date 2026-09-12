# Usage reports

**Usage → pick a range → hours per machine.** One page in the dashboard,
one read-only endpoint behind it, no new tables and no new background work.

## What "used" means

The number reported is **how long each machine was actually usable**, not
how much time was granted. Those differ, and the granted figure would
quietly flatter every report.

| Session | Counted as |
|---|---|
| Expired normally | `startedAt` → `expiresAt` |
| Ended early by an operator | `startedAt` → `endedAt` — a 4-hour session ended after 30 minutes counts 30 minutes |
| Still running | `startedAt` → now, capped at `expiresAt` — an 8-hour session started a minute ago counts one minute, not eight hours |

Sessions are **clipped to the window**, not attributed to the day they
started on. A session running 23:00–01:00 puts one hour in each day, so a
range total always equals the sum of its days and a boundary never
double-counts or loses time.

Machines with no usage are listed with zero rather than omitted — "this PC
was not used" is a real answer, and a missing row would hide it.

## Timezones

The browser sends an absolute instant range, not calendar dates. It already
knows the operator's timezone, so "12 September" becomes local midnight to
the next local midnight there, and the server never has to guess a timezone
or get daylight saving wrong to decide which day a session belongs to.

That is also why the API takes `from`/`to` as ISO instants rather than
`date=2026-09-12`: the endpoint has exactly one interpretation, and it is
the caller's.

## The endpoint

```
GET /reports/usage?from=<ISO instant>&to=<ISO instant>
Authorization: Bearer <operator JWT>
```

`[from, to)` — half-open, so consecutive windows tile without overlap.
Rejected with `400` if `to` is not after `from`, if either is not a valid
ISO 8601 instant, or if the range exceeds 366 days (an unbounded range is
the only way this read could get expensive).

```json
{
  "from": "2026-09-11T16:00:00.000Z",
  "to": "2026-09-12T16:00:00.000Z",
  "totalUsedSeconds": 12600,
  "machines": [
    {
      "machineId": "…",
      "name": "Front desk",
      "platform": "WINDOWS",
      "usedSeconds": 12600,
      "sessionCount": 3
    }
  ]
}
```

Sorted busiest first, then by name. Seconds rather than hours: formatting is
a presentation choice, and the dashboard and a CSV want it differently.

## Where the work happens

`api/src/modules/reports/usage.ts` holds the maths as pure functions — no
Prisma, no clock — so every boundary case (ended early, still running,
straddling midnight, entirely outside the window) is unit-tested without a
database. The service does one indexed read of the machines and a filtered
read of the sessions that could possibly overlap, and hands both to it.

The session filter (`startedAt < to AND expiresAt > from`) is deliberately a
*superset*: a session can only have made the machine usable up to
`expiresAt`, so nothing outside it can contribute, and the exact clipping —
including `endedAt` and still-running sessions — happens in one place rather
than being split between SQL and TypeScript.

Nothing here is live. A report is a snapshot of a window you chose; having
the numbers shuffle while you read them would be worse, not better. The
dashboard's machine list stays realtime as before.

## Export

**Export CSV** downloads the current range with usage in **decimal hours** —
a spreadsheet can sum `3.42`, it cannot sum `3h 25m`. Generated in the
browser from data already on screen; there is no export endpoint.

## Not included, on purpose

- **No per-day breakdown or chart.** The clipping function already supports
  it (ask it for one day at a time), but a bar per machine answers the
  question that was actually asked, and a charting library is a dependency
  this project does not need yet.
- **No billing or rates.** Taymna reports time, not money.
- **No per-user attribution.** Taymna's domain is a *machine* with a
  session; it never learns who sat at it.
