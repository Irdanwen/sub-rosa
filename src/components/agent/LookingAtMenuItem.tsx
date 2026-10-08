import { t } from "../../lib/i18n";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconScreenCapture } from "central-icons/IconScreenCapture";
import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type ScreenAwarenessSettings,
  captureLookingAt,
  lookingAtPaths,
  screenAwarenessSettings,
} from "../../lib/screen-awareness";
import "../../styles/agent-browser.css";

/**
 * "What I'm looking at" in the composer's attach menu (ADR-0094). The capture
 * becomes ordinary attachments (a short note, and the window's picture when
 * asked for), so the chips, their removal and the prompt are the composer's
 * own. When the feature is off, the backend's answer says where to turn it on.
 */
export function LookingAtMenuItem({
  attach,
  close,
}: {
  attach: (paths: string[]) => Promise<unknown>;
  close: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<ScreenAwarenessSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    Promise.resolve()
      .then(() => screenAwarenessSettings())
      .then((next) => setSettings(next ?? null))
      .catch(() => setSettings(null));
  }, []);

  if (!settings) return null;

  async function capture(screenshot: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const value = await captureLookingAt(screenshot);
      await attach(lookingAtPaths(value));
      close(false);
    } catch (err) {
      setNotice(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" role="menuitem" disabled={busy} onClick={() => void capture(false)}>
        <span className="agent-attach-menu-icon">
          <IconEyeOpen size={16} aria-hidden />
        </span>
        <span className="agent-attach-menu-label">{t("What I’m looking at")}</span>
      </button>
      {settings.enabled && settings.screenshots ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => void capture(true)}>
          <span className="agent-attach-menu-icon">
            <IconScreenCapture size={16} aria-hidden />
          </span>
          <span className="agent-attach-menu-label">
            {t("What I’m looking at, with a picture")}
          </span>
        </button>
      ) : null}
      {notice ? (
        <p className="agent-attach-menu-notice" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}
