import { number, t, type SiteLocale } from "../../lib/i18n";
import { eloWinShare, guide } from "../../models/guide";
import { read } from "../docs-content";
import { catalogHref } from "./shared";

/** How a 128K and a 1M window compare with a book and a note, at one page per 700 tokens. */
function ContextFigure() {
  const rows: [string, number][] = [
    [t("A long note (10 pages)", "Une longue note (10 pages)"), 7_000],
    [t("A novel (about 300 pages)", "Un roman (environ 300 pages)"), 210_000],
    [t("128K window", "Fenêtre de 128 k"), 128_000],
    [t("1M window", "Fenêtre de 1 M"), 1_000_000],
  ];
  return (
    <figure className="chart guide-figure">
      <figcaption>
        <strong>{t("How much fits in a window", "Ce qui tient dans une fenêtre")}</strong>
        <span>{t("Tokens, on the same scale", "En jetons, à la même échelle")}</span>
      </figcaption>
      <ol className="chart-bars">
        {rows.map(([label, value]) => (
          <li
            key={label}
            className={label.includes("1M") || label.includes("1 M") ? "is-focus" : undefined}
          >
            <span className="chart-row-link">
              <span className="chart-label">{label}</span>
              <span className="chart-track" aria-hidden="true">
                <span
                  className="chart-bar"
                  style={{ width: `${Math.max(1.5, value / 10_000)}%` }}
                />
              </span>
              <span className="chart-value">{number(value, 0)}</span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function EloFigure() {
  const gaps = [25, 50, 100, 200, 300];
  return (
    <figure className="chart guide-figure">
      <figcaption>
        <strong>{t("What an Elo gap means", "Ce que veut dire un écart d’Elo")}</strong>
        <span>
          {t(
            "Share of duels the higher-rated model wins",
            "Part des duels gagnés par le mieux classé",
          )}
        </span>
      </figcaption>
      <ol className="chart-bars">
        {gaps.map((gap) => (
          <li key={gap}>
            <span className="chart-row-link">
              <span className="chart-label">
                {t(`${gap} points apart`, `${gap} points d’écart`)}
              </span>
              <span className="chart-track" aria-hidden="true">
                <span className="chart-bar" style={{ width: `${eloWinShare(gap) * 100}%` }} />
              </span>
              <span className="chart-value">{number(eloWinShare(gap) * 100, 0)} %</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="chart-caption">
        {t("50% would be a coin toss.", "50 % serait un pile ou face.")}
      </p>
    </figure>
  );
}

function MoeFigure() {
  return (
    <figure
      className="guide-moe"
      aria-label={t(
        "Eight experts, two at work on a token",
        "Huit experts, deux au travail sur un jeton",
      )}
    >
      <div className="guide-moe-grid" aria-hidden="true">
        {["a", "b", "c", "d", "e", "f", "g", "h"].map((expert) => (
          <span
            key={expert}
            className={expert === "c" || expert === "f" ? "is-active" : undefined}
          />
        ))}
      </div>
      <figcaption>
        {t(
          "All the experts hold knowledge; only the few chosen for each token do the work.",
          "Tous les experts détiennent des connaissances ; seuls les quelques-uns choisis pour chaque jeton travaillent.",
        )}
      </figcaption>
    </figure>
  );
}

export function GuidePage({ locale }: { locale: SiteLocale }) {
  return (
    <div className="docs-article-shell wrap models-guide">
      <nav className="docs-sidebar" aria-label={t("Guide sections", "Parties du guide")}>
        <a className="docs-sidebar-home" href={catalogHref("", locale)}>
          ← {t("Model catalog", "Catalogue des modèles")}
        </a>
        {guide.map((section) => (
          <div className="docs-sidebar-group" key={section.id}>
            <p>{read(section.title)}</p>
            {section.terms.map((term) => (
              <a key={term.id} href={`#${term.id}`}>
                {read(term.title)}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <article className="docs-article">
        <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
          <a href={catalogHref("", locale)}>{t("Model catalog", "Catalogue des modèles")}</a>
          <span aria-hidden="true">/</span>
          <span>{t("Understanding models", "Comprendre les modèles")}</span>
        </nav>
        <p className="eyebrow">{t("Understanding models", "Comprendre les modèles")}</p>
        <h1>{t("What makes models different.", "Ce qui rend les modèles différents.")}</h1>
        <p className="docs-article-intro">
          {t(
            "The words, numbers and scores you meet across the catalog, explained once, plainly.",
            "Les mots, chiffres et scores que vous croisez dans le catalogue, expliqués une fois, simplement.",
          )}
        </p>
        {guide.map((section) => (
          <section
            className="guide-section"
            key={section.id}
            aria-labelledby={`guide-${section.id}`}
          >
            <h2 id={`guide-${section.id}`}>{read(section.title)}</h2>
            <p className="models-lede">{read(section.intro)}</p>
            {section.terms.map((term) => (
              <section className="docs-section" id={term.id} key={term.id}>
                <h3>{read(term.title)}</h3>
                {term.body.map((paragraph) => (
                  <p key={paragraph[0]}>{read(paragraph)}</p>
                ))}
                {term.figure === "context" && <ContextFigure />}
                {term.figure === "elo" && <EloFigure />}
                {term.figure === "moe" && <MoeFigure />}
              </section>
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}
