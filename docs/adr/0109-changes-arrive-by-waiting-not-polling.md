# ADR-0109: Changes arrive by waiting, not polling, and a new device receives the heads

Date: 2026-10-11. Status: accepted. Builds on
[ADR-0049](0049-accounts-synchronise-ciphertext-without-hosting-inference.md)
and [ADR-0018](0018-ios-background-work-is-durable-rows.md).

## Context

The other half of the 2026-10-11 report: the synchronisation "took time". The
account service had no channel towards the devices, so each one asked
`GET /api/v1/sync` every five seconds whatever happened, and a local edit
waited for the next tick. A pass then sent one operation per request, with a
new TLS handshake per request, received at most ten pages of a hundred, and
moved one megabyte of file in each direction. A new device replayed the whole
history, every retired revision included. The resume sweep on the phone ran
the synchronisation last, after the search index and the embeddings.

## Decision

1. **The service holds a request until there is something new.**
   `GET /api/v1/sync/wait?after=N` answers `{changed:true}` as soon as the
   account's sequence passes `N`, else `{changed:false}` after twenty
   seconds. It is woken by `append` in the same process and re-reads the
   database every five seconds as insurance. It does not take one of the
   sixteen request slots: waiting is not work, and a family of devices must
   not starve a push. It is rate-limited like every route. Old clients never
   call it; a new client that gets a 404 polls at the old cadence until its
   next launch.
2. **One driver per device, woken rather than ticking.** A waiter task holds
   on the service and pokes the driver when the answer is `changed`; a
   two-second tick looks at SQLite only and pokes when something waits to
   leave; the resume sweep, enabling sync, a restore and "Sync now" poke
   too; and the driver runs by itself once a minute for the bookkeeping a
   pass also does (balance, usage, inventory). Wake-ups coalesce. A wake-up
   that moves nothing backs off, so a pass that cannot run is not a tight
   loop, and the backoff is dropped when the app comes back to the
   foreground, because a request cut by a suspension was refused by nobody.
   The waiter never holds a background-task guard.
3. **A push is a batch.** Up to fifty rows, under four MiB, sealed in one
   transaction and sent in one request; a refused batch is sent row by row,
   so the one row the service objects to is parked (`sync_parent_unknown`,
   re-sealed against the current head on retry) and the others leave. One
   HTTP client reaches the service, and keeps its connection across the
   pushes, pages and chunks of a pass.
4. **A new library asks for the heads.** `GET /api/v1/sync?after=0&heads=1`
   returns the current heads, the direct parents of the heads of an object
   with several (a merge needs its ancestor) and the direct parent of each
   tombstone head (what a deletion took is listed from it), and its cursor
   ends at the watermark. A client uses it only when its cursor is zero and
   its inbox is empty.
5. **The file lane fills its budget.** Chunks move until twelve seconds of
   the pass are spent, two in flight for a download, newest audio first, and
   a throttle is retried once rather than parking the file for ten minutes.
6. **The sweep synchronises first.** What the other devices did while this
   one was away is the first thing a resume brings, and the phone's
   lifecycle observer counts an outbox that is not empty as pending work.

## Consequences

- An edit on one device reaches the other within about a second while both
  are in the foreground, and within one pass after the phone resumes.
- An idle device costs the service one held request every twenty seconds
  instead of a query every five.
- A new phone receives one revision per object rather than the history.
- The service needs one in-memory map and one route; nothing in its
  schema changes, and every existing shape stays as it was.
- Held waits have a cap of their own, 256 service-wide, taken after the
  session is checked so an anonymous request holds nothing. Past it a device
  is answered 429 and backs off to polling; that is a scale this deployment
  is nowhere near, and the cap is what keeps a wait from being a way to hold
  the service's memory.
- iOS cannot be pushed to while suspended: that needs notifications and a
  relationship with Apple this service does not have. The phone synchronises
  at the resume, first.

## Alternatives rejected

- **Server-sent events or a WebSocket.** The ingress, the rate limit and the
  session model are built for requests; a held request is one request.
- **A shorter poll.** Cheaper to write, more costly to run, and still a
  worst case of the interval.
- **Serving only heads to every client at every cursor.** Correct for a
  fresh device, wrong for one that has history: it needs the retired
  revisions it has not seen to keep its heads consistent.
- **Four downloads in flight.** The service holds a request slot for the
  whole of a chunk's object-storage read; a phone and a desktop sharing
  sixteen would throttle each other.
