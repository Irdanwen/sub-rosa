---
status: accepted
date: 2026-07-25
---

# A session's activity comes from the runtime, not from the shape of its transcript

## Addendum — 2026-07-25 (accepted; work that outlives a turn is shown)

The two addenda below make the app stop lying about whether a turn is running.
This one addresses what it was not saying at all.

Since v1.27.0 the soul note tells the agent to put long work (big batches, long
builds, repeated API calls) into a background process with `notify_on_complete`,
say what is running, and **end its turn** — the gateway wakes it when the
process finishes. That is the right shape for long work, and it means a settled
turn is no longer the same thing as an idle session. The app rendered them
identically: a finished turn, an idle composer, nothing anywhere saying a
two-hour job was still going. Users re-prompted to find out whether anything was
happening, which is the behaviour the soul note exists to remove.

**Decision:** track background processes per session
(`hermes-background-processes.ts`, fed from the live subscription) and keep a
notice up while any is running — the only composer notice that stays while the
composer is idle, because it is the only one about work rather than about the
message being typed. When the last one finishes, it says so until the chained
turn announces itself, covering the gap where the agent looks most abandoned.
ADR-0012's interrupted notice yields to it: a turn that parked a job and ended
is waiting, not cut off, and inviting a retry there would duplicate the work.

The store is deliberately tolerant about frame shapes. The runtime is pinned but
its background payloads are not part of the contract June freezes, so each field
is looked up under several plausible names and a process is tracked only when
one of them identifies it. An unrecognized shape yields no notice — never a
wrong one. It also keys by the **stored** session id supplied by the caller, not
the runtime id the frames carry, because that is the identity every UI surface
looks up.

## Addendum — 2026-07-25 (accepted; one resolver for the live runtime id, with eviction)

Every RPC a session makes is keyed by its **runtime** session id, not the stored
one, and the app memoizes that mapping. Four call sites each inlined the same
`cached ?? session.resume` resolution and **none of them evicted the memo when
it went stale**. A runtime dies between turns routinely (Hermes restarted, the
process reaped, the machine slept); the gateway then answers `Session not
found`, the memo was left in place, and every later send in that conversation
failed identically until the app was restarted. The user saw the raw wire text
("Hermes API returned 404 … Session not found") in a banner and, on top of it, a
desktop notification about a message that never left the app.

**Decision:** one `resolveRuntimeSession(storedSessionId, gateway, options)` owns
the mapping — memo, resume, eviction — and returns the gateway that answered
alongside the id. The send path replays a turn once against a freshly resolved
runtime when `prompt.submit` reports the session gone (re-applying `beforePrompt`
state and re-attaching images, both of which lived in the dead process). A
failure that survives that becomes one actionable sentence, and its status is
marked `silent` so no notification repeats what the composer already says.

A resume that 404s is retried once on the **sandboxed** runtime when the session
is recorded as Unrestricted: each mode runs its own Hermes process with its own
session store, so a mis-recorded mode is otherwise permanently unreachable. The
fallback is deliberately one-directional. Resuming a *sandboxed* session on the
Unrestricted runtime would silently widen its write access, and the mode map's
whole design is that absence means sandboxed — recovering a session is not worth
escalating what it may write.

## Addendum — 2026-07-25 (accepted; the live subscription outlives the turn)

The decision above stops the app from *ending* a run too early. The same
investigation surfaced the mirror problem: the app also stopped *listening* too
early, so runs it had no part in starting were invisible.

`attachHermesSessionEventListener` detached its gateway subscription on the
first terminal frame, and `background.complete` was classified as terminal. Both
made sense when a turn could only start from June's own `prompt.submit`. That
stopped being true:

- the gateway's notification poller chains a fresh turn when a background
  process finishes — which is exactly what the v1.27.0 soul note tells the agent
  to do with any long task, so this is now the normal shape of long work;
- the `/goal` loop continues a turn after its post-turn judge;
- a scheduled routine runs one on its own.

Every one of those arrived after the subscription was gone. Worse, the
background frame that *announced* the wake-up was the frame that tore the
subscription down and marked the session finished. With the run settled, the
2.5s poll was not running either, so nothing refreshed the session at all: the
conversation froze until the user typed something — the reported "the chat stops
and I have to keep restarting it".

**Decision:**

- `background.*` is not a turn boundary. It is classified as `lifecycle` (not
  `unsupported`, which would raise an "unknown event" notice for a frame June
  acts on) and carries no session status of its own — the chained turn announces
  itself with its own `message.start`.
- The subscription is scoped to the **session**, not to the turn. It is replaced
  by the next submit (each attach retires the previous one, so there is never
  more than one per session) and torn down on unmount or session delete. One
  handler per touched session, each filtering by session id first, is a cost
  worth paying to never miss a turn.
- A dropped socket is recovered for every session this app instance holds a
  runtime for, not only the visibly-working ones, and the resume re-attaches the
  subscription with the runtime id it just minted (the surviving handler filters
  on the id captured at attach time, so a new one would silently drop every
  frame).

This is what makes the runtime-authority rule above pay off in both directions:
the app no longer declares a live turn dead, and no longer misses a turn it did
not start.

## Context

June tracks, per session, whether the agent is currently working. That flag
drives a lot: the stop button owning the composer's send slot, the "Thinking…"
indicator, the menu-bar status, the "Sub Rosa finished" notification, whether a
typed follow-up is steered into the running turn or submitted as a new one, and
whether the 2.5s reconciliation poll runs at all. ADR-0012's interrupted-turn
notice keys off it too: a transcript ending on a tool result means "cut off"
only when the session is idle.

Three things could end a run:

1. a terminal gateway event (`message.complete`, `turn.complete`, `error`, …),
2. the persisted transcript showing an assistant reply after the user's last
   message (`sessionHasAssistantAfterLatestUser`, evaluated by the selection
   effect and by every 2.5s poll),
3. the runtime's own `session.active_list` reporting the session absent or idle
   for two consecutive polls.

(2) is wrong, and had been quietly wrong for a long time. An agent loop is not a
single assistant message: Hermes persists a row at **every** step — 0.19 seals
mid-turn commentary as its own assistant message (`message.interim`), and each
tool-calling step writes an assistant row plus a `tool` result row. So "an
assistant message exists after the user's" goes true a couple of seconds into
any tool-using turn and stays true for the rest of it.

The consequences were user-visible and were reported as four separate bugs:

- the stop button reverted to send while the agent was working, so the composer
  submitted follow-ups as new turns instead of steering them into the live one;
- "Sub Rosa finished" was announced (menu bar and OS notification) in the middle
  of runs;
- with the run marked idle and the transcript sitting on a tool result, ADR-0012's
  interrupted notice rendered on a turn that then carried on — the reported
  "'This turn stopped before it finished' appears constantly, then the chat
  continues";
- with the run marked idle the poll stopped, so nothing refreshed the session
  until the user touched it — a long task read as a dead chat.

## Decision

**Only the runtime may end a run.** Reconciliation from the transcript is
demoted to a fallback and is made one-directional.

- `session.active_list` is the authority (`reconcileWorkingSessionsAgainstRuntime`).
  A locally-working session absent from it, or reported idle, for two
  consecutive polls has its activity cleared. Two misses, not one, so a
  just-submitted prompt can race the runtime registering its session.
- A terminal gateway event still ends the run immediately. That is the fast path
  for every normal turn; the poll is the safety net for runs whose live stream
  died.
- The transcript no longer ends a run while the runtime is reachable. When the
  runtime cannot be asked this tick (its gateway did not answer), the transcript
  is consulted as a fallback, and only through `hermesMessagesShowCompletedTurn`:
  an assistant reply **and** no dangling tool call. A shape it cannot prove is
  closed leaves the run alone until the runtime can be asked again.
- The transcript keeps its other, unrelated jobs at the weaker
  `hermesMessagesHaveAssistantReply` test — promoting a queued issue report and
  dropping the live event buffer once the persisted rows have caught up. Those
  are about "the persisted transcript is current", not about "the turn is over".

`hermesMessagesShowCompletedTurn` is deliberately unable to distinguish sealed
mid-turn commentary from a final answer — both are plain assistant rows. That is
not a defect to fix in the heuristic; it is the reason the heuristic cannot be
the authority. It is safe in the fallback because a gateway that stays
unreachable means the runtime is gone, so a turn it left mid-loop is a dead turn
and ADR-0012's notice is the correct outcome.

## Consequences

- A tool-using turn stays visibly running for its whole duration, however long
  its individual steps take.
- A run that dies without persisting an answer (provider failure, crash, the app
  quitting mid-turn) is cleared by `session.active_list` within ~5s, then
  ADR-0012's interrupted notice surfaces it. That notice now only ever appears
  on turns the runtime confirms are gone.
- Ending a run costs a round trip that the transcript test did not. It rides the
  existing 2.5s poll, which already called `session.active_list` on every tick,
  so there is no new traffic.
- If both the gateway is unreachable **and** the transcript ends mid-loop, the
  session stays marked working until either recovers. This is the deliberate
  trade: a stale "Working…" is recoverable and honest, a premature "finished" is
  neither.
- Frontend only. No June API change, no change to the pinned Hermes runtime, so
  no upstream re-merge cost beyond the touched blocks.

## Alternatives considered

**Keep settling on transcript shape, with a quiet period.** Only settle if the
transcript has not changed for N seconds. Rejected: it re-adds a guess with a
new tuning constant, it still misfires whenever a single tool step runs longer
than N (exactly the long-batch case this is about), and `session.active_list`
already answers the question exactly.

**Ask Hermes to persist a turn boundary.** Cleanest signal, but it edits the
pinned runtime for a purely client-side need — fork re-merge cost (see
`FORK_NOTES.md`) against a question the gateway already answers.

**Drop transcript reconciliation entirely.** Rejected: with the Hermes bridge
down, nothing would ever clear a working session, and the "Working…" status
would stick until the app restarted.
