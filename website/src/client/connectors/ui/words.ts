import { t } from "../../../lib/i18n";
import { NeedsSignIn } from "../runtime";
import { McpError } from "../mcp";
import { OAuthError } from "../oauth";

/** Why a catalog server cannot be used from a tab, as the person reads it. */
export function unavailableReason(reason: string | null): string {
  switch (reason) {
    case "mcp_cors":
      return t(
        "This service does not accept requests from a browser. Use it in the app.",
        "Ce service n’accepte pas les requêtes d’un navigateur. Utilisez-le dans l’app.",
      );
    case "origin_refused":
      return t(
        "This service refuses requests that come from a web page. Use it in the app.",
        "Ce service refuse les requêtes qui viennent d’une page web. Utilisez-le dans l’app.",
      );
    case "registration_cors":
    case "token_cors":
    case "auth_metadata_cors":
      return t(
        "This service's sign-in does not accept a browser. Use it in the app.",
        "La connexion de ce service n’accepte pas un navigateur. Utilisez-le dans l’app.",
      );
    case "app_only":
      return t(
        "This connector signs in with the app's own access. Use it in the app.",
        "Ce connecteur se connecte avec l’accès propre à l’app. Utilisez-le dans l’app.",
      );
    case "page_policy":
      return t(
        "This page may only reach the services listed in the catalog as available in the browser. Use this server in the app.",
        "Cette page ne peut joindre que les services du catalogue indiqués comme disponibles dans le navigateur. Utilisez ce serveur dans l’app.",
      );
    case "not_probed":
      return t(
        "This service has not been checked for the browser yet. Use it in the app.",
        "Ce service n’a pas encore été vérifié pour le navigateur. Utilisez-le dans l’app.",
      );
    default:
      return t(
        "This service's sign-in is not available to a browser. Use it in the app.",
        "La connexion de ce service n’est pas disponible pour un navigateur. Utilisez-le dans l’app.",
      );
  }
}

/** A failure, as the person reads it. */
export function failureText(error: unknown): string {
  const code =
    error instanceof OAuthError
      ? error.code
      : error instanceof NeedsSignIn
        ? "connector_sign_in"
        : "";
  switch (code) {
    case "connector_sign_in":
      return t(
        "This connector needs you to sign in again.",
        "Ce connecteur a besoin que vous vous reconnectiez.",
      );
    case "connector_oauth_discovery":
      return t(
        "This connector does not say how to sign in. Check its address.",
        "Ce connecteur n’indique pas comment se connecter. Vérifiez son adresse.",
      );
    case "connector_oauth_pkce":
      return t(
        "This connector's sign-in does not support the protection Sub Rosa requires.",
        "La connexion de ce connecteur ne prend pas en charge la protection que Sub Rosa exige.",
      );
    case "connector_oauth_registration":
      return t(
        "This connector does not let apps register themselves, so Sub Rosa cannot sign in to it yet.",
        "Ce connecteur ne laisse pas les apps s’enregistrer, donc Sub Rosa ne peut pas encore s’y connecter.",
      );
    case "connector_oauth_expired":
      return t(
        "That sign-in took too long. Start it again.",
        "Cette connexion a pris trop de temps. Recommencez-la.",
      );
    case "connector_oauth_denied":
      return t("The sign-in was cancelled.", "La connexion a été annulée.");
    case "connector_token_missing":
      return t(
        "Paste the access token the service gave you.",
        "Collez le jeton d’accès que le service vous a donné.",
      );
  }
  if (error instanceof McpError && error.kind === "status")
    return t(
      `The connector answered with status ${error.detail.status}.`,
      `Le connecteur a répondu avec le statut ${error.detail.status}.`,
    );
  return t(
    "The connector could not be reached. Check your connection.",
    "Le connecteur n’a pas pu être joint. Vérifiez votre connexion.",
  );
}
