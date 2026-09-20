import { t } from "../../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type ExtractorStatus,
  ingestExtractorStatus,
  ingestSetExtractorEnabled,
} from "../../lib/tauri";
import { errandSetEnabled, errandSettings } from "../../lib/errands";
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
  const [errands, setErrands] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void ingestExtractorStatus()
      .then(setStatus)
      .catch((err) => setError(messageFromError(err)));
    void errandSettings()
      .then((value) => setErrands(value.enabled))
      .catch(() => setErrands(false));
  }, []);

  const toggleErrands = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setErrands((await errandSetEnabled(enabled)).enabled);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
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

          {/* The machine that runs an errand is the machine that pays for it,
              so the decision belongs here and starts as no (ADR-0054). */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Run links sent from your other devices")}</h3>
              <p className="settings-row-description">
                {t(
                  "Your phone can hand a link to this computer when it cannot read it itself. The link arrives encrypted, this machine fetches it, and the note comes back through your account. It uses this machine's credits, which is why it is off until you say otherwise.",
                )}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={errands === true}
                disabled={errands === null || busy}
                onCheckedChange={(enabled) => void toggleErrands(enabled)}
                aria-label={t("Run links sent from your other devices")}
              />
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="settings-row-error">{error}</p> : null}
    </section>
  );
}
