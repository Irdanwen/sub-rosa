---
status: accepted
date: 2026-08-28
---

# The council issues a verifiable mandate, and one agent executes it

## Context

Sub Rosa reaches a whole catalog of text models and drives a capable agent
runtime, and the two facts sit next to each other without touching. A session
runs on one model, chosen once, and whatever that model's blind spots are, the
work inherits them. Meanwhile the expensive, slow part of any real task is the
agent run itself: a session that writes files for forty minutes against a
misunderstood request costs more than every model call that could have
prevented it.

The obvious move — several agents in a room, talking — is the wrong one, and
it fails in three specific ways rather than one vague one:

- **Free discussion converges.** Models asked to confer produce agreement,
  not scrutiny. Three polite reformulations of the same answer read like a
  consensus and are worth less than one answer.
- **Emergent turn-taking has no ceiling.** If who speaks next is a model's
  decision, the bill is a model's decision too. The fork prices a chat turn
  precisely because the operator does not.
- **Several writers, one working folder.** Concurrent agents with `file` and
  `terminal` do not collaborate, they overwrite. The failure is silent and
  arrives as a broken tree.

There is also a nearer temptation: Hermes already ships a `delegation`
toolset, so subagents are one config flag away. But a subagent inherits the
runtime's model, which is exactly the thing we want to vary; its result comes
back as an opaque process notice with no per-seat identity and no cost
attribution; and it exists only on desktop and only inside a session that has
already started, which is too late to shape what the session was asked to do.

The last question was what the deliberation should produce. The intuitive
answer, "the best prompt", is a trap. Ask three models for a prompt and each
returns nine hundred words; merge them and you have two thousand. Length is
not quality, and — decisively — **a prompt cannot be checked**. There is no
meaning to "did the work satisfy the prompt".

## Decision

**A council deliberates to issue a *mandate*: a fixed, capped structure whose
centre is a list of acceptance criteria, each naming how it is verified. One
agent executes it. The council then returns a verdict, criterion by criterion,
against that same mandate.**

Five rules carry the decision.

**1. The app owns the prompt; the council owns the fields.** Seats fill
mandate slots (objective, deliverable, constraints, acceptance criteria, out of
scope, first step), each length-capped. The string handed to the agent is
rendered from those slots by `mandate.rs`, deterministically. No model is ever
asked for the final prompt. This is the same discipline ADR-0027 applies to
time: the model supplies the field it can know, the app composes what it
cannot.

**2. The first round is blind and parallel.** Every seat answers without
seeing the others, on a *different model family*. Diversity comes from the
weights, not from personas. This is also the cheapest round and the fastest,
and it doubles as the single-model baseline the whole feature is measured
against.

**3. Questions are intersected, not accumulated.** A seat reports what it
would need to know from the user. A question raised independently by two or
more seats is a real ambiguity in the request; one raised by a single seat is
that seat's idiosyncrasy. At most three are put to the user, once. This is
what makes a multi-seat structure *reduce* the number of questions rather than
multiply them.

**4. The contradiction round is targeted and bounded.** The chair compares the
structured first-round answers mechanically — no model call — and reopens only
the slots where seats genuinely disagree, for at most three seats. A council
that agrees costs one round.

**5. Deliberation is plural and parallel; execution is single and
sequential.** No seat holds a tool that changes anything. Seats read and
argue; the agent writes. What a sitting can produce, beyond its mandate, is a
proposed action the user taps.

Two corollaries follow and are binding:

- **The verdict does not run on the session's model.** A reviewer sharing
  weights with the author shares its blind spots. Sub Rosa knows both, so it
  enforces it.
- **The executor is given the acceptance criteria.** Hidden tests produce
  frustrating loops. The defence against gaming lives in the verdict instead:
  every criterion is judged with evidence, one seat hunts satisfaction in the
  letter only, and one seat looks for what no criterion covers — what was
  changed without being asked, and what was quietly skipped.

## Consequences

The module is `src-tauri/src/council/`, on the `longform/` pattern: it sends
its own prompts to `/v1/chat/completions` through the sidecar. **Nothing is
added to `june-api/`** — every line there is a line `upstream-sync.yml`
re-merges forever — and nothing is added to Hermes.

It is desktop-only. There is no Hermes on iOS, so there is nothing for a
mandate to be handed to; `council::` is therefore listed as platform-specific
in `tests/shared_commands.rs`, which is the one place that is allowed to say
so.

Work still lives in durable rows even without iOS to force it. A cycle spans a
deliberation, an agent run that can last an hour, and a verdict; a webview
reload in the middle must not lose it. The rows are `council_mandates`,
`council_turns` (the resume unit — a finished seat is never re-bought) and
`council_verdicts` (one per round, because a retake produces another).

Retakes stop at two. When they run out, the app says what remains unsatisfied
rather than looping: a bounded cycle that reports its residue beats an
unbounded one that reports success.

The two halves are not welded. A mandate can be written by hand and still be
judged; a mandate can be issued and the verdict declined. The cycle is opt-in
per session and never the default path into the composer, because a user who
already knows what they want does not need a committee to find out.

## Alternatives considered

**Hermes subagents (`delegation`).** Rejected: one model family, no per-seat
identity, no cost attribution, and it can only exist after a session has begun.

**A council node inside the Studio workflow engine.** The engine has the right
discipline — durable runs, approval gates, a cost figure before the spend
(ADR-0021, ADR-0030) — and the wrong substance: its nodes are media, its ports
are image and video, its outputs are gallery artifacts. Wiring text through it
would drag the gallery into a text feature. The discipline is copied; the
engine is not.

**Best-of-N execution: run the task with N models, keep the best.** Rejected
on economics and on merge. Execution is the expensive half, the results do not
compose, and picking a winner needs the same judgement the verdict already
provides for one run's price.

**A chat block for the council.** Rejected for the deliberation, which happens
*before* a session exists and is orchestrated by the app rather than authored
by a model — the two properties a chat block assumes (ADR-0024). The mandate
ritual takes over the main region, which is where a new session already
begins, and the verdict opens as an overlay in the same place the session
usage panel does.

---

## Addendum, 2026-08-29: evidence is not only a folder

The first sitting to reach a verdict in the wild answered `unverifiable` seven
times out of seven. Nothing had failed. The request was "analyse this
screenplay, rate it, improve it": the deliverable was prose, the sitting had no
working folder, and `evidence.rs` knew how to read a git diff and a folder's
mtimes and nothing else. Three seats each spent a call to report that they
could not see anything.

The original decision said a verdict without evidence is an opinion. It held.
What it got wrong is what counts as evidence, by assuming that finished work
leaves a trace on a filesystem. Much of what this app is asked for does not.

**The agent's reply is a second evidence source**, used when the folder yields
nothing. Three properties keep it from weakening the original rule:

- **The folder still wins.** A diff is what a filesystem observed; a reply is
  what the agent says about itself. The reply is the fallback, never the
  preference.
- **The seats are told which they hold.** The conformance seat is still
  instructed that an agent reporting it did something is not evidence that it
  did. The `reply` provenance draws the line explicitly rather than softening
  it: when the mandate asked for a text, the text is the artefact and can be
  read; it remains no evidence at all for a file written or a command run
  elsewhere, and those stay unverifiable however confidently they are claimed.
- **It is stored, not passed.** Only the shell can reach the transcript, so it
  hands the reply in; Rust writes it to the verdict row, because a verdict
  re-driven after a relaunch must still hold the thing it is judging
  (ADR-0018).

Two consequences follow upstream of the verdict, and they matter more than the
verdict change itself:

- **A sitting with no folder tells its seats so**, and they are barred from
  writing a criterion that depends on a file, a diff, a command or a passing
  test. The sitting above asked for durations summed to 300 seconds and a text
  search for a pendant, in a document nobody was going to write.
- **A verdict with nothing to read is refused before it is paid for.** No
  folder and no reply is checked before a row exists. Answering
  "unverifiable" once per criterion is not a hard verdict; it is the absence of
  one at the price of a real one.

Two smaller amendments from the same sitting, which lost two of its seven seats
to empty answers, one of them the objection:

- **A seat that returns nothing is asked once more.** Only emptiness: a refusal
  or a 500 is the operator saying something, and asking again is how one failed
  sitting becomes two. This does not breach the bound this record puts on the
  bill — a seat speaks at most twice — because a seat that returned nothing has
  not spoken. It is still a billed call, so the proposal card names it rather
  than inflating every estimate to cover a rare failure.
- **A mandate nobody attacked says so where it is handed over.** Losing the
  objection seat still issues a mandate, deliberately; but the seat row's X is
  not the same as saying, at the moment of decision, that what is about to be
  handed over is what the other seats agreed on, unchallenged.
