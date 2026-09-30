/**
 * Whether this copy of the app may show a link to buy credits on the web.
 *
 * Two independent answers have to be yes. The store that installed the app
 * must allow pointing to a purchase outside it, for the storefront the person
 * is on: Apple only in the United States, Google Play the same, a computer or
 * a sideloaded Android app always. And Carpe Diem must sell there at all: it
 * refuses a list of countries (the United States among them today), and a
 * link that lands on a refusal is worse than no link.
 *
 * Unknown is no. Where the answer is no, the app shows the balance and
 * nothing else: no button, no sentence about buying elsewhere.
 */

export type StoreContext = {
  platform: "desktop" | "ios" | "android";
  distribution: "app-store" | "play" | "direct" | "unknown";
  /** ISO 3166-1 alpha-2, when the store says. */
  storefront?: string | null;
};

/** Storefronts where each store allows a link to an outside purchase. */
export const EXTERNAL_LINK_STOREFRONTS: Record<"app-store" | "play", readonly string[]> = {
  "app-store": ["US"],
  play: ["US"],
};

export function payLinkAllowed(
  context: StoreContext | null | undefined,
  blockedCountries: readonly string[],
): boolean {
  if (!context) return false;
  const country = context.storefront?.trim().toUpperCase() || null;
  const blocked = new Set(blockedCountries.map((code) => code.trim().toUpperCase()));
  if (country && blocked.has(country)) return false;
  switch (context.platform) {
    case "desktop":
      // A computer has no store in the way; its country is not known here,
      // and the pay page explains a refusal itself.
      return true;
    case "ios":
      return (
        context.distribution === "app-store" &&
        country !== null &&
        EXTERNAL_LINK_STOREFRONTS["app-store"].includes(country)
      );
    case "android":
      if (context.distribution === "direct") return true;
      if (context.distribution === "play") {
        return country !== null && EXTERNAL_LINK_STOREFRONTS.play.includes(country);
      }
      return false;
    default:
      return false;
  }
}
