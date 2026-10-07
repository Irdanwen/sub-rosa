---
status: accepted
date: 2026-10-07
---

# A cloned voice keeps its sample and remints its handle

## Context

Venice clones a voice zero-shot. A short reference sample uploaded to
`POST /audio/voices` (Carpe Diem: `/v1/audio/voices`, Lumen-labs-ch/Carpe-diem-#451)
answers a `vv_…` handle that `/audio/speech` accepts as `voice`, on the same
model only. Venice keeps the sample for `voice_cloning.retention_days` (7) and
no template survives it. The operator pins the handle to the provider key that
minted it and to the account that uploaded the sample, keeps it in memory, and
answers `404 VOICE_EXPIRED` once it is gone, including after a restart.

A person wants "my voice" to be a thing they made once and use for weeks: a
narration, a character in a film (ADR-0076's casting), a line read again a
month later. The handle lives seven days at best.

The alternatives were to store the handle as the voice (and let the voice die
silently at seven days, or after an operator restart), to ask the person to
upload again whenever it expires, or to keep the sample and mint a new handle
whenever the old one is gone.

## Decision

1. **The voice is the sample, kept on the device.** A cloned voice is a row
   (name, model, consent time) and a copy of the sample in the app's data
   directory. The handle is a cache on that row, with its expiry.
2. **The handle is reminted, never trusted.** Before a speech request the app
   asks Rust for a usable handle: the cached one if it has more than a day
   left, else a fresh upload of the kept sample. A `VOICE_EXPIRED` answer
   (operator restart, key retired) remints once and retries once.
3. **Consent is part of the record.** Creating a voice requires the person to
   confirm the sample is their own voice or one they have permission to use;
   the time of that confirmation is stored with the voice.
4. **It stays on the device.** Cloned voices are not synchronised: a voice is
   biometric, and the sync boundary (ADR-0049) carries nothing it was not
   designed for. Deleting a voice deletes its sample.
5. **A voice is used where voices are used.** A cloned voice appears in the
   voice list of the model it was made for, on desktop and mobile, in the
   workflow speech node and in the bible's casting (ADR-0076), by a stable
   `cloned:<id>` reference resolved to a handle at the moment of speaking.

## Consequences

- A voice made in October still speaks in December; the person never sees a
  handle or an expiry.
- Every remint is an upload of a few seconds of audio, free upstream.
- The sample file is the one sensitive thing the feature adds to the disk; it
  lives under the app's data directory and goes with the voice.
- A voice works on one model, the one it was made for; moving it to another
  cloning model means uploading the sample there, which this design allows
  but does not do.
- The voice changer (`/audio/voice-changer/*`) is not part of this: no Venice
  model publishes `voice_changer` today.
