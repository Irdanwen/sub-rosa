import "../../styles/deliverables.css";
import { IconFileArrowRightOut } from "central-icons/IconFileArrowRightOut";
import { IconFileDownload } from "central-icons/IconFileDownload";
import { IconFileText } from "central-icons/IconFileText";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconSlidesWide } from "central-icons/IconSlidesWide";
import { IconTable } from "central-icons/IconTable";
import { useState } from "react";
import { friendlyErrorMessage } from "../../lib/errors";
import {
  type DocumentKind,
  type FileChatBlock,
  openDeliverable,
  saveDeliverableCopy,
} from "../../lib/file-block";
import { t } from "../../lib/i18n";
import { isMobilePlatform } from "../../lib/mobile";

function kindLabel(kind: DocumentKind): string {
  switch (kind) {
    case "xlsx":
      return t("Excel workbook");
    case "pptx":
      return t("PowerPoint deck");
    default:
      return t("Word document");
  }
}

function KindIcon({ kind }: { kind: DocumentKind }) {
  if (kind === "xlsx") return <IconTable size={16} />;
  if (kind === "pptx") return <IconSlidesWide size={16} />;
  return <IconFileText size={16} />;
}

/**
 * A `subrosa:file` block: a document the assistant made (ADR-0090). On the
 * computer it opens in its own app or is saved where the person picks; on
 * the phone the share sheet does both, with "Save to Files" among its rows.
 */
export function FileCard({ block }: { block: FileChatBlock }) {
  const mobile = isMobilePlatform();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const meta = block.detail
    ? t("{kind}, {detail}", { kind: kindLabel(block.documentKind), detail: block.detail })
    : kindLabel(block.documentKind);

  const run = (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice(null);
    void action()
      .then((result) => {
        if (done && typeof result === "string") setNotice({ text: done, error: false });
      })
      .catch((cause) =>
        setNotice({
          text: friendlyErrorMessage(cause, t("The file could not be opened. Try again.")),
          error: true,
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="chat-block file-card" aria-label={block.title}>
      <header className="file-card-head">
        <span className="chat-block-row-icon" aria-hidden>
          <KindIcon kind={block.documentKind} />
        </span>
        <span className="chat-block-row-body">
          <span className="chat-block-row-title">{block.title}</span>
          <span className="chat-block-row-meta">{meta}</span>
        </span>
      </header>
      <footer className="file-card-actions">
        {notice ? (
          <span className="file-card-notice" role={notice.error ? "alert" : "status"}>
            {notice.text}
          </span>
        ) : null}
        {mobile ? (
          <button
            type="button"
            className="file-card-action"
            disabled={busy}
            onClick={() => run(() => openDeliverable(block.file))}
          >
            <IconShareOs size={14} aria-hidden />
            {t("Share or save")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="file-card-action"
              disabled={busy}
              onClick={() => run(() => saveDeliverableCopy(block), t("Saved"))}
            >
              <IconFileDownload size={14} aria-hidden />
              {t("Save a copy")}
            </button>
            <button
              type="button"
              className="file-card-action"
              data-primary
              disabled={busy}
              onClick={() => run(() => openDeliverable(block.file))}
            >
              <IconFileArrowRightOut size={14} aria-hidden />
              {t("Open")}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
