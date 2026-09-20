/** Marketing may share a host; account cookies and APIs stay on their own origin. */
export function createSitePaths(base = "/", accountOrigin = "") {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
    throw new Error("The website base must be an absolute path with a trailing slash.");
  if (accountOrigin) {
    const origin = new URL(accountOrigin);
    if (origin.protocol !== "https:" || origin.origin !== accountOrigin)
      throw new Error("The account origin must be an HTTPS origin without a path.");
  }
  const prefix = base.slice(0, -1);
  const route = (pathname: string): string | null => {
    if (pathname === prefix || pathname === base) return "/";
    if (!pathname.startsWith(base)) return null;
    return pathname.slice(prefix.length).replace(/\/$/, "");
  };
  const href = (path: string) => {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path))
      throw new Error("Invalid website path.");
    if (
      (path === "/account" || path.startsWith("/account/") || path.startsWith("/account?")) &&
      accountOrigin
    )
      return `${accountOrigin}${path}`;
    return `${prefix}${path}`;
  };
  const handles = (url: URL, currentOrigin: string) => {
    if (url.origin !== currentOrigin || url.hash) return false;
    const path = route(url.pathname);
    if (!path) return false;
    if (["/", "/downloads", "/privacy", "/security", "/help"].includes(path)) return true;
    // A share link is a fresh page load: it reads its key from the fragment,
    // which `handles` refuses to intercept anyway, and it must not inherit the
    // state of whatever tab the reader clicked from.
    if (path.startsWith("/s/")) return false;
    return !accountOrigin && (path === "/account" || path.startsWith("/account/"));
  };
  return {
    base,
    accountOrigin,
    route,
    href,
    handles,
    hostsAccounts: base === "/" && !accountOrigin,
  };
}

export const sitePaths = createSitePaths(
  import.meta.env.BASE_URL,
  import.meta.env.VITE_ACCOUNT_ORIGIN ?? "",
);
export const siteHref = sitePaths.href;
export const accountsUnavailable =
  import.meta.env.VITE_PREVIEW_ONLY === "1" || import.meta.env.VITE_ACCOUNTS_UNAVAILABLE === "1";
