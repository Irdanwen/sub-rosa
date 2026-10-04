// What an assistant can read, on the phone: one row per reference with what
// it is and whether it is ready, a tap for what can be done with it, and one
// "add" that offers a file, a note or a picture from the gallery.

import { IconFilePdf } from "central-icons/IconFilePdf";
import { IconFileText } from "central-icons/IconFileText";
import { IconImages1 } from "central-icons/IconImages1";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AssistantReference,
  addAssistantArtifact,
  addAssistantNote,
  deleteAssistantReference,
  importAssistantReference,
  listAssistantReferences,
  refreshAssistantNote,
} from "../../../../lib/assistants";
import { messageFromError } from "../../../../lib/errors";
import { hapticNotify } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useModalFocus } from "../../../../lib/modal-focus";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import type { StudioArtifact } from "../../../../lib/studio/types";
import { listNotes, type NoteListItemDto } from "../../../../lib/tauri";
import { EmptyState } from "../../../ui/EmptyState";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet } from "../../ActionSheet";
import { NotePickerSheet } from "../../NotePickerSheet";
import { sheetHost } from "../../sheet-host";
import { StackHeader } from "../../StackHeader";
import { GalleryImageGrid } from "./AssistantAvatar";

/** How often a reference still being prepared is looked at again, while this
 * screen is open; the preparation itself runs in the Rust process. */
const PREPARING_POLL_MS = 1500;

const IMAGE = /^(image|png|jpe?g|webp|gif|avif|heic)/i;

type Sheet =
  | { kind: "add" }
  | { kind: "notes"; notes: NoteListItemDto[] }
  | { kind: "gallery" }
  | { kind: "reference"; reference: AssistantReference }
  | { kind: "remove"; reference: AssistantReference }
  | null;

export function AssistantReferencesScreen({
  assistantId,
  assistantName,
  onBack,
}: {
  assistantId: string;
  assistantName?: string;
  onBack: () => void;
}) {
  const [references, setReferences] = useState<AssistantReference[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReferences(await listAssistantReferences(assistantId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [assistantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A queued reference turns ready (or failed) without telling anyone; look
  // again while one is waiting and the screen is in front of the person.
  const preparing = references?.some((reference) => reference.status === "queued") ?? false;
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, PREPARING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [preparing, refresh]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(messageFromError(err));
      hapticNotify("error");
    } finally {
      setBusy(false);
    }
  };

  // The sheets close themselves after an action; an action that opened the
  // next sheet keeps it.
  const closeFrom = (kind: NonNullable<Sheet>["kind"]) => () =>
    setSheet((current) => (current?.kind === kind ? null : current));

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("References")}
        onBack={onBack}
        backLabel={assistantName || t("Assistant")}
        trailing={
          <button
            type="button"
            className="mobile-icon-button"
            aria-label={t("Add a reference")}
            disabled={busy}
            onClick={() => setSheet({ kind: "add" })}
          >
            {busy ? <Spinner aria-hidden /> : <IconPlusMedium size={20} />}
          </button>
        }
      />
      <div className="mobile-scroll mobile-assistant-references">
        {error ? (
          <p className="mobile-dictation-error" role="alert">
            {error}
          </p>
        ) : null}
        {references === null ? (
          <Spinner aria-label={t("Loading")} />
        ) : references.length === 0 ? (
          <EmptyState
            title={t("No references yet")}
            description={t("Give your assistant the documents that matter to your work.")}
            action={
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => setSheet({ kind: "add" })}
              >
                {t("Add a reference")}
              </button>
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {references.map((reference) => (
              <li key={reference.id}>
                <button
                  type="button"
                  className="mobile-note-row mobile-assistant-reference-row"
                  onClick={() => setSheet({ kind: "reference", reference })}
                >
                  <span className="mobile-assistant-reference-icon" aria-hidden>
                    {referenceIcon(reference)}
                  </span>
                  <span className="mobile-note-row-body">
                    <span className="mobile-note-row-title">{reference.name}</span>
                    {reference.status === "failed" && reference.error ? (
                      <span className="mobile-note-row-subtitle">{reference.error}</span>
                    ) : null}
                  </span>
                  <span
                    className="mobile-assistant-reference-status"
                    data-status={reference.status}
                  >
                    {reference.status === "ready"
                      ? t("Ready")
                      : reference.status === "failed"
                        ? t("Couldn't read this file")
                        : t("Preparing…")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mobile-settings-group-footer">
          {t(
            "Add text, PDF, images or Office documents. Notes are dated copies that you can refresh.",
          )}
        </p>
      </div>

      {sheet?.kind === "add" ? (
        <ActionSheet
          title={t("Add a reference")}
          actions={[
            {
              label: t("Add a file"),
              onAction: () => void run(() => importAssistantReference(assistantId)),
            },
            {
              label: t("Choose a note"),
              onAction: () =>
                void listNotes()
                  .then((result) => setSheet({ kind: "notes", notes: result.items }))
                  .catch((err) => setError(messageFromError(err))),
            },
            { label: t("Choose from the gallery"), onAction: () => setSheet({ kind: "gallery" }) },
          ]}
          onClose={closeFrom("add")}
        />
      ) : null}
      {sheet?.kind === "notes" ? (
        <NotePickerSheet
          title={t("Choose a note")}
          notes={sheet.notes}
          confirmLabel={(count) =>
            count === 1 ? t("Add 1 note") : t("Add {count} notes", { count })
          }
          onConfirm={(noteIds) => {
            setSheet(null);
            void run(async () => {
              for (const noteId of noteIds) await addAssistantNote(assistantId, noteId);
            });
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === "gallery" ? (
        <GalleryPickerSheet
          onPick={(image) => {
            setSheet(null);
            void run(() => addAssistantArtifact(assistantId, image.fileName));
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === "reference" ? (
        <ActionSheet
          title={sheet.reference.name}
          actions={[
            ...(sheet.reference.note_id
              ? [
                  {
                    label: t("Refresh note copy"),
                    onAction: () => void run(() => refreshAssistantNote(sheet.reference.id)),
                  },
                ]
              : []),
            {
              label: t("Remove"),
              destructive: true,
              onAction: () => setSheet({ kind: "remove", reference: sheet.reference }),
            },
          ]}
          onClose={closeFrom("reference")}
        />
      ) : null}
      {sheet?.kind === "remove" ? (
        <ActionSheet
          title={t("Remove this reference?")}
          subtitle={t(
            "New conversations and conversations you explicitly update will no longer use this reference. Existing conversations keep their saved copy.",
          )}
          actions={[
            {
              label: t("Remove"),
              destructive: true,
              onAction: () => void run(() => deleteAssistantReference(sheet.reference.id)),
            },
          ]}
          onClose={closeFrom("remove")}
        />
      ) : null}
    </div>
  );
}

function referenceIcon(reference: AssistantReference) {
  if (reference.note_id) return <IconNoteText size={18} />;
  if (IMAGE.test(reference.format)) return <IconImages1 size={18} />;
  if (/pdf/i.test(reference.format)) return <IconFilePdf size={18} />;
  return <IconFileText size={18} />;
}

/** The Studio gallery's pictures, newest first, in a sheet. */
export function GalleryPickerSheet({
  onPick,
  onClose,
}: {
  onPick: (image: StudioArtifact) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, { onClose });
  const [images, setImages] = useState<StudioArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listArtifacts("image")
      .then(setImages)
      .catch((err) => setError(messageFromError(err)));
  }, []);
  const title = t("Choose from the gallery");
  return createPortal(
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-action-sheet mobile-avatar-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{title}</p>
        {error ? (
          <p className="mobile-sheet-error" role="alert">
            {error}
          </p>
        ) : images === null ? (
          <div className="mobile-avatar-sheet-busy">
            <Spinner />
          </div>
        ) : images.length === 0 ? (
          <p className="mobile-action-sheet-subtitle">
            {t("Your gallery has no images yet. Create one in a conversation, then return here.")}
          </p>
        ) : (
          <GalleryImageGrid images={images} onPick={onPick} />
        )}
        <button type="button" className="mobile-action-sheet-cancel" onClick={onClose}>
          {t("Cancel")}
        </button>
      </div>
    </div>,
    sheetHost(),
  );
}
