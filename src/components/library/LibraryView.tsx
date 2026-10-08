import "../../styles/canvas.css";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconBookmark } from "central-icons/IconBookmark";
import { IconBubbleQuotes } from "central-icons/IconBubbleQuotes";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconImages1 } from "central-icons/IconImages1";
import { IconMapPin } from "central-icons/IconMapPin";
import { IconSidebarSimpleRightWide } from "central-icons/IconSidebarSimpleRightWide";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { type ReactNode, useEffect, useState } from "react";
import { useArtifactDataUrl, useArtifactThumbnail } from "../../lib/artifact-media";
import { openReplyInCanvas } from "../../lib/canvas";
import { chatBlocksToClipboardText } from "../../lib/chat-blocks";
import { friendlyErrorMessage } from "../../lib/errors";
import { safeExternalUrl } from "../../lib/external-link";
import { t } from "../../lib/i18n";
import {
  listChatImages,
  removeSavedItem,
  type SavedItem,
  useSavedItems,
} from "../../lib/chat-library";
import type { StudioArtifact } from "../../lib/studio/types";
import { openExternalUrl } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";

type Section = "saved" | "images";

/**
 * The Library (ADR-0088): what a person kept from their chats, and every
 * picture a chat made. The same view on both shells; each shell gives it its
 * own frame (a page on the desktop, a pushed screen on the phone).
 */
export function LibraryView({ header }: { header?: ReactNode }) {
  const [section, setSection] = useState<Section>("saved");
  return (
    <div className="library-view">
      {header}
      <div className="library-view-switch">
        <SegmentedControl
          value={section}
          onValueChange={setSection}
          aria-label={t("Library sections")}
          options={[
            { value: "saved", label: t("Saved") },
            { value: "images", label: t("Images") },
          ]}
        />
      </div>
      <div className="library-view-body">
        {section === "saved" ? <SavedList /> : <ChatImages />}
      </div>
    </div>
  );
}

function SavedList() {
  const { items, loaded } = useSavedItems();
  const [error, setError] = useState<string | null>(null);
  if (!loaded) return <p className="library-view-quiet">{t("Loading")}</p>;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<IconBookmark size={28} />}
        title={t("Nothing saved yet")}
        description={t("Save a reply, a link or a place from a chat and it waits for you here.")}
      />
    );
  }
  return (
    <>
      {error ? (
        <p className="library-view-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="library-saved-list">
        {items.map((item) => (
          <SavedRow key={item.id} item={item} onError={setError} />
        ))}
      </ul>
    </>
  );
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The same Maps link the place card opens. */
function placeMapsUrl(title: string, payload: Record<string, unknown>): string | undefined {
  const lat = payload.lat;
  const lng = payload.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  return `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(title)}`;
}

function SavedRow({ item, onError }: { item: SavedItem; onError: (message: string) => void }) {
  const text = stringField(item.payload, "text") ?? "";
  const url = safeExternalUrl(
    item.kind === "link"
      ? stringField(item.payload, "url")
      : item.kind === "place"
        ? placeMapsUrl(item.title, item.payload)
        : undefined,
  )?.href;
  const meta =
    item.kind === "reply"
      ? chatBlocksToClipboardText(text).replace(/\s+/g, " ").slice(0, 160)
      : item.kind === "link"
        ? [stringField(item.payload, "domain"), stringField(item.payload, "snippet")]
            .filter(Boolean)
            .join(" · ")
        : [stringField(item.payload, "category"), stringField(item.payload, "address")]
            .filter(Boolean)
            .join(" · ");
  const Icon =
    item.kind === "reply" ? IconBubbleQuotes : item.kind === "link" ? IconGlobe : IconMapPin;

  return (
    <li className="library-saved-row">
      <span className="library-saved-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="library-saved-body">
        <span className="library-saved-title">{item.title}</span>
        {meta ? <span className="library-saved-meta">{meta}</span> : null}
      </span>
      <span className="library-saved-actions">
        {item.kind === "reply" ? (
          <>
            <button
              type="button"
              aria-label={t("Open in canvas")}
              title={t("Open in canvas")}
              onClick={() =>
                void openReplyInCanvas({
                  text,
                  conversationId: item.conversationId ?? undefined,
                  messageId: stringField(item.payload, "messageId"),
                }).catch((cause) =>
                  onError(friendlyErrorMessage(cause, t("The canvas did not open. Try again."))),
                )
              }
            >
              <IconSidebarSimpleRightWide size={15} />
            </button>
            <button
              type="button"
              aria-label={t("Copy reply")}
              title={t("Copy reply")}
              onClick={() => void writeText(chatBlocksToClipboardText(text)).catch(() => undefined)}
            >
              <IconClipboard size={15} />
            </button>
          </>
        ) : url ? (
          <button
            type="button"
            aria-label={t("Open {name}", { name: item.title })}
            title={url}
            onClick={() => void openExternalUrl(url)}
          >
            <IconArrowUpRight size={15} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t("Remove from Library")}
          title={t("Remove from Library")}
          onClick={() =>
            void removeSavedItem(item.id).catch((cause) =>
              onError(friendlyErrorMessage(cause, t("That was not removed. Try again."))),
            )
          }
        >
          <IconTrashCan size={15} />
        </button>
      </span>
    </li>
  );
}

function ChatImages() {
  const [images, setImages] = useState<StudioArtifact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<StudioArtifact | null>(null);

  useEffect(() => {
    let cancelled = false;
    listChatImages()
      .then((found) => {
        if (!cancelled) setImages(found);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="library-view-error">{t("Your images could not be listed.")}</p>;
  }
  if (!images) return <p className="library-view-quiet">{t("Loading")}</p>;
  if (images.length === 0) {
    return (
      <EmptyState
        icon={<IconImages1 size={28} />}
        title={t("No images from your chats yet")}
        description={t("Every picture a chat makes is kept in your gallery and shown here.")}
      />
    );
  }
  return (
    <>
      <ul className="library-image-grid">
        {images.map((image) => (
          <li key={image.id}>
            <ImageTile image={image} onOpen={() => setOpen(image)} />
          </li>
        ))}
      </ul>
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={t("Image from a chat")}
        width="min(720px, calc(100vw - 32px))"
      >
        {open ? <ImageDetail image={open} /> : null}
      </Dialog>
    </>
  );
}

function ImageTile({ image, onOpen }: { image: StudioArtifact; onOpen: () => void }) {
  const thumbnail = useArtifactThumbnail(image);
  return (
    <button
      type="button"
      className="library-image-tile"
      onClick={onOpen}
      aria-label={image.prompt || t("Image from a chat")}
      title={image.prompt || undefined}
    >
      {thumbnail ? <img src={thumbnail.src} alt="" /> : <span className="library-image-blank" />}
      {image.edit ? (
        <span className="library-image-badge">{t("Version {n}", { n: image.edit.n })}</span>
      ) : null}
    </button>
  );
}

function ImageDetail({ image }: { image: StudioArtifact }) {
  const url = useArtifactDataUrl(image);
  return (
    <div className="library-image-detail">
      {url ? <img src={url} alt={image.prompt || ""} /> : <span className="library-image-blank" />}
      {image.prompt ? <p className="library-image-prompt">{image.prompt}</p> : null}
      {image.model ? <p className="library-view-quiet">{image.model}</p> : null}
    </div>
  );
}
