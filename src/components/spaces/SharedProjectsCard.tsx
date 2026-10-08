import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type SpaceSummary,
  type SpacesStatus,
  onSpacesUpdated,
  spacesForget,
  spacesSetEnabled,
  spacesStatus,
} from "../../lib/spaces";
import { JoinSpaceDialog } from "./JoinSpaceDialog";
import { SpaceDialog } from "./SpaceDialog";
import "./spaces.css";

/** What a space's state means for the person, in one line. */
export function spaceStateLine(space: SpaceSummary): string | null {
  switch (space.state) {
    case "pending":
      return t("Waiting for the owner to let you in.");
    case "left":
      return t("You left. What you already received stays on this device.");
    case "removed":
      return t("You are no longer a member. What you already received stays on this device.");
    default:
      return space.lastError ? t("Not synchronized yet. It will try again.") : null;
  }
}

/**
 * Shared projects (ADR-0098), in Settings › Account on both shells: the
 * Preview switch, the name other members see, the spaces this account is
 * in, and joining with a link. The protocol waits for an independent
 * review, so it stays off until the person turns it on.
 */
export function SharedProjectsCard() {
  const [status, setStatus] = useState<SpacesStatus | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // Read only once the card is opened, like the publishing card beside it:
  // an account screen that never shows it asks nothing of it.
  const [opened, setOpened] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await spacesStatus();
      if (!next || !Array.isArray(next.spaces)) return;
      setStatus(next);
      setName((current) => current || next.displayName || "");
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }, []);
  useEffect(() => {
    if (!opened) return;
    void load();
    let stop: (() => void) | undefined;
    let live = true;
    void onSpacesUpdated(() => void load())
      .then((unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [opened, load]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled ?? false;
  return (
    <details
      className="settings-card account-card spaces-card"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="settings-row-title">
        {t("Shared projects")} <span className="spaces-badge">{t("Preview")}</span>
      </summary>
      <p className="settings-row-description">
        {t(
          "Share a project with other Sub Rosa accounts and chat in it together. Everything is encrypted on your devices: the service only carries it and cannot read it. When someone asks the assistant, their own device answers with their own key.",
        )}
      </p>
      <p className="settings-row-description">
        {t(
          "This is a preview. The encryption protocol has not been independently reviewed yet, so do not rely on it for anything sensitive.",
        )}
      </p>
      {opened ? (
        <>
          {error ? (
            <p role="alert" className="settings-row-description">
              {error}
            </p>
          ) : null}
          <label className="spaces-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !status}
              onChange={(event) => void run(() => spacesSetEnabled(event.target.checked, name))}
            />
            <span>{t("Turn on shared projects")}</span>
          </label>
          {enabled && status ? (
            <>
              <label className="dialog-field">
                <span className="dialog-field-label">{t("Your name in shared projects")}</span>
                <span className="spaces-row">
                  <input
                    className="dialog-input"
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || name.trim() === status.displayName}
                    onClick={() => void run(() => spacesSetEnabled(true, name))}
                  >
                    {t("Save")}
                  </button>
                </span>
                <span className="dialog-field-hint">
                  {t("The other members see this name. It is encrypted like everything else.")}
                </span>
              </label>
              {status.spaces.length === 0 ? (
                <p className="settings-row-description">
                  {t(
                    "No shared projects yet. Share one from a project's settings, or join with a link.",
                  )}
                </p>
              ) : (
                <ul className="spaces-list">
                  {status.spaces.map((space) => (
                    <li key={space.id} className="spaces-list-item">
                      <span className="spaces-list-main">
                        <span className="spaces-list-title">
                          {space.name || t("Shared project")}
                          {space.unread > 0 ? (
                            <span className="spaces-unread">
                              {t("{count} new", { count: space.unread })}
                            </span>
                          ) : null}
                        </span>
                        <span className="settings-row-description">
                          {spaceStateLine(space) ??
                            (space.role === "owner" ? t("You own it") : t("Member"))}
                        </span>
                      </span>
                      {space.state === "left" || space.state === "removed" ? (
                        <span className="spaces-row">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setOpen(space.id)}
                          >
                            {t("Open")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() => void run(() => spacesForget(space.id))}
                          >
                            {t("Forget on this device")}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={space.state === "pending"}
                          onClick={() => setOpen(space.id)}
                        >
                          {t("Open")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setJoining(true)}>
                {t("Join with a link")}
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {open ? (
        <SpaceDialog spaceId={open} onClose={() => setOpen(null)} onChanged={() => void load()} />
      ) : null}
      <JoinSpaceDialog
        open={joining}
        onClose={() => setJoining(false)}
        onJoined={() => void load()}
      />
    </details>
  );
}
