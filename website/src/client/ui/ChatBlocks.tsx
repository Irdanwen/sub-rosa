import { parseCanvasPayload } from "@subrosa/chat-core/canvas-block";
import { parseTryOnPayload } from "@subrosa/chat-core/try-on-block";
import { ChatBlockList, type BlockRenderer } from "../../lib/chat-blocks";
import { t } from "../../lib/i18n";
import { canvasMarkdown } from "@subrosa/chat-core/canvas-block";
import { canvasTarget, openCanvas } from "../canvas";
import { linkSaveRequest, placeSaveRequest, type SaveRequest } from "../saved";
import type { SyncClient } from "../sync";

export interface BlockActions {
  /** Opens a canvas, with a proposed version to review when there is one. */
  onCanvas(noteId: string, proposal: string | null): void;
  /** Opens the try-on with the garment the reply named. */
  onTryOn(garment?: string): void;
  onSave(request: SaveRequest): void;
  isSaved(sourceKey: string): boolean;
}

const items = (value: unknown) =>
  (Array.isArray(value) ? value : []).filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );

/**
 * The cards the web client draws with actions: a canvas to open or a version
 * to review (ADR-0087), a try-on to start (ADR-0088), and links and places
 * to save to the library. A temporary chat offers none of these: each is one
 * more way out of a chat that keeps nothing.
 */
export function blockRenderer(
  sync: SyncClient,
  chatId: string | null,
  actions: BlockActions,
): BlockRenderer {
  return (name, payload) => {
    if (payload?.v !== 1) return undefined;
    if (chatId === null) return undefined;
    if (name === "canvas") {
      const block = parseCanvasPayload(payload, t("Canvas", "Canevas"));
      if (!block) return undefined;
      const target = canvasTarget(sync, block);
      return (
        <section className="chat-block wc-card" data-kind="canvas">
          <h3>{block.title}</h3>
          <p className="quiet">
            {block.canvasKind === "code"
              ? t(
                  `Code${block.language ? `, ${block.language}` : ""}`,
                  `Code${block.language ? `, ${block.language}` : ""}`,
                )
              : t("Document", "Document")}
          </p>
          <button
            className="button"
            type="button"
            onClick={() =>
              target
                ? actions.onCanvas(target.id, canvasMarkdown(block))
                : void openCanvas(sync, block).then((id) => actions.onCanvas(id, null))
            }
          >
            {target
              ? t("Review this version", "Examiner cette version")
              : t("Open in canvas", "Ouvrir dans le canevas")}
          </button>
        </section>
      );
    }
    if (name === "tryon") {
      const block = parseTryOnPayload(payload);
      return (
        <section className="chat-block wc-card" data-kind="tryon">
          <h3>{block.title || t("Try it on", "Essayer")}</h3>
          {block.garment && <p>{block.garment}</p>}
          <p className="quiet">
            {t(
              "Pick a photo of the person and one of the garment. The price is shown before anything is made.",
              "Choisissez une photo de la personne et une du vêtement. Le prix s’affiche avant toute création.",
            )}
          </p>
          <button className="button" type="button" onClick={() => actions.onTryOn(block.garment)}>
            {t("Try it on", "Essayer")}
          </button>
        </section>
      );
    }
    if (name === "links" || name === "places") {
      const requests: { label: string; request: SaveRequest }[] =
        name === "links"
          ? items(payload.links)
              .filter((link) => typeof link.url === "string")
              .map((link) => ({
                label: String(link.title || link.url),
                request: linkSaveRequest(
                  {
                    url: String(link.url),
                    title: typeof link.title === "string" ? link.title : undefined,
                    snippet: typeof link.snippet === "string" ? link.snippet : undefined,
                  },
                  chatId,
                ),
              }))
          : items(payload.places)
              .filter(
                (place) =>
                  typeof place.name === "string" &&
                  typeof place.lat === "number" &&
                  typeof place.lng === "number",
              )
              .map((place) => ({
                label: String(place.name),
                request: placeSaveRequest(
                  {
                    name: String(place.name),
                    lat: Number(place.lat),
                    lng: Number(place.lng),
                    ...(typeof place.address === "string" ? { address: place.address } : {}),
                    ...(typeof place.category === "string" ? { category: place.category } : {}),
                    ...(typeof place.url === "string" ? { url: place.url } : {}),
                    ...(typeof place.note === "string" ? { note: place.note } : {}),
                  },
                  chatId,
                ),
              }));
      return (
        <>
          <ChatBlockList name={name} payload={payload} />
          {requests.length > 0 && (
            <div
              className="wc-actions"
              role="toolbar"
              aria-label={t("Save to your library", "Enregistrer dans votre bibliothèque")}
            >
              {requests.slice(0, 12).map(({ label, request }) => {
                const saved = actions.isSaved(request.sourceKey);
                return (
                  <button
                    key={request.sourceKey}
                    type="button"
                    aria-pressed={saved}
                    disabled={saved}
                    onClick={() => actions.onSave(request)}
                  >
                    {saved
                      ? t(`Saved: ${label}`, `Enregistré : ${label}`)
                      : t(`Save ${label}`, `Enregistrer ${label}`)}
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
    }
    return undefined;
  };
}
