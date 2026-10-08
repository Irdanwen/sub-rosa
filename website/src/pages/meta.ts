import { t } from "../lib/i18n";
import { categories, familyBySlug } from "../models/catalog";
import { guideBySlug, read } from "./docs-content";
import { modelCatalogTitle } from "./models";

/**
 * The title and description the prerender writes into a public page's
 * `<head>`, in the current language (`scripts/prerender.mjs`). `page` is the
 * path without its language prefix. The description is plain text: the
 * prerender escapes it.
 */
export function pageMeta(page: string): { title: string; description: string } {
  const guide = page.startsWith("/docs/") ? guideBySlug(page.slice(6)) : undefined;
  const slug = page.startsWith("/models/") ? page.slice(8) : "";
  const family = slug ? familyBySlug(slug) : undefined;
  const kind = slug ? categories.find((item) => item.id === slug) : undefined;
  const models = page === "/models" || page.startsWith("/models/");
  const title = models
    ? `${modelCatalogTitle(page)} · Sub Rosa`
    : guide
      ? `${read(guide.title)} · Sub Rosa`
      : page === "/"
        ? "Sub Rosa"
        : `${
            {
              "/downloads": t("Download", "Télécharger"),
              "/privacy": t("Privacy", "Confidentialité"),
              "/security": t("Security", "Sécurité"),
              "/help": t("Documentation", "Documentation"),
              "/docs": t("Documentation", "Documentation"),
            }[page] ?? t("Information", "Informations")
          } · Sub Rosa`;
  const description = kind
    ? read(kind.description)
    : slug === "guide"
      ? t(
          "Tokens, context windows, reasoning, open weights, benchmarks and Elo ratings: what makes AI models different, explained plainly.",
          "Jetons, fenêtre de contexte, raisonnement, poids ouverts, benchmarks et classements Elo : ce qui rend les modèles d’IA différents, expliqué simplement.",
        )
      : slug === "compare"
        ? t(
            "Compare up to three AI models side by side: scores, prices, versions, strengths and limits.",
            "Comparez jusqu’à trois modèles d’IA côte à côte : scores, prix, versions, forces et limites.",
          )
        : guide
          ? read(guide.summary)
          : family
            ? read(family.summary)
            : page === "/models"
              ? t(
                  "What each Sub Rosa model is good at, what it costs and how to choose: text, transcription, image, editing, video, voice and music.",
                  "Ce que chaque modèle de Sub Rosa sait faire, ce qu’il coûte et comment choisir : texte, transcription, image, retouche, vidéo, voix et musique.",
                )
              : t(
                  "Sub Rosa brings conversations, notes and ideas into one personal workspace. Download the app for your device.",
                  "Sub Rosa réunit vos conversations, vos notes et vos idées dans un espace personnel. Téléchargez l’app pour votre appareil.",
                );
  return { title, description };
}
