# Roadmap

The sequenced list of what Sub Rosa still lacks, with a gate per item: a
command, a test or a metric that says when it is done. It was written on
2026-09-02 against v1.58.0 (the full reasoning, the rubric and the refusals
are in `plan-amelioration.html` at the repository root, which is not
committed), and it is ticked here. An item is ticked when its gate holds on
`main`, not when its code lands.

Legend: `[x]` done and gated · `[~]` partly done, remainder named · `[ ]` open.

## Palier 0 · Sans code (une heure)

- [x] 0.1 Protéger `main` et allumer les scanners. Ruleset `main` (deletion,
  non-fast-forward, `Repository hygiene` required; admin bypass keeps the
  direct-push release ritual), secret scanning + push protection +
  Dependabot alerts and security updates on. Gate: `gh api repos/Irdanwen/sub-rosa/rulesets --jq length` ≥ 1.
- [x] 0.2 Débloquer la synchronisation upstream. Superseded by ADR-0040: the
  weekly job files an "Upstream digest" (run summary + artifact; issue when
  a `DIGEST_TOKEN` PAT exists). Gate: the `Upstream digest` run is green.
- [x] 0.3 Un seul lockfile. `bun.lock` gone; `repository-hygiene.yml`
  refuses a second one.
- [x] 0.4 Enterrer les workflows d'un serveur que le fork n'a pas. 10 workflows.
- [x] 0.5 `HANDOFF.md` dit vrai.

## Palier 1 · Le flux redevient sûr (une semaine)

- [~] 1.1 Solder le backlog Dependabot. npm and cargo brought to where the
  PRs pointed; Dependabot groups minors and patches. Held, with the reason in
  `.github/dependabot.yml`: jsdom 26+ (accessible-name computation), React 19
  (a migration). Not attempted yet: cpal 0.18, sqlx-sqlite 0.9. Gate: no
  Dependabot PR older than 14 days (open PRs are the new grouped ones).
- [x] 1.2 iOS et Windows compilent sur chaque PR (`ios-check`, `windows-check`).
- [~] 1.3 La couverture devient un cliquet. Frontend floor 75.83 % checked on
  every PR (`coverage-floor.json`). The Rust floor is written after the
  first scheduled macOS run; until then the check passes with "no floor".
- [x] 1.4 Une release dit ce qu'elle change. Notes from commit subjects on the
  GitHub release and in `latest.json`; the update card shows them.
- [~] 1.5 Le Rust du desktop sous les mêmes lints que le backend. `[lints]`
  on `src-tauri`: no unwrap/expect/todo/dbg/stdout in production code.
  Deliberately not on: `pedantic`, `panic` (no test exemption),
  `unsafe_op_in_unsafe_fn` (the FFI bridges wrap their calls first).
- [x] 1.6 Décider du suivi upstream, une fois. ADR-0040; the sidecar takes
  its credentials on stdin (`tests/sidecar_secrets_on_stdin.rs`).
- [x] 1.7 Le log de dictée cesse de grossir (`app_paths::open_capped_log`).

## Palier 2 · Ce que l'utilisateur sent chaque jour (deux semaines)

- [x] 2.1 Une recherche qui lit les notes. Migration 020 (FTS5),
  `search_everything`, the palette's "In your notes", the phone's search,
  agent-lite's `search_notes`; `list_notes` honours its cursor. Gate:
  `tests/search.rs` (a word in the thousandth note, under 50 ms).
- [x] 2.2 Une archive complète, restaurable, chiffrable. `archive.rs`: a tar
  of every table as JSON lines plus a Markdown copy of each note, sealed
  with age on request; upsert on import (ADR-0042). Gate: `tests/archive.rs`
  (round trip, idempotence, wrong passphrase refused). Open: the phone
  exports through the share sheet (it imports already).
- [x] 2.3 Hors ligne : un état dit, une reprise en un geste
  (`carpe_diem_probe_upstream`, `list_notes_failed_in_transit`, the banner
  with "Retry all"; nothing retries on its own, ADR-0018).
- [x] 2.4 Un seul premier lancement (welcome, key, permissions, practice,
  first note; the failed gate offers "Try again").
- [x] 2.5 Un diagnostic qu'on peut joindre (Settings › Reports › Export
  diagnostics: a dated folder, every byte through `redact`).
- [~] 2.6 Réglages › Stockage. Seven buckets measured; the audio of
  transcribed notes older than N days can be removed, previewed first.
  The agent runtime's own state is shown, not pruned (it is the runtime's).
- [x] 2.7 Windows dit ce qu'il n'a pas. `platform_capabilities` is the map;
  the dictation settings read it. Other `isMacLikePlatform()` gates migrate
  as they are touched.
  Done 2026-09-04. The two gates that were about a capability (system audio in the note editor, the dictation hotkey in the dictation view) read Rust's answer now, with the platform predicate only filling the frame before it lands. The five that remain (`App.tsx`, onboarding, permission steps, `AppSettings`) describe what the platform looks like, not what it can do, and stay.
- [x] 2.8 Une note que l'agent complète se recharge (the event names its
  notes; the open note reloads; refreshing the list keeps the selection).
- [x] 2.9 Les douze onglets masqués : cinq sont revenus, sept sont supprimés.

## Palier 3 · La structure (un mois)

- [x] 3.1 Cinq parcours au niveau de l'application (before 3.2).
  Done 2026-09-04. `src/test/app-journeys.test.tsx` drives the rendered desktop shell over a fake bridge (`src/test/helpers/fake-bridge.ts` keeps every constant of the real module and stubs every binding a journey does not script): launch and open a note; find a note by a word inside it from the palette; ask the notes a question and open the cited note; reach Settings › Storage (loaded on demand) and read the sizes; be told you are offline, then retry every waiting note once the connection is back. The class of bug they exist for is the one a release shipped once: every part works, the assembly does not.
- [~] 3.2 Aucun fichier de plus de 2 000 lignes. The ratchet is in place
  (`file-size-ratchet.json`, `src/test/file-size-ratchet.test.ts`): the ten
  files above the ceiling may only shrink. The splitting itself is open.
- [~] 3.3 Les règles rétrogradées redeviennent des règles. The ratchet is in
  place (`biome-warnings.json`, `pnpm check:ratchet` in CI): 631 warnings
  across 27 rules may only go down. Promote a rule to `error` at zero.
- [x] 3.4 Le clavier et le focus, une seule fois.
  Done 2026-09-04. `src/lib/modal-focus.ts` holds the four rules (focus in, Tab kept inside, Escape closes, focus back) and a stack so only the top surface listens; the dialog primitive, the ⌘K palette, the ask panel and the phone sheets (actions, model picker, media preview) use it and nothing else. Spec: `spec/modal-focus.md`; the rewrite proposal and the trace drawer are named as non-modal exceptions.
- [x] 3.5 Charger ce qu'on regarde (measure first).
  Done 2026-09-04. Measured first: the root chunk carried 2.3 MB minified, of which the editor (prosemirror + tiptap), the animation runtime and the flow canvas were the largest vendor parts. Now `src/main.tsx` loads the desktop and phone shells as separate chunks, `src/app/lazy-views.tsx` loads Settings and the Studio the first time they open, and `vite.config.ts` splits vendor code into `editor`, `motion`, `flow` and `react` chunks that only change on their own schedule.
- [x] 3.6 Les invariants Rust deviennent des specs (six files,
  `spec-guards.test.ts`).
- [x] 3.7 La documentation se remet d'accord avec le produit. ADR-0040,
  ADR-0041, ADR-0042, addendum 0009, this file, seven CONTEXT.md terms and
  the release-channel term fixed. Done 2026-09-04: the 0003 collision is
  resolved (the fork's image ADR is 0045, indexed, superseded with a line
  to the media MCP) and ADR-0011 carries its addendum (void since
  ADR-0029). Gate: `ls docs/adr | cut -d- -f1 | sort | uniq -d` is empty.

## Palier 4 · Après, et seulement après

- [ ] 4.1 Le français, en entier ou pas (after 3.2, strictly).
- [ ] 4.2 L'extension de partage iOS.
- [x] 4.3 Le téléphone règle ce que le poste règle. Privacy, Archive and
  About reached the phone by reusing the desktop sections. Open: Models,
  Reports, and the desktop's own "Export as Markdown".
  Done 2026-09-04, with one part deferred. The phone reaches Reports (`ReportsScreen`: the diagnostics text, readable, then the share sheet through `diagnostics_report_text` + `share_text`); the desktop exports a note as Markdown next to the PDF button (`note_export.rs`, native save dialog in Rust, ADR-0037's stored Markdown with the title as heading). Deferred: a Models page on the phone. The desktop tab is a picker over AppSettings' own state, and the phone already picks a model per chat, per flow and per Studio panel through `ModelSheet`; a second, global picker would be a second source of truth until the desktop tab is itself extracted from AppSettings (3.2).
- [x] 4.4 Prévenir quand la fenêtre n'est pas devant (`desktop_should_notify`:
  Studio work only, window away, wait over two minutes; the desktop asks
  for permission when a render is queued).
- [x] 4.5 Un modèle d'extraction pour la mémoire (Settings › Memory).
- [x] 4.6 L'ADR Dictation (ADR-0041).
- [x] 4.7 Mesurer le démarrage avant d'y toucher.
  Done 2026-09-04. `diagnostics::mark` records launch milestones (run, database open, migrations, sidecar setup) in the log and in the diagnostics report. Measured, then touched: `schema_migrations` (in `db/migrations.rs`) records each file with its checksum, so a launch replays only files it has not seen; the `ensure_column` catch-ups still run.
## Ce qui rend Sub Rosa singulier (au-delà du plan)

Two features the plan did not list, chosen because each one is a claim the
product makes that no other tool makes checkable.

- [x] S.1 Le registre de ce qui est parti. Settings › Privacy shows, under the
  list of hosts the app *can* reach, the record of what it *did* send: one
  row per request, shapes never contents, ninety days (ADR-0043). Gate:
  `tests/egress_ledger.rs`; the card's sentence and rows in
  `egress-ledger-card.test.tsx`.
- [x] S.2 Interroger ses notes, avec citations. A question over the corpus
  answered from the notes themselves, each claim linked to the note and the
  turn it comes from, the excerpts sent to the model listed on screen (and
  in the ledger). Builds on the FTS5 index (2.1) and the memory embeddings
  path (ADR-0009). Gate: an answer cites a note; the ledger row for the
  question names the note ids it sent.
  Done 2026-09-04 (ADR-0044): `src-tauri/src/ask/`, the "Ask" group of the
  ⌘K palette and the "Ask your notes" button under the phone's search; the
  panel lists what was sent; the ledger row says `ask` (task-local scope in
  `egress_ledger.rs`) and names the note when one note fed every passage.
  Closed 2026-09-04 (ADR-0046): passages of every note are embedded in the
  background and the answer fuses the lexical and the semantic rankings;
  Settings › Privacy carries the setting and the counts.

## Ce qui ne sera pas fait

Thirteen refusals, each carried by a decision: encryption at rest
(ADR-0039), cloud sync, the council on iPhone (ADR-0034), ffmpeg
(ADR-0026), streaming through june-api (ADR-0015/0027), full mobile parity,
partial i18n, Windows code signing, the app stores, the Videomaker watchdog
(ADR-0029), shrinking the DMG without a measurement, live-preview phases
2 and 3 (ADR-0002), and the sidecar token on stdin before the upstream
decision (now taken, and done).
