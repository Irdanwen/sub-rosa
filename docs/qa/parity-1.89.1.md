# Parity verification for 1.89.1, 10 October 2026

What the integration branch `fix/parity-audit-int` gives a person, tried for
real on this Mac (W9 of the parity audit). Branch commit at the start:
`533830ac`. Every line below is something seen happen; what could not be run
says why. Evidence: [`evidence/parity-1.89.1/`](evidence/parity-1.89.1/).

## Credits

**First pass (19:46 to 20:50): no paid action.** The brief set a floor of
132.6 available credits, and the balance was already 110.22 before the first
action, so nothing paid was started. The floor was wrong: the 147.64 given at
19:35 included 33.5 pending credits that settled, and the drop was not this
run's.

**Second pass (20:54 to 21:30): paid checks.** New rule: this run's own spend
may reach 15 credits, and paid actions stop if available drops under 85. The
tally is every usage event of the key after the last event seen before the
pass (id 236277), read from Carpe Diem's read-only ledger
(`GET /api/operator/buyer/usage`), with the two recurring outside series left
out (below). Neither limit was reached.

| When  | Available | Pending | This run's tally | Note |
| ----- | --------- | ------- | ---------------- | ---- |
| 19:35 | 147.64 | | | figure given in the brief |
| 19:46 | 110.22 | | 0 | first pass starts |
| 20:50 | 107.69 | | 0 | first pass ends |
| 20:54 | 107.69 | 73.44 | 0 | second pass starts |
| 21:30 | 101.35 | 79.78 | **5.32** | second pass ends; outside spend over the pass 1.02 |

What the 5.32 credits paid for: chat turns on `z-ai-glm-5-3-flash` (about
0.2 each, the runtime's 28k-token context), one read aloud on `tts-kokoro`
(0.001), memory extraction and recall (0.01 and embeddings), chat titles
(`zai-org-glm-5-2`, 0.1), the reflex model (`jev-latest`, 0.001 each), the
mission (0.09), and the quick research (2.91: one search, five page reads at
0.46 each, five model calls; the dialog had estimated at most $0.06).

**The outside spend.** The ledger carries no key or client field, so it says
what was spent, not by whom. Two series ran on this key all evening
independently of this run: `gemini-3-5-flash` with exactly 1272 prompt tokens
every 15 minutes (about 0.45 each), and `openai-gpt-4o-mini` with 12 prompt
tokens through the OpenRouter rail every 24 minutes (0.001). Both look like
scheduled jobs. The drop before this run (19:33 to 19:42) was eight
`claude-fable-5-1` turns of 11k to 19k tokens (53.7 credits)
and five image generations (15.4): someone's interactive session on the
same key, not this run, which had not started.

## Desktop (debug build from source)

`SUBROSA_DEV_API_KEY=… pnpm tauri:dev`, data folder
`xyz.carpediem.subrosa-dev`. Driven with macOS screenshots, CoreGraphics clicks
and System Events keystrokes (no `cliclick` on this Mac), the extension with
Playwright on Brave.

| # | Item | What was done | Result |
| - | ---- | ------------- | ------ |
| 0 | Starting the app | `pnpm tauri:dev` printed "Found version mismatched Tauri packages: tauri-plugin-updater 2.12.0, @tauri-apps/plugin-updater 2.11.0". `tauri build`, which `release.yml` runs through tauri-action, stops on that error. | broken-fixed (`30ab6ea7`) |
| 1 | Chat controls | Send: "hello" came back. Stop: a count to 300 stopped at 134 and the turn ended there. Edit: the stopped question edited in place to "count to 5" and answered. Regenerate: one more answer on the same question. Branch from here: "hello #2" opened with the history, but showed the runtime's model-switch note "[System: The active model for this chat has changed to …]" as a message the person had sent, and hid Regenerate under it; fixed, the note is gone and Regenerate is back. Read aloud: one `tts-kokoro` request, the button went to Stop and back. Rate: thumbs down with "Trop longue" wrote `rating=down, reason=too_long`; thumbs up and Copy as in the first pass. Context gauge: "Environ 4K jetons utilisés". Effort switch: shown for `zai-org-glm-5-2` (not for the flash model), "Effort faible" chosen; the switch notice was in English, fixed. No turn was sent at the lower effort. | ok after two fixes (`0e811e34`, `c43f6d04`) |
| 2 | Project with instructions and a file | Created "QA parity", instructions saved, a text file added through the native picker ("62 caractères lus"), both rows in `project_settings` / `project_files`. The question that needs the file was not in the second pass's list. | ok up to the question, question not run |
| 3 | Deep research, quick | "In what year was the Eiffel Tower completed?", Quick, notes off. The plan showed the cost ceiling ($0.06), then the report landed in notes citing 4 sources (one unreadable page marked), with Markdown, PDF and Word export. Cost 2.91 credits. Seen: "1 recherches web" in the plan's cost lines. | ok |
| 4 | Mission run now | Today > New mission, no tools, Run now: the run went through the runtime's scheduler ("[assignment] QA mission W9 completed successfully") and its answer appeared under "À examiner" with Approve and Refuse after about 90 s. Seen: the card kept "Exécution en cours" and the history still said "Cette mission ne s'est pas encore exécutée" while the result was waiting for review. | ok, stale status line |
| 5 | Publish a note | Skipped: publishing needs a signed-in account in the debug build, and signing in needs the person's mail or passkey. Read-only against production: `https://pages.subrosa.furetier.com/p/<unknown>` answers 404 with `content-security-policy: default-src 'none'`, `GET /api/v1/catalog/assistants` answers `{"data":[]}`. | not run (account) |
| 6 | Temporary chat | The composer drops Study and Deep research; one message ("…TMPW9…") answered "ok", and the chat stayed out of the sidebar. While open it is an `agent_tasks` row with `ephemeral = 1` and one Hermes session, by design (ADR-0083). After leaving it: `agent_tasks` 0, `agent_messages` 0, `memories` 0, notes unchanged (1), the Hermes session deleted (`state.db` back to 8 sessions and 39 messages), nothing new under `hermes/sessions/`. One trace stays: the runtime's `hermes/logs/agent.log` keeps the message's first 80 characters (deferred, below). | ok, one log trace (deferred) |
| 7 | Protected mode | Turned on with a code, image and video generation off. `/image a red apple` in chat answers "La génération d'images n'est pas disponible": the upstream flag `IMAGE_GENERATION_ENABLED = false`, not protected mode, so a picture asked in chat goes through an agent turn (paid, not run). Studio > Image > Generate under the same settings: the notice "Le mode protégé a désactivé la génération d'images et de vidéos" appeared, but a `media_jobs` row was left `failed` with "The submission was interrupted. Check your provider history…", shown as a banner after the next launch, for a render that never left. After the fix: the notice, and 0 rows. | broken-fixed (`0e2d5b11`) |
| 8 | Voice, one exchange | Skipped: the Mac microphone permission is not granted for the debug helper. | not run (permission) |
| 9 | Global chat bar | Option+Space crashed the app (`EXC_BREAKPOINT`, "Must only be used from the main thread", `order_front_as_key < chat_bar::show < listen_to_helper < dictation::handle_helper_event_line`). The installed 1.89.0 crashed on the same press with the same stack. After the fix: the bar opens over Finder without bringing the app forward, and "pong" came back to a one-word question, with New chat and Open in Sub Rosa. | broken-fixed (`d19552ea`) |
| 10 | Agent browser on Brave | "Open https://example.com … tell me its main heading": a visible Brave window opened on `about:blank` and stayed there while the app asked "Autoriser Sub Rosa à utiliser example.com dans le navigateur de l'agent ?". The first try then hung: during the wait the runtime's keepalive ping to the `june_browser` MCP server went unanswered (the server handled one message at a time), the runtime force-killed it, and the turn stayed on "Browsed" forever. Fixed; second try: consent "this time", the page loaded, the answer named "Example Domain" from the page. Also the opt-in `real_browser_end_to_end` test passed against Brave headless (a refused site never received a request). Seen: the agent first tried the runtime's own browser tool, which failed to start, before using the app's; the tool row reads "Browsed" in English (deferred). | broken-fixed (`6687c2ce`) |
| 11 | Browser extension | Built (`pnpm --filter @subrosa/browser-extension build`), loaded unpacked in a throwaway Brave profile, paired with the six-digit code from Settings > Browser extension: "Ce navigateur est connecté à Sub Rosa", and Settings lists "Brave, connecté le 10 oct. 2026 à 20:17". Second pass: paired again, one question with "Inclure cette page" off answered "pong", and the panel said the chat is also in the app's list. The page-reading actions were not tried (they need the toolbar click that grants `activeTab`). Two setup traps on the way, written into `docs/browser-extension.md` (`1ac8f56a`). | ok |
| 12 | Memory | "Please remember for the future: my favourite tea is genmaicha." The reflex picked it up on the first reply (no cadence wait): Settings > Memory lists "My favourite tea is genmaicha.", learned from a conversation, importance 6. The empty line had been in English inside the French app. | ok, empty line broken-fixed (`3389fb6b`) |
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

Of the list below, the first four were fixed on this branch after the run
(W10): the tool activity labels now read through `t()`
(`src/lib/agent-tool-label-text.ts`), the mission card follows the real run
state (`AssignmentDetail.tsx`), the guard plugin redacts a temporary chat's
words from `agent.log` (ADR-0083 addendum), and the runtime's own browser
toolset is switched off in the rendered config (ADR-0094 addendum). The
gateway label and the gallery question remain as written.


- **A debug build takes over the person's Hermes gateway.** The app registers
  the gateway as the LaunchAgent `ai.hermes.gateway` (`spawn_hermes_gateway_start`,
  `src-tauri/src/hermes_bridge.rs`), a label the debug and release builds
  share. At 20:08 the debug app rewrote `~/Library/LaunchAgents/ai.hermes.gateway.plist`
  to its own `HERMES_HOME` (`xyz.carpediem.subrosa-dev/hermes`): the
  installed app's gateway, which runs its routines, was replaced by the debug
  one until it was restored (below). The label comes from the pinned Hermes CLI; a fix means a per-build
  label there, not a local change.
- **A temporary chat leaves its first words in the runtime's log.** The
  pinned runtime logs every turn at INFO with the first 80 characters of the
  message (`agent/turn_context.py`, "conversation turn: … msg=…") into
  `hermes/logs/agent.log` under the app's data folder. After the temporary
  chat was left, the database rows and the Hermes session were gone, but that
  line stayed. ADR-0083 promises a temporary chat is not saved; a fix is a
  logging filter in the app's runtime plugin or an upstream change, not a
  small local one.
- **Tool activity labels are English.** "Browsed", "Ran command", "Searched
  the web" and the rest come from `src/lib/agent-tool-labels.ts` and are
  rendered as they are (`AgentWorkspace.tsx`, `settledToolLabel(name)`); they
  are also the keys that classify the activity, so translating them means a
  display mapping with literal `t()` calls and about 28 sentences in five
  catalogs.
- **The mission card keeps "running" after its result arrives** (row 4).
- **The agent tries the runtime's own browser tool first** (row 10), which
  fails to start inside the app's sandbox, and only then the app's browser.
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
- Not hardware, but still not run: a project question answered from its
  file, a turn sent at a lower reasoning effort, the extension's page actions,
  publish and unpublish with a signed-in account, shared projects behind
  Preview, and the iPhone reply controls (the simulator holds no
  conversation).

## Side effects of this run on the Mac

- Pressing Option+Space to test the chat bar crashed the installed Sub Rosa
  1.89.0 too, twice: at 20:04 (`os-june-2026-10-10-200439.ips`) and at 21:13
  during the second pass (`os-june-2026-10-10-211306.ips`), because both apps
  hold the same shortcut. It was relaunched each time (last at 21:29); macOS's
  crash dialogs may still be open. **1.89.0 crashes on that shortcut until
  1.89.1 ships.**
- At the start of the second pass the installed app was running and its
  gateway LaunchAgent was active with its own `HERMES_HOME`; the debug app
  took it over again at its launch. At the end the plist saved at the start
  was put back and bootstrapped (`launchctl bootout`, then `bootstrap`), and
  checked: `ai.hermes.gateway` runs the installed app's Python with
  `HERMES_HOME=…/xyz.carpediem.subrosa/hermes`.
- Privacy prompts raised by the debug build (system audio for the "June"
  helper, Documents for the debug Hermes `python3.11` and the `june` relay)
  were answered "Ne pas autoriser".
- Native messaging host manifests written by the debug app (Chrome, Edge,
  Brave, Firefox) were removed; none existed before the run.
- Debug data kept: the "QA parity" project and its file, the test chats,
  two reply ratings, the genmaicha memory, the "QA mission W9" mission (daily
  at 09:00 while the debug app is open), the research report note,
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
| `0e811e34` | The runtime's model-switch note stays out of the transcript, and Regenerate backs up through it | new tests in `agent-chat-runtime` and `hermes-turn-rewrite`, agent workspace suite, live re-run |
| `c43f6d04` | Model switch notices through `t()`, five catalogs | model-switch, i18n and agent workspace tests |
| `6687c2ce` | The `june_browser` MCP server answers ping while a call waits for consent | a proxy holding the call 4 s: ping answered at once (the old script answered after the call), live re-run |

Also run: `pnpm check` (no new warning, ratchet green), `pnpm typecheck`,
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (src-tauri),
and the iPhone simulator build of the branch with these changes.
