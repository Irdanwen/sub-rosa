import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconGlobe } from "central-icons/IconGlobe";
import { type ReactNode, useEffect, useState } from "react";
import { accountStatus } from "../../lib/account";
import {
  type AssistantDefinition,
  type AssistantReference,
  listAssistantReferences,
} from "../../lib/assistants";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type AssistantListing,
  CATALOG_CATEGORIES,
  type CatalogCategory,
  accountPublications,
  publishAssistant,
  unpublishAssistant,
} from "../../lib/publishing";
import { useCanShare } from "../share/useCanShare";
import { Dialog } from "../ui/Dialog";
import { categoryLabel } from "./labels";
import "./publishing.css";

/** The trigger and its dialog, for a shell that renders its own trigger.
 * Nothing renders without an account: the catalog lives on the service. */
export function PublishAssistantAction({
  assistant,
  trigger,
}: {
  assistant: AssistantDefinition;
  trigger: (open: () => void) => ReactNode;
}) {
  const can = useCanShare();
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      {trigger(() => setOpen(true))}
      {open ? (
        <PublishAssistantDialog assistant={assistant} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Text references only: an image or a file's bytes are never published. */
const publishable = (reference: AssistantReference) =>
  reference.status === "ready" && reference.text.trim().length > 0;

/**
 * Publishing an assistant to the public catalog (ADR-0097). Its name,
 * description, instructions and opening message become public; a reference
 * goes only when the person ticks it; a connector never goes. Permissions
 * travel as requests the person who adds it decides on.
 */
export function PublishAssistantDialog({
  assistant,
  onClose,
}: {
  assistant: AssistantDefinition;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<AssistantListing | null>(null);
  const [references, setReferences] = useState<AssistantReference[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [description, setDescription] = useState(assistant.description);
  const [category, setCategory] = useState<CatalogCategory>("other");
  const [site, setSite] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      accountPublications(),
      listAssistantReferences(assistant.id),
      accountStatus().catch(() => null),
    ])
      .then(([publications, refs, status]) => {
        if (!alive) return;
        const existing = publications.assistants.find((entry) => entry.source_id === assistant.id);
        const usable = refs.filter(publishable);
        setReferences(usable);
        setSite(status?.server_url ?? null);
        if (existing) {
          setListing(existing);
          setDescription(existing.description);
          setCategory(existing.category);
          const names = new Set(existing.references.map((reference) => reference.name));
          setTicked(new Set(usable.filter((r) => names.has(r.name)).map((r) => r.id)));
        }
      })
      .catch((cause) => {
        if (alive) setError(messageFromError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [assistant.id]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  const publish = () =>
    run(async () => {
      setListing(
        await publishAssistant({
          assistantId: assistant.id,
          description,
          category,
          referenceIds: [...ticked],
        }),
      );
    });
  const unpublish = () =>
    run(async () => {
      if (!listing) return;
      await unpublishAssistant(listing.id);
      setListing(null);
    });
  const catalogUrl = listing && site ? `${site}/assistants/${listing.id}` : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Publish to the catalog")}
      leading={<IconGlobe size={16} aria-hidden="true" />}
      description={t(
        "Anyone can find this assistant in the public catalog and add it to their own Sub Rosa.",
      )}
      footer={
        <>
          {listing ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => void unpublish()}
              disabled={busy}
            >
              {t("Unpublish")}
            </button>
          ) : (
            <button type="button" className="primary-action" onClick={onClose}>
              {t("Cancel")}
            </button>
          )}
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void publish()}
            disabled={busy || loading || !description.trim()}
          >
            {busy ? t("Publishing...") : listing ? t("Publish changes") : t("Publish")}
          </button>
        </>
      }
    >
      {error ? (
        <p className="dialog-field-hint dialog-share-error" role="alert">
          {error}
        </p>
      ) : null}
      {listing?.taken_down ? (
        <p className="dialog-field-hint" role="status">
          {t("The service took this listing down. It is no longer shown to anyone.")}
        </p>
      ) : null}
      {catalogUrl && !listing?.taken_down ? (
        <div className="share-result">
          <input
            className="share-link"
            readOnly
            value={catalogUrl}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={t("Address of the listing")}
          />
          <button
            type="button"
            className="primary-action"
            onClick={() => void writeText(catalogUrl).then(() => setCopied(true))}
          >
            {copied ? t("Copied") : t("Copy")}
          </button>
        </div>
      ) : null}
      <label className="dialog-field">
        <span className="dialog-field-label">{t("Description")}</span>
        <textarea
          className="dialog-textarea"
          rows={3}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("What this assistant is good at, in a sentence or two")}
        />
      </label>
      <label className="dialog-field">
        <span className="dialog-field-label">{t("Category")}</span>
        <select
          className="dialog-input"
          value={category}
          onChange={(event) => setCategory(event.target.value as CatalogCategory)}
        >
          {CATALOG_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(value)}
            </option>
          ))}
        </select>
      </label>
      {references.length > 0 ? (
        <fieldset className="publish-permissions">
          <legend className="dialog-field-label">{t("References to publish")}</legend>
          {references.map((reference) => (
            <label key={reference.id} className="publish-check">
              <input
                type="checkbox"
                checked={ticked.has(reference.id)}
                onChange={() =>
                  setTicked((current) => {
                    const next = new Set(current);
                    if (next.has(reference.id)) next.delete(reference.id);
                    else next.add(reference.id);
                    return next;
                  })
                }
              />
              {reference.name}
            </label>
          ))}
          <p className="dialog-field-hint">
            {t("A reference is published only if you tick it, and only as text.")}
          </p>
        </fieldset>
      ) : null}
      <ul className="publish-facts">
        <li>{t("Its name, instructions and opening message become public.")}</li>
        <li>{t("Its permissions are shown as requests. Connectors are never published.")}</li>
        <li>
          {t("Unpublishing removes it from the catalog. Copies already added stay where they are.")}
        </li>
      </ul>
    </Dialog>
  );
}
