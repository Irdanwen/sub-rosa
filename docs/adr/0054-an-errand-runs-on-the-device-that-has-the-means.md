# ADR 0054: An errand runs on the device that has the means

- Status: accepted
- Date: 2026-09-20

## Context

Pasting a YouTube or podcast page into Sub Rosa on the phone does nothing.
[`ingest/extractor.rs`](../../src-tauri/src/ingest/extractor.rs) is
`#![cfg(desktop)]` and says why in its own header: iOS cannot execute a binary,
let alone one its owner installed somewhere else. The refusal is correct and
[ADR-0028](0028-import-links-are-fetched-never-scraped.md) means it, but the
person holding the phone is still holding a link they wanted to keep.

The obvious fix is to run the extractor on the account service. It is wrong
twice. It relocates a refusal rather than lifting one — "nothing here is
bundled" becomes "the downloader is bundled, just not on your machine" — and it
hands the service the single thing it has never had: a link in the clear, plus
the job of going to fetch it.

The desktop, meanwhile, can already do this. It has the extractor its owner
installed and the key its owner configured. What is missing is not a capability.
It is a way to ask.

## Decision

**The extractor does not move. The work does. One device writes an encrypted
revision saying "fetch this, on that device"; the device it names runs the
import it could always run, and the note comes back through synchronisation.**

- **An errand is an ordinary revision of a tenth kind**, `errand`, encrypted
  under the vault key like everything else. The service stores opaque
  ciphertext, carries it, and learns neither the link nor that anything is
  meant to happen.
- **It is addressed to one device.** The asking device picks from the account's
  own device list. Nothing races, the waiting message can name the machine, and
  a second desktop never produces a second note.
- **The machine that pays decides whether to accept at all.** Errands are off
  until their owner switches them on, in Settings › Import, beside the
  extractor switch and for the same stated reason: an import spends credits and
  occupies the machine, and switching it on is a statement about what you want
  your computer doing while you are not in front of it. A device with the
  switch off **declines and says so**, rather than leaving the asker waiting.
- **The refusal the import rail already writes is the answer.** The runner
  calls `start_link_ingest` unchanged, so "yt-dlp is installed but switched
  off" comes back to the phone in the words the desktop already uses, including
  what would change it.
- **Single use, durably.** `account_errand_runs` is written before any work
  begins and is **never synchronised**. A synchronised flag cannot carry this:
  the row can legitimately come back as `requested` after a conflict, a late
  revision, or a restored archive, and each of those would otherwise buy the
  same transcription again on a machine nobody is sitting at.
- **Perishable.** An errand nobody picked up within seven days is declined
  rather than run late.

## The exception this makes, stated plainly

ADR-0049 says incoming task history is **inert**: a received execution state is
history, never authorisation to run work. `account/sync.rs` enforces it by
flattening what arrives — an `agent_tasks` row lands `completed`, an `ingests`
row lands `done`.

`account_errands` is the one table deliberately exempt, and the exemption is
the feature rather than an oversight. The distinction is not subtle: every
other incoming row **describes work another device already did**, so honouring
it would mean redoing it. An errand **is a person asking this device to do
something**, and flattening it would flatten the feature.

What keeps the exception from swallowing the rule:

| ADR-0049's worry | What answers it |
| --- | --- |
| The service acquires spending authority | It cannot forge an errand: the AEAD binds it to a device holding the vault key. It cannot read one. It cannot make one run: the switch is local. |
| Work runs because state arrived | Work runs because a person asked, on a device they were holding, addressed to a device they chose, which had already agreed to accept errands. |
| The same paid job runs twice | A local, unsynchronised ledger written before the work, plus an in-process claim, plus a seven-day window. |
| A stale instruction runs much later | Same window. |

## Consequences

- The phone gains link import without one line of extraction code, and
  ADR-0028 is untouched: the rail is still only where its owner installed it.
- **It needs the other machine to be running.** The phone says "waiting for
  your other device", not a spinner, because that is the truth. This is a
  courier, not a cloud worker, and an errand to a laptop in a bag waits.
- An errand spends the *executing* device's credits, from the shared Carpe Diem
  key. One account, one wallet — but the machine consents first.
- The journal now carries an object that is not a record. Any future kind that
  wants the same exemption has to argue it here rather than inherit it.
- The service needs its migration before the apps ship, or an errand push is
  refused as an unknown kind.

## Alternatives rejected

- **The extractor on the VPS.** Moves a refusal, gives the service plaintext
  links and an outbound fetching role, and puts the host's IP reputation in the
  loop. This is the alternative that made the whole idea score 6/10 before it
  was turned inside out.
- **Reusing the `ingests` row as the instruction.** It is already synchronised
  and already flattened to `done` on arrival, precisely because it is somebody
  else's execution state. Un-flattening it would remove the guard for every
  import, not just the asked-for ones.
- **Any capable device picks it up.** Two desktops, two notes. Naming the
  device removes the race instead of detecting it, and makes the copy honest.
- **Approving the spend on the executing machine.** It is the reading of "no
  spending authority" that sounds strictest, and it defeats the feature: you
  asked from the phone precisely because you are not at the Mac. The consent
  that matters is the standing one the machine's owner gave by switching
  errands on.
- **A global hash chain over the journal**, to detect a service withholding or
  replaying an errand. The naive form is wrong here: two devices writing
  concurrently would each chain to a different previous head, so every
  concurrent write would conflict. Detecting withholding needs per-device
  counters and a gap check, which is a design of its own and is not in this
  change. Replay of an *errand* specifically is closed by the ledger above.
