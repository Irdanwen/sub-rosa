// ADR-0140: said once, after the first start that split the assistant's
// home in two. What was set aside (and where), what was left in place but
// deserves a look, what the person has to do again, and a way to put back
// what was set aside. Shown as a banner where the app opens and in
// Settings > Agent; closing it in one place closes it in both.
import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import {
  dismissHermesQuarantineNotice,
  hermesQuarantineNotice,
  restoreHermesQuarantine,
  type HermesQuarantineNotice,
} from "../../lib/tauri";

const CLOSED_EVENT = "subrosa:home-split-notice-closed";

function redoLine(code: string): string | null {
  switch (code) {
    case "messaging":
      return t("Pair your messaging channels again, in Settings, Agent.");
    case "mcp_servers":
      return t("Install again the catalog servers you use, in Settings, Connectors.");
    case "task_boards":
      return t("Your task boards were set aside: put them back below if you use them.");
    case "routines":
      return t("Routines that ran a script of their own were set aside with the rest.");
    case "mcp_sign_in":
      return t(
        "Sign in again to the connectors that asked you to sign in, from a sandboxed session: sign-ins are no longer shared between the two sides.",
      );
    case "workspace":
      return t(
        "The assistant's former folder is now the Unrestricted workspace in the Files panel. Sandboxed sessions start in a new folder of their own.",
      );
    case "conversations":
      return t(
        "Your earlier conversations could not be copied for sandboxed sessions yet. They still open from the unrestricted side, and Sub Rosa tries again the next time the assistant starts.",
      );
    default:
      return null;
  }
}

export function HomeSplitNotice({ placement }: { placement: "banner" | "settings" }) {
  const [notice, setNotice] = useState<HermesQuarantineNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    hermesQuarantineNotice()
      .then((next) => {
        if (!cancelled) setNotice(next ?? null);
      })
      .catch(() => undefined);
    const closed = () => setNotice(null);
    window.addEventListener(CLOSED_EVENT, closed);
    return () => {
      cancelled = true;
      window.removeEventListener(CLOSED_EVENT, closed);
    };
  }, []);

  if (restored !== null) {
    return (
      <div className={`home-split-notice home-split-notice-${placement}`} role="status">
        <p className="home-split-notice-text">
          {t(
            "{count} items are back. They take effect the next time the assistant starts, and they run outside the sandbox again.",
            { count: restored },
          )}
        </p>
        <div className="home-split-notice-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setRestored(null)}>
            {t("Got it")}
          </button>
        </div>
      </div>
    );
  }
  if (!notice) return null;

  const close = () => {
    setNotice(null);
    window.dispatchEvent(new Event(CLOSED_EVENT));
  };
  const dismiss = () => {
    close();
    void dismissHermesQuarantineNotice().catch(() => undefined);
  };
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await restoreHermesQuarantine();
      close();
      setRestored(count);
    } catch {
      setError(
        t("Sub Rosa could not put them back. They are still in {dir}.", { dir: notice.dir }),
      );
    } finally {
      setBusy(false);
    }
  };
  const redo = notice.redo.map(redoLine).filter((line): line is string => line !== null);

  return (
    <div className={`home-split-notice home-split-notice-${placement}`} role="status">
      <h3 className="home-split-notice-title">
        {t("Sandboxed sessions now keep their own folder")}
      </h3>
      <p className="home-split-notice-text">
        {t(
          "So that nothing a sandboxed session writes can run outside the sandbox, the assistant now keeps two folders: one for sandboxed sessions, one for the unrestricted side, routines and messaging.",
        )}
      </p>
      {notice.items.length > 0 ? (
        <details className="home-split-notice-list">
          <summary>
            {t(
              "{count} items were moved out of the assistant's folder because they could run outside the sandbox. Some may be yours. Nothing was deleted: they are in {dir}.",
              { count: notice.items.length, dir: notice.dir },
            )}
          </summary>
          <ul>
            {notice.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {notice.flagged.length > 0 ? (
        <details className="home-split-notice-list">
          <summary>
            {t(
              "Left in place, worth a look: {count} skills and memories an earlier version may have written. The assistant reads them.",
              { count: notice.flagged.length },
            )}
          </summary>
          <ul>
            {notice.flagged.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {redo.length > 0 ? (
        <>
          <p className="home-split-notice-text">{t("What to do again:")}</p>
          <ul className="home-split-notice-redo">
            {redo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? <p className="home-split-notice-error">{error}</p> : null}
      <div className="home-split-notice-actions">
        {notice.items.length > 0 ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void restore()}
          >
            {busy ? t("Putting them back…") : t("Put them back")}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={dismiss}>
          {t("Got it")}
        </button>
      </div>
    </div>
  );
}
