import { useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";

/** The one scheme this page will ever open. A fragment is not a destination:
 * the link is built here, from a constant, and never from what arrived. */
const SCHEME = "subrosa";
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The last step of a sign-in that started in the app. The service put the
 * return code in the fragment, which reached neither it nor any Referer, and
 * this page hands it to the app through the scheme the app registered.
 *
 * It calls no API and reads no cookie. A native callback deliberately leaves no
 * browser session behind, so anything that asked for one would show a sign-in
 * screen here instead of finishing the job.
 */
export function ReturnToApp() {
  const link = useMemo(() => {
    const parts = new URLSearchParams(location.hash.replace(/^#/, ""));
    const code = parts.get("c") ?? "";
    const request = parts.get("r") ?? "";
    if (!OPAQUE.test(code) || !UUID.test(request)) return "";
    return `${SCHEME}://auth/callback?request=${request}&code=${code}`;
  }, []);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    // Take the code out of the address bar before anything else can read it
    // back, whether that is a bookmark, a screen share or the next visitor.
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => {
      location.href = link;
      setOpened(true);
    }, 150);
    return () => clearTimeout(timer);
  }, [link]);

  if (!link)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">{t("Your account", "Votre compte")}</p>
        <h1>{t("This link is finished.", "Ce lien est terminé.")}</h1>
        <p className="lede">
          {t(
            "A sign-in link works once. Start again from the app to get a new one.",
            "Un lien de connexion ne sert qu’une fois. Recommencez depuis l’app pour en obtenir un nouveau.",
          )}
        </p>
      </section>
    );

  return (
    <section className="page wrap prose">
      <p className="eyebrow">{t("Your account", "Votre compte")}</p>
      <h1>{t("You are signed in.", "Vous êtes connecté.")}</h1>
      <p className="lede" role="status">
        {opened
          ? t(
              "Sub Rosa is opening. You can close this tab.",
              "Sub Rosa s’ouvre. Vous pouvez fermer cet onglet.",
            )
          : t("Handing you back to Sub Rosa.", "Retour vers Sub Rosa en cours.")}
      </p>
      <a className="button primary" href={link}>
        {t("Open Sub Rosa", "Ouvrir Sub Rosa")}
      </a>
      <p>
        {t(
          "Nothing was decrypted by signing in. Your notes open in the app, with a device you already use or with your recovery key.",
          "Se connecter n’a rien déchiffré. Vos notes s’ouvrent dans l’app, avec un appareil que vous utilisez déjà ou avec votre clé de récupération.",
        )}
      </p>
    </section>
  );
}
