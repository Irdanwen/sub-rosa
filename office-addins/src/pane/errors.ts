import { CarpeDiemError } from "../../../website/src/client/carpe-diem";
import { t } from "../../../website/src/lib/i18n";
import { PaneError } from "../model";

/** A failure whose message is already the sentence the person reads. */
export class ShownError extends Error {}

/** What the person reads when a request did not give a proposal. */
export function failureText(error: unknown): string {
  if (error instanceof ShownError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return t("Stopped.", "Arrêté.");
  if (error instanceof PaneError) {
    if (error.code === "no_key")
      return t(
        "This add-in has no working key. Sign in to renew it.",
        "Ce complément n’a pas de clé valable. Connectez-vous pour la renouveler.",
      );
    if (error.code === "too_long")
      return t(
        "The selection is too long. Select a shorter passage.",
        "La sélection est trop longue. Sélectionnez un passage plus court.",
      );
    if (error.code === "empty")
      return t("Select some text first.", "Sélectionnez d’abord du texte.");
    return t("The model gave no answer. Try again.", "Le modèle n’a pas répondu. Réessayez.");
  }
  if (error instanceof CarpeDiemError && error.status === 402)
    return t(
      "This add-in reached its daily limit, or your Carpe Diem credits ran out.",
      "Ce complément a atteint sa limite du jour, ou vos crédits Carpe Diem sont épuisés.",
    );
  return t(
    "We could not complete this action. Check your connection and try again.",
    "Cette action n’a pas abouti. Vérifiez votre connexion et réessayez.",
  );
}
