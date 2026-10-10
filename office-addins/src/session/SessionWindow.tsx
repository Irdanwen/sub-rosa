import { useEffect, useRef, useState } from "react";
import { t } from "../../../website/src/lib/i18n";
import { accountOrigin } from "../../../website/src/lib/office-origins";
import type { OfficeGlobal } from "../office";
import { type RelayState, startRelay } from "./relay";

/** The account origin's page that carries the pane's calls (no Office.js). */
export const COURIER_PATH = "/office/courier.html";
/** The account origin's page the service returns to after sign-in; it hands
 * the window back to this page, on the office origin. */
export const SIGNED_IN_PATH = "/office/signed-in.html";

/** Sign-in on the account origin, coming back through `SIGNED_IN_PATH`. */
export function signInUrl(origin = accountOrigin()): string {
  return `${origin}/auth/login?return_to=${encodeURIComponent(SIGNED_IN_PATH)}`;
}

const assign = (url: string) => location.assign(url);
const reloadPage = () => location.reload();

/**
 * The sign-in window an Office pane opens (ADR-0102, addendum of
 * 2026-10-10). It runs on the office origin, with Office.js for the pane's
 * channel, and holds no session: it embeds the account origin's courier
 * frame, which has the account's cookie, and relays the pane's few device
 * calls to it (`relay.ts`). Signing in is a top-level visit to the account
 * origin, which comes back here. It holds no key and shows nothing of the
 * account but the address it is signed in as.
 */
export function SessionWindow({
  office,
  fresh,
  navigate = assign,
  reload = reloadPage,
  origin = accountOrigin(),
  paneOrigin = location.origin,
}: {
  office: OfficeGlobal;
  fresh: boolean;
  navigate?: (url: string) => void;
  reload?: () => void;
  /** The account origin (the build's). */
  origin?: string;
  /** The pane's origin: this window's own. */
  paneOrigin?: string;
}) {
  const [state, setState] = useState<{ kind: "checking" } | RelayState>({ kind: "checking" });
  const frame = useRef<HTMLIFrameElement>(null);
  const relay = useRef<{ hello(): void } | null>(null);

  useEffect(() => {
    if (fresh) {
      navigate(signInUrl(origin));
      return;
    }
    const started = startRelay({
      office,
      courier: () => frame.current?.contentWindow ?? null,
      target: window,
      accountOrigin: origin,
      paneOrigin,
      onState: setState,
    });
    relay.current = started;
    return () => {
      relay.current = null;
      started.stop();
    };
  }, [office, fresh, navigate, origin, paneOrigin]);

  return (
    <main className="office-pane office-session">
      <h1 className="office-brand">Sub Rosa</h1>
      {!fresh && (
        <iframe
          ref={frame}
          src={`${origin}${COURIER_PATH}`}
          title="Sub Rosa"
          hidden
          onLoad={() => relay.current?.hello()}
        />
      )}
      {state.kind === "checking" ? (
        <p role="status">{t("Loading…", "Chargement…")}</p>
      ) : state.kind === "unavailable" ? (
        <>
          <p role="alert">
            {t(
              "The Sub Rosa account site did not answer. Check your connection, then try again.",
              "Le site du compte Sub Rosa n’a pas répondu. Vérifiez votre connexion, puis réessayez.",
            )}
          </p>
          <button className="button" type="button" onClick={reload}>
            {t("Try again", "Réessayer")}
          </button>
        </>
      ) : state.kind === "signed-out" ? (
        <>
          <p>
            {t(
              "Sign in to your Sub Rosa account to connect the add-in. This window closes by itself once the add-in has its key.",
              "Connectez-vous à votre compte Sub Rosa pour relier le complément. Cette fenêtre se ferme d’elle-même une fois que le complément a sa clé.",
            )}
          </p>
          <button
            className="button primary"
            type="button"
            onClick={() => navigate(signInUrl(origin))}
          >
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
