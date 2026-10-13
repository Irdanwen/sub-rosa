import { intlLocale, t } from "../../lib/i18n";
import { useCallback, useEffect, useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type PurgeRecordingsResultDto,
  type StorageReportDto,
  purgeTranscribedRecordings,
  storageReport,
} from "../../lib/tauri";
import { recordingsRetention, setRecordingsRetention } from "../../lib/recording-retention";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/** Megabytes with one decimal below a gigabyte, gigabytes with one above. */
export function formatBytes(bytes: number) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB`;
  return `${bytes} B`;
}

/** `recording_retention::CHOICES`. */
const RETENTION_CHOICES = [7, 30, 90, 180, 365] as const;

function recordingsLabel(count: number) {
  return count === 1 ? t("1 recording") : t("{count} recordings", { count });
}

/**
 * Settings › Storage: what the app keeps on disk, bucket by bucket, and how
 * long recordings stay once their note is transcribed (ADR-0111). The age
 * is the person's choice, made once for every device and the account; a
 * choice that deletes recordings at once says how many and asks first.
 */
export function StorageSettingsSection() {
  const [report, setReport] = useState<StorageReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState<number | null | undefined>(undefined);
  const [pending, setPending] = useState<{
    days: number;
    preview: PurgeRecordingsResultDto;
  } | null>(null);
  const [outcome, setOutcome] = useState<PurgeRecordingsResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const selectId = useId();

  const load = useCallback(() => {
    storageReport()
      .then((next) => {
        setReport(next);
        setError(null);
      })
      .catch((err) => setError(messageFromError(err)));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    recordingsRetention()
      .then(setRetention)
      .catch(() => setRetention(null));
  }, []);

  const apply = async (days: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await setRecordingsRetention(days);
      setRetention(days);
      setOutcome(result.recordings > 0 ? result : null);
      load();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (value: string) => {
    const days = value === "never" ? null : Number(value);
    if (days === null) return apply(null);
    try {
      const preview = await purgeTranscribedRecordings({ olderThanDays: days, dryRun: true });
      if (preview.recordings === 0) return apply(days);
      setPending({ days, preview });
    } catch (err) {
      setError(messageFromError(err));
    }
  };

  return (
    <section className="settings-group" aria-labelledby="storage-heading">
      <h2 id="storage-heading" className="settings-group-heading">
        {t("Storage")}
      </h2>
      <p className="settings-group-description">
        {t(
          "What Sub Rosa keeps on this device. Nothing is deleted on its own; the one action below removes only audio whose note already has its transcript.",
        )}
      </p>

      {error ? (
        <div className="settings-card">
          <p className="settings-row-description">{error}</p>
        </div>
      ) : null}

      <div className="settings-card">
        <div className="settings-rows">
          {report ? (
            report.buckets.map((bucket) => (
              <div className="settings-row" key={bucket.id}>
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{bucket.label}</h3>
                  <p className="settings-row-description">{bucket.note}</p>
                </div>
                <div className="settings-row-control storage-size">
                  <span className="storage-size-bytes">{formatBytes(bucket.bytes)}</span>
                  <span className="storage-size-files">
                    {bucket.files === 1
                      ? t("1 file")
                      : t("{count} files", { count: bucket.files.toLocaleString(intlLocale()) })}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="settings-row">
              <div className="settings-row-info">
                <p className="settings-row-description">{t("Measuring…")}</p>
              </div>
            </div>
          )}
          {report ? (
            <div className="settings-row storage-total">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Total")}</h3>
              </div>
              <div className="settings-row-control storage-size">
                <span className="storage-size-bytes">{formatBytes(report.totalBytes)}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <label htmlFor={selectId} className="settings-row-title">
                {t("Delete recordings automatically")}
              </label>
              <p className="settings-row-description">
                {t(
                  "After the note is transcribed, on every device and in your account. The note keeps its transcript and its text.",
                )}
              </p>
            </div>
            <div className="settings-row-control storage-purge">
              <select
                id={selectId}
                className="mcp-tools-select"
                value={retention === undefined ? "" : (retention ?? "never")}
                disabled={busy || retention === undefined}
                onChange={(event) => void choose(event.target.value)}
              >
                <option value="never">{t("Never")}</option>
                {RETENTION_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t("{choice} days after transcription", { choice })}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {outcome ? (
            <p className="settings-row-description" role="status">
              {t("Removed {recordings} and freed {bytes}.", {
                recordings: recordingsLabel(outcome.recordings),
                bytes: formatBytes(outcome.bytes),
              })}
            </p>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => (pending ? apply(pending.days) : undefined)}
        title={t("Delete the recordings already older than this?")}
        description={
          pending
            ? t(
                "{recordings}, {bytes}, will be deleted on every device and in your account. Their notes keep their transcript. This cannot be undone.",
                {
                  recordings: recordingsLabel(pending.preview.recordings),
                  bytes: formatBytes(pending.preview.bytes),
                },
              )
            : undefined
        }
        confirmLabel={t("Delete")}
        cancelLabel={t("Cancel")}
        destructive
      />
    </section>
  );
}
