import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { AssistantsPanelView } from "../assistants/AssistantsDialog";
import { PortableConversations } from "./PortableConversations";
import { useSidePanelResize } from "./side-panel";

export type AgentAssistantsTab = "assistants" | "devices";

/**
 * The chat's right-hand panel for your assistants, beside the conversation:
 * the library and a conversation with one assistant under "Assistants", the
 * conversations synced from your other devices under "Your devices".
 *
 * It takes the same slot as the Files panel (one at a time), its width, its
 * resize handle and its card. It is not modal: the conversation behind it
 * keeps the keyboard, and Escape closes it from the workspace.
 */
export function AgentAssistantsPanel({
  tab,
  initialTaskId,
  onTab,
  onContinue,
  onClose,
}: {
  tab: AgentAssistantsTab;
  initialTaskId?: string;
  onTab: (tab: AgentAssistantsTab) => void;
  onContinue: (taskId: string, newMessage: string) => Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const startResize = useSidePanelResize(panelRef);
  // Same once-per-mount entrance as the Files panel (see its note in app.css).
  const [entered, setEntered] = useState(false);
  const [visited, setVisited] = useState<Record<AgentAssistantsTab, boolean>>({
    assistants: tab === "assistants",
    devices: tab === "devices",
  });
  if (!visited[tab]) setVisited((previous) => ({ ...previous, [tab]: true }));
  const tabs: { id: AgentAssistantsTab; label: string }[] = [
    { id: "assistants", label: t("Assistants") },
    { id: "devices", label: t("Your devices") },
  ];
  return (
    <>
      <div
        className="agent-files-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize assistants panel")}
        onPointerDown={startResize}
      />
      <aside
        ref={panelRef}
        className="agent-artifact-panel agent-assistants-panel"
        aria-label={t("My assistants")}
        data-entered={entered ? "true" : undefined}
        onAnimationEnd={(event) => {
          if (event.animationName === "agent-artifact-panel-in") setEntered(true);
        }}
      >
        <header className="agent-artifact-panel-bar agent-assistants-panel-bar">
          <div className="agent-assistants-tabs" role="tablist" aria-label={t("My assistants")}>
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`agent-assistants-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls="agent-assistants-tabpanel"
                onClick={() => onTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Close assistants panel")}
            title={t("Close")}
            onClick={onClose}
          >
            <IconCrossMedium size={16} />
          </button>
        </header>
        <div
          className="agent-assistants-panel-body"
          role="tabpanel"
          id="agent-assistants-tabpanel"
          aria-labelledby={`agent-assistants-tab-${tab}`}
        >
          {/* A tab once shown stays mounted while hidden, so looking at your
              devices does not drop the conversation you had open. */}
          {visited.assistants ? (
            <div className="agent-assistants-pane" hidden={tab !== "assistants"}>
              <AssistantsPanelView initialTaskId={initialTaskId} />
            </div>
          ) : null}
          {visited.devices ? (
            <div className="agent-assistants-devices" hidden={tab !== "devices"}>
              <PortableConversations onContinue={onContinue} />
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
