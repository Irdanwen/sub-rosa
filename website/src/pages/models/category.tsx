import { useState } from "react";
import { number, t, type SiteLocale } from "../../lib/i18n";
import {
  type Category,
  type Family,
  benchmarksFor,
  categories,
  categoryTitle,
  creditsLabel,
  creditsPerUnit,
  displayName,
  families,
  familyName,
  familyPrivacyLabel,
  familyReleases,
  familyStanding,
  formatScore,
  latestRelease,
  modelById,
  releaseDate,
} from "../../models/catalog";
import { categoryGuides } from "../../models/categories";
import { BarChart, DotChart, ScatterChart, StatTile } from "../../models/charts";
import { read } from "../docs-content";
import {
  FamilyCard,
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

type SortKey = "name" | "release" | "score" | "price";

export function CategoryPage({ category, locale }: { category: Category; locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const guide = categoryGuides[category];
  const members = families.filter((family) => family.category === category);
  const models = members.reduce((count, family) => count + family.ids.length, 0);
  const marks = benchmarksFor(category);
  const headline = marks[0];
  const releases = members
    .flatMap((family) =>
      familyReleases(family.slug)
        .filter((release) => release.inCatalog && release.date)
        .map((release) => ({ ...release, family })),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const prices = members
    .flatMap((family) => family.ids.map((id) => creditsPerUnit(modelById(id))))
    .filter((value): value is number => value !== null);
  const [sort, setSort] = useState<SortKey>(headline ? "score" : "price");
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (slug: string) =>
    setChosen((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug].slice(-3),
    );

  const score = (family: Family) =>
    headline ? (familyStanding(family, headline.id)?.score.value ?? null) : null;
  const sorted = [...members].sort((a, b) => {
    if (sort === "name") return familyName(a).localeCompare(familyName(b));
    if (sort === "release")
      return (latestRelease(b.slug)?.date ?? "").localeCompare(latestRelease(a.slug)?.date ?? "");
    if (sort === "price")
      return (
        (creditsPerUnit(modelById(a.pick)) ?? Number.POSITIVE_INFINITY) -
        (creditsPerUnit(modelById(b.pick)) ?? Number.POSITIVE_INFINITY)
      );
    const [x, y] = [score(a), score(b)];
    if (x === null) return 1;
    if (y === null) return -1;
    return headline?.higherIsBetter ? y - x : x - y;
  });

  const scatter = headline
    ? members.flatMap((family) => {
        const standing = familyStanding(family, headline.id);
        const price = standing ? creditsPerUnit(modelById(standing.score.model)) : null;
        if (!standing || price === null) return [];
        const model = modelById(standing.score.model);
        return [
          {
            key: family.slug,
            label: model ? displayName(model) : familyName(family),
            x: price,
            y: standing.score.value,
            xDisplay: creditsLabel(price),
            yDisplay:
              `${formatScore(headline, standing.score.value)} ${headline.unit === "%" ? "" : headline.unit}`.trim(),
            href: href(family.slug),
            hollow: familyPrivacyLabel(family).kind === "anonymized",
          },
        ];
      })
    : [];
  // Label the best few and the cheapest few; every other point keeps its tooltip and its table row.
  const byQuality = [...scatter]
    .sort((a, b) => (headline?.higherIsBetter ? b.y - a.y : a.y - b.y))
    .slice(0, 4);
  const byPrice = [...scatter].sort((a, b) => a.x - b.x).slice(0, 2);
  // Best first, so the leaders keep their label when two would collide.
  const points = [...scatter]
    .sort((a, b) => (headline?.higherIsBetter ? b.y - a.y : a.y - b.y))
    .map((point) => ({ ...point, labelled: byQuality.includes(point) || byPrice.includes(point) }));

  const specRows = members
    .map((family) => {
      const pick = modelById(family.pick);
      if (category === "text" && pick?.context)
        return {
          family,
          pick,
          value: pick.context,
          display: `${number(pick.context / 1000, 0)} k`,
        };
      if (category === "video" && pick?.seconds)
        return { family, pick, value: pick.seconds[1], display: `${pick.seconds[1]} s` };
      return null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="models-category">
      <section className="docs-hero">
        <div className="wrap docs-hero-inner">
          <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
            <a href={href("")}>{t("Model catalog", "Catalogue des modèles")}</a>
            <span aria-hidden="true">/</span>
            <span>{read(categoryTitle(category))}</span>
          </nav>
          <p className="eyebrow">{t("Model catalog", "Catalogue des modèles")}</p>
          <h1>{read(categoryTitle(category))}</h1>
          <p>{read(guide.differs)}</p>
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
        <div className="stat-row">
          <StatTile
            label={t("Families", "Familles")}
            value={number(members.length, 0)}
            sub={t(`${models} models`, `${models} modèles`)}
          />
          {releases[0] && (
            <StatTile
              label={t("Newest release", "Sortie la plus récente")}
              value={releases[0].version}
              sub={releaseDate(releases[0].date)}
            />
          )}
          {headline && boardRows(headline, locale)[0] && (
            <StatTile
              label={t("Leader", "En tête")}
              value={boardRows(headline, locale)[0].label.replace(/^1\. /, "")}
              sub={`${boardRows(headline, locale)[0].display}${headline.unit === "%" ? "" : ` ${headline.unit}`} · ${headline.name}`}
            />
          )}
          {prices.length > 1 && (
            <StatTile
              label={t("Price range", "Fourchette de prix")}
              value={`${number(Math.min(...prices), Math.min(...prices) < 1 ? 2 : 1)} à ${number(Math.max(...prices), 1)}`.replace(
                " à ",
                t(" to ", " à "),
              )}
              sub={read(guide.priceAxis).replace(/ \(.*\)$/, "")}
            />
          )}
        </div>

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
              xLabel={read(guide.priceAxis)}
              yLabel={headline.name}
              higherIsBetter={headline.higherIsBetter}
              legend={
                <>
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

        {marks.length > 0 && (
          <section className="models-section" aria-labelledby="category-boards">
            <p className="eyebrow">{t("Leaderboards", "Classements")}</p>
            <h2 id="category-boards">{t("Measured side by side.", "Mesurés côte à côte.")}</h2>
            <div className={marks.length > 1 ? "chart-grid" : undefined}>
              {marks.map((benchmark) => {
                const rows = boardRows(benchmark, locale);
                const Chart = benchmark.unit === "Elo" ? DotChart : BarChart;
                return (
                  <div key={benchmark.id}>
                    <Chart
                      title={benchmark.name}
                      note={
                        <SourceNote benchmark={benchmark} date={latestScoreDate(benchmark.id)} />
                      }
                      rows={rows}
                      valueHead={benchmark.unit}
                      caption={read(benchmark.measures)}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {marks.length === 0 && (
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

        {specRows.length > 2 && (
          <section className="models-section" aria-labelledby="category-spec">
            <p className="eyebrow">{t("Specs", "Caractéristiques")}</p>
            <h2 id="category-spec">
              {category === "text"
                ? t("How much each reads at once.", "Ce que chacun lit d’un coup.")
                : t("How long a single clip can run.", "La durée maximale d’un plan.")}
            </h2>
            <BarChart
              title={
                category === "text"
                  ? t("Context window, in tokens", "Fenêtre de contexte, en jetons")
                  : t("Longest clip, in seconds", "Plan le plus long, en secondes")
              }
              note={t(
                `Recommended version of each family · ${checkedOn()}`,
                `Version recommandée de chaque famille · ${checkedOn()}`,
              )}
              rows={specRows.map((row) => ({
                key: row.family.slug,
                label: displayName(row.pick),
                sub: familyName(row.family),
                value: row.value,
                display: row.display,
                href: href(row.family.slug),
              }))}
              valueHead={category === "text" ? t("Tokens", "Jetons") : t("Seconds", "Secondes")}
            />
          </section>
        )}

        {releases.length > 0 && (
          <section className="models-section" aria-labelledby="category-recent">
            <p className="eyebrow">{t("Release history", "Historique des sorties")}</p>
            <h2 id="category-recent">{t("The latest versions.", "Les dernières versions.")}</h2>
            <ol className="timeline">
              {releases.slice(0, 8).map((release) => (
                <li key={`${release.family.slug}-${release.version}`}>
                  <time dateTime={release.date}>{releaseDate(release.date)}</time>
                  <a href={href(release.family.slug)}>
                    <strong>{release.version}</strong>
                    <span>{familyName(release.family)}</span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="models-section" aria-labelledby="category-needs">
          <p className="eyebrow">{t("How to choose", "Comment choisir")}</p>
          <h2 id="category-needs">
            {t("Start from what you want to do.", "Partez de ce que vous voulez faire.")}
          </h2>
          <NeedList category={category} locale={locale} />
        </section>

        <section className="models-section" aria-labelledby="category-table">
          <p className="eyebrow">{t("Every family", "Toutes les familles")}</p>
          <h2 id="category-table">
            {t("The whole kind, one row each.", "Tout le type, une ligne chacun.")}
          </h2>
          <p className="models-lede">
            {t(
              "Sort by any column. Tick up to three families to compare them in detail.",
              "Triez par n’importe quelle colonne. Cochez jusqu’à trois familles pour les comparer en détail.",
            )}
          </p>
          <div className="models-compare-bar" aria-live="polite">
            {chosen.length > 0 ? (
              <a className="button primary" href={`${href("compare")}?m=${chosen.join(",")}`}>
                {t(`Compare ${chosen.length}`, `Comparer ${chosen.length}`)} ↗
              </a>
            ) : (
              <span>{t("Nothing ticked yet.", "Rien de coché pour l’instant.")}</span>
            )}
          </div>
          <div className="models-table-wrap models-compare">
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t("Compare", "Comparer")}</span>
                  </th>
                  {(
                    [
                      ["name", t("Family", "Famille")],
                      ["release", t("Latest version", "Dernière version")],
                      ...(headline ? [["score", headline.name]] : []),
                      ["price", t("Price", "Prix")],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th scope="col" key={key} aria-sort={sort === key ? "ascending" : undefined}>
                      <button type="button" className="sort-button" onClick={() => setSort(key)}>
                        {label}
                        <span aria-hidden="true">{sort === key ? " ↓" : ""}</span>
                      </button>
                    </th>
                  ))}
                  <th scope="col">{t("Privacy", "Confidentialité")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((family) => {
                  const release = latestRelease(family.slug);
                  const value = score(family);
                  const price = creditsPerUnit(modelById(family.pick));
                  return (
                    <tr key={family.slug}>
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
                        <small>{family.maker}</small>
                      </th>
                      <td>{release ? `${release.version}, ${releaseDate(release.date)}` : "·"}</td>
                      {headline && (
                        <td>
                          {value === null
                            ? t("Not measured", "Non mesuré")
                            : formatScore(headline, value)}
                        </td>
                      )}
                      <td>
                        {price === null ? t("In the app", "Dans l’app") : creditsLabel(price)}
                      </td>
                      <td>{read(familyPrivacyLabel(family).label)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="models-section" aria-labelledby="category-cards">
          <h2 id="category-cards" className="sr-only">
            {t("Family cards", "Cartes des familles")}
          </h2>
          <div className="models-grid">
            {headline
              ? sorted.map((family) => (
                  <FamilyCard family={family} locale={locale} key={family.slug} />
                ))
              : members.map((family) => (
                  <FamilyCard family={family} locale={locale} key={family.slug} />
                ))}
          </div>
          <p className="models-footnote">
            {t(
              `Prices checked on ${checkedOn()}; scores dated on each chart. Sub Rosa shows the exact price before you start.`,
              `Prix vérifiés le ${checkedOn()} ; scores datés sur chaque graphique. Sub Rosa affiche le prix exact avant de lancer.`,
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
