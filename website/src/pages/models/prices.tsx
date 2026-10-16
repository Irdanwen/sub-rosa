import { type ReactNode, useState } from "react";
import { localizedPublicPath, number, t, type SiteLocale } from "../../lib/i18n";
import { siteHref } from "../../lib/paths";
import {
  type Category,
  type Family,
  type SnapshotModel,
  type UsdPrice,
  categories,
  categoryTitle,
  displayName,
  familyName,
  formatUsd,
  modelUse,
  modelsOfCategory,
  priceUnitLabel,
  privacyLabel,
} from "../../models/catalog";
import { read } from "../docs-content";
import { catalogHref, checkedOn } from "./shared";

export type PriceRow = { model: SnapshotModel; family: Family; price: UsdPrice | null };

type Column = {
  key: string;
  head: string;
  /** What the column is measured in, under its name. */
  unit?: string;
  cell: (row: PriceRow) => ReactNode;
  sort?: (row: PriceRow) => number | string | null;
};

const dash = "·";
const unpriced = () => t("Not listed", "Non publié");

/** The first query value a price page understands: `?k=video`. */
export function priceKind(query: string): Category {
  const kind = new URLSearchParams(query).get("k");
  return categories.find((category) => category.id === kind)?.id ?? "text";
}

const thousands = (value: number) =>
  value >= 1_000_000
    ? t(`${number(value / 1_000_000, 1)}M`, `${number(value / 1_000_000, 1)} M`)
    : t(`${number(value / 1000, 0)}K`, `${number(value / 1000, 0)} k`);

/** The model cell: its name, linked to its family, and where it comes from. */
function ModelCell({ row, locale }: { row: PriceRow; locale: SiteLocale }) {
  return (
    <>
      <a href={catalogHref(row.family.slug, locale)}>{displayName(row.model)}</a>
      <small>
        {familyName(row.family)} · {row.family.maker}
      </small>
    </>
  );
}

const usd = (value: number | undefined | null) =>
  value === undefined || value === null ? unpriced() : formatUsd(value);

/** The columns that tell the models of one kind apart, in the unit that kind is sold in. */
export function priceColumns(kind: Category): Column[] {
  const price = (row: PriceRow) => row.price?.value ?? null;
  const privacy: Column = {
    key: "privacy",
    head: t("Privacy", "Confidentialité"),
    cell: (row) => (
      <span className={`models-badge models-privacy-${row.model.privacy}`}>
        {read(privacyLabel(row.model.privacy))}
      </span>
    ),
    sort: (row) => (row.model.privacy === "private" ? 0 : 1),
  };
  if (kind === "text")
    return [
      {
        key: "input",
        head: t("Reading", "Lecture"),
        unit: t("per million tokens", "par million de jetons"),
        cell: (row) => usd(row.price?.input),
        sort: (row) => row.price?.input ?? null,
      },
      {
        key: "price",
        head: t("Writing", "Rédaction"),
        unit: t("per million tokens", "par million de jetons"),
        cell: (row) => usd(row.price?.value),
        sort: price,
      },
      {
        key: "page",
        head: t("A page written", "Une page rédigée"),
        unit: t("about 700 tokens", "environ 700 jetons"),
        cell: (row) => (row.price ? formatUsd((row.price.value * 700) / 1_000_000) : dash),
        sort: price,
      },
      {
        key: "context",
        head: t("Context", "Contexte"),
        unit: t("tokens", "jetons"),
        cell: (row) => (row.model.context ? thousands(row.model.context) : dash),
        sort: (row) => (row.model.context ? -row.model.context : null),
      },
      privacy,
    ];
  if (kind === "image" || kind === "edit")
    return [
      {
        key: "price",
        head: t("Price", "Prix"),
        unit: kind === "edit" ? t("per edit", "par retouche") : t("per image", "par image"),
        cell: (row) =>
          row.price && row.price.unit !== "image" && row.price.unit !== "edit"
            ? `${formatUsd(row.price.value)} ${read(priceUnitLabel[row.price.unit])}`
            : usd(row.price?.value),
        sort: price,
      },
      {
        key: "resolutions",
        head: t("Sizes", "Tailles"),
        cell: (row) => row.model.resolutions?.join(", ") ?? dash,
      },
      privacy,
    ];
  if (kind === "video")
    return [
      {
        key: "use",
        head: t("Mode", "Mode"),
        cell: (row) => read(modelUse(row.model)),
        sort: (row) => read(modelUse(row.model)),
      },
      {
        key: "price",
        head: t("Price", "Prix"),
        unit: t("per second", "par seconde"),
        cell: (row) => usd(row.price?.value),
        sort: price,
      },
      {
        key: "clip",
        head: t("A 5 s clip", "Un plan de 5 s"),
        cell: (row) => (row.price ? formatUsd(row.price.value * 5) : dash),
        sort: price,
      },
      {
        key: "length",
        head: t("Longest", "Le plus long"),
        unit: t("seconds", "secondes"),
        cell: (row) => (row.model.seconds ? `${number(row.model.seconds[1], 0)} s` : dash),
        sort: (row) => (row.model.seconds ? -row.model.seconds[1] : null),
      },
      {
        key: "audio",
        head: t("Sound", "Son"),
        cell: (row) => (row.model.audio ? t("Yes", "Oui") : t("No", "Non")),
        sort: (row) => (row.model.audio ? 0 : 1),
      },
      privacy,
    ];
  if (kind === "voice")
    return [
      {
        key: "price",
        head: t("Price", "Prix"),
        unit: t("per 1,000 characters", "pour 1 000 caractères"),
        cell: (row) =>
          row.price?.unit === "characters"
            ? formatUsd(row.price.value)
            : row.price
              ? `${formatUsd(row.price.value)} ${read(priceUnitLabel[row.price.unit])}`
              : unpriced(),
        sort: price,
      },
      {
        key: "page",
        head: t("A page read aloud", "Une page lue"),
        unit: t("about 3,000 characters", "environ 3 000 caractères"),
        cell: (row) => (row.price?.unit === "characters" ? formatUsd(row.price.value * 3) : dash),
        sort: price,
      },
      privacy,
    ];
  if (kind === "transcription")
    return [
      {
        key: "price",
        head: t("Price", "Prix"),
        unit: t("per hour of audio", "par heure d’audio"),
        cell: (row) => usd(row.price?.value),
        sort: price,
      },
      {
        key: "minute",
        head: t("A minute", "Une minute"),
        cell: (row) => (row.price ? formatUsd(row.price.value / 60) : dash),
        sort: price,
      },
      privacy,
    ];
  // Music and sound effects are sold by the track, the minute or the second:
  // the unit is a column of its own, and sorting groups by it first.
  return [
    {
      key: "price",
      head: t("Price", "Prix"),
      cell: (row) => usd(row.price?.value),
      sort: (row) =>
        row.price ? `${row.price.unit}:${row.price.value.toFixed(6).padStart(14, "0")}` : null,
    },
    {
      key: "unit",
      head: t("For", "Pour"),
      cell: (row) =>
        row.price ? read(priceUnitLabel[row.price.unit]).replace(/^(per|par|pour) /, "") : dash,
      sort: (row) => row.price?.unit ?? null,
    },
    privacy,
  ];
}

/** Sort rows by one column; what the catalog does not price always goes last. */
export function sortRows(rows: PriceRow[], column: Column | undefined, ascending: boolean) {
  if (!column?.sort) return rows;
  const key = column.sort;
  return [...rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === null && y === null) return displayName(a.model).localeCompare(displayName(b.model));
    if (x === null) return 1;
    if (y === null) return -1;
    const order =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return ascending ? order : -order;
  });
}

/** One kind's price table: a row per model, sortable, the cheapest first. */
export function PriceTable({
  kind,
  rows,
  locale,
  caption,
}: {
  kind: Category;
  rows: PriceRow[];
  locale: SiteLocale;
  caption: string;
}) {
  const columns = priceColumns(kind);
  const [sort, setSort] = useState<{ key: string; ascending: boolean }>({
    key: "price",
    ascending: true,
  });
  const sorted =
    sort.key === "name"
      ? [...rows].sort(
          (a, b) =>
            displayName(a.model).localeCompare(displayName(b.model)) * (sort.ascending ? 1 : -1),
        )
      : sortRows(
          rows,
          columns.find((column) => column.key === sort.key),
          sort.ascending,
        );
  const choose = (key: string) =>
    setSort((current) =>
      current.key === key ? { key, ascending: !current.ascending } : { key, ascending: true },
    );
  const ariaSort = (key: string) =>
    sort.key === key ? (sort.ascending ? "ascending" : "descending") : undefined;
  const arrow = (key: string) => (sort.key === key ? (sort.ascending ? "↑" : "↓") : "");

  return (
    <div className="models-table-wrap price-table-wrap">
      <table className={`price-table price-table-${kind}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort("name")}>
              <button type="button" className="sort-button" onClick={() => choose("name")}>
                {t("Model", "Modèle")}
                <span aria-hidden="true">{arrow("name")}</span>
              </button>
            </th>
            {columns.map((column) => (
              <th scope="col" key={column.key} aria-sort={ariaSort(column.key)}>
                {column.sort ? (
                  <button type="button" className="sort-button" onClick={() => choose(column.key)}>
                    {column.head}
                    <span aria-hidden="true">{arrow(column.key)}</span>
                  </button>
                ) : (
                  column.head
                )}
                {column.unit && <small>{column.unit}</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.model.id}>
              <th scope="row">
                <ModelCell row={row} locale={locale} />
              </th>
              {columns.map((column) => (
                <td key={column.key} className={column.key === "price" ? "is-price" : undefined}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PricesPage({ query, locale }: { query: string; locale: SiteLocale }) {
  const href = (target: string) => catalogHref(target, locale);
  const [kind, setKind] = useState<Category>(() => priceKind(query));
  const [privateOnly, setPrivateOnly] = useState(false);
  const [search, setSearch] = useState("");

  const choose = (next: Category) => {
    setKind(next);
    history.replaceState(
      null,
      "",
      `${siteHref(localizedPublicPath("/models/prices", locale))}${next === "text" ? "" : `?k=${next}`}`,
    );
  };

  const needle = search.trim().toLowerCase();
  const all = modelsOfCategory(kind);
  const rows = all.filter(
    (row) =>
      (!privateOnly || row.model.privacy === "private") &&
      (!needle ||
        [displayName(row.model), row.model.id, row.family.name, row.family.maker]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
  const priced = all.filter((row) => row.price);

  return (
    <div className="models-prices">
      <section className="catalog-hero catalog-hero-compact">
        <div className="wrap catalog-hero-inner">
          <nav className="docs-breadcrumb" aria-label={t("Breadcrumb", "Fil d’Ariane")}>
            <a href={href("")}>{t("Model catalog", "Catalogue des modèles")}</a>
            <span aria-hidden="true">/</span>
            <span>{t("Prices", "Prix")}</span>
          </nav>
          <p className="eyebrow">{t("Price comparison", "Comparatif des prix")}</p>
          <h1>{t("Every model, every price.", "Chaque modèle, chaque prix.")}</h1>
          <p className="catalog-lede">
            {t(
              "What each model costs in US dollars, in the unit its kind of work is sold in. Sort any column, keep only private models, or look for a name.",
              "Ce que coûte chaque modèle en dollars américains, dans l’unité où son type de travail se vend. Triez n’importe quelle colonne, gardez seulement les modèles privés ou cherchez un nom.",
            )}
          </p>
        </div>
      </section>

      <div className="wrap models-body">
        <fieldset className="chip-row">
          <legend className="sr-only">{t("Kind of work", "Type de travail")}</legend>
          {categories.map((category) => (
            <button
              type="button"
              className="chip"
              key={category.id}
              aria-pressed={kind === category.id}
              onClick={() => choose(category.id)}
            >
              {read(category.title)}
            </button>
          ))}
        </fieldset>

        <div className="models-filters">
          <label className="models-search">
            <span className="sr-only">{t("Search models", "Rechercher un modèle")}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search a name or a maker", "Rechercher un nom ou un créateur")}
            />
          </label>
          <label className="models-check">
            <input
              type="checkbox"
              checked={privateOnly}
              onChange={(event) => setPrivateOnly(event.target.checked)}
            />
            {t("Private models only", "Seulement les modèles privés")}
          </label>
          <p className="models-count" aria-live="polite">
            {rows.length === 1
              ? t("1 model", "1 modèle")
              : t(`${rows.length} models`, `${rows.length} modèles`)}
          </p>
        </div>

        {rows.length ? (
          <PriceTable
            kind={kind}
            rows={rows}
            locale={locale}
            key={kind}
            caption={t(
              `${read(categoryTitle(kind))}: prices in US dollars`,
              `${read(categoryTitle(kind))} : prix en dollars américains`,
            )}
          />
        ) : (
          <p className="models-lede">
            {t(
              "No model matches. Try another name or show anonymized models too.",
              "Aucun modèle ne correspond. Essayez un autre nom ou affichez aussi les modèles anonymisés.",
            )}
          </p>
        )}

        <div className="price-notes">
          <p>
            {t(
              `Carpe Diem prices read on ${checkedOn()}, in US dollars. ${priced.length} of the ${all.length} models of this kind list a price; the others show theirs in the app before you start.`,
              `Prix Carpe Diem relevés le ${checkedOn()}, en dollars américains. ${priced.length} des ${all.length} modèles de ce type affichent un prix ; les autres montrent le leur dans l’app avant de lancer.`,
            )}
          </p>
          <p>
            {t(
              "In the app you pay in Carpe Diem credits: one credit is one US cent.",
              "Dans l’app, vous payez en crédits Carpe Diem : un crédit vaut un centime de dollar.",
            )}{" "}
            <a href={`${href("guide")}#credits`}>
              {t("How credits work", "Comment marchent les crédits")}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
