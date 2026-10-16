import { useState } from "react";
import { t, type SiteLocale } from "../../lib/i18n";
import {
  type Category,
  type Family,
  type SnapshotModel,
  categories,
  categoryTitle,
  displayName,
  families,
  familyPrivacy,
  familyReleases,
  formatUsd,
  priceUnitLabel,
  releaseDate,
  snapshot,
  usdPrice,
} from "../../models/catalog";
import { type Copy, read } from "../docs-content";
import { FamilyCard, catalogHref, checkedOn, cheapestOf, defaultOf, leaderOf } from "./shared";

/** What a person wants to do, for each kind of work: the hub's first question. */
const verbs: Record<Category, Copy> = {
  text: ["Write and chat", "Écrire et discuter"],
  transcription: ["Transcribe", "Transcrire"],
  image: ["Create an image", "Créer une image"],
  edit: ["Edit an image", "Retoucher une image"],
  video: ["Make a video", "Faire une vidéo"],
  voice: ["Give it a voice", "Donner de la voix"],
  music: ["Compose music", "Composer de la musique"],
  effects: ["Make a sound", "Créer un bruitage"],
};

/** "$0.045 per image", short enough for a tile. */
const priceOf = (model: SnapshotModel | undefined) => {
  const price = usdPrice(model);
  return price ? `${formatUsd(price.value)} ${read(priceUnitLabel[price.unit])}` : null;
};

const fresh = (date: string) =>
  Date.parse(`${snapshot.checkedAt}T12:00:00Z`) -
    Date.parse(`${date.length === 7 ? `${date}-01` : date}T12:00:00Z`) <=
  14 * 86_400_000;

export function CatalogHome({ locale }: { locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [privateOnly, setPrivateOnly] = useState(false);
  const [query, setQuery] = useState("");
  const covered = families.reduce((count, family) => count + family.ids.length, 0);
  const needle = query.trim().toLowerCase();
  const shown = families.filter(
    (family) =>
      (filter === "all" || family.category === filter) &&
      (!privateOnly || familyPrivacy(family) !== "anonymized") &&
      (!needle ||
        [family.name, family.nameFr ?? "", family.maker, ...family.ids, ...family.summary]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
  const groups = categories
    .map((category) => ({
      category,
      members: shown.filter((family) => family.category === category.id),
    }))
    .filter((group) => group.members.length);

  const recent = families
    .flatMap((family) =>
      familyReleases(family.slug)
        .filter((release) => release.inCatalog)
        .map((release) => ({ ...release, family })),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  return (
    <div className="models-home">
      <section className="catalog-hero">
        <div className="wrap catalog-hero-inner">
          <p className="eyebrow">{t("Model catalog", "Catalogue des modèles")}</p>
          <h1>{t("Choose the right model.", "Choisissez le bon modèle.")}</h1>
          <p className="catalog-lede">
            {t(
              "Sub Rosa gives you hundreds of models for writing, listening, drawing, filming and composing. Start from what you want to do: each page says which one to take, what it costs and why.",
              "Sub Rosa vous donne accès à des centaines de modèles pour écrire, écouter, dessiner, filmer et composer. Partez de ce que vous voulez faire : chaque page dit lequel prendre, ce qu’il coûte et pourquoi.",
            )}
          </p>
          <div className="models-hero-actions">
            <a className="button primary" href={href("prices")}>
              {t("Compare prices", "Comparer les prix")}
            </a>
            <a className="button" href={href("compare")}>
              {t("Compare models", "Comparer des modèles")}
            </a>
            <a className="text-link" href={href("guide")}>
              {t("Understanding models", "Comprendre les modèles")}{" "}
              <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="models-checked">
            {t(
              `${families.length} families, ${covered} models, prices read on ${checkedOn()}.`,
              `${families.length} familles, ${covered} modèles, prix relevés le ${checkedOn()}.`,
            )}
          </p>

          <h2 className="task-heading" id="models-tasks">
            {t("What do you want to do?", "Que voulez-vous faire ?")}
          </h2>
          <ul className="task-grid" aria-labelledby="models-tasks">
            {categories.map((category, index) => {
              const members = families.filter((family) => family.category === category.id);
              const chosen = defaultOf(category.id);
              const leader = leaderOf(category.id);
              const cheapest = cheapestOf(category.id);
              return (
                <li key={category.id} className={`task-tile task-${index + 1}`}>
                  <a href={href(category.id)}>
                    <span className="task-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <strong>{read(verbs[category.id])}</strong>
                    <span className="task-kind">
                      {read(category.title)} ·{" "}
                      {members.length === 1
                        ? t("1 family", "1 famille")
                        : t(`${members.length} families`, `${members.length} familles`)}
                    </span>
                    <dl>
                      {chosen && (
                        <div>
                          <dt>{t("Sub Rosa starts on", "Sub Rosa démarre sur")}</dt>
                          <dd>{displayName(chosen)}</dd>
                        </div>
                      )}
                      {leader && (
                        <div>
                          <dt>{t("Best measured", "Le meilleur mesuré")}</dt>
                          <dd>{displayName(leader)}</dd>
                        </div>
                      )}
                      {cheapest && (
                        <div>
                          <dt>{t("Starting at", "Dès")}</dt>
                          <dd>{priceOf(cheapest)}</dd>
                        </div>
                      )}
                    </dl>
                    <span className="task-arrow" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <div className="wrap models-body">
        <section className="models-section" aria-labelledby="models-recent">
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("New releases", "Nouveautés")}</p>
              <h2 id="models-recent">{t("Just arrived.", "Tout juste arrivés.")}</h2>
            </div>
          </div>
          <ol className="release-strip">
            {recent.map((release) => (
              <li key={`${release.family.slug}-${release.version}`}>
                <a href={href(release.family.slug)}>
                  <span className="release-meta">
                    <time dateTime={release.date}>{releaseDate(release.date)}</time>
                    {fresh(release.date) && (
                      <span className="release-new">{t("New", "Nouveau")}</span>
                    )}
                  </span>
                  <strong>{release.version}</strong>
                  <span>
                    {read(categoryTitle(release.family.category))} · {release.family.maker}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>

        <section className="models-section" aria-labelledby="models-prices">
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("Prices", "Prix")}</p>
              <h2 id="models-prices">
                {t("What each kind of work costs.", "Ce que coûte chaque type de travail.")}
              </h2>
            </div>
            <a className="text-link" href={href("prices")}>
              {t("Every price, model by model", "Tous les prix, modèle par modèle")}{" "}
              <span aria-hidden="true">→</span>
            </a>
          </div>
          <div className="models-table-wrap price-glance">
            <table>
              <caption className="sr-only">
                {t(
                  "Prices in US dollars, by kind of work",
                  "Prix en dollars américains, par type de travail",
                )}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("Kind of work", "Type de travail")}</th>
                  <th scope="col">{t("Cheapest", "Le moins cher")}</th>
                  <th scope="col">{t("Sub Rosa’s default", "Le choix de Sub Rosa")}</th>
                  <th scope="col">{t("Best measured", "Le meilleur mesuré")}</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => {
                  const cell = (model: SnapshotModel | undefined, empty: string) =>
                    model ? (
                      <>
                        <span>{displayName(model)}</span>
                        <small>{priceOf(model) ?? t("Price in the app", "Prix dans l’app")}</small>
                      </>
                    ) : (
                      <span className="is-empty">{empty}</span>
                    );
                  return (
                    <tr key={category.id}>
                      <th scope="row">
                        <a
                          href={`${href("prices")}${category.id === "text" ? "" : `?k=${category.id}`}`}
                        >
                          {read(category.title)}
                        </a>
                      </th>
                      <td>{cell(cheapestOf(category.id), t("Not listed", "Non publié"))}</td>
                      <td>
                        {cell(defaultOf(category.id), t("No default", "Pas de choix par défaut"))}
                      </td>
                      <td>{cell(leaderOf(category.id), t("Not measured", "Non mesuré"))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="models-section" aria-labelledby="models-all">
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("The whole catalog", "Tout le catalogue")}</p>
              <h2 id="models-all">{t("Every family.", "Toutes les familles.")}</h2>
            </div>
          </div>
          <fieldset className="chip-row">
            <legend className="sr-only">{t("Kind of work", "Type de travail")}</legend>
            {[{ id: "all" as const, title: ["Every kind", "Tous"] as Copy }, ...categories].map(
              (category) => (
                <button
                  type="button"
                  className="chip"
                  key={category.id}
                  aria-pressed={filter === category.id}
                  onClick={() => setFilter(category.id)}
                >
                  {read(category.title)}
                </button>
              ),
            )}
          </fieldset>
          <div className="models-filters">
            <label className="models-search">
              <span className="sr-only">{t("Search models", "Rechercher un modèle")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search a name or a maker", "Rechercher un nom ou un créateur")}
              />
            </label>
            <label className="models-check">
              <input
                type="checkbox"
                checked={privateOnly}
                onChange={(event) => setPrivateOnly(event.target.checked)}
              />
              {t("Show private options only", "Seulement les options privées")}
            </label>
            <p className="models-count" aria-live="polite">
              {shown.length === 1
                ? t("1 family", "1 famille")
                : t(`${shown.length} families`, `${shown.length} familles`)}
            </p>
          </div>
          {groups.length ? (
            groups.map((group) => (
              <div className="family-group" key={group.category.id}>
                {filter === "all" && (
                  <h3>
                    <a href={href(group.category.id)}>{read(group.category.title)}</a>
                  </h3>
                )}
                <div className="models-grid">
                  {group.members.map((family: Family) => (
                    <FamilyCard family={family} locale={locale} key={family.slug} />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="models-lede">
              {t(
                "No family matches. Try another name or show every kind.",
                "Aucune famille ne correspond. Essayez un autre nom ou affichez tous les types.",
              )}
            </p>
          )}
          <p className="models-footnote">
            {t(
              "Models and prices change often. Sub Rosa always shows what is available today and the exact price before anything is charged. The search index models behind Sub Rosa’s memory are left out: the app picks them, you never do.",
              "Les modèles et les prix changent souvent. Sub Rosa affiche toujours ce qui est disponible aujourd’hui et le prix exact avant toute dépense. Les modèles d’index de recherche de la mémoire de Sub Rosa n’y figurent pas : l’app les choisit, jamais vous.",
            )}{" "}
            <a href={`${href("guide")}#privacy`}>
              {t(
                "What “private” and “anonymized” mean",
                "Ce que veulent dire « privé » et « anonymisé »",
              )}
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
