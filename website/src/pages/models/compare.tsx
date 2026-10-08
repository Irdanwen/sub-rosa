import { useState } from "react";
import { localizedPublicPath, number, t, type SiteLocale } from "../../lib/i18n";
import { siteHref } from "../../lib/paths";
import {
  type Family,
  benchmarksFor,
  categories,
  categoryTitle,
  displayName,
  families,
  familyBySlug,
  familyName,
  familyPrivacyLabel,
  familyStanding,
  formatScore,
  latestRelease,
  modelById,
  priceLine,
  releaseDate,
  traitLabel,
} from "../../models/catalog";
import { compareSelection, detailOf, useDetails } from "../../models/details";
import { read } from "../docs-content";
import { Badges, catalogHref } from "./shared";

const suggestions: [string, string[]][] = [
  ["text", ["glm", "kimi", "claude"]],
  ["video", ["kling-v3", "veo", "seedance-2-5"]],
  ["image", ["nano-banana", "gpt-image", "seedream"]],
  ["transcription", ["parakeet", "whisper", "scribe"]],
  ["voice", ["kokoro", "elevenlabs-tts", "gemini-flash-tts"]],
];

export function ComparePage({ query, locale }: { query: string; locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const [selection, setSelection] = useState(() => compareSelection(query));
  const chosen = selection
    .map((slug) => familyBySlug(slug))
    .filter((family): family is Family => Boolean(family));
  const ready = useDetails([...new Set(chosen.map((family) => family.category))]);

  const choose = (index: number, slug: string) => {
    const next = [...selection];
    if (slug) next[index] = slug;
    else next.splice(index, 1);
    const clean = [...new Set(next.filter(Boolean))].slice(0, 3);
    setSelection(clean);
    const search = clean.length ? `?m=${clean.join(",")}` : "";
    history.replaceState(
      null,
      "",
      `${siteHref(localizedPublicPath("/models/compare", locale))}${search}`,
    );
  };

  const marks = [...new Set(chosen.flatMap((family) => benchmarksFor(family.category)))];
  const row = (label: string, cell: (family: Family) => React.ReactNode) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      {chosen.map((family) => (
        <td key={family.slug}>{cell(family)}</td>
      ))}
    </tr>
  );

  return (
    <div className="wrap models-compare-page">
      <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
        <a href={href("")}>{t("Model catalog", "Catalogue des modèles")}</a>
        <span aria-hidden="true">/</span>
        <span>{t("Compare", "Comparer")}</span>
      </nav>
      <p className="eyebrow">{t("Comparator", "Comparateur")}</p>
      <h1>{t("Compare models side by side.", "Comparez les modèles côte à côte.")}</h1>
      <p className="docs-article-intro">
        {t(
          "Pick up to three families, of the same kind or not. The address of this page keeps your choice, so you can share it.",
          "Choisissez jusqu’à trois familles, du même type ou non. L’adresse de cette page garde votre choix : vous pouvez la partager.",
        )}
      </p>

      <div className="compare-pickers">
        {[0, 1, 2].map((index) => (
          <label key={index}>
            <span>{t(`Family ${index + 1}`, `Famille ${index + 1}`)}</span>
            <select
              value={selection[index] ?? ""}
              onChange={(event) => choose(index, event.target.value)}
            >
              <option value="">{t("Choose a family", "Choisir une famille")}</option>
              {categories.map((category) => (
                <optgroup key={category.id} label={read(category.title)}>
                  {families
                    .filter((family) => family.category === category.id)
                    .map((family) => (
                      <option key={family.slug} value={family.slug}>
                        {familyName(family)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        ))}
      </div>

      {chosen.length < 2 && (
        <section className="models-section" aria-labelledby="compare-suggestions">
          <h2 id="compare-suggestions">{t("Popular comparisons", "Comparaisons fréquentes")}</h2>
          <ul className="compare-suggestions">
            {suggestions.map(([category, slugs]) => (
              <li key={category}>
                <a href={`${href("compare")}?m=${slugs.join(",")}`}>
                  <span>{read(categoryTitle(category as Family["category"]))}</span>
                  <strong>
                    {slugs
                      .map((slug) => familyBySlug(slug))
                      .filter((family): family is Family => Boolean(family))
                      .map(familyName)
                      .join(t(" vs ", " contre "))}
                  </strong>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {chosen.length >= 1 && (
        <div className="models-table-wrap compare-table">
          <table className={`compare-cols-${chosen.length}`}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{t("Property", "Propriété")}</span>
                </th>
                {chosen.map((family) => (
                  <th scope="col" key={family.slug}>
                    <a href={href(family.slug)}>{familyName(family)}</a>
                    <small>
                      {read(categoryTitle(family.category))} · {family.maker}
                    </small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row(t("In one sentence", "En une phrase"), (family) => read(family.summary))}
              {row(t("What sets it apart", "Ce qui le distingue"), (family) => {
                const detail = ready ? detailOf(family.slug) : undefined;
                return detail ? read(detail.differentiator) : "·";
              })}
              {row(t("Latest version", "Dernière version"), (family) => {
                const release = latestRelease(family.slug);
                return release ? `${release.version}, ${releaseDate(release.date)}` : "·";
              })}
              {marks.map((benchmark) =>
                row(benchmark.name, (family) => {
                  if (family.category !== benchmark.category)
                    return t("Not applicable", "Sans objet");
                  const place = familyStanding(family, benchmark.id);
                  return place
                    ? t(
                        `${formatScore(benchmark, place.score.value)} (#${place.rank} of ${place.of})`,
                        `${formatScore(benchmark, place.score.value)} (${place.rank === 1 ? "1er" : `${place.rank}e`} sur ${place.of})`,
                      )
                    : t("Not measured", "Non mesuré");
                }),
              )}
              {row(t("Price", "Prix"), (family) => priceLine(modelById(family.pick)) ?? "·")}
              {row(t("Our pick", "Notre choix"), (family) => {
                const pick = modelById(family.pick);
                return pick ? displayName(pick) : "·";
              })}
              {row(t("Abilities", "Capacités"), (family) => {
                const pick = modelById(family.pick);
                const parts = [
                  pick?.context
                    ? t(
                        `${number(pick.context / 1000, 0)}K context`,
                        `contexte ${number(pick.context / 1000, 0)} k`,
                      )
                    : null,
                  pick?.seconds
                    ? t(`up to ${pick.seconds[1]} s`, `jusqu’à ${pick.seconds[1]} s`)
                    : null,
                  pick?.audio ? t("with sound", "avec le son") : null,
                  ...(pick?.traits ?? []).map((trait) =>
                    traitLabel[trait] ? read(traitLabel[trait]).toLowerCase() : null,
                  ),
                ].filter(Boolean);
                return parts.length ? parts.join(", ") : "·";
              })}
              {row(t("Privacy", "Confidentialité"), (family) => (
                <Badges family={family} />
              ))}
              {row(t("Where it shines", "Ses points forts"), (family) => (
                <ul>
                  {(detailOf(family.slug)?.strengths ?? []).map((item) => (
                    <li key={item[0]}>{read(item)}</li>
                  ))}
                </ul>
              ))}
              {row(t("Think twice when", "À éviter quand"), (family) => (
                <ul>
                  {(detailOf(family.slug)?.limits ?? []).map((item) => (
                    <li key={item[0]}>{read(item)}</li>
                  ))}
                </ul>
              ))}
              {row(t("Private by default", "Privé par défaut"), (family) =>
                familyPrivacyLabel(family).kind === "private" ? t("Yes", "Oui") : t("No", "Non"),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
