import { useEffect, useState } from "react";
import { t } from "./lib/i18n";
import { AccountPage } from "./pages/account";
import { Downloads, Information } from "./pages/public";
import "./style.css";
import { registerAccountNavigation } from "./lib/webmcp";
import { accountsUnavailable, siteHref, sitePaths } from "./lib/paths";

const currentPath = () => (sitePaths.route(location.pathname) ?? "/not-found") + location.search;

export function App({ initialPath }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath ?? currentPath());
  const pathname = path.split("?")[0];
  const accountPath = pathname === "/account" || pathname.startsWith("/account/");
  useEffect(
    () =>
      registerAccountNavigation((next) => {
        const href = siteHref(next);
        if (sitePaths.accountOrigin) {
          location.assign(href);
          return;
        }
        history.pushState(null, "", href);
        setPath(next);
        window.scrollTo(0, 0);
      }),
    [],
  );
  useEffect(() => {
    const changed = () => {
      setPath(currentPath());
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
    document.documentElement.lang = "en";
    document.title = accountPath
      ? `${t("Your account", "Votre compte")} · Sub Rosa`
      : pathname === "/downloads"
        ? `${t("Download", "Télécharger")} · Sub Rosa`
        : "Sub Rosa";
  }, [accountPath, pathname]);
  return (
    <>
      <a className="skip" href="#main">
        {t("Skip to content", "Aller au contenu")}
      </a>
      <header className="header wrap">
        <a className="brand" href={siteHref("/")} aria-label="Sub Rosa">
          <img src={siteHref("/rose.png")} alt="" width="36" height="36" />
          Sub Rosa
        </a>
        <nav aria-label={t("Main navigation", "Navigation principale")}>
          <a href={siteHref("/downloads")}>{t("Download", "Télécharger")}</a>
          <a href={siteHref("/privacy")}>{t("Privacy", "Confidentialité")}</a>
          <a href={siteHref("/account")}>{t("Sign in", "Se connecter")}</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {accountPath && (accountsUnavailable || !sitePaths.hostsAccounts) ? (
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
                    "Vous pouvez télécharger Sub Rosa et travailler localement dès maintenant. Les inscriptions et la synchronisation chiffrée ouvriront lorsque la configuration sera terminée.",
                  )
                : t(
                    "Sign in or create an account on the dedicated Sub Rosa account website.",
                    "Connectez-vous ou créez un compte sur le site dédié aux comptes Sub Rosa.",
                  )}
            </p>
            {!accountsUnavailable && sitePaths.accountOrigin && (
              <a className="button primary" href={siteHref("/account")}>
                {t("Continue to your account", "Accéder à votre compte")}
              </a>
            )}
            <a className="button" href={siteHref("/downloads")}>
              {t("Download the current app", "Télécharger l’app actuelle")}
            </a>
          </section>
        ) : accountPath ? (
          <AccountPage path={path} />
        ) : pathname === "/downloads" ? (
          <Downloads />
        ) : pathname !== "/" ? (
          <Information path={pathname} />
        ) : (
          <>
            <section className="hero wrap">
              <p className="eyebrow">{t("Your personal workspace", "Votre espace personnel")}</p>
              <h1>
                {t("A place for", "Un espace pour")}
                <br />
                <em>{t("what matters.", "ce qui compte.")}</em>
              </h1>
              <p className="intro">
                {t(
                  "Record a conversation. Shape an idea. Pick up where you left off.",
                  "Enregistrez une conversation. Donnez forme à une idée. Reprenez le fil.",
                )}
              </p>
              <div className="actions">
                <a className="button primary" href={siteHref("/downloads")}>
                  {t("Download Sub Rosa", "Télécharger Sub Rosa")}
                  <span aria-hidden="true">↗</span>
                </a>
                <a className="text-link" href={siteHref("/account?intent=signup")}>
                  {t("Create an account", "Créer un compte")} <span aria-hidden="true">→</span>
                </a>
              </div>
              <p className="quiet">macOS · Windows · iPhone</p>
            </section>
            <section className="features wrap">
              <article>
                <p className="step">01</p>
                <h2>{t("Keep the conversation", "Gardez la conversation")}</h2>
                <p>
                  {t(
                    "Record, transcribe and turn your conversations into notes you can use.",
                    "Enregistrez, transcrivez et transformez vos conversations en notes utiles.",
                  )}
                </p>
              </article>
              <article>
                <p className="step">02</p>
                <h2>{t("Make room for ideas", "Faites place aux idées")}</h2>
                <p>
                  {t(
                    "Write, ask your notes a question, or explore an idea in the Studio.",
                    "Écrivez, interrogez vos notes ou explorez une idée dans le Studio.",
                  )}
                </p>
              </article>
              <article>
                <p className="step">03</p>
                <h2>{t("Choose what you share", "Choisissez ce que vous partagez")}</h2>
                <p>
                  {t(
                    "Work locally. Connect your account when you want to bring your devices together.",
                    "Travaillez localement. Connectez votre compte pour réunir vos appareils.",
                  )}
                </p>
              </article>
            </section>
            <section className="closing wrap">
              <h2>{t("Your work. Your space.", "Votre travail. Votre espace.")}</h2>
              <a className="button primary" href={siteHref("/downloads")}>
                {t("Get the app", "Obtenir l’app")} <span aria-hidden="true">↗</span>
              </a>
            </section>
          </>
        )}
      </main>
      <footer className="footer wrap">
        <a className="brand" href={siteHref("/")}>
          Sub Rosa
        </a>
        <div>
          <a href={siteHref("/help")}>{t("Help", "Aide")}</a>
          <a href={siteHref("/privacy")}>{t("Privacy", "Confidentialité")}</a>
          <a href={siteHref("/security")}>{t("Security", "Sécurité")}</a>
          <a href="https://github.com/Irdanwen/sub-rosa-releases/releases">
            {t("Release notes", "Notes de version")}
          </a>
        </div>
        <span>© {new Date().getFullYear()} Sub Rosa</span>
      </footer>
    </>
  );
}
