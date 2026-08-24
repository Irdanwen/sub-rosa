/** The two things every generator here needs, and nothing else. */

/** XML text and attribute escaping. Both directions of quote, deliberately:
 * an attribute written with double quotes still has to survive a name that
 * contains one, and a shot name comes from a user's prompt. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `key="value"` pairs, skipping anything undefined, in the order given. */
export function attrs(pairs: Record<string, string | number | undefined>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");
}
