import { IconChainLink1 } from "central-icons/IconChainLink1";
import { useSyncExternalStore } from "react";
import type { ShareConversationTarget } from "../../lib/account";
import { t } from "../../lib/i18n";
import { useIsTemporaryChat } from "../../lib/temporary-chat";
import { ShareConversationDialog } from "../share/ShareNoteDialog";
import { useCanShare } from "../share/useCanShare";
import { isProvisionalHermesSessionId } from "./hero-content";

/**
 * "Share link" in the desktop chat menu (ADR-0053, addendum). The menu closes
 * when an item is chosen, so the dialog cannot live inside it: the item hands
 * its target to a small store and the host, mounted next to the menu, shows
 * the dialog for as long as it needs.
 */
let current: ShareConversationTarget | null = null;
const listeners = new Set<() => void>();

function setTarget(next: ShareConversationTarget | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ShareConversationMenuItem({
  id: sessionId,
  title,
  onDone,
}: {
  /** The Hermes session; nothing is shown without one. */
  id?: string;
  title?: string;
  /** Closes the menu: called with `false`, the shape of a menu's setter. */
  onDone: (open: false) => void;
}) {
  const canShare = useCanShare();
  // A temporary chat is never shared; Rust refuses it as well.
  const temporary = useIsTemporaryChat(sessionId);
  if (!sessionId || !canShare || temporary || isProvisionalHermesSessionId(sessionId)) {
    return null;
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onDone(false);
        setTarget({ sessionId, title });
      }}
    >
      <IconChainLink1 size={14} />
      {t("Share link")}
    </button>
  );
}

export function ConversationShareHost() {
  const target = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  if (!target) return null;
  return <ShareConversationDialog target={target} open={true} onClose={() => setTarget(null)} />;
}
