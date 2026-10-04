import { useState } from "react";
import { t, type SiteLocale } from "../lib/i18n";
import { localizedSiteHref, siteHref } from "../lib/paths";
import { categories, guideBySlug, guides, read, searchGuides } from "./docs-content";

export const documentationPath = (path: string) => path === "/docs" || path.startsWith("/docs/");

export function Documentation({ path, locale }: { path: string; locale: SiteLocale }) {
  const href = (target: string) => localizedSiteHref(target, locale);
  const slug = path === "/docs" ? null : path.slice("/docs/".length);
  const guide = slug ? guideBySlug(slug) : null;
  const [query, setQuery] = useState("");
  const results = searchGuides(query);

  if (slug && !guide)
    return (
      <section className="page wrap docs-not-found">
        <p className="eyebrow">{t("Documentation", "Documentation")}</p>
        <h1>{t("This guide could not be found.", "Ce guide est introuvable.")}</h1>
        <p>
          {t(
            "Explore the documentation to find a related topic.",
            "Parcourez la documentation pour trouver un sujet proche.",
          )}
        </p>
        <a className="button primary" href={href("/docs")}>
          {t("Browse guides", "Parcourir les guides")}
        </a>
      </section>
    );

  if (guide) {
    const category = categories.find((item) => item.id === guide.category);
    const related = (guide.related ?? []).map(guideBySlug).filter((item) => item !== undefined);
    return (
      <div className="docs-article-shell wrap">
        <nav className="docs-sidebar" aria-label={t("Guide categories", "Catégories de guides")}>
          <a className="docs-sidebar-home" href={href("/docs")}>
            ← {t("All guides", "Tous les guides")}
          </a>
          {categories.map((item) => (
            <div className="docs-sidebar-group" key={item.id}>
              <p>{read(item.title)}</p>
              {guides
                .filter((entry) => entry.category === item.id)
                .map((entry) => (
                  <a
                    key={entry.slug}
                    aria-current={entry.slug === guide.slug ? "page" : undefined}
                    href={href(`/docs/${entry.slug}`)}
                  >
                    {read(entry.title)}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <article className="docs-article">
          <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
            <a href={href("/docs")}>{t("Documentation", "Documentation")}</a>
            <span aria-hidden="true">/</span>
            <span>{category && read(category.title)}</span>
          </nav>
          <p className="eyebrow">{category && read(category.title)}</p>
          <h1>{read(guide.title)}</h1>
          <p className="docs-article-intro">{read(guide.summary)}</p>
          {guide.slug === "install" && (
            <a className="button primary docs-article-action" href={href("/downloads")}>
              {t("Choose a download", "Choisir un téléchargement")} ↗
            </a>
          )}
          {["carpe-diem-key", "studio-media", "agent"].includes(guide.slug) && (
            <a className="button docs-article-action" href={href("/models")}>
              {t("Compare the models", "Comparer les modèles")} ↗
            </a>
          )}
          {guide.slug === "account" && (
            <a className="button primary docs-article-action" href={href("/account")}>
              {t("Go to your account", "Accéder à votre compte")} ↗
            </a>
          )}
          {guide.image && (
            <figure className="docs-figure">
              <img
                src={siteHref(`/docs/${guide.image.file}`)}
                alt={read(guide.image.alt)}
                loading="lazy"
              />
              <figcaption>{read(guide.image.caption)}</figcaption>
            </figure>
          )}
          <nav className="docs-mobile-toc" aria-label={t("On this page", "Sur cette page")}>
            <strong>{t("On this page", "Sur cette page")}</strong>
            {guide.sections.map((section) => (
              <a href={`#${section.id}`} key={section.id}>
                {read(section.title)}
              </a>
            ))}
          </nav>
          {guide.sections.map((section) => (
            <section className="docs-section" id={section.id} key={section.id}>
              <h2>{read(section.title)}</h2>
              <p>{read(section.text)}</p>
              {section.steps && (
                <ol>
                  {section.steps.map((step) => (
                    <li key={step[0]}>{read(step)}</li>
                  ))}
                </ol>
              )}
            </section>
          ))}
          {guide.slug === "troubleshooting" && (
            <a className="button" href="https://github.com/Irdanwen/sub-rosa/issues">
              {t("Open the issue tracker", "Ouvrir le suivi des problèmes")} ↗
            </a>
          )}
          {related.length > 0 && (
            <aside className="docs-related">
              <h2>{t("Continue reading", "Poursuivre la lecture")}</h2>
              <div>
                {related.map((item) => (
                  <a href={href(`/docs/${item.slug}`)} key={item.slug}>
                    <strong>{read(item.title)}</strong>
                    <span>{read(item.summary)}</span>
                  </a>
                ))}
              </div>
            </aside>
          )}
        </article>
        <nav className="docs-toc" aria-label={t("On this page", "Sur cette page")}>
          <p>{t("On this page", "Sur cette page")}</p>
          {guide.sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {read(section.title)}
            </a>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="docs-home">
      <section className="docs-hero">
        <div className="wrap docs-hero-inner">
          <p className="eyebrow">{t("Sub Rosa guides", "Guides Sub Rosa")}</p>
          <h1>{t("Find your way around.", "Trouvez votre chemin.")}</h1>
          <p>
            {t(
              "From your first note to a finished film, learn the tools at your own pace.",
              "De votre première note à un film terminé, découvrez les outils à votre rythme.",
            )}
          </p>
          <label className="docs-search">
            <span className="sr-only">
              {t("Search documentation", "Rechercher dans la documentation")}
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search a topic or action", "Rechercher un sujet ou une action")}
            />
            {query && (
              <button type="button" onClick={() => setQuery("")}>
                {t("Clear", "Effacer")}
              </button>
            )}
          </label>
          <p className="docs-search-hint">
            {t("Search stays in your browser.", "La recherche reste dans votre navigateur.")}
          </p>
          <p className="docs-search-hint">
            <a href={href("/models")}>
              {t(
                "Not sure which model to pick? See the model catalog.",
                "Vous hésitez entre les modèles ? Consultez le catalogue.",
              )}
            </a>
          </p>
        </div>
      </section>
      <div className="wrap docs-home-body">
        {query.trim() ? (
          <section className="docs-results">
            <h2 aria-live="polite">
              {results.length === 1
                ? t("1 guide found", "1 guide trouvé")
                : t(`${results.length} guides found`, `${results.length} guides trouvés`)}
            </h2>
            {results.length ? (
              <div className="docs-card-grid">
                {results.map((item) => (
                  <GuideCard key={item.slug} slug={item.slug} locale={locale} />
                ))}
              </div>
            ) : (
              <p>
                {t(
                  "Try another term, such as notes, account or Studio.",
                  "Essayez un autre terme, comme notes, compte ou Studio.",
                )}
              </p>
            )}
          </section>
        ) : (
          <>
            <section className="docs-featured">
              <div>
                <p className="eyebrow">{t("A good place to begin", "Un bon point de départ")}</p>
                <h2>{t("Start with the essentials.", "Commencez par l’essentiel.")}</h2>
              </div>
              <div className="docs-card-grid">
                {["install", "carpe-diem-key", "first-note"].map((slug) => (
                  <GuideCard key={slug} slug={slug} locale={locale} />
                ))}
              </div>
            </section>
            {categories.map((category, index) => (
              <section className="docs-category" id={category.id} key={category.id}>
                <div className="docs-category-heading">
                  <span className="docs-category-mark" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h2>{read(category.title)}</h2>
                    <p>{read(category.description)}</p>
                  </div>
                </div>
                <div className="docs-link-list">
                  {guides
                    .filter((item) => item.category === category.id)
                    .map((item) => (
                      <a href={href(`/docs/${item.slug}`)} key={item.slug}>
                        <span>
                          <strong>{read(item.title)}</strong>
                          <small>{read(item.summary)}</small>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function GuideCard({ slug, locale }: { slug: string; locale: SiteLocale }) {
  const guide = guideBySlug(slug);
  if (!guide) return null;
  const category = categories.find((item) => item.id === guide.category);
  if (!category) return null;
  return (
    <a className="docs-card" href={localizedSiteHref(`/docs/${slug}`, locale)}>
      <span>{read(category.title)}</span>
      <strong>{read(guide.title)}</strong>
      <p>{read(guide.summary)}</p>
      <span className="docs-card-arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
