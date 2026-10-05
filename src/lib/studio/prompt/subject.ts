/**
 * The frozen descriptor: one sentence per character, place or object, in the
 * same words on every shot it appears in (the prompt bible's [SUBJECT]).
 *
 * The traits are stored without the name, so the descriptor is
 * `Léa, a 30-year-old woman, slim build, ...` - exactly the bible's form.
 * Older traits that start with the name are not doubled.
 */

import type { BibleEntry } from "../bible/types";

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clean(traits: string): string {
  return traits
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.;]+$/, "");
}

/** Traits with a leading copy of the name taken off ("Léa, ...", "Léa: ..."). */
export function traitsWithoutName(entry: Pick<BibleEntry, "name" | "traits">): string {
  const traits = clean(entry.traits);
  const name = entry.name.trim();
  if (!name) return traits;
  const lowered = traits.toLowerCase();
  const prefix = name.toLowerCase();
  if (lowered.startsWith(`${prefix},`) || lowered.startsWith(`${prefix}:`)) {
    return traits.slice(name.length + 1).trim();
  }
  return traits;
}

/** `Léa, <traits>.` Just the name when the bible holds no traits. */
function capitalized(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function fullDescriptor(entry: Pick<BibleEntry, "name" | "traits">): string {
  const traits = traitsWithoutName(entry);
  const name = capitalized(entry.name.trim());
  if (!traits) return name ? `${name}.` : "";
  return `${name}, ${traits}.`;
}

/**
 * What stays when the references or the opening image already carry the
 * look: the name, the distinctive mark that keeps two people apart, the main
 * garment that drifts first. The bible's reason for the mark is the same one
 * that makes it the last thing to cut.
 */
const MARK =
  /\b(scar|mole|tattoo|birthmark|freckle|freckles|streak|piercing|eyepatch|glasses|beard|moustache|mustache)\b/i;
const GARMENT =
  /\b(coat|jacket|dress|shirt|blouse|scarf|sweater|jumper|hoodie|hat|cap|uniform|suit|robe|cloak|gown|vest|trousers|jeans|skirt|boots|apron|overalls|armor|armour)\b/i;
const SHORT_LIMIT = 14;

export function shortDescriptor(entry: Pick<BibleEntry, "name" | "traits" | "kind">): string {
  const name = capitalized(entry.name.trim());
  const clauses = traitsWithoutName(entry)
    .split(/,\s*/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return name ? `${name}.` : "";
  const picked =
    entry.kind === "character"
      ? [
          clauses.find((clause) => MARK.test(clause)),
          clauses.find((clause) => GARMENT.test(clause)),
        ]
      : [clauses[0]];
  const kept: string[] = [];
  for (const clause of picked.filter((clause): clause is string => Boolean(clause))) {
    if (kept.includes(clause)) continue;
    if (words([...kept, clause].join(", ")) > SHORT_LIMIT) break;
    kept.push(clause);
  }
  if (kept.length === 0) kept.push(clauses[0]);
  return `${name}, ${kept.join(", ")}.`;
}

/** The bible's state line, after the descriptor it qualifies. */
export function stateLine(state: string | undefined): string {
  const text = state?.trim().replace(/\.$/, "");
  return text ? `State in this scene: ${text}.` : "";
}

const FRENCH_WORDS = new Set(
  "le la les un une des du de et est pas je tu il elle nous vous ils elles que qui ne mais avec pour sur dans ce cette mon ma mes ton ta son sa où ça c'est".split(
    " ",
  ),
);

/**
 * The language a line is written in, when the film does not say. A guess
 * between French and English is all the families need: no other language is
 * spoken natively by any of them.
 */
export function guessLanguage(text: string): string {
  const tokens = text.toLowerCase().match(/[a-zà-ÿœ']+/g) ?? [];
  if (/[àâçéèêëîïôûùüÿœ]/i.test(text)) return "fr";
  const french = tokens.filter((token) => FRENCH_WORDS.has(token)).length;
  return tokens.length > 0 && french / tokens.length >= 0.2 ? "fr" : "en";
}

const LANGUAGE_NAMES: Record<string, string> = {
  fr: "French",
  en: "English",
  es: "Spanish",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}
