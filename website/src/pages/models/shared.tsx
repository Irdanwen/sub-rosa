import { intlLocale, t, type SiteLocale } from "../../lib/i18n";
import { localizedSiteHref } from "../../lib/paths";
import {
  type Benchmark,
  type Category,
  type Family,
  categoryTitle,
  displayName,
  familyBySlug,
  familyName,
  familyOfModel,
  familyPrivacyLabel,
  familyStanding,
  formatScore,
  headlineBenchmark,
  latestRelease,
  leaderboard,
  modelById,
  priceBand,
  priceBandLabel,
  releaseDate,
  snapshot,
} from "../../models/catalog";
import type { ChartRow } from "../../models/charts";
import { needs } from "../../models/needs";
import { read } from "../docs-content";

export const checkedOn = () =>
  new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long" }).format(
    new Date(`${snapshot.checkedAt}T12:00:00Z`),
  );

export const catalogHref = (target: string, locale: SiteLocale) =>
  localizedSiteHref(target === "" ? "/models" : `/models/${target}`, locale);

export function Badges({ family }: { family: Family }) {
  const privacy = familyPrivacyLabel(family);
  const band = priceBand(modelById(family.pick));
  return (
    <span className="models-badges">
      <span className={`models-badge models-privacy-${privacy.kind}`}>{read(privacy.label)}</span>
      {band && (
        <span className="models-badge models-price">
          <span aria-hidden="true">{"●".repeat(band)}</span>
          <span aria-hidden="true" className="models-price-rest">
            {"●".repeat(4 - band)}
          </span>{" "}
          {read(priceBandLabel(band))}
        </span>
      )}
    </span>
  );
}

/** The one line that places a family: its headline score and rank, when it has one. */
export function standingLine(family: Family) {
  const benchmark = headlineBenchmark(family);
  const standing = benchmark && familyStanding(family, benchmark.id);
  if (!benchmark || !standing) return null;
  return t(
    `#${standing.rank} of ${standing.of} on ${benchmark.name} (${formatScore(benchmark, standing.score.value)} ${benchmark.unit === "%" ? "" : benchmark.unit})`.replace(
      " )",
      ")",
    ),
    `${standing.rank}e sur ${standing.of} au ${benchmark.name} (${formatScore(benchmark, standing.score.value)} ${benchmark.unit === "%" ? "" : benchmark.unit})`
      .replace(" )", ")")
      .replace(/^1e /, "1er "),
  );
}

export function FamilyCard({ family, locale }: { family: Family; locale: SiteLocale }) {
  const release = latestRelease(family.slug);
  const standing = standingLine(family);
  return (
    <a className="models-card" href={catalogHref(family.slug, locale)}>
      <span className="models-card-kind">
        {read(categoryTitle(family.category))} · {family.maker}
      </span>
      <strong>{familyName(family)}</strong>
      <p>{read(family.summary)}</p>
      {(release || standing) && (
        <ul className="models-card-facts">
          {release && (
            <li>
              {t("Latest", "Dernière version")} : {release.version}, {releaseDate(release.date)}
            </li>
          )}
          {standing && <li>{standing}</li>}
        </ul>
      )}
      <Badges family={family} />
      <span className="models-card-count">
        {family.ids.length === 1
          ? t("1 model", "1 modèle")
          : t(`${family.ids.length} models`, `${family.ids.length} modèles`)}
      </span>
    </a>
  );
}

/** Rows for a leaderboard chart: the top of the board, plus the focused family if it ranks lower. */
export function boardRows(
  benchmark: Benchmark,
  locale: SiteLocale,
  focus?: Family,
  limit = 10,
): ChartRow[] {
  const board = leaderboard(benchmark.id);
  const own = focus ? board.filter((score) => focus.ids.includes(score.model)).slice(0, 3) : [];
  const keep = board.filter(
    (score, index) =>
      (index < limit && (!focus || !focus.ids.includes(score.model) || own.includes(score))) ||
      own.includes(score),
  );
  return keep.map((score) => {
    const model = modelById(score.model);
    const family = familyOfModel(score.model);
    const rank = board.indexOf(score) + 1;
    return {
      key: score.model,
      label: `${rank}. ${model ? displayName(model) : score.model}`,
      sub: family ? familyName(family) : undefined,
      value: score.value,
      display: formatScore(benchmark, score.value),
      href: family ? catalogHref(family.slug, locale) : undefined,
      focus: focus ? focus.ids.includes(score.model) : false,
    };
  });
}

/** "Artificial Analysis, 4 October 2026": who measured it and when, linked. */
export function SourceNote({ benchmark, date }: { benchmark: Benchmark; date?: string }) {
  return (
    <>
      {benchmark.unit === "Elo"
        ? t("Elo rating", "Classement Elo")
        : benchmark.higherIsBetter
          ? t("Higher is better", "Plus haut, mieux c’est")
          : t("Lower is better", "Plus bas, mieux c’est")}
      {" · "}
      <a href={benchmark.url} rel="noopener noreferrer">
        {benchmark.publisher}
      </a>
      {date ? `, ${releaseDate(date)}` : ""}
    </>
  );
}

export const latestScoreDate = (benchmarkId: string) =>
  leaderboard(benchmarkId).reduce(
    (latest, score) => (score.date > latest ? score.date : latest),
    "",
  );

export function GuideLink({
  term,
  locale,
  children,
}: {
  term: string;
  locale: SiteLocale;
  children: string;
}) {
  return (
    <a className="models-term" href={`${catalogHref("guide", locale)}#${term}`}>
      {children}
    </a>
  );
}

export const categoryOf = (slug: string): Category | undefined => familyBySlug(slug)?.category;

/** The "what do you want to do" answers of one kind of work: a pick and an alternative each. */
export function NeedList({ category, locale }: { category: Category; locale: SiteLocale }) {
  return (
    <div className="models-needs">
      {needs
        .filter((need) => need.category === category)
        .map((need) => {
          const first = familyBySlug(need.pick);
          const second = need.alternative ? familyBySlug(need.alternative.slug) : undefined;
          return (
            <article className="models-need" key={need.id}>
              <h3>{read(need.question)}</h3>
              {first && (
                <a className="models-need-pick" href={catalogHref(first.slug, locale)}>
                  <span>{t("Choose", "Choisissez")}</span>
                  <strong>{familyName(first)}</strong>
                  <small>{read(need.why)}</small>
                </a>
              )}
              {second && need.alternative && (
                <a className="models-need-alt" href={catalogHref(second.slug, locale)}>
                  <span>{t("Or", "Ou")}</span>
                  <strong>{familyName(second)}</strong>
                  <small>{read(need.alternative.why)}</small>
                </a>
              )}
            </article>
          );
        })}
    </div>
  );
}
