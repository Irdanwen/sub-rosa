# Private assistants, 21 September 2026

Implementation branch: `codex/portable-assistants`. Decision and compatibility
boundary: [ADR-0058](../adr/0058-assistants-are-portable-definitions-with-native-permissions.md).

## Desktop and mobile walkthrough

An isolated Vite preview rendered the production assistant components with a fixture
Tauri bridge. The walkthrough opened the library, edited a profile, opened its
preview, sent a message, inspected the reply and composer at desktop and phone
widths, and opened the guided creation questionnaire. Browser console errors: none.
Screenshots and middle frames of both recordings were visually inspected.

Local evidence remains in the implementation worktree under `.tmp/`:

- `assistants-desktop-library.png`, `assistants-desktop-dark.png`
- `assistants-desktop-preview.png`, `assistants-mobile-chat.png`
- `assistants-mobile-editor.png`, `assistants-mobile-question.png`
- `assistants-desktop-walkthrough.webm`, `assistants-mobile-walkthrough.webm`
- Review followup: `assistants-review-desktop-snapshot.png`,
  `assistants-review-mobile-snapshot.png`, `assistants-review-desktop-reference.png`,
  `assistants-review-mobile-reference.png`, and `assistants-review-{desktop,mobile}.webm`.
  These cover saved conversation settings, explicit revision updates and the
  reference-removal explanation.

The review walkthrough also caught a mobile confirmation clipping outside its
body portal. The shared grid track and card now shrink within the viewport.
The final run asserted the dialog's actual bounds at 390px width and reported no
browser errors.

The recordings contain fixture data and do not prove a live provider or native file
dialog flow. They have not been uploaded to a third-party QA service.

## Automated checks

- Full frontend suite: 271 files passed, 4,239 tests passed, 2 skipped.
- Subsequent focused suite: 80 tests passed, covering the final conversation races,
  media consent, shared Studio input rules and file-size limit.
- Review followup: 45 frontend tests passed for saved conversation settings,
  stale responses, reference-removal copy, notification routing, media and translations.
  Native assistants (21), destinations (1) and shared commands (3) passed, along
  with strict clippy. Notification taps retain their task across a cold shell launch.
- Frontend coverage: 77.79%, above the 75.83% floor. The coverage run encountered
  one existing contenteditable caret-position flake; the complete AgentWorkspace
  suite passed on rerun (179 passed, 2 skipped), and the CI frontend suite passed.
- Typecheck, production frontend build, Biome and warning ratchet passed. Existing
  bundle-size and lint warnings remain.
- Native tests cover revisions, extraction, account synchronization, archive
  round trips, permission filtering, general-chat isolation, durable completion,
  snapshot forks and a concurrent paid claim followed by reopening SQLite.
- iOS library checks passed for device and simulator targets.
- Release preparation regressions: 25 native assistant tests and 6 archive
  tests passed. They cover ownership-aware file deletion, excluding orphan
  bytes from exports, additive restore with newer local references, and
  extraction progress beyond missing synchronized files. Version/build-number
  and iOS extension checks passed (29 frontend tests).
- The supply-chain check caught a vulnerable transitive PDF parser in the initial
  dependency selection. Upgrading `pdf-extract` to 0.12.1 selects patched `lopdf`
  0.42.0. Both `cargo audit` and `cargo deny` pass without a new advisory exception.
- Release review regressions reopen SQLite and rerun migrations between bounded
  sweeps to verify upload discovery and extraction advance beyond 256 missing
  references after a cold launch, then revisit files arriving later. Pending sync
  counts exclude unowned assistant transfers but retain delayed-metadata rows.
  The chat caret-position flake now places the selection explicitly before typing;
  all 179 AgentWorkspace tests pass (2 skipped).

## Remaining validation

No credits were spent during QA. Live image/video/music/speech delivery, encrypted
sync against a running account service, native file dialogs and physical iPhone
keyboard/safe-area/background behavior still need live validation. The existing
account-service fixture test remains ignored without its live fixture. No release,
notarization or installation was performed.

PDF input size and extracted text are capped. The PDF library may expand compressed
content internally before the output cap; this is not a strict memory sandbox.
