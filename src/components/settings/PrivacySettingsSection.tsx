import { accountStatus, type AccountStatus } from "../../lib/account";
import { t } from "../../lib/i18n";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconLock } from "central-icons/IconLock";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { useEffect, useState } from "react";
import { EgressLedgerCard } from "./EgressLedgerCard";
import { SemanticAskCard } from "./SemanticAskCard";
import {
  type EgressHost,
  carpeDiemGetSettings,
  declaredEgress,
  openExternalUrl,
} from "../../lib/tauri";

/**
 * What leaves this machine, and what does not.
 *
 * The list is not written here. It comes from `declared_egress`, which reads
 * the same constant `src-tauri/tests/egress.rs` holds the source to — so a
 * destination the build would refuse is also one this screen could not show,
 * and a destination added to the code without being added to the list fails CI
 * before anyone reads this page. That is the whole reason the screen is worth
 * having: a hand-written reassurance would be worth nothing.
 */
export function PrivacySettingsSection() {
  const [hosts, setHosts] = useState<EgressHost[]>([]);
  const [baseUrl, setBaseUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [account, setAccount] = useState<AccountStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void accountStatus()
      .then((next) => {
        if (!cancelled) setAccount(next ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [declared, settings] = await Promise.all([declaredEgress(), carpeDiemGetSettings()]);
        setHosts(declared);
        setBaseUrl(settings.baseUrl);
      } catch {
        setError(t("Could not read the list of destinations. Restart the app and try again."));
      }
    })();
  }, []);

  const always = hosts.filter((host) => host.reach === "always");
  const whenAsked = hosts.filter((host) => host.reach === "whenAsked");

  return (
    <section className="settings-group" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading" className="settings-group-heading">
        {t("What leaves, what stays")}
      </h2>
      <p className="settings-group-description">
        {t(
          "The built-in destinations are checked against the app’s code. Your configured Carpe Diem and account service addresses are shown here too.",
        )}
      </p>

      {error ? (
        <div className="settings-card">
          <p className="settings-row-description">{error}</p>
        </div>
      ) : null}

      <EgressLedgerCard />

      <SemanticAskCard />

      <div className="settings-card privacy-stays">
        <div className="privacy-stays-icon" aria-hidden>
          <IconLock size={18} />
        </div>
        <div>
          <h3 className="settings-row-title">{t("Your local library and encrypted copies")}</h3>
          <p className="settings-row-description">
            {t(
              "Your library is stored on this device. AI requests send the content needed for the task to your configured provider. If you enable account sync, supported data is encrypted before upload. Your Carpe Diem key is kept in the system keychain and shared only when you choose to use your encrypted vault.",
            )}
          </p>
        </div>
      </div>

      {account?.server_url ? (
        <div className="settings-card">
          <div className="settings-card-header">
            <IconShieldCheck size={15} ariaHidden />
            <h3 className="settings-row-title">{t("Your account service")}</h3>
          </div>
          <ul className="privacy-hosts">
            <li className="privacy-host">
              <code className="privacy-host-name">
                {hostOf(account.server_url) ?? account.server_url}
              </code>
              <span className="privacy-host-reason">
                {account.sync_enabled
                  ? t(
                      "Encrypted sync is enabled. Your account service receives encrypted data, device and sign-in information, and transport metadata such as dates and sizes.",
                    )
                  : t(
                      "Used when you sign in, manage devices, or share your encrypted key. Automatic content sync is currently paused.",
                    )}
              </span>
            </li>
          </ul>
          <p className="settings-row-description">
            {t(
              "The account service cannot decrypt your vault. It can see your account identity and transport metadata. A device or an unlocked browser can read data you authorize it to access.",
            )}
          </p>
        </div>
      ) : null}

      <div className="settings-card">
        <div className="settings-card-header">
          <IconGlobe size={15} ariaHidden />
          <h3 className="settings-row-title">{t("Contacted while the app runs")}</h3>
        </div>
        <ul className="privacy-hosts">
          {always.map((host) => (
            <li key={host.host} className="privacy-host">
              <code className="privacy-host-name">{host.host}</code>
              <span className="privacy-host-reason">
                {host.host === "carpe-diem.xyz" && baseUrl && !baseUrl.includes("carpe-diem.xyz")
                  ? t("You have pointed this at {value} instead. Your requests go there.", {
                      value: hostOf(baseUrl) ?? baseUrl,
                    })
                  : host.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <IconShieldCheck size={15} ariaHidden />
          <h3 className="settings-row-title">{t("Contacted only when you ask")}</h3>
        </div>
        <ul className="privacy-hosts">
          {whenAsked.map((host) => (
            <li key={host.host} className="privacy-host">
              <code className="privacy-host-name">{host.host}</code>
              <span className="privacy-host-reason">{host.reason}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="settings-group-description">
        {t(
          "The full reasoning, including what this app deliberately does not protect against, is in the threat model.",
        )}{" "}
        <button
          type="button"
          className="privacy-link"
          onClick={() =>
            void openExternalUrl(
              "https://github.com/Irdanwen/sub-rosa/blob/main/docs/threat-model.md",
            )
          }
        >
          {t("Read the threat model")}
        </button>
      </p>
    </section>
  );
}

/** The host part of a URL, for showing a configured base without its path. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
