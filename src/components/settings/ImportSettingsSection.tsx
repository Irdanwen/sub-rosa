import { t } from "../../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type ExtractorStatus,
  ingestExtractorStatus,
  ingestSetExtractorEnabled,
} from "../../lib/tauri";
import { Switch } from "../ui/Switch";

/**
 * The extractor rail (ADR-0028).
 *
 * The app ships no downloader and reimplements none, so this switch installs
 * nothing: it says whether Sub Rosa may use a `yt-dlp` the user already has.
 * Off until they say otherwise, and honest about what is missing when it is.
 */
export function ImportSettingsSection() {
  const [status, setStatus] = useState<ExtractorStatus | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void ingestExtractorStatus()
      .then(setStatus)
      .catch((err) => setError(messageFromError(err)));
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await ingestSetExtractorEnabled(enabled));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="settings-group" aria-labelledby="importing-heading">
      <h2 id="importing-heading" className="settings-group-heading">
        {t("Importing from a link")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Podcast feeds, podcast episodes and direct audio or video links are fetched with no extra software. A streaming platform page is different: its media address is not published, and reaching it needs an extractor.",
        )}
      </p>

      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Use yt-dlp for streaming platform pages")}</h3>
              <p className="settings-row-description">
                {status?.available
                  ? status.version
                    ? t(
                        "Found at {path}, version {version}. Sub Rosa never installs or updates it.",
                        { path: status.path ?? t("Unknown path"), version: status.version },
                      )
                    : t("Found at {path}. Sub Rosa never installs or updates it.", {
                        path: status.path ?? t("Unknown path"),
                      })
                  : t(
                      "Not found on this machine. Sub Rosa never installs it, so this stays off until you have it.",
                    )}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={status?.enabled === true}
                disabled={status === null || busy}
                onCheckedChange={(enabled) => void toggle(enabled)}
                aria-label={t("Use yt-dlp for streaming platform pages")}
              />
            </div>
          </div>

          {status?.enabled ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">
                  {status.available ? t("Captions first") : t("Nothing to use yet")}
                </h3>
                <p className="settings-row-description">
                  {status.available
                    ? t(
                        "When a page publishes captions they are read instead of transcribing the audio: no transcription cost, and the chapters keep their timings.",
                      )
                    : t(
                        "The switch is on but yt-dlp is not installed, so platform links are still refused.",
                      )}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <p className="settings-row-error">{error}</p> : null}
    </section>
  );
}
