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

  useEffect(() => {
    void (async () => {
      try {
        const [declared, settings] = await Promise.all([declaredEgress(), carpeDiemGetSettings()]);
        setHosts(declared);
        setBaseUrl(settings.baseUrl);
      } catch {
        setError("Could not read the list of destinations. Restart the app and try again.");
      }
    })();
  }, []);

  const always = hosts.filter((host) => host.reach === "always");
  const whenAsked = hosts.filter((host) => host.reach === "whenAsked");

  return (
    <section className="settings-group" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading" className="settings-group-heading">
        What leaves, what stays
      </h2>
      <p className="settings-group-description">
        Every address this app can reach, and why. Anything not on this list is not something the
        app can contact: the list is checked against the code when the app is built.
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
          <h3 className="settings-row-title">Your notes stay here</h3>
          <p className="settings-row-description">
            Recordings, transcripts, notes, and what the app remembers about you are stored on this
            machine and are never uploaded. Your key is held in the system keychain, and the app
            never shows it to the screen or writes it to a log.
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <IconGlobe size={15} ariaHidden />
          <h3 className="settings-row-title">Contacted while the app runs</h3>
        </div>
        <ul className="privacy-hosts">
          {always.map((host) => (
            <li key={host.host} className="privacy-host">
              <code className="privacy-host-name">{host.host}</code>
              <span className="privacy-host-reason">
                {host.host === "carpe-diem.xyz" && baseUrl && !baseUrl.includes("carpe-diem.xyz")
                  ? `You have pointed this at ${hostOf(baseUrl) ?? baseUrl} instead. Your requests go there.`
                  : host.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <IconShieldCheck size={15} ariaHidden />
          <h3 className="settings-row-title">Contacted only when you ask</h3>
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
        The full reasoning, including what this app deliberately does not protect against, is in the
        threat model.{" "}
        <button
          type="button"
          className="privacy-link"
          onClick={() =>
            void openExternalUrl(
              "https://github.com/Irdanwen/sub-rosa/blob/main/docs/threat-model.md",
            )
          }
        >
          Read the threat model
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
