import { t } from "../../lib/i18n";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import type { ReactNode } from "react";
import type { MobileTab } from "../../app/mobile/nav";

type TabBarProps = {
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
  /** Tabs with work in flight (a reply being written, a render running):
   * they carry a small breathing dot so background work stays visible from
   * any tab. */
  busy?: Partial<Record<MobileTab, boolean>>;
};

const TABS: Array<{ id: MobileTab; label: string; icon: ReactNode }> = [
  { id: "notes", label: t("Notes"), icon: <IconNoteText size={22} /> },
  { id: "dictation", label: t("Dictation"), icon: <IconMicrophoneSparkle size={22} /> },
  { id: "agent", label: t("Chat"), icon: <IconBubble3 size={22} /> },
  { id: "studio", label: t("Studio"), icon: <IconCameraSparkle size={22} /> },
  { id: "settings", label: t("Settings"), icon: <IconSettingsGear4 size={22} /> },
];

export function TabBar({ active, onSelect, busy }: TabBarProps) {
  return (
    <nav className="mobile-tab-bar" aria-label={t("Main")}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="mobile-tab-bar-item"
          data-active={active === tab.id ? "true" : undefined}
          aria-current={active === tab.id ? "page" : undefined}
          aria-busy={busy?.[tab.id] || undefined}
          onClick={() => onSelect(tab.id)}
        >
          <span className="mobile-tab-bar-icon" aria-hidden>
            {tab.icon}
            {busy?.[tab.id] ? <span className="mobile-tab-bar-dot" /> : null}
          </span>
          <span className="mobile-tab-bar-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
