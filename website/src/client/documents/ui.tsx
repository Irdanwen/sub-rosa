import { useEffect, useRef, useState } from "react";
import { date, number, t } from "../../lib/i18n";
import type { BlockProps, FeatureHost } from "../feature";
import {
  documentBytes,
  documentTitle,
  type LocalDocument,
  parseFilePayload,
  saveFile,
  storeOf,
  suggestedFileName,
} from "./documents";
import { type GalleryDocument, listDocuments } from "../gallery";
import type { DocumentKind } from "./make";
import "./documents.css";

export function kindLabel(kind: DocumentKind): string {
  return kind === "docx"
    ? t("Word document", "Document Word")
    : kind === "xlsx"
      ? t("Excel workbook", "Classeur Excel")
      : t("PowerPoint deck", "Présentation PowerPoint");
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024
    ? t(
        `${number(Math.max(1, Math.round(bytes / 1024)), 0)} KB`,
        `${number(Math.max(1, Math.round(bytes / 1024)), 0)} Ko`,
      )
    : t(`${number(bytes / 1024 / 1024, 1)} MB`, `${number(bytes / 1024 / 1024, 1)} Mo`);
}

/** Downloads one document, with the sentence to show when it fails. */
function useDownload(host: FeatureHost) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async (file: string, kind: DocumentKind, title?: string) => {
    setBusy(true);
    setError("");
    try {
      const bytes = await documentBytes(host, file);
      const named = title ?? (await documentTitle(bytes)) ?? file.replace(/\.[a-z]+$/, "");
      saveFile(suggestedFileName(named, kind), kind, bytes);
    } catch {
      setError(
        t(
          "This file could not be opened here. It may still be on its way from the device that made it.",
          "Ce fichier n’a pas pu être ouvert ici. Il est peut-être encore en route depuis l’appareil qui l’a créé.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, download };
}

/** The `subrosa:file` card: what the file is, and its download. */
export function FileCard({ payload, host }: BlockProps) {
  const block = parseFilePayload(payload);
  const [local, setLocal] = useState<LocalDocument | null | undefined>(undefined);
  const { busy, error, download } = useDownload(host);
  // The page hands a new host on every render; the store it opens is the same.
  const hostRef = useRef(host);
  hostRef.current = host;
  const file = block?.file;
  useEffect(() => {
    if (!file) return;
    let active = true;
    storeOf(hostRef.current)
      .get<LocalDocument>(file)
      .then((value) => active && setLocal(value ?? null))
      .catch(() => active && setLocal(null));
    return () => {
      active = false;
    };
  }, [file]);
  if (!block) return null;
  const filed = host.sync
    .rows("account_studio_files")
    .some((row) => row.id === block.file.slice(0, 36));
  return (
    <section className="chat-block doc-card" data-kind="file">
      <h3>{block.title}</h3>
      <p className="chat-block-meta">
        {[kindLabel(block.kind), block.detail, local ? sizeLabel(local.bytes) : null]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="wc-row">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => void download(block.file, block.kind, block.title)}
        >
          {busy ? t("Preparing…", "Préparation…") : t("Download", "Télécharger")}
        </button>
        {local !== undefined && (
          <span className="quiet">
            {filed || local?.filed
              ? t("In your gallery", "Dans votre galerie")
              : local
                ? t("Kept in this browser only", "Gardé dans ce navigateur seulement")
                : null}
          </span>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

interface Row {
  file: string;
  kind: DocumentKind;
  title: string | null;
  bytes: number;
  createdAt: string;
  readable: boolean;
  here: boolean;
}

/** The documents of the account's gallery and of this browser, newest first. */
export function FilesPanel({ host }: { host: FeatureHost }) {
  const [locals, setLocals] = useState<LocalDocument[]>([]);
  const { busy, error, download } = useDownload(host);
  const hostRef = useRef(host);
  hostRef.current = host;
  const account = host.account.id;
  useEffect(() => {
    let active = true;
    void account;
    storeOf(hostRef.current)
      .list<LocalDocument>()
      .then((entries) => active && setLocals(entries.map((entry) => entry.value)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [account]);
  const gallery: GalleryDocument[] = listDocuments(host.sync);
  const rows = new Map<string, Row>();
  for (const item of gallery)
    rows.set(item.name, {
      file: item.name,
      kind: item.format,
      title: null,
      bytes: item.bytes,
      createdAt: item.createdAt,
      readable: item.readable,
      here: false,
    });
  for (const item of locals)
    rows.set(item.file, {
      file: item.file,
      kind: item.kind,
      title: item.title,
      bytes: item.bytes,
      createdAt: item.createdAt,
      readable: true,
      here: true,
    });
  const sorted = [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="doc-panel">
      <h2>{t("Files", "Fichiers")}</h2>
      <p className="quiet">
        {t(
          "The Word, Excel and PowerPoint files the assistant made, on any of your devices.",
          "Les fichiers Word, Excel et PowerPoint que l’assistant a créés, sur n’importe lequel de vos appareils.",
        )}
      </p>
      {sorted.length === 0 ? (
        <p className="quiet">{t("No file yet.", "Aucun fichier pour l’instant.")}</p>
      ) : (
        <ul className="doc-list">
          {sorted.map((row) => (
            <li key={row.file}>
              <div>
                <strong>{row.title ?? kindLabel(row.kind)}</strong>
                <span className="quiet">
                  {[
                    kindLabel(row.kind),
                    sizeLabel(row.bytes),
                    row.createdAt ? date(row.createdAt) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <button
                className="button"
                type="button"
                disabled={busy || !row.readable}
                onClick={() => void download(row.file, row.kind, row.title ?? undefined)}
              >
                {row.readable ? t("Download", "Télécharger") : t("On its way", "En route")}
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
