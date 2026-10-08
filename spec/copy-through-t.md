# Copy goes through `t()`

## Rule

Every sentence a person can read on screen is written in English in the
code and passed through `t()` from `src/lib/i18n.ts`: JSX text, the
attributes that carry copy (`aria-label`, `title`, `placeholder`, `label`,
`description`, …), the object properties and status sinks that carry copy,
and the messages the Rust side sends as `AppError` literals. Variables are
`{name}` placeholders; plurals are two sentences chosen in code. The
French catalog (`src/locales/fr.json`) has every sentence, translated, with
the same placeholders.

## Why

The audit refused a partial translation: a screen in one language and the
next in another reads as broken (ADR-0047). The sentence in the code is
the key, so a missing translation is a visible English sentence rather
than a broken id, and the gate turns a new untranslated sentence into a
red test before it ships.

## How to apply

- Write the sentence in English, in place: `t("Export as PDF")`,
  `t("{count} steps", { count })`. Never build a sentence from fragments
  joined at runtime; give the translator the whole sentence.
- Run `pnpm i18n:extract` after adding copy; it adds the sentence to
  `en.json` and an empty entry to `fr.json`. Fill the French. The gate
  `src/test/i18n-catalog.test.ts` refuses an empty or placeholder-mismatched
  entry, and `src/test/i18n-guard.test.mjs` refuses bare copy left outside
  `t()`.
- Dates and numbers format with `intlLocale()`, never a hard-coded tag.
- A backend sentence: write it as a literal in `AppError::new(code, "…")`,
  then run `pnpm i18n:extract` (it collects the Rust literals too).
- A sentence Rust shows by itself (a notification): `crate::tr!("…")`, with
  `{name}` placeholders as named arguments (`tr!("{count} notes", count =
  n)`), never `format!` on English text. `pnpm i18n:check` fails until it
  is in the catalog and translated.

## Exceptions

- Code, identifiers, shortcuts, URLs and example values (`cdm_…`,
  `owner/repo`, `0 9 * * 1-5`) are not copy.
- Text inside `<code>`, `<kbd>` and `<pre>`.
- A backend message built with `format!` keeps its English; keep those
  rare and make the literal part carry the meaning.
- Studio prompts stored with an artifact (`prompt: "Upscaled image (x2)"`)
  are data saved with the file, not copy.
