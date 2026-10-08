import { useEffect, useState } from "react";
import { type Account, api } from "../../../website/src/lib/api";
import { t } from "../../../website/src/lib/i18n";
import type { OfficeGlobal } from "../office";
import { SIGN_IN_PATH } from "../pane/sign-in-window";
import { carry, csrfFromCookie, parseMessage } from "./courier";

/** Where the account service sends the window back after signing in. */
export const SIGN_IN_URL = `/auth/login?return_to=${encodeURIComponent(SIGN_IN_PATH)}`;

const assign = (url: string) => location.assign(url);

/**
 * The sign-in window an Office pane opens (ADR-0102). It signs in on the
 * account origin like any page of the site, then carries the pane's few
 * session calls (`courier.ts`) until the pane closes it. It holds no key and
 * shows nothing of the account but the address it is signed in as.
 */
export function SessionWindow({
  office,
  fresh,
  navigate = assign,
}: {
  office: OfficeGlobal;
  fresh: boolean;
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<
    { kind: "checking" } | { kind: "signed-out" } | { kind: "carrying"; account: Account }
  >({ kind: "checking" });

  useEffect(() => {
    if (fresh) {
      navigate(SIGN_IN_URL);
      return;
    }
    let live = true;
    const reply = (message: unknown) => {
      try {
        office.context.ui.messageParent(JSON.stringify(message));
      } catch {
        // Opened outside an Office dialog: there is no pane to answer.
      }
    };
    api<Account>("/api/v1/me")
      .then((account) => {
        if (!live) return;
        office.context.ui.addHandlerAsync(
          office.EventType.DialogParentMessageReceived,
          (arg) => {
            if (arg.origin && arg.origin !== location.origin) return;
            const request = parseMessage(arg.message);
            if (request?.type !== "request") return;
            void carry(
              {
                fetch: (...args) => fetch(...args),
                csrf: () => csrfFromCookie(document.cookie),
                reply,
              },
              request,
            );
          },
          () => {
            setState({ kind: "carrying", account });
            reply({ v: 1, type: "ready", account: { id: account.id, email: account.email } });
          },
        );
      })
      .catch(() => {
        if (!live) return;
        setState({ kind: "signed-out" });
        reply({ v: 1, type: "signed-out" });
      });
    return () => {
      live = false;
    };
  }, [office, fresh, navigate]);

  return (
    <main className="office-pane office-session">
      <h1 className="office-brand">Sub Rosa</h1>
      {state.kind === "checking" ? (
        <p role="status">{t("Loading…", "Chargement…")}</p>
      ) : state.kind === "signed-out" ? (
        <>
          <p>
            {t(
              "Sign in to your Sub Rosa account to connect the add-in. This window closes by itself once the add-in has its key.",
              "Connectez-vous à votre compte Sub Rosa pour relier le complément. Cette fenêtre se ferme d’elle-même une fois que le complément a sa clé.",
            )}
          </p>
          <button className="button primary" type="button" onClick={() => navigate(SIGN_IN_URL)}>
            {t("Sign in", "Se connecter")}
          </button>
        </>
      ) : (
        <p role="status">
          {t(
            `Signed in as ${state.account.email}. Go back to the add-in to finish; keep this window open until it closes by itself.`,
            `Connecté en tant que ${state.account.email}. Revenez au complément pour terminer ; gardez cette fenêtre ouverte jusqu’à ce qu’elle se ferme d’elle-même.`,
          )}
        </p>
      )}
    </main>
  );
}
