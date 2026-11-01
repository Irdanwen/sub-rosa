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
  type HermesRestoreOutcome,
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
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<HermesRestoreOutcome | null>(null);
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

  if (!notice) return null;

  const close = () => {
    setNotice(null);
    window.dispatchEvent(new Event(CLOSED_EVENT));
  };
  const dismiss = () => {
    close();
    void dismissHermesQuarantineNotice().catch(() => undefined);
  };
  const toggle = (item: string) =>
    setChosen((current) =>
      current.includes(item) ? current.filter((one) => one !== item) : [...current, item],
    );
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await restoreHermesQuarantine(chosen);
      setOutcome(result);
      setNotice({
        ...notice,
        items: notice.items.filter((item) => !result.restored.includes(item)),
      });
      setChosen([]);
      setConfirming(false);
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
              <li key={item}>
                <label className="home-split-notice-choice">
                  <input
                    type="checkbox"
                    checked={chosen.includes(item)}
                    disabled={busy || confirming}
                    onChange={() => toggle(item)}
                  />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {notice.flagged.length > 0 ? (
        <details className="home-split-notice-list">
          <summary>
            {t(
              "Left in place, worth a look: {count} files an earlier version may have written, or linked to a file elsewhere. The assistant reads some of them.",
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
      {confirming ? (
        <div className="home-split-notice-confirm">
          <p className="home-split-notice-text">
            {t(
              "From the assistant's next start, these will run outside the sandbox again, with access to everything your account can reach. Put back only what you recognize:",
            )}
          </p>
          <ul className="home-split-notice-redo">
            {chosen.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome ? (
        <div className="home-split-notice-outcome">
          {outcome.restored.length > 0 ? (
            <p className="home-split-notice-text">
              {t(
                "{count} items are back. They take effect the next time the assistant starts, and they run outside the sandbox again.",
                { count: outcome.restored.length },
              )}
            </p>
          ) : null}
          {outcome.refused.length > 0 ? (
            <>
              <p className="home-split-notice-text">
                {t(
                  "{count} items stay aside: a link is never put back, nor an item whose place is taken.",
                  { count: outcome.refused.length },
                )}
              </p>
              <ul className="home-split-notice-redo">
                {outcome.refused.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="home-split-notice-error">{error}</p> : null}
      <div className="home-split-notice-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void restore()}
            >
              {busy ? t("Putting them back…") : t("Put them back")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("Cancel")}
            </button>
          </>
        ) : (
          <>
            {notice.items.length > 0 ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={chosen.length === 0}
                onClick={() => {
                  setOutcome(null);
                  setConfirming(true);
                }}
              >
                {t("Put back the selected items ({count})", { count: chosen.length })}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={dismiss}>
              {t("Got it")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
