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

The recordings contain fixture data and do not prove a live provider or native file
dialog flow. They have not been uploaded to a third-party QA service.

## Automated checks

- Full frontend suite: 271 files passed, 4,239 tests passed, 2 skipped.
- Subsequent focused suite: 80 tests passed, covering the final conversation races,
  media consent, shared Studio input rules and file-size limit.
- Typecheck, production frontend build, Biome and warning ratchet passed. Existing
  bundle-size and lint warnings remain.
- Native tests cover revisions, extraction, account synchronization, archive
  round trips, permission filtering, general-chat isolation, durable completion,
  snapshot forks and a concurrent paid claim followed by reopening SQLite.
- iOS library checks passed for device and simulator targets.

## Remaining validation

No credits were spent during QA. Live image/video/music/speech delivery, encrypted
sync against a running account service, native file dialogs and physical iPhone
keyboard/safe-area/background behavior still need live validation. The existing
account-service fixture test remains ignored without its live fixture. No release,
notarization or installation was performed.

PDF input size and extracted text are capped. The PDF library may expand compressed
content internally before the output cap; this is not a strict memory sandbox.
