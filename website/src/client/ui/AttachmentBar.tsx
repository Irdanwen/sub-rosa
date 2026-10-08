import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
  type Attachment,
  canvasImageFitter,
  type ImageFitter,
  MAX_IMAGE_ATTACHMENTS,
} from "../attachments";
import { DocumentError, type PdfReader, pdfJsReader, readDocument } from "../documents/read";

export const ACCEPTED_FILES =
  "image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.json,text/plain";

/** The words for a document the browser could not read. */
export function documentFailure(error: unknown): string {
  if (error instanceof DocumentError)
    switch (error.code) {
      case "unsupported":
        return t(
          "This file type cannot be read. Attach a PDF, Word, Excel, PowerPoint, text or CSV file.",
          "Ce type de fichier ne peut pas être lu. Joignez un PDF, un fichier Word, Excel, PowerPoint, texte ou CSV.",
        );
      case "too_large":
        return t(
          "This file is too large. Documents up to 20 MB and text files up to 512 KB can be read.",
          "Ce fichier est trop volumineux. Les documents jusqu’à 20 Mo et les fichiers texte jusqu’à 512 Ko peuvent être lus.",
        );
      case "scan":
        return t(
          "This PDF is a scan, with no text to read. Export it with its text, or paste the text.",
          "Ce PDF est un scan, sans texte à lire. Exportez-le avec son texte, ou collez le texte.",
        );
      case "empty":
        return t("This document has no text to read.", "Ce document n’a pas de texte à lire.");
      default:
        break;
    }
  return t("This file could not be read.", "Ce fichier n’a pas pu être lu.");
}

/** Reads a picked file into an attachment, on this device only. */
export async function readAttachment(
  file: File,
  readers: { pdf?: PdfReader; image?: ImageFitter } = {},
): Promise<Attachment> {
  if (file.type.startsWith("image/"))
    return {
      kind: "image",
      name: file.name,
      data: await (readers.image ?? canvasImageFitter)(file),
    };
  const document = await readDocument(
    { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    readers.pdf ?? pdfJsReader,
  );
  return { kind: "text", name: file.name, data: document.text };
}

/**
 * The composer's attachments: files and photos for the next message only.
 * They are read here, never uploaded; the message keeps only their names.
 */
export function AttachmentBar({
  attachments,
  onChange,
  disabled,
  readers,
}: {
  attachments: Attachment[];
  onChange: (next: Attachment[]) => void;
  disabled?: boolean;
  readers?: { pdf?: PdfReader; image?: ImageFitter };
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    setReading(true);
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (
        file.type.startsWith("image/") &&
        next.filter((item) => item.kind === "image").length >= MAX_IMAGE_ATTACHMENTS
      ) {
        setError(t("Attach at most four pictures.", "Joignez quatre images au plus."));
        continue;
      }
      try {
        next.push(await readAttachment(file, readers));
      } catch (failure) {
        setError(documentFailure(failure));
      }
    }
    setReading(false);
    onChange(next);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="wc-attachments">
      <label className="button wc-attach">
        {reading ? t("Reading…", "Lecture…") : t("Attach", "Joindre")}
        <input
          ref={input}
          className="sr-only"
          type="file"
          multiple
          accept={ACCEPTED_FILES}
          disabled={disabled || reading}
          onChange={(event) => void pick(event.target.files)}
        />
      </label>
      {attachments.length > 0 && (
        <ul
          className="wc-chips"
          aria-label={t("Attached to the next message", "Joint au prochain message")}
        >
          {attachments.map((attachment, index) => (
            // Names may repeat; the order is the composer's own.
            // biome-ignore lint/suspicious/noArrayIndexKey: a short list, never reordered
            <li key={index}>
              {attachment.kind === "image" ? (
                <img src={attachment.data} alt="" className="wc-thumb" />
              ) : null}
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={t(`Remove ${attachment.name}`, `Retirer ${attachment.name}`)}
                onClick={() => onChange(attachments.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
