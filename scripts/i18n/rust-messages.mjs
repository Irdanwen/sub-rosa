#!/usr/bin/env node
/**
 * Writes the Rust side's sentences (see rust-sentences.mjs) to
 * src/locales/backend-messages.json. `pnpm i18n:extract` does this too, and
 * `pnpm i18n:check` fails when the file is behind the code.
 *
 *   node scripts/i18n/rust-messages.mjs
 */
import { writeFileSync } from "node:fs";
import { collectRustSentences } from "./rust-sentences.mjs";

const list = collectRustSentences();
writeFileSync("src/locales/backend-messages.json", `${JSON.stringify(list, null, 2)}\n`);
console.log(`${list.length} backend sentences`);
