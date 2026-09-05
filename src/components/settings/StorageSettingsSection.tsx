import { intlLocale, t } from "../../lib/i18n";
import { useCallback, useEffect, useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type PurgeRecordingsResultDto,
  type StorageReportDto,
  purgeTranscribedRecordings,
  storageReport,
} from "../../lib/tauri";

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

const RETENTION_CHOICES = [30, 90, 180, 365] as const;

/**
 * Settings › Storage: what the app keeps on disk, bucket by bucket, and the
 * one action that is safe to offer. Nothing here runs on its own: a person
 * reads the numbers, picks an age, sees what would go, and then says so.
 */
export function StorageSettingsSection() {
  const [report, setReport] = useState<StorageReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(90);
  const [preview, setPreview] = useState<PurgeRecordingsResultDto | null>(null);
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
    let cancelled = false;
    purgeTranscribedRecordings({ olderThanDays: days, dryRun: true })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const purge = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await purgeTranscribedRecordings({ olderThanDays: days });
      setOutcome(result);
      setPreview({ ...result, dryRun: true, recordings: 0, bytes: 0 });
      load();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
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
                {t("Remove the audio of notes transcribed more than")}
              </label>
              <p className="settings-row-description">
                {t("The note keeps its transcript and its text; only the recording file goes.")}
                {preview
                  ? preview.recordings === 0
                    ? ` ${t("Nothing matches right now.")}`
                    : ` ${preview.recordings === 1 ? t("1 recording") : t("{count} recordings", { count: preview.recordings })}, ${formatBytes(preview.bytes)}.`
                  : ""}
              </p>
            </div>
            <div className="settings-row-control storage-purge">
              <select
                id={selectId}
                className="mcp-tools-select"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {RETENTION_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t("{choice} days ago", { choice })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !preview || preview.recordings === 0}
                onClick={() => void purge()}
              >
                {busy ? t("Removing…") : t("Remove")}
              </button>
            </div>
          </div>
          {outcome && !outcome.dryRun ? (
            <p className="settings-row-description" role="status">
              {t("Removed {recordings} and freed {bytes}.", {
                recordings:
                  outcome.recordings === 1
                    ? t("1 recording")
                    : t("{count} recordings", { count: outcome.recordings }),
                bytes: formatBytes(outcome.bytes),
              })}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
