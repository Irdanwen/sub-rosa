import { type FormEvent, useEffect, useState } from "react";
import {
  CATEGORIES,
  type Category,
  importLink,
  type Listing,
  type ListingSummary,
  listingIdOf,
  readListing,
  type ReportReason,
  reportListing,
  searchCatalog,
} from "../lib/catalog";
import { siteHref } from "../lib/paths";
import { t } from "../lib/i18n";
import "./assistants.css";

/** A category, as a reader reads it. */
export function categoryName(category: Category | string): string {
  switch (category) {
    case "writing":
      return t("Writing and editing", "Écriture et relecture");
    case "research":
      return t("Research", "Recherche");
    case "learning":
      return t("Learning", "Apprentissage");
    case "productivity":
      return t("Productivity", "Productivité");
    case "creative":
      return t("Creative work", "Création");
    case "coding":
      return t("Code", "Code");
    case "lifestyle":
      return t("Everyday life", "Vie quotidienne");
    default:
      return t("Other", "Autre");
  }
}

export function permissionName(key: string): string {
  switch (key) {
    case "web":
      return t("Search the web", "Chercher sur le web");
    case "image":
      return t("Propose images", "Proposer des images");
    case "video":
      return t("Propose videos", "Proposer des vidéos");
    case "music":
      return t("Propose music", "Proposer de la musique");
    case "speech":
      return t("Propose speech", "Proposer de la voix");
    case "documents":
      return t("Write Office files", "Écrire des fichiers Office");
    case "notes":
      return t("Read your notes, if you allow it", "Lire vos notes, si vous l’autorisez");
    case "memory":
      return t("Use your memory, if you allow it", "Utiliser votre mémoire, si vous l’autorisez");
    default:
      return key;
  }
}

/** The catalog (`/assistants`) or one listing (`/assistants/<id>`). */
export function AssistantCatalog({ path }: { path: string }) {
  const id = listingIdOf(path);
  if (path !== "/assistants" && !id)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">{t("Assistant catalog", "Catalogue d’assistants")}</p>
        <h1>{t("This assistant is not here.", "Cet assistant n’existe pas.")}</h1>
        <a className="button" href={siteHref("/assistants")}>
          {t("Browse the catalog", "Parcourir le catalogue")}
        </a>
      </section>
    );
  return id ? <ListingPage id={id} /> : <CatalogPage />;
}

function CatalogPage() {
  const initial = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const [query, setQuery] = useState(initial.get("q") ?? "");
  const [submitted, setSubmitted] = useState(initial.get("q") ?? "");
  const [category, setCategory] = useState<Category | "">(
    CATEGORIES.includes(initial.get("category") as Category)
      ? (initial.get("category") as Category)
      : "",
  );
  const [results, setResults] = useState<ListingSummary[] | null>(null);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setResults(null);
    searchCatalog({ q: submitted, category, page: 0 }, controller.signal)
      .then((found) => {
        setResults(found);
        setPage(0);
        setMore(found.length === 24);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    // The search is in the address, so a result can be linked and reloaded.
    const params = new URLSearchParams();
    if (submitted) params.set("q", submitted);
    if (category) params.set("category", category);
    const suffix = params.toString();
    history.replaceState(null, "", `${location.pathname}${suffix ? `?${suffix}` : ""}`);
    return () => controller.abort();
  }, [submitted, category]);

  const loadMore = () => {
    const next = page + 1;
    searchCatalog({ q: submitted, category, page: next })
      .then((found) => {
        setResults((current) => [...(current ?? []), ...found]);
        setPage(next);
        setMore(found.length === 24);
      })
      .catch(() => setError(true));
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(query.trim());
  };

  return (
    <section className="page wrap catalog">
      <div className="prose">
        <p className="eyebrow">{t("Assistant catalog", "Catalogue d’assistants")}</p>
        <h1>{t("Assistants people made", "Les assistants de la communauté")}</h1>
        <p className="lede">
          {t(
            "Each one is a set of instructions someone published. Add one to Sub Rosa, read everything it does first, and choose what it may use.",
            "Chacun est un ensemble d’instructions publié par quelqu’un. Ajoutez-en un à Sub Rosa, lisez d’abord tout ce qu’il fait et choisissez ce qu’il peut utiliser.",
          )}
        </p>
      </div>
      <form className="catalog-search" role="search" onSubmit={search}>
        <label className="sr-only" htmlFor="catalog-query">
          {t("Search the catalog", "Chercher dans le catalogue")}
        </label>
        <input
          id="catalog-query"
          type="search"
          value={query}
          maxLength={100}
          placeholder={t("Search by name or purpose", "Chercher par nom ou par usage")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="button primary" type="submit">
          {t("Search", "Chercher")}
        </button>
      </form>
      <fieldset className="catalog-categories">
        <legend className="sr-only">{t("Categories", "Catégories")}</legend>
        <button type="button" aria-pressed={category === ""} onClick={() => setCategory("")}>
          {t("All", "Toutes")}
        </button>
        {CATEGORIES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {categoryName(value)}
          </button>
        ))}
      </fieldset>
      {error ? (
        <p className="error" role="alert">
          {t(
            "The catalog could not be read. Try again in a moment.",
            "Le catalogue n’a pas pu être lu. Réessayez dans un instant.",
          )}
        </p>
      ) : results === null ? (
        <p className="muted" role="status">
          {t("Loading…", "Chargement…")}
        </p>
      ) : results.length === 0 ? (
        <p className="notice">
          {t("No assistant matches yet.", "Aucun assistant ne correspond pour l’instant.")}
        </p>
      ) : (
        <ul className="catalog-list">
          {results.map((listing) => (
            <li key={listing.id} className="card">
              <p className="eyebrow">{categoryName(listing.category)}</p>
              <h2>
                <a href={siteHref(`/assistants/${listing.id}`)}>{listing.name}</a>
              </h2>
              <p>{listing.description}</p>
              <p className="quiet">
                {listing.author ? `${listing.author.display_name} · ` : ""}
                {t("{count} added", "{count} ajouts").replace(
                  "{count}",
                  String(listing.import_count),
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      {more ? (
        <button className="button" type="button" onClick={loadMore}>
          {t("Show more", "Afficher plus")}
        </button>
      ) : null}
    </section>
  );
}

function ListingPage({ id }: { id: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    readListing(id, controller.signal)
      .then(setListing)
      .catch(() => {
        if (!controller.signal.aborted) setMissing(true);
      });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (listing) document.title = `${listing.name} · Sub Rosa`;
  }, [listing]);

  if (missing)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">{t("Assistant catalog", "Catalogue d’assistants")}</p>
        <h1>{t("This assistant is not here.", "Cet assistant n’existe pas.")}</h1>
        <p className="lede">
          {t("It was unpublished or taken down.", "Il a été dépublié ou retiré.")}
        </p>
        <a className="button" href={siteHref("/assistants")}>
          {t("Browse the catalog", "Parcourir le catalogue")}
        </a>
      </section>
    );
  if (!listing)
    return (
      <section className="page wrap" aria-busy="true">
        <p role="status">{t("Loading…", "Chargement…")}</p>
      </section>
    );
  return (
    <section className="page wrap catalog-listing">
      <div className="prose">
        <p className="eyebrow">
          <a href={siteHref("/assistants")}>{t("Assistant catalog", "Catalogue d’assistants")}</a>
          {" · "}
          {categoryName(listing.category)}
        </p>
        <h1>{listing.name}</h1>
        <p className="lede">{listing.description}</p>
        {listing.author ? (
          <p className="quiet">
            {t("Published by", "Publié par")} {listing.author.display_name} (@
            {listing.author.handle})
          </p>
        ) : null}
        <div className="actions">
          <a className="button primary" href={importLink(listing.id)}>
            {t("Add to Sub Rosa", "Ajouter à Sub Rosa")}
          </a>
          <a className="text-link" href={siteHref("/downloads")}>
            {t("Get Sub Rosa first", "Obtenir d’abord Sub Rosa")} <span aria-hidden="true">→</span>
          </a>
        </div>
        <p className="quiet">
          {t(
            "Opens Sub Rosa on this device, which shows everything below and asks before adding it. Reading your notes or your memory stays off unless you allow it there.",
            "Ouvre Sub Rosa sur cet appareil, qui montre tout ce qui suit et demande avant de l’ajouter. La lecture de vos notes ou de votre mémoire reste désactivée sauf si vous l’autorisez.",
          )}
        </p>
      </div>
      <div className="catalog-detail">
        <h2>{t("Instructions", "Instructions")}</h2>
        <pre className="catalog-text">{listing.instructions}</pre>
        {listing.starter ? (
          <>
            <h2>{t("Opening message", "Message d’accueil")}</h2>
            <blockquote>{listing.starter}</blockquote>
          </>
        ) : null}
        {listing.permissions.length > 0 ? (
          <>
            <h2>{t("What it asks to use", "Ce qu’il demande à utiliser")}</h2>
            <ul>
              {listing.permissions.map((key) => (
                <li key={key}>{permissionName(key)}</li>
              ))}
            </ul>
          </>
        ) : null}
        {listing.references.length > 0 ? (
          <>
            <h2>{t("References", "Références")}</h2>
            {listing.references.map((reference, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
              <details key={index} className="catalog-reference">
                <summary>{reference.name}</summary>
                <pre className="catalog-text">{reference.text}</pre>
              </details>
            ))}
          </>
        ) : null}
        <p className="quiet">
          {t("{count} added", "{count} ajouts").replace("{count}", String(listing.import_count))}
        </p>
        <ReportForm id={listing.id} />
      </div>
    </section>
  );
}

function ReportForm({ id }: { id: string }) {
  const [reason, setReason] = useState<ReportReason>("spam");
  const [detail, setDetail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setState("sending");
    reportListing(id, reason, detail).then(
      () => setState("sent"),
      () => setState("failed"),
    );
  };
  return (
    <details className="catalog-report">
      <summary>{t("Report this assistant", "Signaler cet assistant")}</summary>
      {state === "sent" ? (
        <p className="notice" role="status">
          {t(
            "Your report was sent. The people who run this service read every one.",
            "Votre signalement a été envoyé. Les personnes qui gèrent ce service les lisent tous.",
          )}
        </p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>
            {t("Why", "Motif")}
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as ReportReason)}
            >
              <option value="spam">{t("Spam or advertising", "Spam ou publicité")}</option>
              <option value="abuse">{t("Harassment or hate", "Harcèlement ou haine")}</option>
              <option value="illegal">{t("Illegal content", "Contenu illégal")}</option>
              <option value="privacy">
                {t("Someone’s private information", "Informations privées d’une personne")}
              </option>
              <option value="other">{t("Something else", "Autre chose")}</option>
            </select>
          </label>
          <label>
            {t("Details (optional)", "Précisions (facultatif)")}
            <textarea
              rows={3}
              maxLength={500}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </label>
          {state === "failed" ? (
            <p className="error" role="alert">
              {t(
                "The report could not be sent. Try again in a minute.",
                "Le signalement n’a pas pu être envoyé. Réessayez dans une minute.",
              )}
            </p>
          ) : null}
          <button className="button" type="submit" disabled={state === "sending"}>
            {t("Send the report", "Envoyer le signalement")}
          </button>
        </form>
      )}
    </details>
  );
}
