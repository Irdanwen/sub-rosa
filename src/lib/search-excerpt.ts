/**
 * The excerpt the search engine returns wraps each hit in \u0001 and \u0002
 * so the webview never has to trust markup from the database. The palette
 * shows plain text, so the markers go and the whitespace is collapsed.
 */
const SEARCH_HIT_START = String.fromCharCode(1);
const SEARCH_HIT_END = String.fromCharCode(2);

export function searchExcerptText(excerpt: string) {
  return excerpt
    .split(SEARCH_HIT_START)
    .join("")
    .split(SEARCH_HIT_END)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
