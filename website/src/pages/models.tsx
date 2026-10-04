import { useState } from "react";
import { t, type SiteLocale } from "../lib/i18n";
import { localizedSiteHref } from "../lib/paths";
import {
  categories,
  categoryTitle,
  contextLine,
  displayName,
  type Category,
  type Family,
  families,
  familyBySlug,
  familyName,
  familyPrivacy,
  familyPrivacyLabel,
  modelById,
  modelTypeLabel,
  priceBand,
  priceBandLabel,
  priceLine,
  privacyLabel,
  snapshot,
  specLine,
  traitLabel,
  unitPrice,
} from "../models/catalog";
import { defaults, needs } from "../models/needs";
import { read } from "./docs-content";

/** The page title for a catalog path, in the current language. */
export function modelCatalogTitle(path: string) {
  const family = path.startsWith("/models/") ? familyBySlug(path.slice(8)) : undefined;
  const catalog = t("Model catalog", "Catalogue des modèles");
  return family ? `${familyName(family)} · ${catalog}` : catalog;
}

export function ModelCatalog({ path, locale }: { path: string; locale: SiteLocale }) {
  const slug = path === "/models" ? null : path.slice("/models/".length);
  if (!slug) return <CatalogHome locale={locale} />;
  const family = familyBySlug(slug);
  if (!family) return <FamilyMissing locale={locale} />;
  return <FamilyPage family={family} locale={locale} />;
}

const checkedOn = () =>
  new Intl.DateTimeFormat(t("en", "fr"), { dateStyle: "long" }).format(
    new Date(`${snapshot.checkedAt}T12:00:00Z`),
  );

function Badges({ family }: { family: Family }) {
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

function FamilyCard({ family, locale }: { family: Family; locale: SiteLocale }) {
  return (
    <a className="models-card" href={localizedSiteHref(`/models/${family.slug}`, locale)}>
      <span className="models-card-kind">
        {read(categoryTitle(family.category))} · {family.maker}
      </span>
      <strong>{familyName(family)}</strong>
      <p>{read(family.summary)}</p>
      <Badges family={family} />
      <span className="models-card-count">
        {family.ids.length === 1
          ? t("1 model", "1 modèle")
          : t(`${family.ids.length} models`, `${family.ids.length} modèles`)}
      </span>
    </a>
  );
}

function CatalogHome({ locale }: { locale: SiteLocale }) {
  const href = (target: string) => localizedSiteHref(target, locale);
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
          <nav className="models-jump" aria-label={t("On this page", "Sur cette page")}>
            <a href="#models-needs">{t("How to choose", "Comment choisir")}</a>
            <a href="#models-legend">{t("Privacy and price", "Confidentialité et prix")}</a>
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
          <div className="models-needs">
            {needs
              .filter((need) => need.category === tab)
              .map((need) => {
                const first = familyBySlug(need.pick);
                const second = need.alternative ? familyBySlug(need.alternative.slug) : undefined;
                return (
                  <article className="models-need" key={need.id}>
                    <h3>{read(need.question)}</h3>
                    {first && (
                      <a className="models-need-pick" href={href(`/models/${first.slug}`)}>
                        <span>{t("Choose", "Choisissez")}</span>
                        <strong>{familyName(first)}</strong>
                        <small>{read(need.why)}</small>
                      </a>
                    )}
                    {second && need.alternative && (
                      <a className="models-need-alt" href={href(`/models/${second.slug}`)}>
                        <span>{t("Or", "Ou")}</span>
                        <strong>{familyName(second)}</strong>
                        <small>{read(need.alternative.why)}</small>
                      </a>
                    )}
                  </article>
                );
              })}
          </div>
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

function FamilyMissing({ locale }: { locale: SiteLocale }) {
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
      <a className="button primary" href={localizedSiteHref("/models", locale)}>
        {t("Browse the catalog", "Parcourir le catalogue")}
      </a>
    </section>
  );
}

function FamilyPage({ family, locale }: { family: Family; locale: SiteLocale }) {
  const href = (target: string) => localizedSiteHref(target, locale);
  const pick = modelById(family.pick);
  const price = priceLine(pick);
  const context = contextLine(pick);
  const shared = (other: Family) =>
    other.needs.filter((need) => family.needs.includes(need)).length;
  const neighbours = families
    .filter((other) => other.category === family.category && other.slug !== family.slug)
    .sort((a, b) => shared(b) - shared(a))
    .slice(0, 6);
  const fitsNeeds = needs.filter(
    (need) => need.pick === family.slug || need.alternative?.slug === family.slug,
  );
  return (
    <div className="wrap models-family">
      <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
        <a href={href("/models")}>{t("Model catalog", "Catalogue des modèles")}</a>
        <span aria-hidden="true">/</span>
        <span>{read(categoryTitle(family.category))}</span>
      </nav>
      <header className="models-family-head">
        <p className="eyebrow">
          {read(categoryTitle(family.category))} · {family.maker}
        </p>
        <h1>{familyName(family)}</h1>
        <p className="docs-article-intro">{read(family.summary)}</p>
        <Badges family={family} />
      </header>

      <div className="models-family-grid">
        <section className="models-panel">
          <h2>{t("Where it shines", "Ses points forts")}</h2>
          <ul>
            {family.strengths.map((item) => (
              <li key={item[0]}>{read(item)}</li>
            ))}
          </ul>
        </section>
        <section className="models-panel">
          <h2>{t("Think twice when", "À éviter quand")}</h2>
          <ul>
            {family.limits.map((item) => (
              <li key={item[0]}>{read(item)}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="models-panel models-pick">
        <h2>{t("Our pick in this family", "Notre choix dans cette famille")}</h2>
        {pick && (
          <>
            <p className="models-pick-name">
              <strong>{displayName(pick)}</strong> <code>{pick.id}</code>
            </p>
            <ul className="models-facts">
              {price && <li>{price}</li>}
              {context && <li>{context}</li>}
              {pick.seconds && !family.facts.some(([en]) => /\d s\b/.test(en)) && (
                <li>
                  {pick.seconds[0] === pick.seconds[1]
                    ? t(`Clips of ${pick.seconds[0]} s`, `Plans de ${pick.seconds[0]} s`)
                    : t(
                        `Clips from ${pick.seconds[0]} to ${pick.seconds[1]} s`,
                        `Plans de ${pick.seconds[0]} à ${pick.seconds[1]} s`,
                      )}
                </li>
              )}
              {pick.audio && !family.facts.some(([en]) => /sound|audio/i.test(en)) && (
                <li>{t("Can add its own sound", "Peut ajouter son propre son")}</li>
              )}
              {(pick.traits ?? []).map((trait) =>
                traitLabel[trait] ? <li key={trait}>{read(traitLabel[trait])}</li> : null,
              )}
              {family.facts.map((item) => (
                <li key={item[0]}>{read(item)}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {family.variants && family.variants.length > 0 && (
        <section className="models-panel">
          <h2>{t("Other versions worth knowing", "Autres versions à connaître")}</h2>
          <dl className="models-variants">
            {family.variants.map((variant) => {
              const model = modelById(variant.id);
              return (
                <div key={variant.id}>
                  <dt>{model ? displayName(model) : variant.id}</dt>
                  <dd>{read(variant.note)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}

      {fitsNeeds.length > 0 && (
        <section className="models-panel">
          <h2>{t("Recommended for", "Recommandé pour")}</h2>
          <ul>
            {fitsNeeds.map((need) => (
              <li key={need.id}>{read(need.question)}</li>
            ))}
          </ul>
        </section>
      )}

      <details className="models-panel models-all-ids">
        <summary>
          {family.ids.length === 1
            ? t("The model in this family", "Le modèle de cette famille")
            : t(
                `All ${family.ids.length} models in this family`,
                `Les ${family.ids.length} modèles de cette famille`,
              )}
        </summary>
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
      </details>

      {family.url && (
        <p className="models-learn">
          <a className="button" href={family.url} rel="noopener noreferrer">
            {t(
              `Learn more about ${familyName(family)}`,
              `En savoir plus sur ${familyName(family)}`,
            )}{" "}
            ↗
          </a>
        </p>
      )}

      {neighbours.length > 0 && (
        <aside className="docs-related">
          <h2>{t("Compare with", "Comparer avec")}</h2>
          <div>
            {neighbours.map((other) => (
              <a href={href(`/models/${other.slug}`)} key={other.slug}>
                <strong>{familyName(other)}</strong>
                <span>{read(other.summary)}</span>
              </a>
            ))}
          </div>
        </aside>
      )}
      <p className="models-footnote">
        {t(
          `Prices and availability checked on ${checkedOn()}. Sub Rosa shows the exact price before you start.`,
          `Prix et disponibilité vérifiés le ${checkedOn()}. Sub Rosa affiche le prix exact avant de lancer.`,
        )}
      </p>
    </div>
  );
}
