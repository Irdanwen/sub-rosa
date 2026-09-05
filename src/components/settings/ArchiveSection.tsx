import { t } from "../../lib/i18n";
import { useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { isMobilePlatform } from "../../lib/mobile";
import { type ImportSummaryDto, exportArchive, importArchive } from "../../lib/tauri";

/**
 * The archive (ADR-0042): everything you made here, in one file you can
 * carry to another machine or another phone, restored on purpose. Sealed with
 * a passphrase, it is the one copy of your notes that is safe to leave the
 * disk; in the clear, it is your notes.
 */
export function ArchiveSection() {
  const passphraseId = useId();
  const recordingsId = useId();
  const [passphrase, setPassphrase] = useState("");
  const [includeRecordings, setIncludeRecordings] = useState(false);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const mobile = isMobilePlatform();

  const runExport = async () => {
    setBusy("export");
    setError(null);
    setStatus(null);
    try {
      const result = await exportArchive({ includeRecordings, passphrase });
      setStatus(
        result.path
          ? result.sealed
            ? t("Sealed archive written to {path} ({size} KB).", {
                path: result.path,
                size: Math.max(1, Math.round(result.bytes / 1024)),
              })
            : t("Archive written to {path} ({size} KB).", {
                path: result.path,
                size: Math.max(1, Math.round(result.bytes / 1024)),
              })
          : t("Export cancelled."),
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    setStatus(null);
    try {
      const result = await importArchive({ passphrase });
      if (result.needsPassphrase) {
        setNeedsPassphrase(true);
        setStatus(t("That archive is sealed. Enter its passphrase, then import again."));
        return;
      }
      setNeedsPassphrase(false);
      setStatus(result.summary ? archiveImportStatus(result.summary) : t("Import cancelled."));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-group" aria-labelledby="archive-heading">
      <h2 id="archive-heading" className="settings-group-heading">
        {t("Archive")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Everything you made here, in one file: notes, transcripts, folders, memories, the bible, conversations. Carry it to another device and import it there. It is not a sync: nothing moves unless you move it.",
        )}
      </p>

      {error ? (
        <div className="settings-card">
          <p className="settings-row-description">{error}</p>
        </div>
      ) : null}

      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <label htmlFor={passphraseId} className="settings-row-title">
                {t("Passphrase")}
              </label>
              <p className="settings-row-description">
                {needsPassphrase
                  ? t("The archive you chose is sealed; its passphrase opens it.")
                  : t(
                      "Optional. With one, the archive is sealed (age) and is safe to carry anywhere. Without one, it is your notes in the clear.",
                    )}
              </p>
            </div>
            <div className="settings-row-control">
              <input
                id={passphraseId}
                type="password"
                className="mcp-add-input"
                autoComplete="off"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
          </div>
          {mobile ? null : (
            <div className="settings-row">
              <div className="settings-row-info">
                <label htmlFor={recordingsId} className="settings-row-title">
                  {t("Include the recordings")}
                </label>
                <p className="settings-row-description">
                  {t(
                    "The audio behind your notes. Large; a transcribed note keeps its words without it.",
                  )}
                </p>
              </div>
              <div className="settings-row-control">
                <input
                  id={recordingsId}
                  type="checkbox"
                  checked={includeRecordings}
                  onChange={(event) => setIncludeRecordings(event.target.checked)}
                />
              </div>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">
                {mobile ? t("Import an archive") : t("Export or import")}
              </h3>
              <p className="settings-row-description">
                {t(
                  "Importing adds what the archive holds and rewrites nothing you wrote since; importing the same archive twice changes nothing.",
                )}
              </p>
              {status ? (
                <p className="settings-row-description" role="status">
                  {status}
                </p>
              ) : null}
            </div>
            <div className="settings-row-control">
              {mobile ? null : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy !== null}
                  onClick={() => void runExport()}
                >
                  {busy === "export" ? t("Writing…") : t("Export")}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => void runImport()}
              >
                {busy === "import" ? t("Importing…") : t("Import")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function archiveImportStatus(summary: ImportSummaryDto) {
  const values = {
    notes: summary.notes,
    rows: summary.rows,
    version: summary.appVersion,
    recordings: summary.recordings,
  };
  if (summary.recordings === 0) {
    return summary.notes === 1
      ? t("Imported 1 note and {rows} rows from Sub Rosa {version}.", values)
      : t("Imported {notes} notes and {rows} rows from Sub Rosa {version}.", values);
  }
  if (summary.recordings === 1) {
    return summary.notes === 1
      ? t("Imported 1 note and {rows} rows from Sub Rosa {version}, with 1 recording.", values)
      : t(
          "Imported {notes} notes and {rows} rows from Sub Rosa {version}, with 1 recording.",
          values,
        );
  }
  return summary.notes === 1
    ? t(
        "Imported 1 note and {rows} rows from Sub Rosa {version}, with {recordings} recordings.",
        values,
      )
    : t(
        "Imported {notes} notes and {rows} rows from Sub Rosa {version}, with {recordings} recordings.",
        values,
      );
}
