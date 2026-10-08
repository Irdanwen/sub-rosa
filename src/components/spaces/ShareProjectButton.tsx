import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { spacesCreate, spacesStatus } from "../../lib/spaces";
import { SpaceDialog } from "./SpaceDialog";
import "./spaces.css";

/**
 * "Share this project" in a project's settings, on both shells. Shown only
 * while the shared projects preview is on; opens the shared copy when the
 * project was already shared from this device.
 */
export function ShareProjectButton({ folderId }: { folderId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [existing, setExisting] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    spacesStatus()
      .then((status) => {
        if (!live) return;
        setEnabled(status.enabled);
        setExisting(
          status.spaces.find((s) => s.sourceFolderId === folderId && s.state === "active")?.id ??
            null,
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [folderId]);
  if (!enabled) return null;
  return (
    <div className="spaces-share">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={async () => {
          if (existing) return setOpen(existing);
          setBusy(true);
          setError(null);
          try {
            const space = await spacesCreate(folderId);
            setExisting(space.id);
            setOpen(space.id);
          } catch (cause) {
            setError(messageFromError(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        {existing ? t("Open the shared copy") : t("Share with other people")}
      </button>
      <span className="spaces-hint">
        {existing
          ? t("Changes made here are not copied to the shared project.")
          : t(
              "Preview. Shares a copy of the name, instructions, files and notes, end-to-end encrypted.",
            )}
      </span>
      {error ? (
        <span role="alert" className="spaces-hint">
          {error}
        </span>
      ) : null}
      {open ? <SpaceDialog spaceId={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
