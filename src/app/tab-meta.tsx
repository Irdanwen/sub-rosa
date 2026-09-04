import { t } from "../lib/i18n";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconProjects } from "central-icons/IconProjects";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { IconZap } from "central-icons/IconZap";
import type { ReactNode } from "react";
import type { TabItem } from "../components/tabs/TabBar";
import type { FolderDto, HermesSessionInfo, NoteListItemDto } from "../lib/tauri";
import type { TabNav } from "./tabs/tabs";

/**
 * What a tab says about the view it holds: its title, its icon, and whether
 * the work behind it is running or waiting on the person. Pure, so the shell
 * can call it for every open tab on every render without thinking about it.
 */

const TAB_ICON_SIZE = 14;

export function agentSessionTabTitle(session?: HermesSessionInfo): string | undefined {
  return session?.title?.trim() || session?.preview?.trim() || undefined;
}

export function tabMeta(
  nav: TabNav,
  notes: NoteListItemDto[],
  folders: FolderDto[],
  sessions: HermesSessionInfo[],
  activity: {
    workingSessionIds: ReadonlySet<string>;
    waitingSessionIds: ReadonlySet<string>;
  },
): { title: string; icon: ReactNode; status?: TabItem["status"] } {
  switch (nav.view) {
    case "meetings": {
      const note = nav.noteId ? notes.find((n) => n.id === nav.noteId) : undefined;
      const processing =
        note?.processingStatus === "validating" ||
        note?.processingStatus === "transcribing" ||
        note?.processingStatus === "generating";
      return {
        title: note?.title?.trim() || "New note",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
        status: processing ? "working" : undefined,
      };
    }
    case "folders": {
      const folder = nav.folderId ? folders.find((f) => f.id === nav.folderId) : undefined;
      return {
        title: folder?.name?.trim() || "Projects",
        icon: <IconProjects size={TAB_ICON_SIZE} />,
      };
    }
    case "agent": {
      const session = nav.agentSessionId
        ? sessions.find((s) => s.id === nav.agentSessionId)
        : undefined;
      const sessionId = nav.agentSessionId;
      return {
        title: agentSessionTabTitle(session) || nav.agentSessionTitle?.trim() || "New session",
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
        status: !sessionId
          ? undefined
          : activity.waitingSessionIds.has(sessionId)
            ? "waitingForUser"
            : activity.workingSessionIds.has(sessionId)
              ? "working"
              : undefined,
      };
    }
    case "agent-sessions":
      return {
        title: t("Sessions"),
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
      };
    case "all-notes":
      return {
        title: t("All notes"),
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
    case "routines":
      return {
        title: t("Routines"),
        icon: <IconZap size={TAB_ICON_SIZE} />,
      };
    case "studio":
      return {
        title: t("Studio"),
        icon: <IconSparkle3 size={TAB_ICON_SIZE} />,
      };
    case "dictation":
      return {
        title: t("Dictation"),
        icon: <IconMicrophone size={TAB_ICON_SIZE} />,
      };
    case "settings":
      return {
        title: t("Settings"),
        icon: <IconSettingsGear4 size={TAB_ICON_SIZE} />,
      };
    case "notes":
    default:
      return {
        title: t("Notes"),
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
  }
}
