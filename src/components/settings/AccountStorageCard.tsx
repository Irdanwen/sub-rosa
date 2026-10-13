import { useCallback, useEffect, useState } from "react";
import {
  accountStorageSetSending,
  accountStorageStatus,
  type AccountStatus,
  type AccountStorageStatus,
} from "../../lib/account";
import { t } from "../../lib/i18n";
import { InlineNotice } from "../ui/InlineNotice";

/** Above this share of the quota the card says so before it is too late. */
const ALMOST_FULL = 0.9;

/** In binary units, as the quota is set: a 5 GiB account reads "5.0 GB",
 * not "5.4 GB". */
function formatSize(bytes: number): string {
  const kib = 1024;
  if (bytes >= kib ** 3) return t("{n} GB", { n: (bytes / kib ** 3).toFixed(1) });
  if (bytes >= kib ** 2) return t("{n} MB", { n: Math.round(bytes / kib ** 2) });
  return t("{n} KB", { n: Math.max(1, Math.round(bytes / kib)) });
}

/**
 * The account's room (ADR-0110): how much of the quota is used and by what,
 * what waits for space, and the two choices a person has before it fills:
 * delete large files, or keep this device's new ones here.
 *
 * Read from the native side, which keeps it current on every pass; it is
 * read again whenever the account status around it changes.
 */
export function AccountStorageCard({ status }: { status: AccountStatus }) {
  const [storage, setStorage] = useState<AccountStorageStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    accountStorageStatus()
      .then(setStorage)
      .catch(() => setStorage(null));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the status around it changes
  useEffect(load, [load, status]);

  const setSending = async (kind: "audio" | "studio", enabled: boolean) => {
    setBusy(true);
    try {
      setStorage(await accountStorageSetSending(kind, enabled));
    } catch {
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!storage) return null;
  const { used_bytes: used, quota_bytes: quota } = storage;
  const full = storage.journal_held || storage.files_held;
  const almostFull = !full && used !== null && quota ? used >= quota * ALMOST_FULL : false;

  return (
    <div className="settings-card account-card">
      <h3 className="settings-row-title">{t("Account storage")}</h3>
      {used !== null && quota ? (
        <>
          <p className="settings-row-description">
            {t("{used} of {quota} used", { used: formatSize(used), quota: formatSize(quota) })}
          </p>
          <meter
            className="account-storage-meter"
            min={0}
            max={quota}
            low={quota * 0.75}
            high={quota * ALMOST_FULL}
            optimum={0}
            value={used}
            aria-label={t("Account storage")}
          />
        </>
      ) : null}
      <p className="settings-row-description">
        {t("Recordings {audio}, Studio {studio}, assistant files {assistant}", {
          audio: formatSize(storage.audio_bytes),
          studio: formatSize(storage.studio_bytes),
          assistant: formatSize(storage.assistant_bytes),
        })}
      </p>
      {full ? (
        <InlineNotice
          tone="destructive"
          body={t(
            "Your account storage is full. Your changes are safe on this device and will sync once space is freed.",
          )}
        />
      ) : almostFull ? (
        <InlineNotice
          body={t(
            "Your account storage is almost full. Delete large files you no longer need, or keep new ones on this device.",
          )}
        />
      ) : null}
      {storage.files_held && storage.waiting_files > 0 ? (
        <p className="settings-row-description">
          {t("Files waiting for space on this device: {count}", {
            count: storage.waiting_files,
          })}
        </p>
      ) : null}
      {storage.releasing_chunks > 0 ? (
        <p className="settings-row-description">{t("Freeing space from deleted files.")}</p>
      ) : null}
      {storage.compact_pending > 0 ? (
        <p className="settings-row-description">
          {storage.compact_ready
            ? t("Making files smaller to save space.")
            : t(
                "Files will take less space once every device runs the latest version: {devices}.",
                {
                  devices: storage.compact_blockers.join(", "),
                },
              )}
        </p>
      ) : null}
      {storage.largest.length ? (
        <div className="account-storage-largest">
          <p className="settings-row-description">{t("Largest files")}</p>
          <ul>
            {storage.largest.slice(0, 5).map((file) => (
              <li key={file.artifact_id}>
                <span>{file.label || t("Untitled file")}</span>
                <span>{formatSize(file.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <label className="account-consent">
        <input
          type="checkbox"
          checked={storage.send_audio}
          disabled={busy}
          onChange={(event) => void setSending("audio", event.target.checked)}
        />
        <span>{t("Send this device's recordings to the account")}</span>
      </label>
      <label className="account-consent">
        <input
          type="checkbox"
          checked={storage.send_studio}
          disabled={busy}
          onChange={(event) => void setSending("studio", event.target.checked)}
        />
        <span>{t("Send this device's Studio files to the account")}</span>
      </label>
      <p className="settings-row-description">
        {t("Unchecked, new files stay on this device. Files already in the account keep syncing.")}
      </p>
    </div>
  );
}
