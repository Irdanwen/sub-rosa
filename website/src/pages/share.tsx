import { useEffect, useState } from "react";
import { date, t } from "./../lib/i18n";
import { Markdown } from "./../lib/markdown";
import { readShare, readShareLink, type SharedDocument, type SharePreview } from "./../lib/share";

/**
 * The page a link opens. It holds a key, so it is deliberately the plainest
 * thing on this site: no account, no navigation into the account, nothing
 * fetched from anywhere but this origin.
 */
export function SharePage({ path }: { path: string }) {
  const [state, setState] = useState<{
    document?: SharedDocument;
    preview?: SharePreview;
    error?: string;
  }>({});
  useEffect(() => {
    const link = readShareLink(path.split("?")[0], location.hash);
    if (!link) {
      setState({
        error: t(
          "This link is incomplete. Copy it again in full, including everything after the # sign.",
          "Ce lien est incomplet. Copiez-le à nouveau en entier, y compris ce qui suit le signe #.",
        ),
      });
      return;
    }
    const controller = new AbortController();
    readShare(link.id, link.key, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({
            error: t(
              "This link has expired, was revoked, or the key it carries does not open it.",
              "Ce lien a expiré, a été révoqué, ou la clé qu’il porte ne l’ouvre pas.",
            ),
          });
      })
      .finally(() => link.key.fill(0));
    return () => {
      controller.abort();
      link.key.fill(0);
    };
  }, [path]);

  if (state.error)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">Sub Rosa</p>
        <h1>{t("This link does not open.", "Ce lien ne s’ouvre pas.")}</h1>
        <p className="lede">{state.error}</p>
        <a className="button" href="/">
          {t("About Sub Rosa", "À propos de Sub Rosa")}
        </a>
      </section>
    );
  if (!state.document)
    return (
      <section className="page wrap" aria-busy="true">
        <p role="status">{t("Opening…", "Ouverture…")}</p>
      </section>
    );
  return (
    <section className="page wrap">
      <div className="prose">
        <p className="eyebrow">{t("Shared with you", "Partagé avec vous")}</p>
        <h1>{state.document.title || t("Untitled note", "Note sans titre")}</h1>
      </div>
      <article className="card">
        <Markdown text={state.document.body} />
      </article>
      <p className="quiet">
        {t("Shared on", "Partagé le")} {date(state.document.shared_at)}
        {state.preview ? (
          <>
            {" · "}
            {t("available until", "disponible jusqu’au")} {date(state.preview.expires_at)}
          </>
        ) : null}
        {" · "}
        {t(
          "Decrypted in this browser. Sub Rosa never received the key in this link.",
          "Déchiffré dans ce navigateur. Sub Rosa n’a jamais reçu la clé de ce lien.",
        )}
      </p>
    </section>
  );
}
