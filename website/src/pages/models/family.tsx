import { useState } from "react";
import { number, t, type SiteLocale } from "../../lib/i18n";
import {
  type Family,
  type FamilyDetail,
  type Release,
  benchmarksFor,
  categoryTitle,
  displayName,
  familyBySlug,
  familyName,
  familyScores,
  familyStanding,
  formatScore,
  headlineBenchmark,
  modelById,
  modelTypeLabel,
  priceLine,
  privacyLabel,
  releaseDate,
  scores,
  traitLabel,
} from "../../models/catalog";
import { BarChart, DotChart, StatTile, TrendChart } from "../../models/charts";
import { detailOf, useDetails } from "../../models/details";
import { needs } from "../../models/needs";
import { read } from "../docs-content";
import {
  Badges,
  GuideLink,
  SourceNote,
  boardRows,
  catalogHref,
  checkedOn,
  standingLine,
} from "./shared";

const modality: Record<string, [string, string]> = {
  text: ["text", "texte"],
  image: ["images", "images"],
  audio: ["audio", "audio"],
  video: ["video", "vidéo"],
};
const modalities = (list: string[]) =>
  list.map((item) => read(modality[item] ?? [item, item])).join(", ");

export function FamilyMissing({ locale }: { locale: SiteLocale }) {
  return (
    <section className="page wrap docs-not-found">
      <p className="eyebrow">{t("Model catalog", "Catalogue des modèles")}</p>
      <h1>{t("This model could not be found.", "Ce modèle est introuvable.")}</h1>
      <p>
        {t(
          "It may have been renamed or retired. The catalog lists everything available today.",
          "Il a peut-être été renommé ou retiré. Le catalogue liste tout ce qui est disponible aujourd’hui.",
        )}
      </p>
      <a className="button primary" href={catalogHref("", locale)}>
        {t("Browse the catalog", "Parcourir le catalogue")}
      </a>
    </section>
  );
}

/** The release a catalog id or an external label belongs to. */
const releaseOf = (detail: FamilyDetail | undefined, model: string) =>
  detail?.releases.find((release) => release.ids.includes(model) || release.version === model);

function CopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="use-case-prompt">
      <p>{text}</p>
      <button
        type="button"
        className="copy-button"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => setCopied(false),
          )
        }
      >
        {copied ? t("Copied", "Copié") : t("Copy the prompt", "Copier le prompt")}
      </button>
    </div>
  );
}

function Timeline({ releases }: { releases: Release[] }) {
  const latest = [...releases].reverse().find((release) => !release.external);
  return (
    <ol className="version-timeline">
      {releases.map((release) => (
        <li
          key={release.version}
          className={
            release === latest ? "is-latest" : release.external ? "is-external" : undefined
          }
        >
          <div className="version-head">
            <time dateTime={release.date ?? undefined}>
              {release.date
                ? releaseDate(release.date)
                : t("Date not published", "Date non publiée")}
            </time>
            <strong>{release.version}</strong>
            {release === latest && (
              <span className="models-badge models-privacy-private">
                {t("Latest", "La plus récente")}
              </span>
            )}
            {release.external && (
              <span className="models-badge">
                {t("Earlier, not in Sub Rosa", "Antérieure, hors de Sub Rosa")}
              </span>
            )}
          </div>
          <ul>
            {release.changes.map((change) => (
              <li key={change[0]}>{read(change)}</li>
            ))}
          </ul>
          {release.source && (
            <a className="version-source" href={release.source} rel="noopener noreferrer">
              {t("Source", "Source")} : {new URL(release.source).hostname.replace(/^www\./, "")}
            </a>
          )}
        </li>
      ))}
      {releases.length === 0 && (
        <li>{t("No dated history yet.", "Pas encore d’historique daté.")}</li>
      )}
    </ol>
  );
}

export function FamilyPage({ family, locale }: { family: Family; locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const ready = useDetails([family.category]);
  const detail = ready ? detailOf(family.slug) : undefined;
  const pick = modelById(family.pick);
  const headline = headlineBenchmark(family);
  const standing = headline ? familyStanding(family, headline.id) : null;
  const marks = benchmarksFor(family.category).filter((benchmark) =>
    familyStanding(family, benchmark.id),
  );
  const vendor = scores.filter(
    (score) => score.kind === "vendor" && family.ids.includes(score.model),
  );
  const datedReleases = (detail?.releases ?? []).filter((release) => release.date);
  const latest = [...datedReleases].reverse().find((release) => !release.external);
  const rivals = (detail?.rivals ?? [])
    .map((rival) => ({ ...rival, family: familyBySlug(rival.slug) }))
    .filter((rival): rival is typeof rival & { family: Family } => Boolean(rival.family));
  const fitsNeeds = needs.filter(
    (need) => need.pick === family.slug || need.alternative?.slug === family.slug,
  );
  const sources = detail?.sources ?? [];

  // One point per release on the headline benchmark: the best version of that release.
  const trend = headline
    ? [
        ...familyScores(family, detail, headline.id)
          .map((score) => ({ score, release: releaseOf(detail, score.model) }))
          .filter((entry): entry is { score: typeof entry.score; release: Release } =>
            Boolean(entry.release?.date),
          )
          .reduce((byRelease, entry) => {
            const seen = byRelease.get(entry.release.version);
            const better = headline.higherIsBetter
              ? entry.score.value > (seen?.score.value ?? -Infinity)
              : entry.score.value < (seen?.score.value ?? Infinity);
            if (!seen || better) byRelease.set(entry.release.version, entry);
            return byRelease;
          }, new Map<string, { score: (typeof scores)[number]; release: Release }>())
          .values(),
      ].map(({ score, release }) => ({
        key: release.version,
        label: release.version,
        date: release.date,
        value: score.value,
        display: formatScore(headline, score.value),
        inCatalog: !release.external,
      }))
    : [];

  const specRows = detail?.specs ?? [];
  const keySpec = pick?.context
    ? pick.context >= 1_000_000
      ? t(
          `${number(pick.context / 1_000_000, 1)}M tokens of context`,
          `${number(pick.context / 1_000_000, 1)} M de jetons de contexte`,
        )
      : t(
          `${number(pick.context / 1000, 0)}K tokens of context`,
          `${number(pick.context / 1000, 0)} k jetons de contexte`,
        )
    : pick?.seconds
      ? t(
          `Clips up to ${pick.seconds[1]} s${pick.audio ? ", with sound" : ""}`,
          `Plans jusqu’à ${pick.seconds[1]} s${pick.audio ? ", avec le son" : ""}`,
        )
      : specRows.find((row) => row.languages)?.languages
        ? read(specRows.find((row) => row.languages)?.languages ?? ["", ""])
        : null;

  const toc: [string, string][] = [
    ["different", t("What sets it apart", "Ce qui le distingue")],
    ["versions", t("Version history", "Historique des versions")],
    ...(marks.length || vendor.length
      ? [["benchmarks", t("Benchmarks", "Benchmarks")] as [string, string]]
      : []),
    ["specs", t("Specifications", "Fiche technique")],
    ["strengths", t("Strengths and limits", "Forces et limites")],
    ["use-cases", t("Use cases", "Cas d’usage")],
    ...(rivals.length
      ? [["rivals", t("Against its rivals", "Face à ses rivaux")] as [string, string]]
      : []),
    ["models", t("Every model", "Tous les modèles")],
    ["sources", t("Sources", "Sources")],
  ];

  return (
    <div className="wrap family-shell">
      <article className="family-article">
        <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
          <a href={href("")}>{t("Model catalog", "Catalogue des modèles")}</a>
          <span aria-hidden="true">/</span>
          <a href={href(family.category)}>{read(categoryTitle(family.category))}</a>
        </nav>
        <header className="models-family-head">
          <p className="eyebrow">
            {read(categoryTitle(family.category))} · {family.maker}
          </p>
          <h1>{familyName(family)}</h1>
          <p className="docs-article-intro">{read(family.summary)}</p>
          <Badges family={family} />
        </header>

        <div className="stat-row">
          <StatTile
            label={t("Latest version", "Dernière version")}
            value={latest?.version ?? (pick ? displayName(pick) : family.name)}
            sub={latest?.date ? releaseDate(latest.date) : undefined}
          />
          {headline && standing && (
            <StatTile
              label={headline.name}
              value={`${formatScore(headline, standing.score.value)}${headline.unit === "%" ? "" : ` ${headline.unit}`}`}
              sub={standingLine(family)?.replace(/ \(.*\)$/, "") ?? undefined}
            />
          )}
          {priceLine(pick) && (
            <StatTile
              label={t("Price", "Prix")}
              value={priceLine(pick)?.replace(/^(About|Environ) /, "") ?? ""}
              sub={pick ? displayName(pick) : undefined}
            />
          )}
          {keySpec && <StatTile label={t("Key spec", "Spec phare")} value={keySpec} />}
        </div>

        <section className="family-section" id="different">
          <h2>{t("What sets it apart", "Ce qui le distingue")}</h2>
          {detail ? (
            <>
              <p className="family-lead">{read(detail.differentiator)}</p>
              <ul className="signature">
                {detail.signature.map((item) => (
                  <li key={item[0]}>{read(item)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="models-lede" aria-busy="true">
              {t("Loading the details…", "Chargement des détails…")}
            </p>
          )}
          {fitsNeeds.length > 0 && (
            <p className="family-needs">
              {t("Recommended for: ", "Recommandé pour : ")}
              {fitsNeeds.map((need) => read(need.question).toLowerCase()).join(" ; ")}.
            </p>
          )}
        </section>

        <section className="family-section" id="versions">
          <h2>{t("Version history", "Historique des versions")}</h2>
          <p className="models-lede">
            {t(
              "Each version, dated, with what it changed over the one before.",
              "Chaque version, datée, avec ce qu’elle a changé par rapport à la précédente.",
            )}
          </p>
          {headline && trend.length > 1 && (
            <TrendChart
              title={t(
                `${headline.name}, version after version`,
                `${headline.name}, version après version`,
              )}
              note={<SourceNote benchmark={headline} />}
              points={trend}
              higherIsBetter={headline.higherIsBetter}
              valueHead={headline.unit}
              caption={t(
                "Hollow points are earlier versions no longer offered in Sub Rosa.",
                "Les points creux sont des versions antérieures qui ne sont plus proposées dans Sub Rosa.",
              )}
            />
          )}
          {detail && <Timeline releases={detail.releases} />}
        </section>

        {(marks.length > 0 || vendor.length > 0) && (
          <section className="family-section" id="benchmarks">
            <h2>{t("Benchmarks", "Benchmarks")}</h2>
            <p className="models-lede">
              {t("How to read these scores: ", "Comment lire ces scores : ")}
              <GuideLink term="why-benchmarks" locale={locale}>
                {t("what a benchmark tells you", "ce qu’un benchmark dit")}
              </GuideLink>
              .
            </p>
            {marks.map((benchmark) => {
              const place = familyStanding(family, benchmark.id);
              const Chart = benchmark.unit === "Elo" ? DotChart : BarChart;
              return (
                <div className="family-benchmark" key={benchmark.id}>
                  <p>
                    <strong>{benchmark.name}</strong>
                    {place &&
                      t(
                        `: #${place.rank} of ${place.of} models measured in the catalog.`,
                        ` : ${place.rank === 1 ? "1er" : `${place.rank}e`} sur ${place.of} modèles mesurés du catalogue.`,
                      )}{" "}
                    {read(benchmark.measures)} {read(benchmark.howToRead)}
                  </p>
                  <Chart
                    title={benchmark.name}
                    note={<SourceNote benchmark={benchmark} date={place?.score.date} />}
                    rows={boardRows(benchmark, locale, family)}
                    valueHead={benchmark.unit}
                  />
                </div>
              );
            })}
            {vendor.length > 0 && (
              <div className="family-vendor">
                <h3>{t("Announced by the maker", "Annoncé par le fabricant")}</h3>
                <p className="models-lede">
                  {t(
                    "Measured by the maker with its own settings: useful, but not directly comparable with the independent scores above.",
                    "Mesurés par le fabricant avec ses propres réglages : utiles, mais pas directement comparables aux scores indépendants ci-dessus.",
                  )}
                </p>
                <div className="models-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("Benchmark", "Benchmark")}</th>
                        <th scope="col">{t("Model", "Modèle")}</th>
                        <th scope="col">{t("Score", "Score")}</th>
                        <th scope="col">{t("Source", "Source")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendor.map((score) => {
                        const benchmark = benchmarksFor(family.category).find(
                          (item) => item.id === score.benchmark,
                        );
                        const model = modelById(score.model);
                        return (
                          <tr key={`${score.benchmark}-${score.model}`}>
                            <td>{benchmark?.name ?? score.benchmark}</td>
                            <td>{model ? displayName(model) : score.model}</td>
                            <td>{benchmark ? formatScore(benchmark, score.value) : score.value}</td>
                            <td>
                              <a href={score.url} rel="noopener noreferrer">
                                {new URL(score.url).hostname.replace(/^www\./, "")}
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="family-section" id="specs">
          <h2>{t("Specifications", "Fiche technique")}</h2>
          <div className="models-table-wrap spec-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t("Specification", "Caractéristique")}</span>
                  </th>
                  {(specRows.length
                    ? specRows
                    : [{ version: pick ? displayName(pick) : family.name, ids: [family.pick] }]
                  ).map((row) => (
                    <th scope="col" key={row.version}>
                      {row.version}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {specLines(family, detail).map(([label, cells]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {cells
                      .map((cell, index) => ({
                        cell,
                        version: specRows[index]?.version ?? family.pick,
                      }))
                      .map(({ cell, version }) => (
                        <td key={`${label}-${version}`}>{cell}</td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="models-footnote">
            {t(
              `Prices, context and lengths from the live catalog on ${checkedOn()}; parameters and licenses from the maker.`,
              `Prix, contexte et durées tirés du catalogue le ${checkedOn()} ; paramètres et licences selon le fabricant.`,
            )}
          </p>
        </section>

        <section className="family-section" id="strengths">
          <h2>{t("Strengths and limits", "Forces et limites")}</h2>
          <div className="models-family-grid">
            <div className="models-panel">
              <h3>{t("Where it shines", "Ses points forts")}</h3>
              <ul>
                {(detail?.strengths ?? []).map((item) => (
                  <li key={item[0]}>{read(item)}</li>
                ))}
              </ul>
            </div>
            <div className="models-panel">
              <h3>{t("Think twice when", "À éviter quand")}</h3>
              <ul>
                {(detail?.limits ?? []).map((item) => (
                  <li key={item[0]}>{read(item)}</li>
                ))}
              </ul>
            </div>
          </div>
          {(detail?.facts.length ?? 0) > 0 && (
            <ul className="models-facts">
              {(detail?.facts ?? []).map((item) => (
                <li key={item[0]}>{read(item)}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="family-section" id="use-cases">
          <h2>{t("Use cases", "Cas d’usage")}</h2>
          <div className="use-cases">
            {(detail?.useCases ?? []).map((useCase) => (
              <article className="use-case" key={useCase.title[0]}>
                <h3>{read(useCase.title)}</h3>
                <CopyPrompt text={read(useCase.prompt)} />
                <p>{read(useCase.why)}</p>
              </article>
            ))}
          </div>
        </section>

        {rivals.length > 0 && (
          <section className="family-section" id="rivals">
            <h2>{t("Against its rivals", "Face à ses rivaux")}</h2>
            <ul className="rivals">
              {rivals.map((rival) => (
                <li key={rival.slug}>
                  <a href={href(rival.slug)}>
                    <strong>{familyName(rival.family)}</strong>
                  </a>
                  <span>{read(rival.verdict)}</span>
                  {standingLine(rival.family) && <small>{standingLine(rival.family)}</small>}
                </li>
              ))}
            </ul>
            <a
              className="button"
              href={`${href("compare")}?m=${[family.slug, ...rivals.map((rival) => rival.slug)].slice(0, 3).join(",")}`}
            >
              {t("Compare side by side", "Comparer côte à côte")} ↗
            </a>
          </section>
        )}

        <section className="family-section" id="models">
          <h2>
            {family.ids.length === 1
              ? t("The model in this family", "Le modèle de cette famille")
              : t(
                  `All ${family.ids.length} models in this family`,
                  `Les ${family.ids.length} modèles de cette famille`,
                )}
          </h2>
          <div className="models-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("Model", "Modèle")}</th>
                  <th scope="col">{t("Use", "Usage")}</th>
                  <th scope="col">{t("Privacy", "Confidentialité")}</th>
                  <th scope="col">{t("Price", "Prix")}</th>
                </tr>
              </thead>
              <tbody>
                {family.ids.map((id) => {
                  const model = modelById(id);
                  if (!model) return null;
                  return (
                    <tr key={id}>
                      <td>
                        <strong>{displayName(model)}</strong>
                        <code>{id}</code>
                      </td>
                      <td>{read(modelTypeLabel[model.type] ?? [model.type, model.type])}</td>
                      <td>{read(privacyLabel(model.privacy))}</td>
                      <td>{priceLine(model) ?? t("Shown in the app", "Affiché dans l’app")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="family-section" id="sources">
          <h2>{t("Sources", "Sources")}</h2>
          <p className="models-lede">
            {t(
              `Everything on this page comes from these pages, read on ${checkedOn()} or as dated on each score.`,
              `Tout ce qui figure sur cette page vient de ces pages, lues le ${checkedOn()} ou à la date indiquée sur chaque score.`,
            )}
          </p>
          <ul className="sources">
            {sources.map((url) => (
              <li key={url}>
                <a href={url} rel="noopener noreferrer">
                  {new URL(url).hostname.replace(/^www\./, "")}
                  <span>{new URL(url).pathname.replace(/\/$/, "") || "/"}</span>
                </a>
              </li>
            ))}
          </ul>
          {family.url && (
            <a className="button" href={family.url} rel="noopener noreferrer">
              {t(`Learn more about ${family.name}`, `En savoir plus sur ${familyName(family)}`)} ↗
            </a>
          )}
        </section>
      </article>

      <nav className="family-toc" aria-label={t("On this page", "Sur cette page")}>
        <p>{t("On this page", "Sur cette page")}</p>
        {toc.map(([id, label]) => (
          <a href={`#${id}`} key={id}>
            {label}
          </a>
        ))}
        <a className="family-toc-guide" href={href("guide")}>
          {t("Understanding models", "Comprendre les modèles")} ↗
        </a>
      </nav>
    </div>
  );
}

/** The specification table: one row per property, one column per notable version. */
function specLines(family: Family, detail: FamilyDetail | undefined): [string, string[]][] {
  const columns = detail?.specs.length
    ? detail.specs
    : [
        {
          version: "",
          ids: [family.pick],
          params: null,
          activeParams: null,
          openWeights: null,
          license: null,
          maxOutput: null,
          inputs: [],
          outputs: [],
          languages: null,
          source: "",
        },
      ];
  const model = (ids: string[]) => modelById(ids[0]);
  const dash = "·";
  const lines: [string, string[]][] = [
    [
      t("Released", "Sortie"),
      columns.map((column) => {
        const release = detail?.releases.find((item) =>
          item.ids.some((id) => column.ids.includes(id)),
        );
        return release?.date ? releaseDate(release.date) : dash;
      }),
    ],
    [
      t("Parameters", "Paramètres"),
      columns.map((column) =>
        "params" in column && column.params
          ? column.activeParams
            ? t(
                `${column.params} total, ${column.activeParams} active`,
                `${column.params} au total, ${column.activeParams} actifs`,
              )
            : column.params
          : t("Not disclosed", "Non publié"),
      ),
    ],
    [
      t("Weights", "Poids"),
      columns.map((column) =>
        column.openWeights === true
          ? t(
              `Open${column.license ? `, ${column.license}` : ""}`,
              `Ouverts${column.license ? `, ${column.license}` : ""}`,
            )
          : column.openWeights === false
            ? t("Closed", "Fermés")
            : dash,
      ),
    ],
    [
      t("Accepts", "Accepte"),
      columns.map((column) => (column.inputs.length ? modalities(column.inputs) : dash)),
    ],
    [
      t("Produces", "Produit"),
      columns.map((column) => (column.outputs.length ? modalities(column.outputs) : dash)),
    ],
    [
      t("Context", "Contexte"),
      columns.map((column) => {
        const context = model(column.ids)?.context;
        return context
          ? t(`${number(context / 1000, 0)}K tokens`, `${number(context / 1000, 0)} k jetons`)
          : dash;
      }),
    ],
    [
      t("Longest answer", "Réponse la plus longue"),
      columns.map((column) =>
        column.maxOutput
          ? t(
              `${number(column.maxOutput / 1000, 0)}K tokens`,
              `${number(column.maxOutput / 1000, 0)} k jetons`,
            )
          : dash,
      ),
    ],
    [
      t("Clip length", "Durée des plans"),
      columns.map((column) => {
        const seconds = model(column.ids)?.seconds;
        if (!seconds) return dash;
        const audio = model(column.ids)?.audio ? t(", with sound", ", avec le son") : "";
        return seconds[0] === seconds[1]
          ? `${seconds[1]} s${audio}`
          : t(
              `${seconds[0]} to ${seconds[1]} s${audio}`,
              `${seconds[0]} à ${seconds[1]} s${audio}`,
            );
      }),
    ],
    [
      t("Resolutions", "Résolutions"),
      columns.map((column) => model(column.ids)?.resolutions?.join(", ") ?? dash),
    ],
    [
      t("Languages", "Langues"),
      columns.map((column) => (column.languages ? read(column.languages) : dash)),
    ],
    [
      t("Abilities", "Capacités"),
      columns.map(
        (column) =>
          (model(column.ids)?.traits ?? [])
            .map((trait) => (traitLabel[trait] ? read(traitLabel[trait]) : null))
            .filter(Boolean)
            .join(", ") || dash,
      ),
    ],
    [
      t("Price", "Prix"),
      columns.map(
        (column) => priceLine(model(column.ids))?.replace(/^(About|Environ) /, "") ?? dash,
      ),
    ],
    [
      t("Privacy", "Confidentialité"),
      columns.map((column) => {
        const found = model(column.ids);
        return found ? read(privacyLabel(found.privacy)) : dash;
      }),
    ],
  ];
  // A row that says nothing for any version is noise.
  return lines.filter(
    ([, cells]) =>
      cells.some((cell) => cell !== dash && cell !== t("Not disclosed", "Non publié")) ||
      cells.length === 0,
  );
}
