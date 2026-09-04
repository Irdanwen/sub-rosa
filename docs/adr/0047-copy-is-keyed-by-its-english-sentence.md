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
