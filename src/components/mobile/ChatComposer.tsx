// The phone's one way to write to a model: the field, its attachments, and a
// single round button that is the microphone until there is something to
// send, then the arrow, and the stop square while a reply is being written.
// The Chat tab and an assistant's conversation share it,
// so the two never drift into two ways of typing a message.

import { IconArrowUp } from "central-icons/IconArrowUp";
import { ASK_ABOUT_SELECTION_EVENT, takePendingQuote } from "../../lib/ask-selection";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { IconScanTextSparkle } from "central-icons/IconScanTextSparkle";
import { IconStop } from "central-icons/IconStop";
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { messageFromError } from "../../lib/errors";
import { hapticImpact, hapticNotify } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { documentExtract, isExtractableDocument } from "../../lib/projects";
import { scanDocument, scanTitle, supportsDocumentScan } from "../../lib/scan";
import {
  type AgentLiteAttachment,
  mobileDictationStart,
  mobileDictationStop,
} from "../../lib/tauri";

export function ChatComposer({
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
  placeholder,
  canSend,
  onSend,
  onError,
  chip,
  above,
  inputRef,
  running = false,
  onStop,
}: {
  draft: string;
  onDraftChange: Dispatch<SetStateAction<string>>;
  attachments: AgentLiteAttachment[];
  onAttachmentsChange: Dispatch<SetStateAction<AgentLiteAttachment[]>>;
  placeholder: string;
  /** False while a turn runs or the conversation cannot take one. */
  canSend: boolean;
  onSend: () => void;
  onError: (message: string) => void;
  /** A control beside the paperclip: the model, for the Chat tab. */
  chip?: ReactNode;
  /** What sits above the card: openers on an empty conversation. */
  above?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement>;
  /** A reply is being written. With `onStop`, the round button stops it. */
  running?: boolean;
  onStop?: () => void;
}) {
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? ownInput;
  // "Ask Sub Rosa" on a selection (lib/ask-selection): the quote goes on top
  // of the draft, taken once, whether it was asked for before this composer
  // mounted or while it is on screen.
  useEffect(() => {
    const take = () => {
      const quote = takePendingQuote();
      if (!quote) return;
      onDraftChange((current) => `${quote}${current}`);
      field.current?.focus();
    };
    take();
    window.addEventListener(ASK_ABOUT_SELECTION_EVENT, take);
    return () => window.removeEventListener(ASK_ABOUT_SELECTION_EVENT, take);
  }, [onDraftChange, field]);
  const fileInput = useRef<HTMLInputElement>(null);
  const keyboardInset = useKeyboardInset();
  const [dictating, setDictating] = useState(false);
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0;

  // Grow with the content (up to a few lines, then scroll) so a multi-line
  // draft stays visible instead of hiding above a one-row box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger, not an input
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
  }, [draft, field]);

  const addAttachment = useCallback(
    (file: File) => {
      if (file.type.startsWith("image/")) {
        void downscaleImageFile(file)
          .then((data) =>
            onAttachmentsChange((current) => [
              ...current,
              { kind: "image", name: file.name, data },
            ]),
          )
          .catch(() => onError(t("This image could not be read.")));
        return;
      }
      // PDF and Office documents are read on the device, and their text
      // rides as a text attachment (ADR-0085). A scan says so.
      if (isExtractableDocument(file.name)) {
        void documentExtract(file)
          .then((document) =>
            onAttachmentsChange((current) => [
              ...current,
              { kind: "text", name: file.name, data: document.text },
            ]),
          )
          .catch((err: unknown) => onError(messageFromError(err)));
        return;
      }
      if (file.size > 512 * 1024) {
        onError(t("Text files up to 512 KB can be attached."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          const data = reader.result;
          onAttachmentsChange((current) => [...current, { kind: "text", name: file.name, data }]);
        }
      };
      reader.readAsText(file);
    },
    [onAttachmentsChange, onError],
  );

  // Paper into the conversation: the scan becomes a note of its own, and its
  // text rides this turn the way a PDF's does.
  const [scanning, setScanning] = useState(false);
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await scanDocument();
      if (!result) return;
      if (!result.text.trim()) {
        onError(t("No text was found on these pages. The scan is saved in your notes."));
        return;
      }
      onAttachmentsChange((current) => [
        ...current,
        { kind: "text", name: scanTitle(), data: result.text },
      ]);
      hapticNotify("success");
    } catch (err) {
      onError(messageFromError(err));
    } finally {
      setScanning(false);
    }
  }, [onAttachmentsChange, onError]);

  const toggleDictation = useCallback(async () => {
    if (dictating) {
      setDictating(false);
      try {
        const result = await mobileDictationStop({ style: "standard" });
        onDraftChange((current) => (current ? `${current} ${result.text}` : result.text));
        hapticNotify("success");
      } catch (err) {
        onError(messageFromError(err));
      }
      return;
    }
    try {
      await mobileDictationStart();
      setDictating(true);
      hapticImpact("medium");
    } catch (err) {
      onError(messageFromError(err));
    }
  }, [dictating, onDraftChange, onError]);

  return (
    <div
      className="mobile-chat-composer-stack"
      data-keyboard={keyboardInset > 0 ? "true" : undefined}
      style={{ marginBottom: keyboardInset }}
    >
      {attachments.length > 0 ? (
        <div className="mobile-chat-attachments">
          {attachments.map((entry, index) => (
            <button
              key={`${entry.name}-${index}`}
              type="button"
              className="mobile-chat-attachment"
              aria-label={t("Remove {name}", { name: entry.name })}
              onClick={() =>
                onAttachmentsChange((current) => current.filter((_, i) => i !== index))
              }
            >
              {entry.kind === "image" ? (
                <img src={entry.data} alt={entry.name} />
              ) : (
                <span className="mobile-chat-attachment-file">{entry.name}</span>
              )}
              <span className="mobile-chat-attachment-remove" aria-hidden>
                x
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {above}
      <div className="mobile-chat-composer-card">
        <input
          ref={fileInput}
          type="file"
          accept="image/*,.txt,.md,.csv,.json,text/plain,.pdf,.docx,.xlsx,.pptx"
          multiple
          hidden
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? [])) addAttachment(file);
            event.target.value = "";
          }}
        />
        <textarea
          ref={field}
          className="mobile-chat-input"
          value={draft}
          placeholder={placeholder}
          rows={1}
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={(event) => {
            // Pasting an image (long-press > Paste on iOS) attaches it
            // instead of dropping it: textareas cannot hold images.
            const files = Array.from(event.clipboardData?.items ?? [])
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (files.length === 0) return;
            event.preventDefault();
            for (const file of files) {
              addAttachment(
                file.name
                  ? file
                  : new File([file], `pasted-${Date.now()}.png`, { type: file.type }),
              );
            }
          }}
        />
        <div className="mobile-chat-composer-row">
          <button
            type="button"
            className="mobile-composer-bare"
            aria-label={t("Attach a file")}
            onClick={() => fileInput.current?.click()}
          >
            <IconPaperclip1 size={19} />
          </button>
          {supportsDocumentScan() ? (
            <button
              type="button"
              className="mobile-composer-bare"
              aria-label={t("Scan a document")}
              disabled={scanning}
              onClick={() => void scan()}
            >
              <IconScanTextSparkle size={19} />
            </button>
          ) : null}
          {chip}
          <span className="mobile-composer-spacer" />
          {/* One round button that changes with the field: the microphone
              while there is nothing to send, the arrow once there is, and
              the stop square for as long as a reply is being written. */}
          {running && onStop ? (
            <button
              type="button"
              className="mobile-chat-send"
              aria-label={t("Stop reply")}
              onClick={() => {
                hapticImpact("medium");
                onStop();
              }}
            >
              <IconStop size={18} />
            </button>
          ) : hasDraft && !dictating ? (
            <button
              type="button"
              className="mobile-chat-send"
              aria-label={t("Send")}
              disabled={!canSend}
              onClick={onSend}
            >
              <IconArrowUp size={20} />
            </button>
          ) : (
            <button
              type="button"
              className="mobile-chat-send"
              data-mic="true"
              data-active={dictating ? "true" : undefined}
              aria-label={dictating ? t("Stop dictation") : t("Dictate")}
              onClick={() => void toggleDictation()}
            >
              <IconMicrophone size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Camera photos are far larger than vision models need; cap the long edge
 * and re-encode as JPEG so requests stay fast and within body limits. Loads
 * through a data URL (not a blob URL): the app CSP allows `data:` images
 * only, and WKWebView decodes HEIC natively along the same path. */
export async function downscaleImageFile(file: File, maxDim = 2048): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("file read failed"));
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("image decode failed"));
    element.src = original;
  });
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
