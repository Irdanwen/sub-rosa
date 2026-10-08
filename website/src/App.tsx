import { lazy, Suspense, useEffect, useState } from "react";
import {
  initialWebsiteLocale,
  rememberWebsiteLocale,
  setWebsiteLocale,
  t,
  type SiteLocale,
} from "./lib/i18n";
import { AccountPage } from "./pages/account";
import { ReturnToApp } from "./pages/return";
import { Downloads, Information } from "./pages/public";
import { Documentation, documentationPath } from "./pages/docs";
import { guideBySlug, read } from "./pages/docs-content";
import { modelsPath, useModelCatalog } from "./models/loader";

import { SharePage } from "./pages/share";
import { AssistantCatalog } from "./pages/assistants";

/** The web client is its own chunk: the marketing pages never load it. */
const WebAppPage = lazy(() =>
  import("./pages/web-app").then((module) => ({ default: module.WebAppPage })),
);
import "./style.css";
import { registerAccountNavigation } from "./lib/webmcp";
import { accountsUnavailable, localizedSiteHref, siteHref, sitePaths } from "./lib/paths";
import releases from "./releases.json";

const currentPath = () => (sitePaths.route(location.pathname) ?? "/not-found") + location.search;
const publicRoute = (path: string) =>
  path === "/fr" ? "/" : path.startsWith("/fr/") ? path.slice(3) : path;

function HomePage({ locale }: { locale: SiteLocale }) {
  const href = (path: string) => localizedSiteHref(path, locale);
  return (
    <>
      <section className="hero wrap">
        <div className="hero-copy">
          <p className="eyebrow">
            {t(
              "The space between a thought and what comes next",
              "L’espace entre une idée et sa suite",
            )}
          </p>
          <h1>
            {t("Keep the thread.", "Gardez le fil.")}
            <br />
            <em>{t("Make more of it.", "Allez plus loin.")}</em>
          </h1>
          <p className="intro">
            {t(
              "Record what was said, write what you think, and return to it all in one private workspace.",
              "Enregistrez les échanges, écrivez vos idées et retrouvez le tout dans un espace personnel.",
            )}
          </p>
          <div className="actions">
            <a className="button primary" href={href("/downloads")}>
              {t("Download Sub Rosa", "Télécharger Sub Rosa")} <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href={href("/account")}>
              {t("Go to your account", "Accéder à votre compte")} <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="platform-line">
            {releases.android
              ? t("For Mac, Windows and Android", "Sur Mac, Windows et Android")
              : t("For Mac and Windows", "Sur Mac et Windows")}{" "}
            <span aria-hidden="true">·</span> {t("Start locally", "Commencez en local")}
          </p>
        </div>
        <div
          className="hero-visual"
          role="img"
          aria-label={t(
            "Illustration of a conversation becoming a note",
            "Illustration d’une conversation transformée en note",
          )}
        >
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="product-window">
            <div className="product-topbar">
              <span className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>Sub Rosa</span>
              <span className="product-topbar-end">{t("Your workspace", "Votre espace")}</span>
            </div>
            <div className="product-body">
              <div className="product-sidebar" aria-hidden="true">
                <span className="side-line long" />
                <span className="side-line" />
                <span className="side-line short" />
                <span className="side-space" />
                <span className="side-line" />
                <span className="side-line short" />
              </div>
              <div className="product-content">
                <span className="product-kicker">
                  {t("Conversation note", "Note de conversation")}
                </span>
                <h2>{t("The ideas worth keeping", "Les idées à retenir")}</h2>
                <p className="product-date">
                  {t("Today · 42 minutes", "Aujourd’hui · 42 minutes")}
                </p>
                <div className="note-rule" />
                <div className="note-section">
                  <span className="note-dot" />
                  <div>
                    <strong>{t("A clearer direction", "Une direction plus claire")}</strong>
                    <p>
                      {t(
                        "The conversation, shaped into a note you can return to.",
                        "La conversation devient une note que vous pouvez retrouver.",
                      )}
                    </p>
                  </div>
                </div>
                <div className="note-section">
                  <span className="note-dot" />
                  <div>
                    <strong>{t("What comes next", "La suite")}</strong>
                    <p>
                      {t(
                        "Decisions, questions and ideas stay together.",
                        "Décisions, questions et idées restent réunies.",
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="floating-card">
            <span className="floating-icon" aria-hidden="true">
              ✦
            </span>
            <div>
              <strong>{t("Ready to revisit", "Prêt à relire")}</strong>
              <span>{t("Your notes stay close.", "Vos notes restent à portée.")}</span>
            </div>
          </div>
        </div>
      </section>

      <section
        className="proof-strip"
        aria-label={t("How Sub Rosa fits your work", "Comment Sub Rosa accompagne votre travail")}
      >
        <div className="wrap proof-grid">
          <span>{t("One place for your conversations", "Un lieu pour vos conversations")}</span>
          <span>{t("Room to write and explore", "De l’espace pour écrire et explorer")}</span>
          <span>
            {accountsUnavailable
              ? t("Local from the first day", "En local dès le premier jour")
              : t("Local first, sync when you choose", "Local d’abord, synchronisé à votre choix")}
          </span>
        </div>
      </section>

      <section className="story wrap">
        <div className="section-heading">
          <p className="eyebrow">{t("From moment to meaning", "Du moment à l’essentiel")}</p>
          <h2>
            {t("Your work has a life after the meeting.", "Vos idées vivent après la réunion.")}
          </h2>
          <p>
            {t(
              "Sub Rosa gives every conversation somewhere to go.",
              "Sub Rosa donne une suite à chaque conversation.",
            )}
          </p>
        </div>
        <div className="story-grid">
          <article className="story-card story-card-featured">
            <span className="story-number">01</span>
            <div className="waveform" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <h3>{t("Capture the conversation", "Saisissez la conversation")}</h3>
            <p>
              {t(
                "Record and transcribe, then turn what was said into a useful note.",
                "Enregistrez et transcrivez, puis transformez les échanges en une note utile.",
              )}
            </p>
          </article>
          <article className="story-card">
            <span className="story-number">02</span>
            <div className="story-symbol" aria-hidden="true">
              ✳
            </div>
            <h3>{t("Follow the idea", "Suivez l’idée")}</h3>
            <p>
              {t(
                "Write freely, ask questions of your notes and create in Studio.",
                "Écrivez librement, interrogez vos notes et créez dans Studio.",
              )}
            </p>
          </article>
          <article className="story-card">
            <span className="story-number">03</span>
            <div className="story-symbol" aria-hidden="true">
              ◎
            </div>
            <h3>
              {accountsUnavailable
                ? t("Your work stays yours", "Votre travail reste à vous")
                : t("Pick up anywhere", "Reprenez où vous voulez")}
            </h3>
            <p>
              {accountsUnavailable
                ? t(
                    "Keep working locally. Encrypted continuity will be available when public accounts open.",
                    "Continuez en local. Vous pourrez retrouver vos données chiffrées sur vos appareils à l’ouverture des comptes publics.",
                  )
                : t(
                    "Work locally. Connect your account when you want encrypted continuity across devices.",
                    "Travaillez en local. Connectez votre compte quand vous souhaitez retrouver vos données chiffrées sur vos appareils.",
                  )}
            </p>
          </article>
        </div>
      </section>

      <section className="studio-band">
        <div className="wrap studio-layout">
          <div className="studio-copy">
            <p className="eyebrow">{t("A wider canvas", "Un espace plus vaste")}</p>
            <h2>{t("A workspace for more than notes.", "Bien plus qu’un espace de notes.")}</h2>
            <p>
              {t(
                "Move from a passing thought to an image, a voice or a film in Studio. The tools are there when the idea calls for them.",
                "Passez d’une idée à une image, une voix ou un film dans Studio. Les outils sont là quand vous en avez besoin.",
              )}
            </p>
            <a className="text-link" href={href("/downloads")}>
              {t("Explore Sub Rosa", "Découvrir Sub Rosa")} <span aria-hidden="true">→</span>
            </a>
          </div>
          <figure className="studio-frame">
            <img
              src={siteHref(locale === "fr" ? "/studio-preview-fr.png" : "/studio-preview-en.png")}
              alt={t(
                "The film editor in Sub Rosa Studio",
                "L’écran Studio de l’app Sub Rosa et ses outils de création",
              )}
              loading="lazy"
            />
            <figcaption>{t("Film editing in Studio", "Studio dans l’app")}</figcaption>
          </figure>
        </div>
      </section>

      <section className="privacy-story wrap">
        <div>
          <p className="eyebrow">{t("Your space, your decision", "Votre espace, votre choix")}</p>
          <h2>
            {t(
              "Start on your device. Connect on your terms.",
              "Commencez sur votre appareil. Connectez-vous à votre rythme.",
            )}
          </h2>
        </div>
        <div>
          <p>
            {accountsUnavailable
              ? t(
                  "Use Sub Rosa locally with your Carpe Diem key today. Optional encrypted sync will open after the account service is ready.",
                  "Utilisez Sub Rosa en local avec votre clé Carpe Diem dès aujourd’hui. La synchronisation chiffrée facultative ouvrira quand le service de compte sera prêt.",
                )
              : t(
                  "You can use Sub Rosa locally with your Carpe Diem key. An optional account brings encrypted content to your other devices when you decide to turn sync on.",
                  "Utilisez Sub Rosa en local avec votre clé Carpe Diem. Un compte facultatif vous permet de retrouver vos contenus chiffrés sur vos autres appareils, lorsque vous activez la synchronisation.",
                )}
          </p>
          <a className="text-link" href={href("/privacy")}>
            {t("How your data is handled", "Comment vos données sont traitées")}{" "}
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section className="closing wrap">
        <div>
          <p className="eyebrow">{t("Begin here", "À vous de commencer")}</p>
          <h2>{t("Make space for what matters.", "Faites place à l’essentiel.")}</h2>
        </div>
        <a className="button primary" href={href("/downloads")}>
          {t("Get Sub Rosa", "Obtenir Sub Rosa")} <span aria-hidden="true">↗</span>
        </a>
      </section>
    </>
  );
}

export function App({ initialPath }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath ?? currentPath());
  const rawPathname = path.split("?")[0];
  const appPath = rawPathname === "/app";
  const accountPath = appPath || rawPathname === "/account" || rawPathname.startsWith("/account/");
  const sharePath = rawPathname.startsWith("/s/");
  // The assistant catalog (ADR-0097) lives with the account service it reads.
  const catalogPath = rawPathname === "/assistants" || rawPathname.startsWith("/assistants/");
  const returnPath = rawPathname === "/account/devices/return";
  const [locale, setLocale] = useState<SiteLocale>(() =>
    rawPathname === "/fr" || rawPathname.startsWith("/fr/")
      ? "fr"
      : accountPath || sharePath || catalogPath
        ? initialWebsiteLocale(
            rawPathname,
            path.split("?")[1] ?? "",
            typeof navigator === "undefined" ? "en" : navigator.language,
          )
        : "en",
  );
  const pathname = publicRoute(rawPathname);
  const catalog = useModelCatalog(modelsPath(pathname));
  setWebsiteLocale(locale);
  const href = (target: string) => localizedSiteHref(target, locale);

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
      if (next === "/fr" || next.startsWith("/fr/")) {
        rememberWebsiteLocale("fr");
        setLocale("fr");
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
            : documentationPath(pathname) || pathname === "/help"
              ? `${pathname.startsWith("/docs/") ? read(guideBySlug(pathname.slice(6))?.title ?? ["Documentation", "Documentation"]) : t("Documentation", "Documentation")} · Sub Rosa`
              : modelsPath(pathname)
                ? `${catalog ? catalog.modelCatalogTitle(pathname) : t("Model catalog", "Catalogue des modèles")} · Sub Rosa`
                : pathname === "/downloads"
                  ? `${t("Download", "Télécharger")} · Sub Rosa`
                  : pathname === "/"
                    ? "Sub Rosa"
                    : `${t("Information", "Informations")} · Sub Rosa`;
  }, [locale, appPath, accountPath, sharePath, catalogPath, pathname, catalog]);
  const changeLocale = (next: SiteLocale) => {
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
    setPath(next === "fr" ? (pathname === "/" ? "/fr/" : `/fr${pathname}`) : pathname);
  };

  return (
    <>
      <a className="skip" href="#main">
        {t("Skip to content", "Aller au contenu")}
      </a>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="brand" href={href("/")} aria-label="Sub Rosa">
            <img src={siteHref("/rose.png")} alt="" width="36" height="36" /> Sub Rosa
          </a>
          <nav className="header-nav" aria-label={t("Main navigation", "Navigation principale")}>
            <a href={href("/downloads")}>{t("Download", "Télécharger")}</a>
            <a className="header-secondary docs-header-link" href={href("/docs")}>
              {t("Guides", "Guides")}
            </a>
            <a className="header-secondary docs-header-link" href={href("/models")}>
              {t("Models", "Modèles")}
            </a>
            <a className="header-secondary" href={href("/privacy")}>
              {t("Our approach", "Notre approche")}
            </a>
            <a className="account-link" href={href("/account")}>
              {t("Your account", "Votre compte")} <span aria-hidden="true">↗</span>
            </a>
          </nav>
          <fieldset className="locale-switch">
            <legend className="sr-only">{t("Website language", "Langue du site")}</legend>
            <button type="button" aria-pressed={locale === "en"} onClick={() => changeLocale("en")}>
              EN
            </button>
            <button type="button" aria-pressed={locale === "fr"} onClick={() => changeLocale("fr")}>
              FR
            </button>
          </fieldset>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
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
        ) : documentationPath(pathname) || pathname === "/help" ? (
          <Documentation path={pathname === "/help" ? "/docs" : pathname} locale={locale} />
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
            <a href={href("/docs")}>{t("Documentation", "Documentation")}</a>
            <a href={href("/models")}>{t("Model catalog", "Catalogue des modèles")}</a>
            <a href={href("/assistants")}>{t("Assistant catalog", "Catalogue d’assistants")}</a>
            <a href={href("/privacy")}>{t("Privacy", "Confidentialité")}</a>
            <a href={href("/security")}>{t("Security", "Sécurité")}</a>
            <a href="https://github.com/Irdanwen/sub-rosa-releases/releases">
              {t("Release notes", "Notes de version")}
            </a>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} Sub Rosa</span>
            <span>
              {t("Made for the moments worth keeping.", "Pour les moments qui méritent de rester.")}
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
