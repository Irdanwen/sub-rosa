import { t } from "../../lib/i18n";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useEffect, useState } from "react";
import {
  type AgentBrowserSettings,
  type AgentBrowserSettingsResponse,
  agentBrowserSettings,
  saveAgentBrowserSettings,
} from "../../lib/agent-browser";
import { messageFromError } from "../../lib/errors";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import "../../styles/agent-browser.css";

/**
 * Settings › Agent: the agent browser (ADR-0094). Whether the agent may use
 * one, which installed browser, and the sites it may use without asking.
 */
export function AgentBrowserSettingsSection() {
  const [state, setState] = useState<AgentBrowserSettingsResponse | null>(null);
  const [draftSite, setDraftSite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.resolve()
      .then(() => agentBrowserSettings())
      .then((next) => {
        if (next?.settings) setState(next);
      })
      .catch((err) => setError(messageFromError(err)));
  }, []);

  if (!state) {
    return error ? <p className="settings-row-description">{error}</p> : null;
  }

  const settings = state.settings;
  async function save(next: AgentBrowserSettings) {
    setSaving(true);
    setError(null);
    try {
      setState(await saveAgentBrowserSettings(next));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  function addSite() {
    const site = draftSite.trim();
    if (!site) return;
    setDraftSite("");
    void save({ ...settings, allowedSites: [...settings.allowedSites, site] });
  }

  const noBrowser = state.browsers.length === 0;

  return (
    <section className="settings-group" aria-labelledby="agent-browser-heading">
      <h2 id="agent-browser-heading" className="settings-group-heading">
        {t("Agent browser")}
      </h2>
      <p className="settings-group-description">
        {t(
          "The agent can use websites for you in a browser window you can watch, in a profile of its own: none of your cookies or saved passwords. It asks before each new site, and never types passwords or card numbers.",
        )}
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-text">
              <h3 className="settings-row-title" id="agent-browser-enabled">
                {t("Let the agent use a browser")}
              </h3>
              <p className="settings-row-description">
                {noBrowser
                  ? t("No Chrome, Edge, Brave or Chromium was found on this computer.")
                  : t("Turning it off closes the browser if it is open.")}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={settings.enabled}
                disabled={saving}
                onCheckedChange={(enabled) => void save({ ...settings, enabled })}
                aria-labelledby="agent-browser-enabled"
              />
            </div>
          </div>
          {state.browsers.length > 1 ? (
            <div className="settings-row">
              <div className="settings-row-text">
                <h3 className="settings-row-title">{t("Browser")}</h3>
              </div>
              <div className="settings-row-control">
                <Select
                  value={settings.browser ?? state.browsers[0]?.id ?? null}
                  options={state.browsers.map((browser) => ({
                    value: browser.id,
                    label: browser.name,
                  }))}
                  placeholder={t("Choose a browser")}
                  ariaLabel={t("Browser")}
                  disabled={saving}
                  onChange={(browser) => void save({ ...settings, browser })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="settings-card">
        <h3 className="settings-row-title">{t("Sites allowed without asking")}</h3>
        <p className="settings-row-description">
          {t("Added when you answer Always allow. Remove a site to be asked again.")}
        </p>
        {settings.allowedSites.length === 0 ? (
          <p className="settings-empty">{t("No site yet.")}</p>
        ) : (
          <ul className="agent-browser-sites">
            {settings.allowedSites.map((site) => (
              <li key={site} className="agent-browser-site">
                <code>{site}</code>
                <button
                  type="button"
                  className="agent-browser-site-remove"
                  aria-label={t("Remove {site}", { site })}
                  disabled={saving}
                  onClick={() =>
                    void save({
                      ...settings,
                      allowedSites: settings.allowedSites.filter((entry) => entry !== site),
                    })
                  }
                >
                  <IconCrossSmall size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="agent-browser-site-add"
          onSubmit={(event) => {
            event.preventDefault();
            addSite();
          }}
        >
          <input
            type="text"
            value={draftSite}
            placeholder={t("example.com")}
            aria-label={t("Add a site")}
            onChange={(event) => setDraftSite(event.currentTarget.value)}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={saving || !draftSite.trim()}
          >
            {t("Add")}
          </button>
        </form>
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
