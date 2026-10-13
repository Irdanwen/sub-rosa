// Every settings tab, once: the groups the settings sidebar shows, the flat
// list the settings page renders (SETTINGS_TABS), and what the command
// palette indexes. Before this module the list existed twice, in the sidebar
// and in AppSettings, and a test kept the two in step.
//
// Four groups a person reads, and a fifth, Advanced, that is folded by
// default and opens by itself when one of its tabs is active or a search
// matches it. Folded is not hidden: the header stays, the palette finds every
// tab, and a filter shows them all (the lesson of the tabs hidden "while they
// stabilised" in 2026, which stayed out of sight for two months).

import { IconArchive1 } from "central-icons/IconArchive1";
import { IconAudio } from "central-icons/IconAudio";
import { IconBookmark } from "central-icons/IconBookmark";
import { IconBox2 } from "central-icons/IconBox2";
import { IconBrain2 } from "central-icons/IconBrain2";
import { IconBug } from "central-icons/IconBug";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCirclesThree } from "central-icons/IconCirclesThree";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import { IconFolderShared } from "central-icons/IconFolderShared";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconKey1 } from "central-icons/IconKey1";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { IconPeopleSparkles } from "central-icons/IconPeopleSparkles";
import { IconPlugin2 } from "central-icons/IconPlugin2";
import { IconPuzzle } from "central-icons/IconPuzzle";
import { IconRobot2 } from "central-icons/IconRobot2";
import { IconServer1 } from "central-icons/IconServer1";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconShield } from "central-icons/IconShield";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShortcut } from "central-icons/IconShortcut";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconUser } from "central-icons/IconUser";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import type { SettingsTab } from "./AppSettings";

export type SettingsGroup = {
  id: "you" | "voice" | "assistant" | "advanced" | "app";
  title: string;
  /** Folded until a tab in it is active, or a search matches it. */
  folded?: boolean;
  items: { id: SettingsTab; label: string; icon: ReactNode }[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "you",
    title: t("You"),
    items: [
      { id: "general", label: t("General"), icon: <IconSettingsGear4 size={16} /> },
      { id: "account", label: t("Account and sync"), icon: <IconUser size={16} /> },
      { id: "carpe-diem", label: t("Carpe Diem"), icon: <IconKey1 size={16} /> },
      { id: "privacy", label: t("Privacy"), icon: <IconShieldCheck size={16} /> },
      { id: "shortcuts", label: t("Shortcuts"), icon: <IconShortcut size={16} /> },
    ],
  },
  {
    id: "voice",
    title: t("Voice and audio"),
    items: [
      { id: "dictation", label: t("Dictation"), icon: <IconMicrophoneSparkle size={16} /> },
      { id: "audio", label: t("Audio"), icon: <IconAudio size={16} /> },
    ],
  },
  {
    id: "assistant",
    title: t("Assistant"),
    items: [
      { id: "models", label: t("Models"), icon: <IconBrain2 size={16} /> },
      { id: "agent", label: t("Agent"), icon: <IconRobot2 size={16} /> },
      {
        id: "personalization",
        label: t("Personalization"),
        icon: <IconPeopleSparkles size={16} />,
      },
      { id: "memory", label: t("Memory"), icon: <IconBookmark size={16} /> },
      { id: "council", label: t("Council"), icon: <IconCirclesThree size={16} /> },
      { id: "skills", label: t("Installed skills"), icon: <IconPlugin2 size={16} /> },
      { id: "connectors", label: t("Connectors"), icon: <IconConnectors1 size={16} /> },
      { id: "browser-extension", label: t("Browser extension"), icon: <IconPuzzle size={16} /> },
    ],
  },
  {
    id: "advanced",
    title: t("Advanced"),
    folded: true,
    items: [
      { id: "mcp", label: t("MCP servers"), icon: <IconServer1 size={16} /> },
      { id: "mcp-diagnostics", label: t("MCP diagnostics"), icon: <IconHeartBeat size={16} /> },
      { id: "mcp-security", label: t("MCP security"), icon: <IconShield size={16} /> },
      {
        id: "external-dirs",
        label: t("External skill directories"),
        icon: <IconFolderShared size={16} />,
      },
      { id: "toolsets", label: t("Toolsets"), icon: <IconToolbox size={16} /> },
      { id: "import-export", label: t("Import / export"), icon: <IconBox2 size={16} /> },
    ],
  },
  {
    id: "app",
    title: t("App"),
    items: [
      { id: "storage", label: t("Storage"), icon: <IconArchive1 size={16} /> },
      { id: "reports", label: t("Reports"), icon: <IconBug size={16} /> },
      { id: "about", label: t("About"), icon: <IconCircleInfo size={16} /> },
    ],
  },
];

/** What the settings page can render, in the order the sidebar lists it. */
export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = SETTINGS_GROUPS.flatMap(
  (group) => group.items.map(({ id, label }) => ({ id, label })),
);
