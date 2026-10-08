import { localizedPublicPath, type SiteLocale, splitLocalePath } from "./i18n";

/** Pages the account origin serves: the account itself, the web client
 * (ADR-0101), and the assistant
 * catalog (ADR-0097), which reads the account service's public routes. */
function servedByAccount(path: string) {
  return /^\/(?:account|assistants|app)(?:$|[/?])/.test(path);
}
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
    if (servedByAccount(path) && accountOrigin) return `${accountOrigin}${path}`;
    return `${prefix}${path}`;
  };
  const handles = (url: URL, currentOrigin: string) => {
    if (url.origin !== currentOrigin || url.hash) return false;
    const path = route(url.pathname);
    if (!path) return false;
    // A public page, in English or under a language prefix (`/fr`, `/pt-br`).
    const page = splitLocalePath(path).page;
    if (["/", "/downloads", "/privacy", "/security", "/help"].includes(page)) return true;
    if (/^\/docs(?:\/[a-z0-9-]+)?$/.test(page)) return true;
    if (/^\/models(?:\/[a-z0-9-]+)?$/.test(page)) return true;
    // A share link is a fresh page load: it reads its key from the fragment,
    // which `handles` refuses to intercept anyway, and it must not inherit the
    // state of whatever tab the reader clicked from.
    if (path.startsWith("/s/")) return false;
    return (
      !accountOrigin && (path === "/account" || path.startsWith("/account/") || path === "/app")
    );
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
export function localizedSiteHref(path: string, locale: SiteLocale) {
  if (servedByAccount(path)) {
    const separator = path.includes("?") ? "&" : "?";
    return siteHref(`${path}${separator}lang=${locale}`);
  }
  return siteHref(localizedPublicPath(path, locale));
}
export const accountsUnavailable =
  import.meta.env.VITE_PREVIEW_ONLY === "1" || import.meta.env.VITE_ACCOUNTS_UNAVAILABLE === "1";
