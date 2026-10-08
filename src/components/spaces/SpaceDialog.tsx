import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type Space,
  onSpacesUpdated,
  spacesDelete,
  spacesGet,
  spacesLeave,
  spacesMarkRead,
  spacesSync,
} from "../../lib/spaces";
import { Dialog } from "../ui/Dialog";
import { spaceStateLine } from "./SharedProjectsCard";
import { SpaceChat } from "./SpaceChat";
import { SpaceContent } from "./SpaceContent";
import { SpaceMembers } from "./SpaceMembers";

type Tab = "chat" | "content" | "members";

/**
 * One shared project: its group chats, its content (instructions, notes,
 * files) and its members. The same surface on both shells.
 */
export function SpaceDialog({
  spaceId,
  onClose,
  onChanged,
}: {
  spaceId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [space, setSpace] = useState<Space | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setSpace(await spacesGet(spaceId));
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }, [spaceId]);
  useEffect(() => {
    void load();
    void spacesMarkRead(spaceId).catch(() => undefined);
    void spacesSync(spaceId).catch(() => undefined);
    let stop: (() => void) | undefined;
    void onSpacesUpdated((ids) => {
      if (ids.length === 0 || ids.includes(spaceId)) {
        void load();
        void spacesMarkRead(spaceId).catch(() => undefined);
      }
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [spaceId, load]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged?.();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  const active = space?.summary.state === "active";
  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: t("Chats") },
    { id: "content", label: t("Content") },
    { id: "members", label: t("Members") },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      className="spaces-dialog"
      title={space?.summary.name || t("Shared project")}
      description={space ? (spaceStateLine(space.summary) ?? undefined) : undefined}
      footer={
        space && active ? (
          confirming ? (
            <>
              <span className="spaces-confirm">
                {space.isOwner
                  ? t(
                      "Delete this shared project for every member? Copies they already received stay on their devices.",
                    )
                  : t("Leave this shared project? What you already received stays on this device.")}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(false)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (space.isOwner) {
                      await spacesDelete(space.summary.id);
                      onClose();
                    } else {
                      await spacesLeave(space.summary.id);
                    }
                    setConfirming(false);
                  })
                }
              >
                {space.isOwner ? t("Delete") : t("Leave")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
              {space.isOwner ? t("Delete shared project") : t("Leave shared project")}
            </button>
          )
        ) : undefined
      }
    >
      {error ? (
        <p role="alert" className="dialog-description">
          {error}
        </p>
      ) : null}
      {space ? (
        <>
          <div className="spaces-tabs" role="tablist">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className="spaces-tab"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="spaces-panel" role="tabpanel">
            {tab === "chat" ? (
              <SpaceChat space={space} version={version} onChanged={load} />
            ) : tab === "content" ? (
              <SpaceContent space={space} onChanged={load} />
            ) : (
              <SpaceMembers space={space} onChanged={load} />
            )}
          </div>
          {space.pendingWrites > 0 ? (
            <p className="spaces-hint">{t("Some changes are still on their way.")}</p>
          ) : null}
        </>
      ) : (
        <p className="dialog-description" aria-busy="true">
          {t("Opening…")}
        </p>
      )}
    </Dialog>
  );
}
