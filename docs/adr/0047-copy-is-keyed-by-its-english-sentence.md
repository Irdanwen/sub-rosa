# ADR 0047: Copy is keyed by its English sentence, and the French is a gate

- Status: accepted
- Date: 2026-09-05

## Context

Every sentence the app shows was written in English, in the code, next to
the control it labels. The audit refused a partial translation: a screen
in one language and the next in another reads as broken, so 4.1 was "all
or nothing". "All" is some 1,700 sentences in the React shells plus the
sentences the Rust side sends to the screen as errors. The question was
how to key them, how to keep them complete, and how to make a new
sentence impossible to ship untranslated by accident.

## Decision

**The English sentence is the key.** `t("Export as PDF")` is the call;
`src/locales/fr.json` maps that sentence to its French; a sentence the
catalog does not have comes back as written. There are no invented ids
(`settings.export.pdf`) to name, look up and keep in step: the sentence
in the code is the source, readable in place, and a missing translation
is a visible English sentence, never a broken key.

- **Variables are named placeholders.** `t("{count} steps", { count })`.
  A translation may reorder them and must keep every name. Plurals are
  two sentences chosen in code (`count === 1 ? t("1 shot") : t("{count}
  shots", …)`), because the sentence is the key and a rule engine would
  have to invent one.
- **Extraction is mechanical, and so was the first pass.** A codemod over
  the TypeScript AST wrapped JSX text, the attributes that carry copy and
  the object properties and status sinks that carry copy
  (`scripts/i18n/codemod.mjs`, `literals.mjs`); a hand pass rewrote the
  runs that mixed text with expressions into templates. `extract.mjs`
  lists every `t("…")` and keeps `en.json` and `fr.json` in step with the
  code, and `pnpm i18n:check` fails CI when they are not.
- **Completeness is a test, not a promise.** `src/test/i18n-catalog.test.ts`
  refuses an empty French sentence and a placeholder set that differs
  from the English. A new sentence is a red test until it is translated.
- **Backend sentences go through the same door.** `messageFromError`
  passes every message the Rust side sends through `t()`; the literal
  ones are collected by `rust-messages.mjs` into the catalog and
  translated. A message built with `format!` keeps its English: that is
  the documented limit, and it is a short list.
- **The language is a device choice.** "System", English or French, in
  Settings on both shells, stored in localStorage and applied before the
  first render; a switch re-mounts the shell. `Intl` calls take the app's
  tag, so dates and numbers follow the sentences.

## Alternatives considered

- **Message ids.** Every sentence would have needed a name, and the code
  would show the name rather than the sentence. The English sentence is
  already a good id and the only one the writer sees.
- **A library (i18next, FormatJS).** Plural rules and ICU syntax would
  have bought little here (two languages, plurals as two sentences) and
  cost a dependency in the bundle's critical path and a second syntax in
  every string.
- **Translating at build time per locale.** Two bundles for two
  languages; the switch would be a restart. One bundle with a catalog is
  a few hundred kilobytes and switches in place.

## Consequences

- Copy specs still bind (sentence case, one voice, no typographic dashes)
  and bind the French too.
- Some copy is built at module scope (a table of rows with labels, the
  welcome page's points) and is translated when its module loads. Two
  things follow: `src/lib/i18n-boot.ts` is the shell's first import, so
  the language is decided before any component module evaluates; and a
  switch in Settings reloads the page (`chooseLocaleAndReload`) rather
  than only re-mounting the shell, so module-scope copy follows too.
- Adding a language is a JSON file and one entry in `SUPPORTED_LOCALES`.

## Addendum (2026-10-08): Rust renders its own sentences from the same catalog

Notifications are posted from Rust, often while the webview is frozen or
not loaded at all, so `messageFromError` never sees them and they were
always English. Rust now renders them itself:

- **One catalog.** `src-tauri/src/i18n.rs` compiles `src/locales/fr.json`
  in (`include_str!`) and renders `crate::tr!("…")` exactly as `t()` does:
  the English sentence is the key and the fallback (an empty translation
  counts as missing), `{name}` placeholders are named arguments, plurals
  are two sentences chosen in code.
- **The macro takes a literal**, so the extractor sees every sentence:
  `scripts/i18n/rust-sentences.mjs` collects `tr!` literals beside the
  `AppError::new` ones (comments skipped), `pnpm i18n:extract` writes
  `backend-messages.json` itself, and `pnpm i18n:check` now fails when that
  file is behind the Rust source. It was: six Code mode errors had never
  reached the catalog.
- **The language is the webview's.** The webview resolves the choice
  (`system` included) and tells Rust at every boot (`i18n_set_locale`,
  `src/lib/i18n-native.ts`); Rust keeps it in `locale.json` so a
  background launch that posts before the webview loads speaks it too.
  With nothing stored, the system's language decides. A switch reloads the
  page, so the boot covers it.
- **What stays as it came.** Text a person or a model wrote (a note title,
  a result summary, a provider's error) is never translated. A stored run
  failure keeps its English in the row, because the webview and every
  device translate that sentence themselves, and `translate_known` renders
  it for the notification. The meeting brief asks the model to write in the
  app's language.

## Addendum (2026-10-08): German, Italian, Spanish and Brazilian Portuguese

The app now speaks six languages: English, French, German (`de`), Italian
(`it`), Spanish (`es`) and Brazilian Portuguese (`pt-BR`). Nothing about the
key changed; what changed is how many catalogs the gate holds and how the
person reaches them.

- **Every catalog is a gate.** `extract.mjs` keeps `fr`, `de`, `it`, `es`
  and `pt-BR` in step with the code, and `pnpm i18n:check` fails when any
  of them has an empty sentence. `scripts/i18n/verify-catalogs.mjs` is the
  quality gate the catalog test and the check both run: same placeholder
  set, no en or em dash, no product name lost, and no sentence of more than
  three words left identical to its English (the rare legitimate one, a
  command or a sample, is listed in `untranslated-ok.json`).
- **A glossary per language** (`scripts/i18n/glossary.<lang>.json`) records
  the register (du in German, tu in Italian, tú in neutral Spanish, você in
  Brazilian Portuguese, the address of the reader modern apps use there),
  the product names that never change, and the agreed word for each
  recurring noun. Its term check prints warnings, never fails: inflection,
  compounds and a natural rephrasing make it a reading aid, not a gate.
- **Hermes is never shown** in the new languages, including where the
  French still carries the name in a diagnostic sentence.
- **The system decides by its language subtag.** `de-CH` reads German, and
  any Portuguese (`pt-PT` too) reads the Brazilian catalog, the only
  Portuguese the app has. `localeFromTag` (TypeScript) and
  `Locale::from_tag` (Rust) agree on it, and `locale.json` stores the
  webview's code (`"pt-BR"`).
- **All six catalogs ship in the bundle,** statically imported, about 2.4 MB
  of JSON before compression. Loading a catalog on demand would make the
  boot asynchronous, and module-scope copy (the reason `i18n-boot.ts` is the
  first import) needs the language decided synchronously. Rust compiles in
  the same files and parses only the one it speaks, on first use.
- **The picker names each language in itself** ("Deutsch", "Português
  (Brasil)") so a person who landed in a language they cannot read still
  finds theirs, and became a list (a select on the desktop, an option sheet
  on the phone): six names do not fit a segmented control.
- **Intl follows:** `intlLocale()` maps each language to its tag (`de-DE`,
  `it-IT`, `es-ES`, `pt-BR`), and the page's `lang` attribute is set too.
- **The native strings follow the same list:** the iOS widgets, the watch
  app, its complication and the Shortcuts actions have a `.lproj` per
  language (declared in `CFBundleLocalizations` and the project's known
  regions), the Android widget and notifications have `values-de`,
  `values-it`, `values-es` and `values-pt-rBR`, and the browser extension
  has `_locales/{de,it,es,pt_BR}`. Tests hold each of them to the full list.

Adding a seventh language is now: the catalog, its glossary, one entry in
`SUPPORTED_LOCALES` and `TRANSLATED_LOCALES`, one arm in `Locale`, and the
native tables.

## Addendum (2026-10-08): one sentence per sense, and the permission prompts

- **A word with two senses gets two sentences.** The key is the English, so
  an English word that is both a verb and a noun shares one translation and
  reads wrong in one place. "Archive" stays the action (Archiver,
  Archivieren); the settings section that writes the archive of ADR-0042 is
  "Archive file". "Shortcuts" stays the desktop's keyboard shortcuts; the
  phone's group is "Shortcuts app" on the iPhone (Apple's app, whose name
  differs per language: Kurzbefehle, Comandi Rapidi) and "Automation
  shortcuts" on Android. The shared Archive folder is data, found by its
  stored name, and is not copy. `src/test/i18n-ambiguous-words.test.ts`
  pins the split. When a word reads differently in two places, split the
  English rather than pick the less wrong translation.
- **The permission prompts are translated too.** The usage descriptions
  live in `os-june_iOS/<lang>.lproj/InfoPlist.strings`, a variant group of
  the app target (XcodeGen finds it under the `os-june_iOS` source path),
  and the Mac app ships the same files through `bundle.macOS.files` into
  `Contents/Resources/<lang>.lproj`. The plists keep the English as the
  fallback; `src/test/ios-privacy-usage.test.ts` holds every language to
  every key either plist declares.
