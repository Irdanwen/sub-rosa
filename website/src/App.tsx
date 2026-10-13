import { lazy, Suspense, useEffect, useState } from "react";
import {
  initialWebsiteLocale,
  LOCALE_CODES,
  LOCALE_NAMES,
  loadWebsiteMessages,
  localizedPublicPath,
  rememberWebsiteLocale,
  requireWebsiteMessages,
  SITE_LOCALES,
  setWebsiteLocale,
  splitLocalePath,
  t,
  type SiteLocale,
} from "./lib/i18n";
import { Downloads, Information } from "./pages/public";
import { HomePage } from "./pages/home";
import { documentationPath, useDocs } from "./pages/docs-loader";
import { modelsPath, useModelCatalog } from "./models/loader";

// The pages a marketing visit never opens load with their route: the account
// (with its passkeys and QR code), a shared link, the assistant catalog and
// the way back to the app are not prerendered, and the home page paid for all
// of them in its first script.
const AccountPage = lazy(() =>
  import("./pages/account").then((module) => ({ default: module.AccountPage })),
);
const SharePage = lazy(() =>
  import("./pages/share").then((module) => ({ default: module.SharePage })),
);
const AssistantCatalog = lazy(() =>
  import("./pages/assistants").then((module) => ({ default: module.AssistantCatalog })),
);
const ReturnToApp = lazy(() =>
  import("./pages/return").then((module) => ({ default: module.ReturnToApp })),
);

/** The web client is its own chunk, with its own words: the marketing pages never load them. */
const WebAppPage = lazy(() =>
  Promise.all([import("./pages/web-app"), requireWebsiteMessages("app")]).then(([module]) => ({
    default: module.WebAppPage,
  })),
);
import "./style.css";
import { registerAccountNavigation } from "./lib/webmcp";
import { accountsUnavailable, localizedSiteHref, siteHref, sitePaths } from "./lib/paths";

const currentPath = () => (sitePaths.route(location.pathname) ?? "/not-found") + location.search;
const publicRoute = (path: string) => splitLocalePath(path).page;
const browserLanguages = () =>
  typeof navigator === "undefined" ? "en" : (navigator.languages ?? navigator.language);

export function App({ initialPath }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath ?? currentPath());
  const rawPathname = path.split("?")[0];
  const appPath = rawPathname === "/app";
  const accountPath = appPath || rawPathname === "/account" || rawPathname.startsWith("/account/");
  const sharePath = rawPathname.startsWith("/s/");
  // The assistant catalog (ADR-0097) lives with the account service it reads.
  const catalogPath = rawPathname === "/assistants" || rawPathname.startsWith("/assistants/");
  const returnPath = rawPathname === "/account/devices/return";
  const [locale, setLocale] = useState<SiteLocale>(
    () =>
      splitLocalePath(rawPathname).locale ??
      (accountPath || sharePath || catalogPath
        ? initialWebsiteLocale(rawPathname, path.split("?")[1] ?? "", browserLanguages())
        : "en"),
  );
  const pathname = publicRoute(rawPathname);
  const catalog = useModelCatalog(modelsPath(pathname));
  const docs = useDocs(documentationPath(pathname));
  setWebsiteLocale(locale);
  const href = (target: string) => localizedSiteHref(target, locale);
  // `main.tsx` loads the words before the first render; this covers a
  // render that did not go through it.
  const [, setMessagesFor] = useState<SiteLocale | null>(null);
  useEffect(() => {
    if (locale === "en" || locale === "fr") return;
    let live = true;
    loadWebsiteMessages(locale).then(() => live && setMessagesFor(locale));
    return () => {
      live = false;
    };
  }, [locale]);

  useEffect(() => {
    if (new URLSearchParams(path.split("?")[1] ?? "").has("lang")) rememberWebsiteLocale(locale);
  }, [path, locale]);
  useEffect(
    () =>
      registerAccountNavigation((next) => {
        const destination = siteHref(next);
        if (sitePaths.accountOrigin) {
          location.assign(destination);
          return;
        }
        history.pushState(null, "", destination);
        setPath(next);
        window.scrollTo(0, 0);
      }),
    [],
  );
  useEffect(() => {
    const changed = () => {
      const next = currentPath();
      setPath(next);
      const prefixed = splitLocalePath(next.split("?")[0]).locale;
      if (prefixed) {
        rememberWebsiteLocale(prefixed);
        loadWebsiteMessages(prefixed).then(() => setLocale(prefixed));
      } else if (
        !next.startsWith("/account") &&
        !next.startsWith("/s/") &&
        !next.startsWith("/assistants")
      )
        setLocale("en");
      window.scrollTo(0, 0);
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element | null)?.closest("a");
      if (!link || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (!sitePaths.handles(url, location.origin)) return;
      event.preventDefault();
      history.pushState(null, "", url.pathname + url.search);
      changed();
      requestAnimationFrame(() => document.getElementById("main")?.focus());
    };
    window.addEventListener("popstate", changed);
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("popstate", changed);
      document.removeEventListener("click", click);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = sharePath
      ? `${t("Shared with you", "Partagé avec vous")} · Sub Rosa`
      : appPath
        ? `${t("Chats", "Discussions")} · Sub Rosa`
        : catalogPath
          ? `${t("Assistant catalog", "Catalogue d’assistants")} · Sub Rosa`
          : accountPath
            ? `${t("Your account", "Votre compte")} · Sub Rosa`
            : documentationPath(pathname)
              ? `${docs ? docs.documentationTitle(pathname) : t("Documentation", "Documentation")} · Sub Rosa`
              : modelsPath(pathname)
                ? `${catalog ? catalog.modelCatalogTitle(pathname) : t("Model catalog", "Catalogue des modèles")} · Sub Rosa`
                : pathname === "/downloads"
                  ? `${t("Download", "Télécharger")} · Sub Rosa`
                  : pathname === "/"
                    ? "Sub Rosa"
                    : `${t("Information", "Informations")} · Sub Rosa`;
  }, [locale, appPath, accountPath, sharePath, catalogPath, pathname, catalog]);
  const changeLocale = async (next: SiteLocale) => {
    await loadWebsiteMessages(next);
    rememberWebsiteLocale(next);
    setLocale(next);
    if (accountPath) {
      const query = new URLSearchParams(location.search);
      query.set("lang", next);
      const destination = `${location.pathname}?${query}${location.hash}`;
      history.replaceState(null, "", destination);
      setPath(`${rawPathname}?${query}`);
      return;
    }
    if (sharePath || catalogPath) return;
    const destination = localizedSiteHref(pathname, next);
    history.pushState(null, "", destination);
    setPath(localizedPublicPath(pathname, next));
  };

  return (
    <>
      <a className="skip" href="#main">
        {t("Skip to content", "Aller au contenu")}
      </a>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="brand" href={href("/")} aria-label="Sub Rosa">
            <img src={siteHref("/rose.png")} alt="" width="36" height="36" />{" "}
            <span className="brand-name">Sub Rosa</span>
          </a>
          <nav className="header-nav" aria-label={t("Main navigation", "Navigation principale")}>
            <a className="header-secondary" href={href("/docs")}>
              {t("Guides", "Guides")}
            </a>
            <a className="header-secondary" href={href("/models")}>
              {t("Models", "Modèles")}
            </a>
            <a className="header-secondary" href={href("/privacy")}>
              {t("Privacy", "Confidentialité")}
            </a>
            <a className="header-secondary header-account" href={href("/account")}>
              {t("Your account", "Votre compte")} <span aria-hidden="true">↗</span>
            </a>
            {/* The one thing this site asks of a visitor, so the one filled
                button in the header. */}
            <a className="download-link" href={href("/downloads")}>
              {t("Download", "Télécharger")}
            </a>
          </nav>
          <details className="header-menu">
            <summary aria-label={t("Menu", "Menu")}>
              <span aria-hidden="true" className="header-menu-icon" />
            </summary>
            <nav aria-label={t("Site menu", "Menu du site")}>
              <a href={href("/docs")}>{t("Guides", "Guides")}</a>
              <a href={href("/models")}>{t("Models", "Modèles")}</a>
              <a href={href("/privacy")}>{t("Privacy", "Confidentialité")}</a>
              <a href={href("/security")}>{t("Security", "Sécurité")}</a>
              <a href={href("/account")}>
                {t("Your account", "Votre compte")} <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </details>
          <label className="locale-switch">
            <span aria-hidden="true">{LOCALE_CODES[locale]}</span>
            <select
              aria-label={t("Website language", "Langue du site")}
              value={locale}
              onChange={(event) => changeLocale(event.target.value as SiteLocale)}
            >
              {SITE_LOCALES.map((option) => (
                <option key={option} value={option} lang={option}>
                  {LOCALE_NAMES[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Suspense
          fallback={
            <section className="page wrap" aria-busy="true">
              <p role="status">{t("Loading…", "Chargement…")}</p>
            </section>
          }
        >
          {sharePath ? (
            <SharePage path={path} />
          ) : catalogPath ? (
            <AssistantCatalog path={rawPathname} />
          ) : returnPath ? (
            <ReturnToApp />
          ) : accountPath && (accountsUnavailable || !sitePaths.hostsAccounts) ? (
            <section className="page wrap prose">
              <p className="eyebrow">{t("Your account", "Votre compte")}</p>
              <h1>
                {accountsUnavailable || !sitePaths.accountOrigin
                  ? t("Accounts are coming soon.", "Les comptes seront bientôt disponibles.")
                  : t("Continue to your account.", "Accédez à votre compte.")}
              </h1>
              <p className="lede">
                {accountsUnavailable || !sitePaths.accountOrigin
                  ? t(
                      "You can download Sub Rosa and work locally today. Account registration and encrypted sync will open once setup is complete.",
                      "Vous pouvez télécharger Sub Rosa et travailler localement dès aujourd’hui. Les inscriptions et la synchronisation chiffrée ouvriront une fois leur configuration terminée.",
                    )
                  : t(
                      "Sign in or create an account on the dedicated Sub Rosa account website.",
                      "Connectez-vous ou créez un compte sur le site dédié aux comptes Sub Rosa.",
                    )}
              </p>
              {!accountsUnavailable && sitePaths.accountOrigin && (
                <a className="button primary" href={href("/account")}>
                  {t("Continue to your account", "Accéder à votre compte")}
                </a>
              )}
              <a className="button" href={href("/downloads")}>
                {t("Download the current app", "Télécharger l’app actuelle")}
              </a>
            </section>
          ) : appPath ? (
            <Suspense
              fallback={
                <section className="page wrap" aria-busy="true">
                  <p role="status">{t("Opening your chats…", "Ouverture de vos discussions…")}</p>
                </section>
              }
            >
              <WebAppPage />
            </Suspense>
          ) : accountPath ? (
            <AccountPage path={path} />
          ) : documentationPath(pathname) ? (
            docs ? (
              <docs.Documentation
                path={pathname === "/help" ? "/docs" : pathname}
                locale={locale}
              />
            ) : (
              <section className="page wrap" aria-busy="true">
                <p className="eyebrow">{t("Documentation", "Documentation")}</p>
              </section>
            )
          ) : modelsPath(pathname) ? (
            catalog ? (
              <catalog.ModelCatalog
                path={pathname}
                query={path.split("?")[1] ?? ""}
                locale={locale}
              />
            ) : (
              <section className="page wrap" aria-busy="true">
                <p className="eyebrow">{t("Model catalog", "Catalogue des modèles")}</p>
              </section>
            )
          ) : pathname === "/downloads" ? (
            <Downloads />
          ) : pathname !== "/" ? (
            <Information path={pathname} />
          ) : (
            <HomePage locale={locale} />
          )}
        </Suspense>
      </main>
      <footer className="footer">
        <div className="wrap footer-inner">
          <div className="footer-top">
            <a className="brand" href={href("/")}>
              Sub Rosa
            </a>
            <p>
              {t(
                "A place for the work you want to keep.",
                "Un espace pour ce que vous souhaitez garder.",
              )}
            </p>
          </div>
          <div className="footer-links">
            <a href={href("/downloads")}>{t("Download", "Télécharger")}</a>
            <a href={href("/docs")}>{t("Documentation", "Documentation")}</a>
            <a href={href("/models")}>{t("Model catalog", "Catalogue des modèles")}</a>
            <a href={href("/assistants")}>{t("Assistant catalog", "Catalogue d’assistants")}</a>
            <a href={href("/privacy")}>{t("Privacy", "Confidentialité")}</a>
            <a href={href("/security")}>{t("Security", "Sécurité")}</a>
            <a href={href("/legal")}>{t("Legal notice", "Mentions légales")}</a>
            <a href="https://github.com/Irdanwen/sub-rosa-releases/releases">
              {t("Release notes", "Notes de version")}
            </a>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} Lumen Labs</span>
            <span>
              {t("Made for the moments worth keeping.", "Pour les moments qui méritent de rester.")}
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
