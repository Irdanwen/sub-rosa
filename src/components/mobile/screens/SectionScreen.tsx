import { type ReactNode, useEffect, useState } from "react";
import { diagnosticsReportText } from "../../../lib/diagnostics-report";
import { messageFromError } from "../../../lib/errors";
import { shareText } from "../../../lib/tauri";
import { APP_COMMIT_HASH, APP_VERSION } from "../../../app/build-info";
import { usePlatformCapabilities } from "../../../lib/platform-capabilities";
import { PrivacySettingsSection } from "../../settings/PrivacySettingsSection";
import { ArchiveSection } from "../../settings/ArchiveSection";
import { SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";

/**
 * A settings section on the phone: the stack header, then a desktop section
 * reused as it is. The desktop components render plain settings markup, and
 * mobile.css already styles that markup inside `mobile-screen-root`, so the
 * phone gets the same words and the same facts (the egress list, the archive)
 * without a second implementation to keep true.
 */
export function SectionScreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mobile-screen-root">
      <StackHeader title={title} onBack={onBack} backLabel="Settings" />
      <div className="mobile-scroll mobile-settings-section">{children}</div>
    </div>
  );
}

export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  return (
    <SectionScreen title="Privacy" onBack={onBack}>
      <PrivacySettingsSection />
    </SectionScreen>
  );
}

export function ArchiveScreen({ onBack }: { onBack: () => void }) {
  return (
    <SectionScreen title="Archive" onBack={onBack}>
      <ArchiveSection />
    </SectionScreen>
  );
}

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const caps = usePlatformCapabilities();
  return (
    <SectionScreen title="About" onBack={onBack}>
      <SettingsGroup title="Sub Rosa">
        <SettingsRow label="Version">
          <span className="mobile-settings-value">{APP_VERSION}</span>
        </SettingsRow>
        <SettingsRow label="Build">
          <span className="mobile-settings-value">{APP_COMMIT_HASH}</span>
        </SettingsRow>
        <SettingsRow label="Platform">
          <span className="mobile-settings-value">{caps?.platform ?? "…"}</span>
        </SettingsRow>
      </SettingsGroup>
      <p className="mobile-settings-footnote">
        Your notes, transcripts and memories stay on this phone. Requests go to the Carpe Diem
        endpoint you configured, and nowhere else.
      </p>
    </SectionScreen>
  );
}

/**
 * The diagnostics report, readable before it is shared: what the desktop
 * writes to a folder, the phone hands to the share sheet as text.
 */
export function ReportsScreen({ onBack }: { onBack: () => void }) {
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    diagnosticsReportText()
      .then(setReport)
      .catch((err) => setError(messageFromError(err)));
  }, []);
  return (
    <SectionScreen title="Reports" onBack={onBack}>
      <SettingsGroup title="Diagnostics">
        <p className="mobile-settings-note">
          Versions, platform, storage and the local backend's state. No note, no transcript, no key.
          Read it, then share it with whoever is helping you.
        </p>
        {error ? <p className="mobile-settings-error">{error}</p> : null}
        {report ? (
          <>
            <pre className="mobile-report">{report}</pre>
            <button
              type="button"
              className="mobile-settings-button"
              onClick={() => void shareText(report)}
            >
              Share report
            </button>
          </>
        ) : (
          <p className="mobile-settings-note">Gathering the report…</p>
        )}
      </SettingsGroup>
    </SectionScreen>
  );
}
