import { useState } from "react";
import { date, t } from "../../lib/i18n";
import { Markdown, webLink } from "../../lib/markdown";
import { listGalleryPictures, loadPicture } from "../gallery";
import { listSaved, removeSaved, type SavedItem } from "../saved";
import type { ClientContext } from "./context";

/**
 * The Library (ADR-0088): what was saved from chats, synchronised as saved
 * items, and the account's gallery pictures. Pictures are fetched and opened
 * only when asked for, one at a time, in this tab.
 */
export function LibraryView({ ctx }: { ctx: ClientContext }) {
  const [tab, setTab] = useState<"saved" | "pictures">("saved");
  const [status, setStatus] = useState("");
  const saved = listSaved(ctx.sync);
  return (
    <section className="wc-view" aria-labelledby="wc-library-title">
      <h1 id="wc-library-title">{t("Library", "Bibliothèque")}</h1>
      <fieldset className="wc-tabs">
        <legend className="sr-only">{t("What to show", "Que montrer")}</legend>
        <button type="button" aria-pressed={tab === "saved"} onClick={() => setTab("saved")}>
          {t("Saved", "Enregistré")}
        </button>
        <button type="button" aria-pressed={tab === "pictures"} onClick={() => setTab("pictures")}>
          {t("Pictures", "Images")}
        </button>
      </fieldset>
      {tab === "saved" ? (
        saved.length === 0 ? (
          <p className="quiet">
            {t(
              "Nothing saved yet. Save a reply, a link or a place from a chat.",
              "Rien d’enregistré pour l’instant. Enregistrez une réponse, un lien ou un lieu depuis une discussion.",
            )}
          </p>
        ) : (
          <ul className="wc-plain wc-saved">
            {saved.map((item) => (
              <SavedRow
                key={item.id}
                item={item}
                onOpen={
                  item.conversationId
                    ? () => ctx.openChat(item.conversationId as string)
                    : undefined
                }
                onRemove={() =>
                  void removeSaved(ctx.sync, item.id).then(() => {
                    ctx.flush();
                    setStatus(t("Removed from your library.", "Retiré de votre bibliothèque."));
                  })
                }
              />
            ))}
          </ul>
        )
      ) : (
        <Pictures ctx={ctx} />
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

function SavedRow({
  item,
  onOpen,
  onRemove,
}: {
  item: SavedItem;
  onOpen?: () => void;
  onRemove: () => void;
}) {
  const url = typeof item.payload.url === "string" ? webLink(item.payload.url) : null;
  return (
    <li>
      <p className="quiet">
        {item.kind === "reply"
          ? t("Reply", "Réponse")
          : item.kind === "link"
            ? t("Link", "Lien")
            : t("Place", "Lieu")}
        {item.createdAt ? ` · ${date(item.createdAt)}` : ""}
      </p>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener">
          {item.title || url}
        </a>
      ) : (
        <strong>{item.title}</strong>
      )}
      {item.kind === "reply" && typeof item.payload.text === "string" && (
        <details>
          <summary>{t("Show the reply", "Afficher la réponse")}</summary>
          <Markdown text={item.payload.text} />
        </details>
      )}
      {item.kind === "place" && typeof item.payload.address === "string" && (
        <p>{item.payload.address}</p>
      )}
      <div className="wc-actions">
        {onOpen && (
          <button type="button" onClick={onOpen}>
            {t("Open the chat", "Ouvrir la discussion")}
          </button>
        )}
        <button type="button" onClick={onRemove}>
          {t("Remove", "Retirer")}
        </button>
      </div>
    </li>
  );
}

function Pictures({ ctx }: { ctx: ClientContext }) {
  const pictures = listGalleryPictures(ctx.sync);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  if (!pictures.length)
    return (
      <p className="quiet">
        {t(
          "No picture in your gallery yet. Pictures made here or in the app appear once they have synchronised.",
          "Aucune image dans votre galerie. Les images faites ici ou dans l’app apparaissent une fois synchronisées.",
        )}
      </p>
    );
  return (
    <>
      <ul className="wc-gallery">
        {pictures.slice(0, 60).map((picture) => (
          <li key={picture.id}>
            {shown[picture.id] ? (
              <img src={shown[picture.id]} alt={picture.prompt ?? t("A picture", "Une image")} />
            ) : (
              <button
                className="button"
                type="button"
                onClick={() =>
                  void loadPicture(ctx.sync, ctx.account.id, ctx.vaultKey, picture.id)
                    .then((url) => setShown((value) => ({ ...value, [picture.id]: url })))
                    .catch(() =>
                      setError(
                        t(
                          "This picture could not be opened.",
                          "Cette image n’a pas pu être ouverte.",
                        ),
                      ),
                    )
                }
              >
                {t("Show picture", "Afficher l’image")}
              </button>
            )}
            <p className="quiet">{picture.prompt ?? picture.model ?? ""}</p>
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
