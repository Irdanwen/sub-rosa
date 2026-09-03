import { useCallback, useEffect, useId, useState } from "react";
import {
  issueReportsClearGithubToken,
  issueReportsGetSettings,
  issueReportsImportCliToken,
  type IssueReportSettingsDto,
  issueReportsSetGithubToken,
  issueReportsTestToken,
  openExternalUrl,
  exportDiagnostics,
} from "../../lib/tauri";
import { isMobilePlatform } from "../../lib/mobile";

/**
 * Where a report goes when you send one.
 *
 * The point of this surface is that the answer is never a mystery: it names
 * the tracker, says which of the two paths a report will take right now, and
 * lets you switch between them by adding or removing one token. Mirrors the
 * Carpe Diem key row - keychain storage, only presence crosses IPC.
 */
export function ReportsSettingsSection() {
  const tokenInputId = useId();
  const [settings, setSettings] = useState<IssueReportSettingsDto | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // A report used to be able to name a log and never carry one. The bundle
  // is a dated folder the user chooses in the native dialog, with every
  // secret-shaped token stripped before it is written (diagnostics::redact).
  const exportBundle = async () => {
    setExporting(true);
    setDiagnostics(null);
    try {
      const result = await exportDiagnostics();
      setDiagnostics(
        result.path
          ? `Written to ${result.path} (${result.files} files). Attach the folder's files to your report.`
          : "Export cancelled.",
      );
    } catch (err) {
      setDiagnostics(err instanceof Error ? err.message : "The diagnostics could not be written.");
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(() => {
    issueReportsGetSettings()
      .then(setSettings)
      .catch(() => setError("The report settings could not be read."));
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setError(null);
    setStatus(null);
    try {
      setSettings(await issueReportsSetGithubToken(draft.trim()));
      setDraft("");
      setStatus("Token saved. Reports will now be filed from the app.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That token could not be saved.");
    }
  };

  const remove = async () => {
    setError(null);
    setStatus(null);
    try {
      setSettings(await issueReportsClearGithubToken());
      setStatus("Token removed. Reports will open a pre-filled issue in your browser.");
    } catch {
      setError("The token could not be removed.");
    }
  };

  const importFromCli = async () => {
    setError(null);
    setStatus(null);
    try {
      setSettings(await issueReportsImportCliToken());
      setStatus("Token taken from the GitHub CLI. Reports will now be filed from the app.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The GitHub CLI token could not be read.");
    }
  };

  const test = async () => {
    setError(null);
    setStatus(null);
    setTesting(true);
    try {
      const result = await issueReportsTestToken();
      if (result.ok) setStatus(result.message);
      else setError(result.message);
    } catch {
      setError("GitHub could not be reached.");
    } finally {
      setTesting(false);
    }
  };

  const hasToken = settings?.hasToken ?? false;
  const canSave = draft.trim().length > 0;

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Where your reports go</h3>
            <p className="settings-row-description">
              Reports you send from the assistant become issues on {settings?.repo ?? "the tracker"}
              .{" "}
              {hasToken
                ? "With your token saved, the app files them for you and gives you the link."
                : "Without a token, sending one opens GitHub's new issue form with everything filled in, and you press Submit under your own account."}
            </p>
            {status ? (
              <p className="settings-row-substatus" role="status">
                {status}
              </p>
            ) : null}
            {error ? (
              <p className="settings-row-substatus" role="status">
                {error}
              </p>
            ) : null}
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!settings}
              onClick={() => {
                if (settings) void openExternalUrl(settings.repoUrl).catch(() => {});
              }}
            >
              Open tracker
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">GitHub token</h3>
            <p className="settings-row-description">
              Optional. A token with permission to open issues lets the app file the report in the
              background instead of sending you to the browser. It stays in your keychain and is
              only ever sent to GitHub. If you already use the GitHub CLI, take its token instead of
              making a new one. Screenshots are named in the issue, never uploaded: GitHub's API
              cannot attach a file.
            </p>
          </div>
          <div className="settings-row-control settings-secret-control">
            <input
              id={tokenInputId}
              className="settings-secret-input"
              type="password"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder={hasToken ? "Saved token hidden" : "ghp_…"}
              aria-label="GitHub token"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSave) void save();
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canSave}
              onClick={() => void save()}
            >
              Save
            </button>
            {!hasToken && settings?.hasCliToken ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void importFromCli()}
              >
                Use GitHub CLI token
              </button>
            ) : null}
            {hasToken ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={testing}
                  onClick={() => void test()}
                >
                  {testing ? "Checking…" : "Check"}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void remove()}>
                  Remove
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      {isMobilePlatform() ? null : (
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Diagnostics</h3>
              <p className="settings-row-description">
                Write a folder with the backend and dictation logs, the version, the state of the
                local engine, the hosts this build can reach and what it keeps on disk. Keys and
                tokens are removed before anything is written.
              </p>
              {diagnostics ? (
                <p className="settings-row-description" role="status">
                  {diagnostics}
                </p>
              ) : null}
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={exporting}
                onClick={() => void exportBundle()}
              >
                {exporting ? "Writing…" : "Export diagnostics"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
