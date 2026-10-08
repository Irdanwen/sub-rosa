/**
 * Rust's text semantics, where the writers depend on them: the TypeScript
 * port of the app's Office writers (ADR-0090) must write the same bytes of
 * XML for the same request, so trimming, splitting into lines, counting
 * characters and printing a number follow `str` and `f64` exactly, not
 * JavaScript's habits (UTF-16 lengths, `1e+21`).
 */

const WHITE = /\p{White_Space}/u;
const ALNUM = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u;
const CONTROL = /\p{Cc}/u;

export const isWhitespace = (c: string) => WHITE.test(c);
export const isAlphanumeric = (c: string) => ALNUM.test(c);
export const isControl = (c: string) => CONTROL.test(c);

/** Code points, as Rust's `chars()`. */
export const chars = (text: string): string[] => Array.from(text);

/** `chars().take(max).collect()`. */
export const take = (text: string, max: number): string => chars(text).slice(0, max).join("");

export function trimStart(text: string): string {
  return text.replace(/^\p{White_Space}+/u, "");
}
export function trimEnd(text: string): string {
  return text.replace(/\p{White_Space}+$/u, "");
}
export const trim = (text: string): string => trimEnd(trimStart(text));

/** `split_whitespace()`. */
export const words = (text: string): string[] => text.split(/\p{White_Space}+/u).filter(Boolean);

/** `str::lines()`: on `\n`, a trailing `\r` dropped, no final empty line. */
export function lines(text: string): string[] {
  if (!text) return [];
  const out = text.split("\n");
  if (text.endsWith("\n")) out.pop();
  return out.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** `trim_matches(c)` for one character. */
export function trimMatches(text: string, c: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === c) start++;
  while (end > start && text[end - 1] === c) end--;
  return text.slice(start, end);
}

/** `to_ascii_lowercase()` / `to_ascii_uppercase()`. */
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const asciiUpper = (text: string) => text.replace(/[a-z]/g, (c) => c.toUpperCase());

/** The shortest digits of `n` and the exponent of its first one. */
function expanded(n: number): string {
  const text = String(n);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, first, rest = "", exponent] = match;
  const digits = first + rest;
  const point = 1 + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** `format!("{n}")` for an `f64`: the shortest digits, never an exponent. */
export function rustFloat(n: number): string {
  if (Object.is(n, -0)) return "-0";
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  return expanded(n);
}

/** `serde_json`'s text for a JSON number: an integer as it is, a float as
 * ryu prints it (`1e21`, `1.5e-7`). */
export function jsonNumber(n: number): string {
  return String(n).replace("e+", "e");
}

/** `serde_json::to_string` of a value: compact, object keys sorted (the app's
 * `serde_json` has no `preserve_order`). */
export function jsonCompact(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return jsonNumber(value);
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(jsonCompact).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${jsonCompact(item)}`).join(",")}}`;
}

/** `xml_text`: escaped, tabs as spaces, the characters XML 1.0 refuses dropped. */
export function xmlText(text: string): string {
  let out = "";
  for (const c of text) {
    if (c === "&") out += "&amp;";
    else if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else if (c === "\t") out += " ";
    else {
      const code = c.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0xfffe || code === 0xffff) continue;
      out += c;
    }
  }
  return out;
}

/** A JSON value, as `serde_json::Value` is read by the writers. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isObject = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** `as_u64`: a non-negative integer, or undefined. */
export const asU64 = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
