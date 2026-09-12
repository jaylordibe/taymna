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
  ],
  "sessions": [
    {
      "machineId": "…",
      "startedAt": "2026-09-12T01:00:00.000Z",
      "endedAt": "2026-09-12T03:00:00.000Z",
      "status": "EXPIRED",
      "usedSeconds": 7200
    }
  ]
}
```

Machines are sorted busiest first, then by name; sessions newest first.
Seconds rather than hours: formatting is a presentation choice, and the
dashboard and a CSV want it differently.

`sessions` carries the rows behind the totals. `startedAt`/`endedAt` are the
session's **real** bounds -- so a history row reads honestly even for a
session that began before the window -- while `usedSeconds` is clipped to the
window, so the rows always add up to the machine total. It is returned with
the summary rather than from a second endpoint because the dashboard needs it
for two things at once, and because bucketing into local days has to happen
in the browser anyway (below).

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

## By day

Below the per-machine list, a range of 2–31 days is also broken down by day,
including days with no usage — a gap is information, a missing row is a
mystery. A single day has nothing to break down, and beyond about a month a
bar-per-day stops being readable on a phone.

The bucketing happens in the browser, from the `sessions` the report already
returned, for the same reason the range does: local midnights are a timezone
question and the browser is the only place that knows the answer. Every
boundary comes from local-time date maths rather than from adding 24 hours,
so the two days a year that are 23 or 25 hours long still land in exactly one
bucket each.

## Session detail

Each machine row expands to show the sessions behind its total: when the
session ran, how much of it counted toward this window, and how it finished —
**ran to the end**, **ended early**, or **running**. That last distinction is
the one the totals depend on, so it is worth being able to see.

This is also the answer to "what happened on PC-02 yesterday": set the range
to yesterday and expand the machine.

## Export

**Export CSV** downloads the current range with usage in **decimal hours** —
a spreadsheet can sum `3.42`, it cannot sum `3h 25m`. Generated in the
browser from data already on screen; there is no export endpoint.

## Not included, on purpose

- **No charting library.** The bars are two divs. One relative magnitude per
  row is all there is to show, and it reads fine on a phone.
- **No daily breakdown beyond 31 days.** The maths handles any range; the
  screen does not.
- **No billing or rates.** Taymna reports time, not money.
- **No per-user attribution.** Taymna's domain is a *machine* with a
  session; it never learns who sat at it.
