---
status: accepted
date: 2026-10-08
---

# A voice conversation is a cascade run in Rust, around the shell's own chat

## Context

The parity matrix (ADR-0078) left three P7 rows open: a realtime voice
conversation, voice with the camera or the screen, and voice with connected
apps. The vendor's version is a speech-to-speech model behind a realtime
socket. Sub Rosa's inference goes through Carpe Diem, and what Carpe Diem
offers was checked in the operator itself (`operator/src/app.ts`):

- `POST /v1/audio/transcriptions` is a whole-file multipart request. There
  is no streaming transcription and no realtime or WebSocket endpoint.
- `POST /v1/audio/speech` does not forward Venice's `streaming` flag and
  buffers the upstream body before answering, so one request renders one
  text, whole.
- The fast transcription model (`nvidia/parakeet-tdt-0.6b-v3`) is already
  the transcription default of Settings, and dictation already reaches it in
  a few hundred milliseconds (ADR-0041).

The other constraints are the app's own. A chat turn belongs to a shell:
the desktop agent runtime (Hermes, driven from the webview's gateway) or the
phone's agent-lite. Tools, connectors, memory, personalization, projects and
history all hang off that turn. And three platforms record and play audio
differently, with echo cancellation in three different places.

## Decision

1. **A cascade, not a speech-to-speech model.** Utterance, transcription,
   ordinary chat turn, reply read back sentence by sentence. Every stage is
   a rail the app already pays for and already guards; nothing new is asked
   of Carpe Diem, and nothing goes in `june-api/` (ADR-0027).
2. **The loop runs in Rust, shared by every shell** (`src-tauri/src/voice/`).
   One session thread owns the microphone and the speaker. A local energy
   detector (`vad.rs`: adaptive floor as the minimum of the last 5 s,
   hysteresis, 700 ms hangover, 30 s cap, 300 ms pre-roll) cuts utterances;
   each is transcribed on the dictation's `/v1/dictate` rail with the
   transcription model of Settings; the reply is cut into sentences as it
   streams (`sentences.rs`, fenced blocks named, never read); each sentence
   is rendered on `/audio/speech` with the voice of Settings
   (`voice-preference.ts`), **one sentence ahead of the one playing and no
   more**, and played by the session itself.
3. **The orchestration is a pure state machine** (`machine.rs`: listening,
   transcribing, thinking, speaking) joined to the detector in `engine.rs`.
   Every user turn gets a number; a reply, a rendered sentence or a finished
   clip names its turn, and a barge-in forgets the turn so whatever is still
   in flight for it is dropped on arrival. Words said while an earlier part
   is being transcribed make one turn, not two. The whole loop is tested
   with fake audio, transcription, chat, speech and speaker.
4. **The turn is the shell's.** The session asks the webview for a turn
   (`voice://event`, kind `turn`); the webview sends it through the shell's
   own send (the desktop workspace's `submitHermesSession`, the phone
   screen's `send`) and feeds the reply back as it streams, read from the
   transcript rather than the send call (a new user message marks the
   turn's reply; done once the chat was seen working). So a voice turn is a
   normal turn: saved in history, titled, remembered, with every tool and
   connector of a typed one. The voice conversation itself is live, not
   durable (ADR-0018 protects work that must outlive the screen; this is a
   conversation the person is in), and its turns are durable as chat turns.
5. **Barge-in silences first, then stops.** Speech detected over the reply
   (or a tap on the orb) stops the speaker in the session at once, then asks
   the webview to stop the chat turn (Hermes stop, `agent_lite_cancel`),
   which keeps what was written (ADR-0079, ADR-0080).
6. **Echo is cancelled where the platform can, and allowed for where it
   cannot.** iOS plays and records through one Voice-Processing I/O unit
   with the session in `.voiceChat` mode (`io_ios.rs`). Android opens the
   microphone with Oboe's `VoiceCommunication` preset, the source its echo
   canceller attaches to (`io_android.rs`). macOS and Windows use plain cpal
   streams: the detector's barge-in threshold rises over the reply (the
   playback level held 250 ms, plus the path's coupling and a margin) and
   the screen suggests headphones. A voice-processing input that opens but
   stays silent for 3 s is reopened on the plain streams.
7. **Protected mode's "Voice off" is enforced in Rust**, with quiet hours:
   `protected_mode::check_voice` refuses `voice_start` and is asked again
   before every utterance is transcribed, so a switch turned on mid
   conversation ends it with its reason.
8. **A picture goes with the turn it belongs to.** On the phone, the live
   camera preview (the webview's camera) gives one frame when the person
   stops speaking, or on "Look"; without a preview, "Look" takes one photo
   with the system camera. The frame rides the turn as an image, which
   routes the turn to a vision model (`vision-routing.ts`). On the Mac, the
   system audio helper (already the app's ScreenCaptureKit identity) gains a
   `--screenshot` run that captures the main display without Sub Rosa's own
   windows; the frame is imported as an attachment of that turn, and a chat
   whose model cannot see switches to the vision fallback first. Nothing is
   recorded between turns.
9. **The price is said before the first use**: half a minute heard (priced
   by the second) and half a minute spoken (about 450 characters, priced by
   the character) from the live catalog, plus the replies themselves.

## Alternatives rejected

- **A realtime speech-to-speech model.** Carpe Diem serves none, and it
  would bypass the shell's chat: no history, tools or memory without
  rebuilding them around a second conversation engine.
- **The loop in the webview.** WKWebView freezes in the background,
  autoplay rules can refuse a reply that starts without a tap, and the echo
  cancellation lives in native audio units the webview cannot reach.
- **Rust sends the turns itself.** The desktop turn is Hermes's, driven
  from the webview's gateway with its session bookkeeping; duplicating that
  in Rust would fork the chat. The phone could, but one contract for both
  shells keeps the loop identical.
- **Speaking the whole reply in one request.** The operator renders a
  request whole before answering; a long reply would be seconds of silence.
  Rendering every sentence at once would pay for what a barge-in throws away.
- **A neural detector (Silero, WebRTC VAD).** A model file or a C library on
  three targets for an end-of-utterance decision the energy detector makes
  well enough with an adaptive floor; it can replace `vad.rs` behind the
  same events if rooms prove it wrong.

## Consequences

- Latency is the sum of the rails: the hangover (700 ms), one transcription,
  the chat's first sentence, one speech render. Carpe Diem streaming speech
  would cut the last one; the app works without it.
- The echo handling on iOS and Android is unverified on hardware at the time
  of writing; the plain-stream fallback and the echo-aware threshold are the
  safety net.
- Screen sharing is macOS only; Windows has no helper. The phone camera's
  live preview depends on the webview's camera; where it is missing, "Look"
  still works one photo at a time.
- A voice turn is billed like a typed one plus its transcription and its
  speech; nothing is billed while the person is silent.

## Addendum (2026-10-08): the Mac cancels echo, Windows shares its screen, the chain was measured

- **macOS uses the voice-processing unit too.** The Mac has the same
  Voice-Processing I/O audio unit as the iPhone, and `coreaudio-rs` was
  already linked by cpal with the same features, so `io_ios.rs` became
  `io_apple.rs` for both. On macOS the unit follows the default devices.
  Selection is one tested function (`io::prefer_echo_cancelling`): the unit
  when it starts, else cpal with the raised barge-in threshold; the
  watchdog's reopen never tries the unit again. Opened on a Mac (the
  ignored `io_apple` test), both directions run. Windows keeps the plain
  streams, and decision 6 now reads "Windows uses plain cpal streams".
- **Windows shares its screen** with one GDI `BitBlt` of the primary display
  (`screen_windows.rs`), scaled and encoded like the Mac's helper (1600 px,
  JPEG 80, `screen_frame.rs`). Windows.Graphics.Capture was rejected: a
  capture session, a Direct3D device and a capture border for one frame per
  turn, where Windows asks no permission for a GDI copy anyway. The app's
  own windows are marked `WDA_EXCLUDEFROMCAPTURE` for the instant of the
  copy (Windows 10 2004 and later). The explanation before the first share
  is the consent on both systems; on Windows it says no permission is
  asked. No new crate: a feature of the `windows` crate already used.
  Unverified on Windows hardware; the pure parts are tested everywhere and
  the module type-checks for `x86_64-pc-windows-msvc`.
- **The real chain, measured once** (`voice/selftest.rs`, debug only,
  2026-10-08, this Mac, Carpe Diem): question rendered by `tts-kokoro`,
  cut by the detector, transcribed by Parakeet on `/v1/dictate` in 2.0 s
  (word for word), answered by `zai-org-glm-5-2` with its whole first
  sentence after 1.25 s, that sentence rendered in 1.96 s. With the 700 ms
  hangover, about 5.9 s from the end of speech to the first sound. The
  transcription and the speech render dominate; streamed speech on the
  operator remains the biggest single saving.
