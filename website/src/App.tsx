import { useEffect, useState } from "react";
import { setLanguage, t, useLanguage } from "./lib/i18n";
import { AccountPage } from "./pages/account";
import { Downloads, Information } from "./pages/public";
import "./style.css";
import { registerAccountNavigation } from "./lib/webmcp";

export function App({ initialPath }: { initialPath?: string }) {
  const language = useLanguage();
  const [path, setPath] = useState(initialPath ?? location.pathname + location.search);
  useEffect(
    () =>
      registerAccountNavigation((next) => {
        history.pushState(null, "", next);
        setPath(next);
        window.scrollTo(0, 0);
      }),
    [],
  );
  useEffect(() => {
    const changed = () => {
      setPath(location.pathname + location.search);
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
      if (url.origin !== location.origin || url.pathname.startsWith("/auth/") || url.hash) return;
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
    document.documentElement.lang = language;
    document.title = path.startsWith("/account")
      ? `${t("Your account", "Votre compte")} · Sub Rosa`
      : path === "/downloads"
        ? `${t("Download", "Télécharger")} · Sub Rosa`
        : "Sub Rosa";
  }, [path, language]);
  return (
    <>
      <a className="skip" href="#main">
        {t("Skip to content", "Aller au contenu")}
      </a>
      <header className="header wrap">
        <a className="brand" href="/" aria-label="Sub Rosa">
          <img src="/rose.png" alt="" width="36" height="36" />
          Sub Rosa
        </a>
        <nav aria-label={t("Main navigation", "Navigation principale")}>
          <a href="/downloads">{t("Download", "Télécharger")}</a>
          <a href="/privacy">{t("Privacy", "Confidentialité")}</a>
          <a href="/account">{t("Sign in", "Se connecter")}</a>
          <button
            className="language"
            type="button"
            onClick={() => setLanguage(language === "fr" ? "en" : "fr")}
            aria-label={t("Read in French", "Lire en anglais")}
          >
            {language === "fr" ? "EN" : "FR"}
          </button>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {path.startsWith("/account") && import.meta.env.VITE_PREVIEW_ONLY === "1" ? (
          <section className="page wrap prose">
            <p className="eyebrow">{t("Private preview", "Aperçu privé")}</p>
            <h1>{t("Your account is being prepared.", "Votre compte se prépare.")}</h1>
            <p className="lede">
              {t(
                "This preview shows the website. Account creation and encrypted sync are available in the local test environment and will open here once the account service is deployed.",
                "Cet aperçu présente le site. La création de compte et la synchronisation chiffrée fonctionnent dans l’environnement de test local et seront ouvertes ici après le déploiement du service de compte.",
              )}
            </p>
            <a className="button primary" href="/downloads">
              {t("Download the current app", "Télécharger l’app actuelle")}
            </a>
          </section>
        ) : path.startsWith("/account") ? (
          <AccountPage path={path} />
        ) : path === "/downloads" ? (
          <Downloads />
        ) : path !== "/" ? (
          <Information path={path} />
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
                <a className="button primary" href="/downloads">
                  {t("Download Sub Rosa", "Télécharger Sub Rosa")}
                  <span aria-hidden="true">↗</span>
                </a>
                <a className="text-link" href="/account?intent=signup">
                  {t("Create an account", "Créer un compte")} <span aria-hidden="true">→</span>
                </a>
              </div>
              <p className="quiet">macOS · Windows · iPhone</p>
            </section>
            <section className="product wrap" aria-label={t("Inside Sub Rosa", "Dans Sub Rosa")}>
              <div className="product-caption">
                <span>
                  {t(
                    "From the first word to your next creation",
                    "Du premier mot à votre prochaine création",
                  )}
                </span>
                <span>Sub Rosa / Studio</span>
              </div>
              <img
                src="/studio.png"
                alt={t(
                  "Sub Rosa Studio, with image, video, narration and music creation tools",
                  "Le Studio Sub Rosa et ses outils de création d’images, de vidéos, de narration et de musique",
                )}
                width="1755"
                height="1440"
              />
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
              <a className="button primary" href="/downloads">
                {t("Get the app", "Obtenir l’app")} <span aria-hidden="true">↗</span>
              </a>
            </section>
          </>
        )}
      </main>
      <footer className="footer wrap">
        <a className="brand" href="/">
          Sub Rosa
        </a>
        <div>
          <a href="/help">{t("Help", "Aide")}</a>
          <a href="/privacy">{t("Privacy", "Confidentialité")}</a>
          <a href="/security">{t("Security", "Sécurité")}</a>
          <a href="https://github.com/Irdanwen/sub-rosa-releases/releases">
            {t("Release notes", "Notes de version")}
          </a>
        </div>
        <span>© {new Date().getFullYear()} Sub Rosa</span>
      </footer>
    </>
  );
}
