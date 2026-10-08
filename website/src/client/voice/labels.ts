/** What the voice conversation says and shows, in the page's language. */
import { t } from "../../lib/i18n";
import type { Notice, Phase } from "./machine";

/** How a fenced block is said instead of read (`voice/session.rs`). */
export function fenceLabel(info: string): string {
  const lower = info.trim().toLowerCase();
  if (!lower.startsWith("subrosa:")) return t("There is some code here.", "Il y a du code ici.");
  switch (lower.slice("subrosa:".length).trim()) {
    case "links":
      return t("There are links here.", "Il y a des liens ici.");
    case "places":
      return t("There are places here.", "Il y a des lieux ici.");
    case "notes":
      return t("There are notes here.", "Il y a des notes ici.");
    case "chart":
      return t("There is a chart here.", "Il y a un graphique ici.");
    case "table":
      return t("There is a table here.", "Il y a un tableau ici.");
    default:
      return t("There is a card here.", "Il y a une carte ici.");
  }
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "listening":
      return t("Listening", "À l’écoute");
    case "transcribing":
      return t("Writing down what you said", "Transcription de vos mots");
    case "thinking":
      return t("Thinking", "Réflexion");
    case "speaking":
      return t("Speaking", "Réponse à voix haute");
  }
}

export function noticeLabel(notice: Notice): string {
  switch (notice) {
    case "nothingHeard":
      return t("Nothing was heard. Say it again.", "Rien n’a été entendu. Redites-le.");
    case "transcriptionFailed":
      return t(
        "What you said could not be written down. Say it again.",
        "Vos mots n’ont pas pu être transcrits. Redites-les.",
      );
    case "speechFailed":
      return t(
        "A sentence could not be read aloud and was skipped.",
        "Une phrase n’a pas pu être lue et a été sautée.",
      );
    case "turnFailed":
      return t(
        "The reply could not be written. Say it again.",
        "La réponse n’a pas pu être écrite. Redites-le.",
      );
  }
}
