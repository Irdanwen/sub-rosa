import { useEffect, useState } from "react";
import {
  CATEGORIES,
  type Category,
  type Listing,
  type ListingSummary,
  readListing,
  searchCatalog,
} from "../../lib/catalog";
import { t } from "../../lib/i18n";
import { categoryName, permissionName } from "../../pages/assistants";
import {
  addReference,
  type AssistantDefinition,
  deleteAssistant,
  getAssistant,
  listAssistants,
  PERMISSIONS,
  referencesOf,
  removeReference,
  saveAssistant,
} from "../assistants";
import { readDocument } from "../documents";
import {
  importListing,
  publications,
  publishAssistant,
  type PublishedListing,
  unpublishAssistant,
} from "../publish";
import { ACCEPTED_FILES, documentFailure } from "./AttachmentBar";
import type { ClientContext } from "./context";

/**
 * Custom assistants (ADR-0058, ADR-0097): yours, made and edited here as in
 * the app; a chat with one; publishing one to the catalog; and the catalog
 * itself, where an assistant someone published becomes yours on a tap, with
 * every permission it asks for left for you to grant.
 */
export function AssistantsView({
  ctx,
  onStart,
}: {
  ctx: ClientContext;
  /** Starts a chat with an assistant: the first question asks for it. */
  onStart: (assistantId: string) => void;
}) {
  const [tab, setTab] = useState<"mine" | "discover">("mine");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [status, setStatus] = useState("");
  const assistants = listAssistants(ctx.sync);
  return (
    <section className="wc-view" aria-labelledby="wc-assistants-title">
      <h1 id="wc-assistants-title">{t("Assistants", "Assistants")}</h1>
      <fieldset className="wc-tabs">
        <legend className="sr-only">{t("Which assistants", "Quels assistants")}</legend>
        <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>
          {t("Yours", "Les vôtres")}
        </button>
        <button type="button" aria-pressed={tab === "discover"} onClick={() => setTab("discover")}>
          {t("Discover", "Découvrir")}
        </button>
      </fieldset>
      {tab === "mine" ? (
        editing ? (
          <AssistantEditor
            key={editing}
            ctx={ctx}
            id={editing === "new" ? null : editing}
            onClose={(message) => {
              setEditing(null);
              if (message) setStatus(message);
            }}
          />
        ) : (
          <>
            <button className="button primary" type="button" onClick={() => setEditing("new")}>
              {t("New assistant", "Nouvel assistant")}
            </button>
            {assistants.length === 0 ? (
              <p className="quiet">{t("No assistant yet.", "Aucun assistant pour l’instant.")}</p>
            ) : (
              <ul className="wc-plain wc-assistants">
                {assistants.map((assistant) => (
                  <li key={assistant.id}>
                    <strong>{assistant.name}</strong>
                    {assistant.description && <p>{assistant.description}</p>}
                    <div className="wc-actions">
                      <button type="button" onClick={() => onStart(assistant.id)}>
                        {t(`Chat with ${assistant.name}`, `Discuter avec ${assistant.name}`)}
                      </button>
                      <button type="button" onClick={() => setEditing(assistant.id)}>
                        {t("Edit", "Modifier")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      ) : (
        <Discover ctx={ctx} onAdded={(message) => setStatus(message)} />
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

function AssistantEditor({
  ctx,
  id,
  onClose,
}: {
  ctx: ClientContext;
  id: string | null;
  onClose: (message?: string) => void;
}) {
  const existing = id ? getAssistant(ctx.sync, id) : null;
  const [draft, setDraft] = useState({
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    instructions: existing?.instructions ?? "",
    model: existing?.model ?? "",
    openingMessage: existing?.opening_message ?? "",
    tools: existing?.tools ?? [],
    allowNotes: existing?.allow_notes ?? false,
    allowMemory: existing?.allow_memory ?? false,
  });
  const [savedId, setSavedId] = useState<string | null>(id);
  const [paste, setPaste] = useState({ name: "", text: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState(false);
  const references = savedId ? referencesOf(ctx.sync, savedId) : [];
  const definition = savedId ? getAssistant(ctx.sync, savedId) : null;
  const toggle = (key: string) =>
    setDraft((value) => ({
      ...value,
      tools: value.tools.includes(key)
        ? value.tools.filter((tool) => tool !== key)
        : [...value.tools, key],
    }));
  return (
    <div className="form wc-assistant-editor">
      <label>
        <span>{t("Name", "Nom")}</span>
        <input
          value={draft.name}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        <span>{t("Description", "Description")}</span>
        <input
          value={draft.description}
          maxLength={4000}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <label>
        <span>{t("Instructions", "Instructions")}</span>
        <textarea
          rows={6}
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label>
        <span>{t("Opening message", "Message d’accueil")}</span>
        <input
          value={draft.openingMessage}
          maxLength={8000}
          onChange={(event) => setDraft({ ...draft, openingMessage: event.target.value })}
        />
      </label>
      <label>
        <span>{t("Model", "Modèle")}</span>
        <select
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        >
          <option value="">
            {t("The model chosen in the chat", "Le modèle choisi dans la discussion")}
          </option>
          {ctx.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="wc-choices">
        <legend>{t("What it may do", "Ce qu’il peut faire")}</legend>
        {PERMISSIONS.map((key) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={draft.tools.includes(key)}
              onChange={() => toggle(key)}
            />
            {permissionName(key)}
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.allowNotes}
            onChange={(event) => setDraft({ ...draft, allowNotes: event.target.checked })}
          />
          {t("Read your notes", "Lire vos notes")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.allowMemory}
            onChange={(event) => setDraft({ ...draft, allowMemory: event.target.checked })}
          />
          {t("Use and add to your memory", "Utiliser et enrichir votre mémoire")}
        </label>
        <p className="quiet">
          {t(
            "In the browser an assistant can search the web, read your notes and use your memory when allowed. Pictures, music, speech and Office files it proposes are made in the app.",
            "Dans le navigateur, un assistant peut chercher sur le web, lire vos notes et utiliser votre mémoire s’il y est autorisé. Les images, la musique, la voix et les fichiers Office qu’il propose se font dans l’app.",
          )}
        </p>
      </fieldset>
      <div className="wc-row">
        <button
          className="button primary"
          type="button"
          disabled={!draft.name.trim()}
          onClick={() =>
            void saveAssistant(ctx.sync, draft, savedId ?? undefined)
              .then((saved) => {
                setSavedId(saved);
                ctx.flush();
                setStatus(t("Assistant saved.", "Assistant enregistré."));
              })
              .catch(() =>
                setError(
                  t(
                    "This assistant could not be saved.",
                    "Cet assistant n’a pas pu être enregistré.",
                  ),
                ),
              )
          }
        >
          {t("Save assistant", "Enregistrer l’assistant")}
        </button>
        <button className="button" type="button" onClick={() => onClose()}>
          {t("Back to your assistants", "Retour à vos assistants")}
        </button>
      </div>
      {savedId && (
        <>
          <h2>{t("References", "Références")}</h2>
          <p className="quiet">
            {t(
              "Documents the assistant may search and cite. They are read in this browser, and their text travels with the assistant.",
              "Des documents que l’assistant peut chercher et citer. Ils sont lus dans ce navigateur, et leur texte voyage avec l’assistant.",
            )}
          </p>
          <ul className="wc-plain">
            {references.map((reference) => (
              <li key={reference.id} className="wc-row">
                <span>{reference.name}</span>
                <button
                  className="button"
                  type="button"
                  onClick={() => void removeReference(ctx.sync, reference.id).then(ctx.flush)}
                >
                  {t(`Remove ${reference.name}`, `Retirer ${reference.name}`)}
                </button>
              </li>
            ))}
          </ul>
          <label className="button wc-attach">
            {t("Add a document", "Ajouter un document")}
            <input
              className="sr-only"
              type="file"
              accept={ACCEPTED_FILES.replace("image/*,", "")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file || !savedId) return;
                void (async () => {
                  try {
                    const read = await readDocument({
                      name: file.name,
                      bytes: new Uint8Array(await file.arrayBuffer()),
                    });
                    await addReference(ctx.sync, savedId, {
                      name: file.name,
                      format: read.format,
                      text: read.text,
                    });
                    ctx.flush();
                  } catch (failure) {
                    setError(documentFailure(failure));
                  }
                })();
              }}
            />
          </label>
          <form
            className="wc-paste"
            onSubmit={(event) => {
              event.preventDefault();
              void addReference(ctx.sync, savedId, {
                name: paste.name,
                format: "md",
                text: paste.text,
              }).then(() => {
                setPaste({ name: "", text: "" });
                ctx.flush();
              });
            }}
          >
            <label>
              <span>{t("Or paste a text", "Ou collez un texte")}</span>
              <input
                value={paste.name}
                placeholder={t("Its name", "Son nom")}
                onChange={(event) => setPaste({ ...paste, name: event.target.value })}
              />
            </label>
            <textarea
              rows={3}
              value={paste.text}
              aria-label={t("Text of the reference", "Texte de la référence")}
              onChange={(event) => setPaste({ ...paste, text: event.target.value })}
            />
            <button className="button" type="submit" disabled={!paste.text.trim()}>
              {t("Add the text", "Ajouter le texte")}
            </button>
          </form>
          {definition && <PublishListing ctx={ctx} definition={definition} />}
          <div className="wc-row">
            {confirm ? (
              <>
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    void deleteAssistant(ctx.sync, savedId).then(() => {
                      ctx.flush();
                      onClose(
                        t(
                          "Assistant deleted. Its chats are kept.",
                          "Assistant supprimé. Ses discussions sont gardées.",
                        ),
                      );
                    })
                  }
                >
                  {t("Delete this assistant", "Supprimer cet assistant")}
                </button>
                <button className="button" type="button" onClick={() => setConfirm(false)}>
                  {t("Keep it", "Le garder")}
                </button>
              </>
            ) : (
              <button className="button" type="button" onClick={() => setConfirm(true)}>
                {t("Delete assistant", "Supprimer l’assistant")}
              </button>
            )}
          </div>
        </>
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PublishListing({
  ctx,
  definition,
}: {
  ctx: ClientContext;
  definition: AssistantDefinition;
}) {
  const references = referencesOf(ctx.sync, definition.id).filter(
    (reference) => reference.status === "ready",
  );
  const [listing, setListing] = useState<PublishedListing | null | undefined>(undefined);
  const [category, setCategory] = useState<Category>("other");
  const [ticked, setTicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    publications()
      .then((overview) =>
        setListing(overview.assistants.find((item) => item.source_id === definition.id) ?? null),
      )
      .catch(() => setListing(null));
  }, [definition.id]);
  return (
    <section aria-labelledby={`publish-${definition.id}`}>
      <h2 id={`publish-${definition.id}`}>
        {t("Share in the catalog", "Partager dans le catalogue")}
      </h2>
      <p className="quiet">
        {t(
          "A published assistant is public: anyone can read its instructions and the references you tick, until you unpublish it. Unpublishing cannot reach a copy someone already made.",
          "Un assistant publié est public : tout le monde peut lire ses instructions et les références cochées, jusqu’à ce que vous le retiriez. Le retirer n’atteint pas une copie déjà faite.",
        )}
      </p>
      <label>
        <span>{t("Category", "Catégorie")}</span>
        <select value={category} onChange={(event) => setCategory(event.target.value as Category)}>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {categoryName(value)}
            </option>
          ))}
        </select>
      </label>
      {references.map((reference) => (
        <label key={reference.id} className="check">
          <input
            type="checkbox"
            checked={ticked.includes(reference.id)}
            onChange={() =>
              setTicked((value) =>
                value.includes(reference.id)
                  ? value.filter((item) => item !== reference.id)
                  : [...value, reference.id],
              )
            }
          />
          {t(`Publish ${reference.name}`, `Publier ${reference.name}`)}
        </label>
      ))}
      <div className="wc-row">
        <button
          className="button"
          type="button"
          onClick={() =>
            void publishAssistant(definition, {
              category,
              description: definition.description,
              references: references.filter((reference) => ticked.includes(reference.id)),
            })
              .then((published) => {
                setListing(published);
                setError("");
              })
              .catch((failure) =>
                setError(
                  (failure as { code?: string }).code === "content_policy"
                    ? t(
                        "The catalog's rules refuse this assistant as it is.",
                        "Les règles du catalogue refusent cet assistant tel quel.",
                      )
                    : t(
                        "The assistant could not be published.",
                        "L’assistant n’a pas pu être publié.",
                      ),
                ),
              )
          }
        >
          {listing ? t("Publish changes", "Publier les modifications") : t("Publish", "Publier")}
        </button>
        {listing && (
          <button
            className="button"
            type="button"
            onClick={() => void unpublishAssistant(listing.id).then(() => setListing(null))}
          >
            {t("Unpublish", "Retirer")}
          </button>
        )}
      </div>
      {listing && (
        <p className="quiet">
          <a href={`/assistants/${listing.id}`} target="_blank" rel="noreferrer">
            {t("See it in the catalog", "Le voir dans le catalogue")}
          </a>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Discover({ ctx, onAdded }: { ctx: ClientContext; onAdded: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ListingSummary[] | null>(null);
  const [open, setOpen] = useState<Listing | null>(null);
  const [granted, setGranted] = useState<string[]>([]);
  const [error, setError] = useState("");
  const search = () =>
    searchCatalog({ q: query })
      .then(setResults)
      .catch(() =>
        setError(t("The catalog could not be read.", "Le catalogue n’a pas pu être lu.")),
      );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page loads once.
  useEffect(() => {
    void search();
  }, []);
  if (open)
    return (
      <div className="form">
        <h2>{open.name}</h2>
        <p>{open.description}</p>
        <details>
          <summary>{t("Its instructions", "Ses instructions")}</summary>
          <p className="wc-pre">{open.instructions}</p>
        </details>
        {open.permissions.length > 0 && (
          <fieldset className="wc-choices">
            <legend>{t("It asks to", "Il demande à")}</legend>
            {open.permissions.map((key) => (
              <label key={key} className="check">
                <input
                  type="checkbox"
                  checked={granted.includes(key)}
                  onChange={() =>
                    setGranted((value) =>
                      value.includes(key) ? value.filter((item) => item !== key) : [...value, key],
                    )
                  }
                />
                {permissionName(key)}
              </label>
            ))}
          </fieldset>
        )}
        <div className="wc-row">
          <button
            className="button primary"
            type="button"
            onClick={() =>
              void importListing(ctx.sync, open.id, granted)
                .then(() => {
                  ctx.flush();
                  setOpen(null);
                  onAdded(
                    t(
                      `${open.name} is now one of your assistants.`,
                      `${open.name} fait maintenant partie de vos assistants.`,
                    ),
                  );
                })
                .catch(() =>
                  setError(
                    t(
                      "This assistant could not be added.",
                      "Cet assistant n’a pas pu être ajouté.",
                    ),
                  ),
                )
            }
          >
            {t("Add to my assistants", "Ajouter à mes assistants")}
          </button>
          <button className="button" type="button" onClick={() => setOpen(null)}>
            {t("Back", "Retour")}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <>
      <form
        className="wc-row"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="wc-grow">
          <span className="sr-only">{t("Search the catalog", "Chercher dans le catalogue")}</span>
          <input
            type="search"
            value={query}
            placeholder={t("Search the catalog", "Chercher dans le catalogue")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          {t("Search", "Chercher")}
        </button>
      </form>
      {results?.length === 0 && (
        <p className="quiet">{t("Nothing matches.", "Rien ne correspond.")}</p>
      )}
      <ul className="wc-plain wc-assistants">
        {(results ?? []).map((listing) => (
          <li key={listing.id}>
            <strong>{listing.name}</strong>
            <p className="quiet">{categoryName(listing.category)}</p>
            <p>{listing.description}</p>
            <button
              className="button"
              type="button"
              onClick={() =>
                void readListing(listing.id)
                  .then((full) => {
                    setGranted([]);
                    setOpen(full);
                  })
                  .catch(() =>
                    setError(
                      t("This assistant could not be read.", "Cet assistant n’a pas pu être lu."),
                    ),
                  )
              }
            >
              {t("Look at it", "Le regarder")}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
