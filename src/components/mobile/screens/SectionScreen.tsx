import type { ReactNode } from "react";
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
