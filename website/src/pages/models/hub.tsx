import { useState } from "react";
import { t, type SiteLocale } from "../../lib/i18n";
import {
  type Category,
  benchmarksFor,
  categories,
  categoryTitle,
  displayName,
  families,
  familyBySlug,
  familyName,
  familyPrivacy,
  familyPrivacyLabel,
  familyReleases,
  leaderboard,
  modelById,
  priceLine,
  releaseDate,
  specLine,
  unitPrice,
} from "../../models/catalog";
import { defaults } from "../../models/needs";
import { read } from "../docs-content";
import { FamilyCard, NeedList, catalogHref, checkedOn } from "./shared";

export function CatalogHome({ locale }: { locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target.replace(/^\/models\/?/, ""), locale);
  const [tab, setTab] = useState<Category>("text");
  // The grid follows the kind of work chosen above, so a phone shows twenty
  // families rather than a hundred; the select still opens the whole catalog.
  const [filter, setFilter] = useState<Category | "all">("text");
  const chooseTab = (next: Category) => {
    setTab(next);
    setFilter(next);
  };
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

  return (
    <div className="models-home">
      <section className="docs-hero">
        <div className="wrap docs-hero-inner">
          <p className="eyebrow">{t("Model catalog", "Catalogue des modèles")}</p>
          <h1>{t("Choose the right model.", "Choisissez le bon modèle.")}</h1>
          <p>
            {t(
              "Sub Rosa gives you hundreds of models for writing, listening, drawing, filming and composing. Here is what each one is good at, what it costs and how to choose.",
              "Sub Rosa vous donne accès à des centaines de modèles pour écrire, écouter, dessiner, filmer et composer. Voici à quoi chacun excelle, ce qu’il coûte et comment choisir.",
            )}
          </p>
          <div className="models-hero-actions">
            <a className="button primary" href={href("/models/guide")}>
              {t("Understand what makes them different", "Comprendre ce qui les distingue")}
            </a>
            <a className="button" href={href("/models/compare")}>
              {t("Compare models", "Comparer des modèles")}
            </a>
          </div>
          <nav className="models-jump" aria-label={t("On this page", "Sur cette page")}>
            <a href="#models-kinds">{t("By kind of work", "Par type de travail")}</a>
            <a href="#models-needs">{t("How to choose", "Comment choisir")}</a>
            <a href="#models-recent">{t("New releases", "Nouveautés")}</a>
            <a href="#models-all">{t("Every family", "Toutes les familles")}</a>
          </nav>
          <p className="models-checked">
            {t(
              `${families.length} families covering ${covered} models, checked on ${checkedOn()}.`,
              `${families.length} familles couvrant ${covered} modèles, vérifiées le ${checkedOn()}.`,
            )}
          </p>
        </div>
      </section>

      <div className="wrap models-body">
        <section className="models-section" aria-labelledby="models-kinds">
          <p className="eyebrow">{t("Explore", "Explorer")}</p>
          <h2 id="models-kinds">{t("Eight kinds of work.", "Huit types de travail.")}</h2>
          <p className="models-lede">
            {t(
              "Each kind has its own page: what separates its models, leaderboards, a quality and price chart, and every family side by side.",
              "Chaque type a sa page : ce qui distingue ses modèles, des classements, un graphique qualité-prix, et toutes les familles côte à côte.",
            )}
          </p>
          <div className="kind-grid">
            {categories.map((category) => {
              const members = families.filter((family) => family.category === category.id);
              const benchmark = benchmarksFor(category.id)[0];
              const leader = benchmark ? leaderboard(benchmark.id)[0] : undefined;
              const leaderModel = leader ? modelById(leader.model) : undefined;
              const newest = members
                .flatMap((family) =>
                  familyReleases(family.slug)
                    .filter((release) => release.inCatalog)
                    .map((release) => ({ ...release, family })),
                )
                .sort((a, b) => b.date.localeCompare(a.date))[0];
              return (
                <a className="kind-tile" href={href(`/models/${category.id}`)} key={category.id}>
                  <strong>{read(category.title)}</strong>
                  <p>{read(category.description)}</p>
                  <dl>
                    <div>
                      <dt>{t("Families", "Familles")}</dt>
                      <dd>{members.length}</dd>
                    </div>
                    {leaderModel && (
                      <div>
                        <dt>{t("Top measured", "En tête mesuré")}</dt>
                        <dd>{displayName(leaderModel)}</dd>
                      </div>
                    )}
                    {newest && (
                      <div>
                        <dt>{t("Newest", "Plus récent")}</dt>
                        <dd>
                          {newest.version.startsWith(newest.family.name.split(" ")[0])
                            ? newest.version
                            : `${newest.version} (${familyName(newest.family)})`}
                          , {releaseDate(newest.date)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <span className="kind-tile-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              );
            })}
          </div>
        </section>

        <section className="models-section" aria-labelledby="models-defaults">
          <p className="eyebrow">{t("Not sure?", "Vous hésitez ?")}</p>
          <h2 id="models-defaults">
            {t("Keep what Sub Rosa picks for you.", "Gardez les choix de Sub Rosa.")}
          </h2>
          <p className="models-lede">
            {t(
              "Every tool starts on a model chosen for a good balance of quality, privacy and price. You never have to change it.",
              "Chaque outil démarre sur un modèle choisi pour son équilibre entre qualité, confidentialité et prix. Vous n’avez jamais besoin d’en changer.",
            )}
          </p>
          <div className="models-defaults">
            {defaults.map((item) => {
              const family = familyBySlug(item.slug);
              const model = modelById(item.model);
              return (
                <a
                  className="models-default"
                  href={href(`/models/${item.slug}`)}
                  key={`${item.slug}-${item.model}`}
                >
                  <span>{read(item.task)}</span>
                  <strong>{model ? displayName(model) : family && familyName(family)}</strong>
                  <small>{read(item.why)}</small>
                </a>
              );
            })}
          </div>
        </section>

        <section className="models-section" aria-labelledby="models-needs">
          <p className="eyebrow">{t("How to choose", "Comment choisir")}</p>
          <h2 id="models-needs">
            {t("Start from what you want to do.", "Partez de ce que vous voulez faire.")}
          </h2>
          <div
            className="models-tabs"
            role="group"
            aria-label={t("Kind of work", "Type de travail")}
          >
            {categories.map((category) => (
              <button
                type="button"
                key={category.id}
                aria-pressed={tab === category.id}
                onClick={() => chooseTab(category.id)}
              >
                {read(category.title)}
              </button>
            ))}
          </div>
          <p className="models-tab-description">
            {read(categories.find((category) => category.id === tab)?.description ?? ["", ""])}
          </p>
          <NeedList category={tab} locale={locale} />
        </section>

        <section className="models-section" aria-labelledby="models-compare">
          <p className="eyebrow">{t("Side by side", "Côte à côte")}</p>
          <h2 id="models-compare">
            {t(
              `${read(categoryTitle(tab))}, from cheapest to dearest.`,
              `${read(categoryTitle(tab))}, du moins cher au plus cher.`,
            )}
          </h2>
          <p className="models-lede">
            {t(
              "Each row is a family’s recommended version. Change the kind of work with the buttons above.",
              "Chaque ligne est la version recommandée d’une famille. Changez de type de travail avec les boutons ci-dessus.",
            )}
          </p>
          <div className="models-table-wrap models-compare">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("Family", "Famille")}</th>
                  <th scope="col">{t("Price", "Prix")}</th>
                  {(tab === "text" || tab === "video") && (
                    <th scope="col">{t("Key facts", "Repères")}</th>
                  )}
                  <th scope="col">{t("Privacy", "Confidentialité")}</th>
                </tr>
              </thead>
              <tbody>
                {families
                  .filter((family) => family.category === tab)
                  .sort((a, b) => unitPrice(modelById(a.pick)) - unitPrice(modelById(b.pick)))
                  .map((family) => {
                    const pick = modelById(family.pick);
                    return (
                      <tr key={family.slug}>
                        <th scope="row">
                          <a href={href(`/models/${family.slug}`)}>{familyName(family)}</a>
                          <small>{pick ? displayName(pick) : family.pick}</small>
                        </th>
                        <td>{priceLine(pick) ?? t("Shown in the app", "Affiché dans l’app")}</td>
                        {(tab === "text" || tab === "video") && <td>{specLine(pick)}</td>}
                        <td>{read(familyPrivacyLabel(family).label)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="models-section" aria-labelledby="models-recent">
          <p className="eyebrow">{t("New releases", "Nouveautés")}</p>
          <h2 id="models-recent">{t("What came out lately.", "Ce qui est sorti récemment.")}</h2>
          <ol className="timeline">
            {families
              .flatMap((family) =>
                familyReleases(family.slug)
                  .filter((release) => release.inCatalog)
                  .map((release) => ({ ...release, family })),
              )
              .sort((a, b) => b.date.localeCompare(a.date))
              .slice(0, 12)
              .map((release) => (
                <li key={`${release.family.slug}-${release.version}`}>
                  <time dateTime={release.date}>{releaseDate(release.date)}</time>
                  <a href={href(`/models/${release.family.slug}`)}>
                    <strong>{release.version}</strong>
                    <span>
                      {read(categoryTitle(release.family.category))} · {release.family.maker}
                    </span>
                  </a>
                </li>
              ))}
          </ol>
        </section>

        <section className="models-section models-legend" aria-labelledby="models-legend">
          <p className="eyebrow">{t("Reading a card", "Lire une fiche")}</p>
          <h2 id="models-legend">
            {t("Privacy and price, plainly.", "Confidentialité et prix, simplement.")}
          </h2>
          <dl>
            <div>
              <dt>
                <span className="models-badge models-privacy-private">{t("Private", "Privé")}</span>
              </dt>
              <dd>
                {t(
                  "The provider that runs the model keeps nothing from your request once it has answered. A few versions marked E2EE are also listed as end-to-end encrypted by their provider; that is its stated policy, not something Sub Rosa checks.",
                  "Le fournisseur qui fait tourner le modèle ne garde rien de votre demande une fois la réponse donnée. Quelques versions marquées E2EE sont en plus annoncées chiffrées de bout en bout par leur fournisseur ; c’est sa politique déclarée, pas une vérification de Sub Rosa.",
                )}
              </dd>
            </div>
            <div>
              <dt>
                <span className="models-badge models-privacy-anonymized">
                  {t("Anonymized", "Anonymisé")}
                </span>
              </dt>
              <dd>
                {t(
                  "Your request reaches the model maker’s own servers without anything that says who you are. The maker’s own retention rules apply to its content.",
                  "Votre demande arrive sur les serveurs du créateur du modèle sans rien qui dise qui vous êtes. Les règles de conservation du créateur s’appliquent à son contenu.",
                )}
              </dd>
            </div>
            <div>
              <dt>
                <span className="models-badge models-price">
                  <span aria-hidden="true">●●</span>
                  <span aria-hidden="true" className="models-price-rest">
                    ●●
                  </span>{" "}
                  {t("Moderate cost", "Coût modéré")}
                </span>
              </dt>
              <dd>
                {t(
                  "Cost is compared within one kind of work, from low to very high. One credit is one US cent; the exact price shows in the app before you start.",
                  "Le coût se compare au sein d’un même type de travail, de bas à très élevé. Un crédit vaut un centime de dollar ; le prix exact s’affiche dans l’app avant de lancer.",
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="models-section" aria-labelledby="models-all">
          <p className="eyebrow">{t("The whole catalog", "Tout le catalogue")}</p>
          <h2 id="models-all">
            {t("Every family, one card each.", "Toutes les familles, une carte chacune.")}
          </h2>
          <p className="models-lede">
            {t(
              "Showing the kind of work chosen above. Pick “All kinds” to see the whole catalog.",
              "Le type de travail choisi plus haut est affiché. Choisissez « Tous les types » pour voir tout le catalogue.",
            )}
          </p>
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
            <label className="models-select">
              <span>{t("Kind", "Type")}</span>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as Category | "all")}
              >
                <option value="all">{t("All kinds", "Tous les types")}</option>
                {categories.map((category) => (
                  <option value={category.id} key={category.id}>
                    {read(category.title)}
                  </option>
                ))}
              </select>
            </label>
            <label className="models-check">
              <input
                type="checkbox"
                checked={privateOnly}
                onChange={(event) => setPrivateOnly(event.target.checked)}
              />
              {t("Show private options only", "Seulement les options privées")}
            </label>
          </div>
          <p className="models-count" aria-live="polite">
            {shown.length === 1
              ? t("1 family", "1 famille")
              : t(`${shown.length} families`, `${shown.length} familles`)}
          </p>
          {shown.length ? (
            <div className="models-grid">
              {shown.map((family) => (
                <FamilyCard family={family} locale={locale} key={family.slug} />
              ))}
            </div>
          ) : (
            <p>
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
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
