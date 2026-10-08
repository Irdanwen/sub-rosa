import { IconGlobe } from "central-icons/IconGlobe";
import { useEffect, useState } from "react";
import type { AssistantDefinition } from "../../lib/assistants";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type AssistantListing,
  catalogListing,
  importCatalogAssistant,
} from "../../lib/publishing";
import { Dialog } from "../ui/Dialog";
import { categoryLabel, permissionLabel } from "./labels";
import "./publishing.css";

/** What a link asks for: one listing, by id. */
const IMPORT_EVENT = "subrosa:assistant-import";

/** Opens the review for one catalog listing. Called by each shell's
 * destination handler for `subrosa://assistant/import?id=…`. */
export function requestAssistantImport(listingId: string) {
  window.dispatchEvent(new CustomEvent<string>(IMPORT_EVENT, { detail: listingId }));
}

/** Data the person keeps out of a stranger's assistant unless they tick it. */
const PERSONAL = new Set(["notes", "memory"]);

/** Mounted once per shell; shows the review when a link asks for it. */
export function AssistantImportHost({
  onImported,
}: {
  onImported: (definition: AssistantDefinition) => void;
}) {
  const [listingId, setListingId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string") setListingId(id);
    };
    window.addEventListener(IMPORT_EVENT, open);
    return () => window.removeEventListener(IMPORT_EVENT, open);
  }, []);
  if (!listingId) return null;
  return (
    <AssistantImportDialog
      listingId={listingId}
      onClose={() => setListingId(null)}
      onImported={(definition) => {
        setListingId(null);
        onImported(definition);
      }}
    />
  );
}

/**
 * "Add to Sub Rosa" (ADR-0097). A link from the catalog names a listing; the
 * app reads it from its own account site and shows everything it would add:
 * the instructions in full, the references, and each permission as a choice.
 * Reading your notes or your memory starts unticked. Nothing is added until
 * the person taps, and what is added is an ordinary assistant they can edit.
 */
export function AssistantImportDialog({
  listingId,
  onClose,
  onImported,
}: {
  listingId: string;
  onClose: () => void;
  onImported: (definition: AssistantDefinition) => void;
}) {
  const [listing, setListing] = useState<AssistantListing | null>(null);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setListing(null);
    setError(null);
    catalogListing(listingId)
      .then((value) => {
        if (!alive) return;
        setListing(value);
        setGranted(new Set(value.permissions.filter((key) => !PERSONAL.has(key))));
      })
      .catch((cause) => {
        if (alive) setError(messageFromError(cause));
      });
    return () => {
      alive = false;
    };
  }, [listingId]);

  async function add() {
    if (!listing || busy) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await importCatalogAssistant(listing.id, [...granted]));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string) =>
    setGranted((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={listing ? t("Add {name}?", { name: listing.name }) : t("Add an assistant")}
      leading={<IconGlobe size={16} aria-hidden="true" />}
      description={t("Someone else wrote this assistant. Read its instructions before you add it.")}
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void add()}
            disabled={!listing || busy}
          >
            {busy ? t("Adding...") : t("Add to Sub Rosa")}
          </button>
        </>
      }
    >
      {error ? (
        <p className="dialog-field-hint dialog-share-error" role="alert">
          {error}
        </p>
      ) : null}
      {!listing && !error ? (
        <p className="dialog-field-hint" role="status">
          {t("Reading the catalog...")}
        </p>
      ) : null}
      {listing ? (
        <div className="publish-review">
          <p className="publish-review-meta">
            {categoryLabel(listing.category)}
            {listing.author ? ` · @${listing.author.handle}` : ""}
          </p>
          <p>{listing.description}</p>
          <div className="dialog-field">
            <span className="dialog-field-label">{t("Instructions")}</span>
            <pre className="publish-review-text">{listing.instructions}</pre>
          </div>
          {listing.starter ? (
            <div className="dialog-field">
              <span className="dialog-field-label">{t("Opening message")}</span>
              <p className="publish-review-quote">{listing.starter}</p>
            </div>
          ) : null}
          {listing.references.length > 0 ? (
            <div className="dialog-field">
              <span className="dialog-field-label">{t("References")}</span>
              <ul className="publish-review-list">
                {listing.references.map((reference, index) => (
                  // Names may repeat; the order is the listing's own.
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
                  <li key={index}>{reference.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {listing.permissions.length > 0 ? (
            <fieldset className="publish-permissions">
              <legend className="dialog-field-label">{t("What it may do")}</legend>
              {listing.permissions.map((key) => (
                <label key={key} className="publish-check">
                  <input type="checkbox" checked={granted.has(key)} onChange={() => toggle(key)} />
                  {permissionLabel(key)}
                </label>
              ))}
              <p className="dialog-field-hint">
                {t("Reading your notes and your memory stays off unless you tick it.")}
              </p>
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
