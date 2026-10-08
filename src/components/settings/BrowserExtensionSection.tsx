import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  BROWSER_EXTENSION_CHANGED_EVENT,
  type BrowserExtensionStatus,
  browserExtensionStatus,
  cancelBrowserExtensionPairing,
  connectBrowserExtension,
  disconnectBrowserExtension,
  forgetPairedBrowser,
  formatPairingCode,
  pairedBrowserName,
} from "../../lib/browser-extension";
import { intlLocale, t } from "../../lib/i18n";

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings › Browser extension (ADR-0100).
 *
 * Nothing here runs until the person asks: "Connect a browser" registers the
 * app with the browsers found on this computer and shows a code, and only a
 * browser whose extension typed that code can ask anything. The list below
 * is every browser that did, each one removable on its own.
 */
export function BrowserExtensionSection() {
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    browserExtensionStatus()
      .then(setStatus)
      .catch(() => setError(t("The browser extension settings could not be read.")));
  }, []);

  useEffect(() => {
    load();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen(BROWSER_EXTENSION_CHANGED_EVENT, () => load())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  // The code expires on its own; drop it from the screen when it does.
  useEffect(() => {
    if (!status?.pairing) return;
    const remaining = new Date(status.pairing.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(load, Math.max(1_000, remaining));
    return () => window.clearTimeout(timer);
  }, [status?.pairing, load]);

  const run = async (action: () => Promise<BrowserExtensionStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const found = status?.browsers.filter((browser) => browser.found) ?? [];
  const registered = status?.browsers.filter((browser) => browser.registered) ?? [];

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">{t("Sub Rosa in your browser")}</h3>
            <p className="settings-row-description">
              {t(
                "The Sub Rosa extension asks this app about the page you are reading, adds it to a note or saves its link to your library. It talks only to this app, on this computer, and reads a page only when you click one of its buttons.",
              )}
            </p>
            <p className="settings-row-description">
              {found.length > 0
                ? t("Found on this computer: {browsers}.", {
                    browsers: found.map((browser) => browser.label).join(", "),
                  })
                : t("No supported browser was found. Open Chrome, Edge, Brave or Firefox once.")}
            </p>
            {error ? (
              <p className="settings-row-substatus" role="status">
                {error}
              </p>
            ) : null}
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || found.length === 0}
              onClick={() => run(() => connectBrowserExtension())}
            >
              {status?.pairing ? t("Show a new code") : t("Connect a browser")}
            </button>
          </div>
        </div>

        {status?.pairing ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Pairing code")}</h3>
              <p className="settings-row-description">
                {t(
                  "Install the Sub Rosa extension, open it, and type this code. It works once, for five minutes.",
                )}
              </p>
              <p className="settings-row-title" aria-live="polite" data-testid="pairing-code">
                {formatPairingCode(status.pairing.code)}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => run(cancelBrowserExtensionPairing)}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        ) : null}

        {status?.paired.map((browser) => (
          <div className="settings-row" key={browser.id}>
            <div className="settings-row-info">
              <h3 className="settings-row-title">{pairedBrowserName(browser.browser)}</h3>
              <p className="settings-row-description">
                {t("Connected {date}. Last used {last}.", {
                  date: formatWhen(browser.pairedAt),
                  last: formatWhen(browser.lastSeenAt),
                })}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => run(() => forgetPairedBrowser(browser.id))}
              >
                {t("Remove")}
              </button>
            </div>
          </div>
        ))}

        {registered.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Turn off the extension")}</h3>
              <p className="settings-row-description">
                {t(
                  "Removes Sub Rosa from {browsers} and forgets every connected browser. The extension stays installed but can no longer reach this app.",
                  { browsers: registered.map((browser) => browser.label).join(", ") },
                )}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => run(disconnectBrowserExtension)}
              >
                {t("Turn off")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
