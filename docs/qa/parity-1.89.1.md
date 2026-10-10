# Parity verification for 1.89.1, 10 October 2026

What the integration branch `fix/parity-audit-int` gives a person, tried for
real on this Mac (W9 of the parity audit). Branch commit at the start:
`533830ac`. Every line below is something seen happen; what could not be run
says why. Evidence: [`evidence/parity-1.89.1/`](evidence/parity-1.89.1/).

## No paid action was run

The budget was 20 credits with a floor of 132.6 available credits. The balance
was already under the floor before the first action of this run, so no paid
action was started: no chat turn, research, mission, voice, image, read aloud
or extension question.

| When  | Available credits | Note |
| ----- | ----------------- | ---- |
| 19:35 | 147.64 | figure given in the brief |
| 19:46 | 110.22 | before the first action of this run, already under 132.6 |
| 19:59 | 109.61 | between lots |
| 20:22 | 108.50 | between lots |
| 20:50 | 107.69 | after |

The drop during the run did not come from it. The debug app's own ledger
(Settings > Privacy > "What left this machine") lists 29 requests, all
`catalog`, 0 bytes sent. The iPhone build sent no question. The installed
1.89.0 app was running until 20:04 and something else is spending on the same
key. Paid actions of this run: none, 0 credits.

## Desktop (debug build from source)

`SUBROSA_DEV_API_KEY=… pnpm tauri:dev`, data folder
`xyz.carpediem.subrosa-dev`. Driven with macOS screenshots, CoreGraphics clicks
and System Events keystrokes (no `cliclick` on this Mac), the extension with
Playwright on Brave.

| # | Item | What was done | Result |
| - | ---- | ------------- | ------ |
| 0 | Starting the app | `pnpm tauri:dev` printed "Found version mismatched Tauri packages: tauri-plugin-updater 2.12.0, @tauri-apps/plugin-updater 2.11.0". `tauri build`, which `release.yml` runs through tauri-action, stops on that error. | broken-fixed (`30ab6ea7`) |
| 1 | Chat controls | On a stored conversation: Copy put the reply on the clipboard; thumbs up wrote a `reply_ratings` row; the context gauge reads "Environ 4K jetons utilisés"; Read aloud, Regenerate and Branch from here are shown. Send, stop, edit, regenerate, branch, read aloud: not run (each is a paid turn). The reasoning switch is not offered for the default model and no other model was tried. | partial, rest not run (paid) |
| 2 | Project with instructions and a file | Created "QA parity", instructions saved, a text file added through the native picker ("62 caractères lus"), both rows in `project_settings` / `project_files`. The question that needs the file: not run. | ok up to the question, question not run (paid) |
| 3 | Deep research, quick | Not run. | not run (paid) |
| 4 | Mission run now | Not run. | not run (paid) |
| 5 | Publish a note | Not run: publishing needs a signed-in account in the debug build, and signing in needs the person's mail or passkey. Read-only against production: `https://pages.subrosa.furetier.com/p/<unknown>` answers 404 with `content-security-policy: default-src 'none'`, `GET /api/v1/catalog/assistants` answers `{"data":[]}`. | not run (account) |
| 6 | Temporary chat | The temporary composer drops Study and Deep research, and the + menu offers neither; the banner reads "ni enregistrée, ni mémorisée". Sending one message and checking `agent_messages`, `memories`, notes and Hermes sessions: not run. | composer ok, persistence not run (paid) |
| 7 | Protected mode | Turned on with a code, image and video generation off. `/image a red apple` in chat answers "La génération d'images n'est pas disponible": the upstream flag `IMAGE_GENERATION_ENABLED = false`, not protected mode, so a picture asked in chat goes through an agent turn (paid, not run). Studio > Image > Generate under the same settings: the notice "Le mode protégé a désactivé la génération d'images et de vidéos" appeared, but a `media_jobs` row was left `failed` with "The submission was interrupted. Check your provider history…", shown as a banner after the next launch, for a render that never left. After the fix: the notice, and 0 rows. | broken-fixed (`0e2d5b11`) |
| 8 | Voice, one exchange | Not run: a paid exchange, and the Mac microphone permission was not granted for the debug helper. | not run (paid, permission) |
| 9 | Global chat bar | Option+Space crashed the app (`EXC_BREAKPOINT`, "Must only be used from the main thread", `order_front_as_key < chat_bar::show < listen_to_helper < dictation::handle_helper_event_line`). The installed 1.89.0 crashed on the same press with the same stack. After the fix: the bar opens, Escape closes it, three more presses, no crash report. Asking: not run. | broken-fixed (`d19552ea`), ask not run (paid) |
| 10 | Agent browser on Brave | The agent turn that would open a site was not run (paid). Ran the opt-in `agent_browser::tests::real_browser_end_to_end` against Brave headless: consent asked for `127.0.0.1` before it loaded, snapshot, click and typing worked, the password field was refused, a link to `localhost` was refused and the test server never received it. Weaker than the brief's check: headless, consent answered by the test. | ok (scripted), in-app not run (paid) |
| 11 | Browser extension | Built (`pnpm --filter @subrosa/browser-extension build`), loaded unpacked in a throwaway Brave profile, paired with the six-digit code from Settings > Browser extension: "Ce navigateur est connecté à Sub Rosa", and Settings lists "Brave, connecté le 10 oct. 2026 à 20:17". One question: not run. Two setup traps on the way, written into `docs/browser-extension.md` (`1ac8f56a`). Then Turn off removed every host manifest. | ok up to the question, question not run (paid) |
| 12 | Memory | Extraction needs chat turns: not run. Settings > Memory showed its empty line in English inside the French app. | broken-fixed (`3389fb6b`), extraction not run (paid) |
| - | Tab titles | A new chat, a project and a new note fell back to English tab titles in the French app. | broken-fixed (`c55f8709`) |

## iPhone (simulator)

`pnpm tauri ios dev "iPhone 17 Pro"` (iOS 26.3, debug build of this branch),
key injected with `SIMCTL_CHILD_SUBROSA_DEV_API_KEY`. Driven by clicks and
drags on the Simulator window, screenshots with `simctl io`.

| Item | What was done | Result |
| ---- | ------------- | ------ |
| Chat with controls | Home and composer shown; the temporary chat removes the study and research button. The simulator holds no conversation and a turn is paid, so no reply controls were seen. | partial, rest not run (paid) |
| Study and research menu | The study button opened "Étude et recherche" with only its title and Cancel: the sheet rendered inside the composer, whose glass makes it the box a fixed layer is placed in, and the list shrank to nothing. Deep research and Review were unreachable from the iPhone chat. After the fix: turn study on, Deep research, Review. | broken-fixed (`b9386839`) |
| Projects | "+ Dossier" created a project; its menu opens Project settings with instructions, memory mode and files. No file added on the phone. | ok |
| Research | The dialog opens with Quick, Standard and Deep. Not started. | ok up to the run, run not started (paid) |
| Study and review | Study mode toggle in the sheet; Review shows its empty state. | ok |
| Library | Saved, Images and Files tabs, empty state. | ok |
| Health | Empty state, every measure off. | ok |
| Finances | A three-line synthetic CSV put in On My iPhone, picked from the Files sheet: preview read 3 lines, 0 ignored, columns guessed; import gave 42.50 spent, 200.00 received, 157.50 difference. | ok |
| Today and missions | Daily brief switch, New mission, New scheduled task shown. Nothing created. | ok (not run) |
| Shared projects behind Preview | Not run: the switch lives in the signed-in account card, and the simulator has no account. | not run (account) |

Seen on the way, not fixed: the credits card reads "108 crédits" while its
Details sheet says "Solde indisponible sur votre compte Carpe Diem" (the sheet
asks the account, which this device does not have); the Settings list moves
down when the credits card arrives, so a tap lands on the row below.

## Web

| Item | What was done | Result |
| ---- | ------------- | ------ |
| `/app` waiting screen | `pnpm --filter @subrosa/website build`, `website/dist` served on loopback with `/api/v1/me` answered by a stub account (Carpe Diem #464 is not deployed). No device record: "Make this browser one of your devices." A record without a key: "This browser needs a new key." | ok (stubbed account) |
| Python sandbox | `node website/scripts/python-sandbox-smoke.mjs chromium` with the cached headless shell: "ok chromium sandboxed" and "ok chromium direct"; every probe for a way out raised, asyncio and pandas answered. | ok |

Android was not part of this run.

## Broken, deferred

- **A debug build takes over the person's Hermes gateway.** The app registers
  the gateway as the LaunchAgent `ai.hermes.gateway` (`spawn_hermes_gateway_start`,
  `src-tauri/src/hermes_bridge.rs`), a label the debug and release builds
  share. At 20:08 the debug app rewrote `~/Library/LaunchAgents/ai.hermes.gateway.plist`
  to its own `HERMES_HOME` (`xyz.carpediem.subrosa-dev/hermes`): the
  installed app's gateway, which runs its routines, was replaced by the debug
  one until it was restored (below). The label comes from the pinned Hermes CLI; a fix means a per-build
  label there, not a local change.
- **Protected mode leaves past media on view.** With protected mode on, the
  Studio gallery still shows earlier adult renders. ADR-0084 promises new
  renders filtered and adult models hidden, not the gallery hidden; whether a
  shared device should see them is a product question for the owner of
  ADR-0084. No matrix cell changed for it.

No matrix cell changed: the failures found in parity rows (chat bar, iPhone
study and research menu, Studio under protected mode) are fixed on this
branch, which is the 1.89.1 build.

## What remains for hardware

- A voice exchange on the Mac microphone, and every voice and camera row on
  real phones, speaker on (the "Unverified" list of `docs/parity/chatgpt.md`).
- Document scanning, widgets, the watch app and Health with real data.
- Office extensions in real Office, once their gates lift.
- Every paid item above, on a key with credits above the floor: send, stop,
  edit, regenerate, branch, read aloud, reasoning switch, a project question
  on its file, quick research, a mission, temporary chat persistence, the chat
  bar question, an agent browser turn with the consent prompt in a visible
  Brave, an extension question, memory extraction, publish and unpublish with
  a signed-in account, and the iPhone reply controls.

## Side effects of this run on the Mac

- Pressing Option+Space to test the chat bar crashed the installed Sub Rosa
  1.89.0 as well (`os-june-2026-10-10-200439.ips`). It was relaunched at
  20:27; macOS's crash dialog for it may still be open. **1.89.0 crashes on
  that shortcut until 1.89.1 ships.**
- The gateway plist was put back: the debug gateway was booted out, the
  installed app relaunched and re-registered `ai.hermes.gateway` with its own
  `HERMES_HOME` (checked).
- Privacy prompts raised by the debug build (system audio for the "June"
  helper, Documents for the debug Hermes `python3.11` and the `june` relay)
  were answered "Ne pas autoriser".
- Native messaging host manifests written by the debug app were removed with
  Turn off.
- Debug data kept: the "QA parity" project and its file, one reply rating,
  protected mode turned off again. Simulator: an "AQ project" folder and three
  synthetic transactions; the CSV was removed from On My iPhone.

## Fixes on the branch from this run

| Commit | Fix | Checks |
| ------ | --- | ------ |
| `30ab6ea7` | `@tauri-apps/plugin-updater` `~2.12.0`, matching the crate | `tauri info` shows 2.12.0 on both sides |
| `0e2d5b11` | Protected mode refuses a queued Studio render before its job row exists | clippy `--all-targets -D warnings`, live re-run |
| `d19552ea` | The chat bar opens on the main thread | clippy, live re-run, no crash report |
| `3389fb6b` | Settings > Memory empty and no-match lines through `t()`, five catalogs | i18n catalog, guard and memory-settings tests |
| `c55f8709` | Fallback tab titles through `t()` | tab-bar, folders and shortcut tests |
| `1ac8f56a` | Browser extension: two pairing traps documented | |
| `b9386839` | Phone action sheets render at the shell | 39 mobile and assistant test files, live re-run |

Also run: `pnpm check` (no new warning, ratchet green), `pnpm typecheck`,
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (src-tauri),
and the iPhone simulator build of the branch with these changes.
