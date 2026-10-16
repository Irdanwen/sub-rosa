import { type ReactNode, useEffect, useState } from "react";
import { number, t, type SiteLocale } from "../../lib/i18n";
import {
  type Category,
  type Family,
  type PriceUnit,
  type SnapshotModel,
  benchmarksFor,
  categories,
  categoryTitle,
  displayName,
  families,
  familyName,
  familyOfModel,
  familyPrivacyLabel,
  familyReleases,
  familyStanding,
  formatScore,
  formatUsd,
  modelById,
  modelsOfCategory,
  priceUnitLabel,
  releaseDate,
  scores,
  usdPrice,
} from "../../models/catalog";
import { categoryGuides } from "../../models/categories";
import { BarChart, DotChart, ScatterChart } from "../../models/charts";
import { read } from "../docs-content";
import {
  cheapestOf,
  defaultOf,
  leaderOf,
  GuideLink,
  NeedList,
  SourceNote,
  boardRows,
  catalogHref,
  checkedOn,
  latestScoreDate,
} from "./shared";

export const isCategory = (value: string): value is Category =>
  categories.some((category) => category.id === value);

type SortKey = "name" | "score" | "price" | "spec";

const nameOf = (id: string) => {
  const model = modelById(id);
  return model ? displayName(model) : id;
};

/** The unit most models of a kind are sold in: the one its charts and table speak. */
function mainUnit(category: Category): PriceUnit | undefined {
  const units = modelsOfCategory(category)
    .map((row) => row.price?.unit)
    .filter((unit): unit is PriceUnit => Boolean(unit));
  return units
    .slice()
    .sort((a, b) => units.filter((u) => u === b).length - units.filter((u) => u === a).length)[0];
}

/** One advice card: a question answered with a model, its price and why. */
function Advice({
  label,
  model,
  reason,
  locale,
}: {
  label: string;
  model: SnapshotModel | undefined;
  reason: ReactNode;
  locale: SiteLocale;
}) {
  const family = model ? familyOfModel(model.id) : undefined;
  if (!model || !family) return null;
  const price = usdPrice(model);
  return (
    <a className="advice-card" href={catalogHref(family.slug, locale)}>
      <span className="advice-label">{label}</span>
      <strong>{displayName(model)}</strong>
      <span className="advice-family">
        {familyName(family)} · {family.maker}
      </span>
      <span className="advice-reason">{reason}</span>
      {price && (
        <span className="advice-price">
          {formatUsd(price.value)} <small>{read(priceUnitLabel[price.unit])}</small>
        </span>
      )}
    </a>
  );
}

export function CategoryPage({ category, locale }: { category: Category; locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const guide = categoryGuides[category];
  const members = families.filter((family) => family.category === category);
  const models = members.reduce((count, family) => count + family.ids.length, 0);
  const marks = benchmarksFor(category);
  const headline = marks[0];
  const unit = mainUnit(category);
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  const [board, setBoard] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: headline ? "score" : "price",
    ascending: true,
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (slug: string) =>
    setChosen((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug].slice(-3),
    );

  const releases = members
    .flatMap((family) =>
      familyReleases(family.slug)
        .filter((release) => release.inCatalog && release.date)
        .map((release) => ({ ...release, family })),
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  // A price only compares with a price in the same unit.
  const priceIn = (model: SnapshotModel | undefined) => {
    const price = usdPrice(model);
    return price && price.unit === unit ? price.value : null;
  };
  // The recommended version's own score when it has one, so a row's score and
  // price speak of the same model; otherwise the family's best, named.
  const score = (family: Family) =>
    headline
      ? (scores.find(
          (entry) =>
            entry.benchmark === headline.id && entry.model === family.pick && !entry.external,
        ) ??
        familyStanding(family, headline.id)?.score ??
        null)
      : null;

  const scatter = headline
    ? members.flatMap((family) => {
        const standing = familyStanding(family, headline.id);
        const model = standing ? modelById(standing.score.model) : undefined;
        const price = priceIn(model);
        if (!standing || !model || price === null) return [];
        return [
          {
            key: family.slug,
            label: displayName(model),
            x: price,
            y: standing.score.value,
            xDisplay: formatUsd(price),
            yDisplay:
              `${formatScore(headline, standing.score.value)} ${headline.unit === "%" ? "" : headline.unit}`.trim(),
            href: href(family.slug),
            hollow: familyPrivacyLabel(family).kind === "anonymized",
            model,
          },
        ];
      })
    : [];
  const better = (a: number, b: number) => (headline?.higherIsBetter ? b - a : a - b);
  // Best value: the cheapest among the best third, so "value" never means "weak".
  const topThird = [...scatter]
    .sort((a, b) => better(a.y, b.y))
    .slice(0, Math.max(1, Math.ceil(scatter.length / 3)));
  const value = [...topThird].sort((a, b) => a.x - b.x)[0]?.model;
  const leader = leaderOf(category);
  const start = defaultOf(category);
  const cheapest = cheapestOf(category);

  const byQuality = [...scatter].sort((a, b) => better(a.y, b.y)).slice(0, 4);
  const byPrice = [...scatter].sort((a, b) => a.x - b.x).slice(0, 2);
  const highlighted = new Set([leader?.id, value?.id, start?.id].filter(Boolean));
  const points = [...scatter]
    .sort((a, b) => better(a.y, b.y))
    .map((point) => ({
      ...point,
      focus: highlighted.has(point.model.id),
      labelled: byQuality.includes(point) || byPrice.includes(point),
    }));

  const spec = (model: SnapshotModel | undefined) =>
    category === "text"
      ? (model?.context ?? null)
      : category === "video"
        ? (model?.seconds?.[1] ?? null)
        : null;
  const hasSpec = category === "text" || category === "video";
  const sorted = [...members].sort((a, b) => {
    const direction = sort.ascending ? 1 : -1;
    const nullLast = (x: number | null, y: number | null, order: number) =>
      x === null ? (y === null ? 0 : 1) : y === null ? -1 : order;
    if (sort.key === "name") return familyName(a).localeCompare(familyName(b)) * direction;
    if (sort.key === "price") {
      const [x, y] = [priceIn(modelById(a.pick)), priceIn(modelById(b.pick))];
      return nullLast(x, y, ((x ?? 0) - (y ?? 0)) * direction);
    }
    if (sort.key === "spec") {
      const [x, y] = [spec(modelById(a.pick)), spec(modelById(b.pick))];
      return nullLast(x, y, ((y ?? 0) - (x ?? 0)) * direction);
    }
    const [x, y] = [score(a)?.value ?? null, score(b)?.value ?? null];
    return nullLast(x, y, better(x ?? 0, y ?? 0) * direction);
  });
  const choose = (key: SortKey) =>
    setSort((current) =>
      current.key === key ? { key, ascending: !current.ascending } : { key, ascending: true },
    );
  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.ascending ? "ascending" : "descending") : undefined;

  const unitLabel = unit ? read(priceUnitLabel[unit]) : "";
  const shownBoards = enhanced ? [marks[board] ?? marks[0]].filter(Boolean) : marks;

  return (
    <div className="models-category">
      <section className="catalog-hero catalog-hero-compact">
        <div className="wrap catalog-hero-inner">
          <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
            <a href={href("")}>{t("Model catalog", "Catalogue des modèles")}</a>
            <span aria-hidden="true">/</span>
            <span>{read(categoryTitle(category))}</span>
          </nav>
          <p className="eyebrow">
            {t(
              `${members.length} families, ${models} models`,
              `${members.length} familles, ${models} modèles`,
            )}
          </p>
          <h1>{read(categoryTitle(category))}</h1>
          <p className="catalog-lede">{read(guide.differs)}</p>
          <ul className="models-criteria">
            {guide.criteria.map((criterion) => (
              <li key={criterion.text[0]}>
                {criterion.term ? (
                  <GuideLink term={criterion.term} locale={locale}>
                    {read(criterion.text)}
                  </GuideLink>
                ) : (
                  read(criterion.text)
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="wrap models-body">
        <section className="models-section" aria-labelledby="category-advice">
          <p className="eyebrow">{t("Our advice", "Notre conseil")}</p>
          <h2 id="category-advice">{t("Which one to take.", "Lequel prendre.")}</h2>
          <div className="advice-grid">
            <Advice
              label={t("To start", "Pour commencer")}
              model={start}
              reason={t(
                "What Sub Rosa starts on: a balance of quality, privacy and price.",
                "Ce sur quoi Sub Rosa démarre : un équilibre entre qualité, confidentialité et prix.",
              )}
              locale={locale}
            />
            {leader && headline ? (
              <Advice
                label={t("For the best result", "Pour le meilleur résultat")}
                model={leader}
                reason={t(
                  `First on ${headline.name}, the independent ranking of this kind.`,
                  `Premier au ${headline.name}, le classement indépendant de ce type.`,
                )}
                locale={locale}
              />
            ) : (
              releases[0] && (
                <Advice
                  label={t("The newest", "Le plus récent")}
                  model={modelById(releases[0].family.pick)}
                  reason={t(
                    `${releases[0].version}, released ${releaseDate(releases[0].date)}.`,
                    `${releases[0].version}, sorti le ${releaseDate(releases[0].date)}.`,
                  )}
                  locale={locale}
                />
              )
            )}
            {value && value.id !== leader?.id ? (
              <Advice
                label={t("For the best value", "Pour le meilleur rapport qualité-prix")}
                model={value}
                reason={t(
                  "The cheapest of the best third on the ranking.",
                  "Le moins cher du meilleur tiers du classement.",
                )}
                locale={locale}
              />
            ) : (
              <Advice
                label={t("For the lowest price", "Pour le prix le plus bas")}
                model={cheapest}
                reason={t(
                  "The cheapest model of this kind in the catalog.",
                  "Le modèle le moins cher de ce type dans le catalogue.",
                )}
                locale={locale}
              />
            )}
          </div>
          <h3 className="needs-heading">
            {t("Or start from what you want to do", "Ou partez de ce que vous voulez faire")}
          </h3>
          <NeedList category={category} locale={locale} compact />
        </section>

        {headline && scatter.length > 2 && (
          <section className="models-section" aria-labelledby="category-scatter">
            <p className="eyebrow">{t("Quality and price", "Qualité et prix")}</p>
            <h2 id="category-scatter">
              {t("What you get for what you pay.", "Ce que vous obtenez pour ce que vous payez.")}
            </h2>
            <p className="models-lede">{read(headline.howToRead)}</p>
            <ScatterChart
              title={`${headline.name} ${t("against price", "selon le prix")}`}
              note={<SourceNote benchmark={headline} date={latestScoreDate(headline.id)} />}
              points={points}
              xLabel={t(
                `US dollars ${unitLabel} (log scale)`,
                `Dollars ${unitLabel} (échelle logarithmique)`,
              )}
              yLabel={headline.name}
              higherIsBetter={headline.higherIsBetter}
              legend={
                <>
                  <span className="legend-dot is-focus" /> {t("Our advice", "Notre conseil")}
                  <span className="legend-dot" /> {t("Private", "Privé")}
                  <span className="legend-dot is-hollow" /> {t("Anonymized", "Anonymisé")}
                </>
              }
              caption={t(
                "Each point is a family’s best measured version. The top left holds the best value.",
                "Chaque point est la meilleure version mesurée d’une famille. En haut à gauche se trouve le meilleur rapport qualité-prix.",
              )}
            />
          </section>
        )}

        {marks.length > 0 ? (
          <section className="models-section" aria-labelledby="category-boards">
            <p className="eyebrow">{t("Leaderboards", "Classements")}</p>
            <h2 id="category-boards">{t("Measured side by side.", "Mesurés côte à côte.")}</h2>
            {enhanced && marks.length > 1 && (
              <fieldset className="chip-row">
                <legend className="sr-only">{t("Benchmark", "Benchmark")}</legend>
                {marks.map((benchmark, index) => (
                  <button
                    type="button"
                    className="chip"
                    key={benchmark.id}
                    aria-pressed={board === index}
                    onClick={() => setBoard(index)}
                  >
                    {benchmark.name}
                  </button>
                ))}
              </fieldset>
            )}
            <div className="board-stack">
              {shownBoards.map((benchmark) => {
                const Chart = benchmark.unit === "Elo" ? DotChart : BarChart;
                return (
                  <Chart
                    key={benchmark.id}
                    title={benchmark.name}
                    note={<SourceNote benchmark={benchmark} date={latestScoreDate(benchmark.id)} />}
                    rows={boardRows(benchmark, locale).map((row) => ({
                      ...row,
                      focus: highlighted.has(row.key),
                    }))}
                    valueHead={benchmark.unit}
                    caption={read(benchmark.measures)}
                  />
                );
              })}
            </div>
          </section>
        ) : (
          <section className="models-section">
            <p className="eyebrow">{t("Leaderboards", "Classements")}</p>
            <h2>
              {t("No reliable public ranking yet.", "Pas encore de classement public fiable.")}
            </h2>
            <p className="models-lede">
              {t(
                "No independent arena ranks these models yet, so this page compares them on specs and price only.",
                "Aucune arène indépendante ne classe encore ces modèles : cette page les compare donc sur leurs specs et leur prix seulement.",
              )}
            </p>
          </section>
        )}

        <section className="models-section" aria-labelledby="category-table">
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("Prices", "Prix")}</p>
              <h2 id="category-table">
                {t("Every family, side by side.", "Toutes les familles, côte à côte.")}
              </h2>
            </div>
            <a
              className="text-link"
              href={`${href("prices")}${category === "text" ? "" : `?k=${category}`}`}
            >
              {t(
                `Every price, model by model (${models})`,
                `Tous les prix, modèle par modèle (${models})`,
              )}{" "}
              <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="models-lede">
            {t(
              "One row per family, at its recommended version, in US dollars. Sort any column; tick up to three families to compare them in detail.",
              "Une ligne par famille, à sa version recommandée, en dollars américains. Triez n’importe quelle colonne ; cochez jusqu’à trois familles pour les comparer en détail.",
            )}
          </p>
          <div className="models-compare-bar" aria-live="polite">
            {chosen.length > 0 ? (
              <a className="button primary" href={`${href("compare")}?m=${chosen.join(",")}`}>
                {t(`Compare ${chosen.length}`, `Comparer ${chosen.length}`)}{" "}
                <span aria-hidden="true">→</span>
              </a>
            ) : (
              <span>{t("Nothing ticked yet.", "Rien de coché pour l’instant.")}</span>
            )}
          </div>
          <div className="models-table-wrap price-table-wrap">
            <table className="price-table">
              <caption className="sr-only">
                {t(
                  `${read(categoryTitle(category))}: every family at its recommended version`,
                  `${read(categoryTitle(category))} : chaque famille à sa version recommandée`,
                )}
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t("Compare", "Comparer")}</span>
                  </th>
                  <th scope="col" aria-sort={ariaSort("name")}>
                    <button type="button" className="sort-button" onClick={() => choose("name")}>
                      {t("Family", "Famille")}
                    </button>
                  </th>
                  {headline && (
                    <th scope="col" aria-sort={ariaSort("score")}>
                      <button type="button" className="sort-button" onClick={() => choose("score")}>
                        {headline.name}
                      </button>
                      <small>
                        {headline.unit === "Elo"
                          ? t("Elo rating", "Classement Elo")
                          : headline.higherIsBetter
                            ? t("higher is better", "plus haut, mieux c’est")
                            : t("lower is better", "plus bas, mieux c’est")}
                      </small>
                    </th>
                  )}
                  <th scope="col" aria-sort={ariaSort("price")}>
                    <button type="button" className="sort-button" onClick={() => choose("price")}>
                      {t("Price", "Prix")}
                    </button>
                    {unitLabel && <small>{unitLabel}</small>}
                  </th>
                  {hasSpec && (
                    <th scope="col" aria-sort={ariaSort("spec")}>
                      <button type="button" className="sort-button" onClick={() => choose("spec")}>
                        {category === "text"
                          ? t("Context", "Contexte")
                          : t("Longest clip", "Plan le plus long")}
                      </button>
                      <small>
                        {category === "text" ? t("tokens", "jetons") : t("seconds", "secondes")}
                      </small>
                    </th>
                  )}
                  <th scope="col">{t("Privacy", "Confidentialité")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((family) => {
                  const pick = modelById(family.pick);
                  const place = score(family);
                  const price = usdPrice(pick);
                  const reach = spec(pick);
                  const privacy = familyPrivacyLabel(family);
                  return (
                    <tr
                      key={family.slug}
                      className={highlighted.has(family.pick) ? "is-advised" : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t(
                            `Compare ${familyName(family)}`,
                            `Comparer ${familyName(family)}`,
                          )}
                          checked={chosen.includes(family.slug)}
                          onChange={() => toggle(family.slug)}
                        />
                      </td>
                      <th scope="row">
                        <a href={href(family.slug)}>{familyName(family)}</a>
                        <small>
                          {pick ? displayName(pick) : family.pick} · {family.maker}
                        </small>
                      </th>
                      {headline && (
                        <td>
                          {place ? (
                            <>
                              {formatScore(headline, place.value)}
                              {place.model !== family.pick && <small>{nameOf(place.model)}</small>}
                            </>
                          ) : (
                            <span className="is-empty">{t("Not measured", "Non mesuré")}</span>
                          )}
                        </td>
                      )}
                      <td className="is-price">
                        {price ? (
                          price.unit === unit ? (
                            formatUsd(price.value)
                          ) : (
                            `${formatUsd(price.value)} ${read(priceUnitLabel[price.unit])}`
                          )
                        ) : (
                          <span className="is-empty">{t("In the app", "Dans l’app")}</span>
                        )}
                      </td>
                      {hasSpec && (
                        <td>
                          {reach === null
                            ? "·"
                            : category === "text"
                              ? t(`${number(reach / 1000, 0)}K`, `${number(reach / 1000, 0)} k`)
                              : `${reach} s`}
                        </td>
                      )}
                      <td>
                        <span className={`models-badge models-privacy-${privacy.kind}`}>
                          {read(privacy.label)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {releases.length > 0 && (
          <section className="models-section" aria-labelledby="category-recent">
            <p className="eyebrow">{t("Release history", "Historique des sorties")}</p>
            <h2 id="category-recent">{t("The latest versions.", "Les dernières versions.")}</h2>
            <ol className="release-strip">
              {releases.slice(0, 8).map((release) => (
                <li key={`${release.family.slug}-${release.version}`}>
                  <a href={href(release.family.slug)}>
                    <span className="release-meta">
                      <time dateTime={release.date}>{releaseDate(release.date)}</time>
                    </span>
                    <strong>{release.version}</strong>
                    <span>{familyName(release.family)}</span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}

        <p className="models-footnote">
          {t(
            `Prices read on ${checkedOn()}, in US dollars; scores dated on each chart. Sub Rosa shows the exact price before you start.`,
            `Prix relevés le ${checkedOn()}, en dollars américains ; scores datés sur chaque graphique. Sub Rosa affiche le prix exact avant de lancer.`,
          )}
        </p>
      </div>
    </div>
  );
}
