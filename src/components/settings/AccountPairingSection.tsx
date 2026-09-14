import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  type AccountPairing,
  accountPairingStart,
  accountPairingApprove,
  accountPairingExchange,
  accountPairingCancel,
} from "../../lib/account";
import { errorCode } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/** The transfer code carries a one-time random secret. It is never put in
 * URLs' query strings, logs or web storage, and expires after five minutes. */
export function AccountPairingSection({
  unlocked,
  serverUrl,
  onUnlocked,
}: {
  unlocked: boolean;
  serverUrl: string | null;
  onUnlocked: () => Promise<unknown>;
}) {
  const [request, setRequest] = useState<AccountPairing | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (!request) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disposed) return;
      if (Date.now() >= Date.parse(request.expires_at)) {
        setRequest(null);
        setError(t("This device request expired. Start a new request."));
        return;
      }
      if (document.visibilityState !== "hidden") {
        try {
          await accountPairingExchange(request.request_id);
          if (!disposed) {
            setRequest(null);
            await onUnlocked();
          }
          return;
        } catch (cause) {
          if (disposed) return;
          if (errorCode(cause) !== "pairing_pending") {
            setRequest(null);
            setError(t("This device could not be connected. Start a new request and try again."));
            return;
          }
        }
      }
      timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [request, onUnlocked]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setRequest(await accountPairingStart());
    } catch {
      setError(t("Could not create a device request. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // Browser QR links hold the code only in their fragment. The native
      // parser still verifies format, account binding, entropy and expiry.
      const value = code.trim();
      const transfer = value.startsWith("srpair1.") ? value : new URL(value).hash.slice(1);
      await accountPairingApprove(transfer);
      setCode("");
      setApproved(true);
      setConfirming(false);
    } catch {
      setError(
        t(
          "This device code could not be verified. Check that both devices use the same account, then try again.",
        ),
      );
      throw new Error("pairing_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-form">
      <h4 className="settings-row-title">
        {unlocked ? t("Connect another device") : t("Use an unlocked device")}
      </h4>
      {error && !confirming ? (
        <p role="alert" className="settings-row-description">
          {error}
        </p>
      ) : null}
      {unlocked ? (
        <>
          <p className="settings-row-description">
            {t(
              "On your new device, sign in to this account and choose to use an unlocked device. Paste its code here.",
            )}
          </p>
          <label className="account-field">
            <span>{t("Code from your new device")}</span>
            <textarea
              value={code}
              rows={3}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={4096}
              disabled={busy}
              onChange={(event) => {
                setCode(event.target.value);
                setApproved(false);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !code.trim()}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t("Authorize this device")}
          </button>
          {approved ? (
            <p role="status" className="settings-row-description">
              {t("Device authorized. Return to your new device to finish connecting.")}
            </p>
          ) : null}
        </>
      ) : request ? (
        <>
          <p className="settings-row-description">
            {t(
              "Scan this code with your unlocked device, or paste the transfer code into its Account and sync settings. Only share it with a device you own.",
            )}
          </p>
          <div
            className="account-pairing-qr"
            role="img"
            aria-label={t("One-time device authorization code")}
          >
            <QRCodeSVG
              value={pairingQrValue(request.transfer_code, serverUrl)}
              size={192}
              marginSize={2}
              level="M"
            />
          </div>
          <label className="account-field">
            <span>{t("Transfer code")}</span>
            <textarea readOnly rows={3} value={request.transfer_code} spellCheck={false} />
          </label>
          <p role="status" className="settings-row-description">
            {t("Waiting for approval on your unlocked device. This code expires in five minutes.")}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              const id = request.request_id;
              setRequest(null);
              void accountPairingCancel(id).catch(() => {});
            }}
          >
            {t("Cancel device request")}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void start()}
        >
          {t("Connect using another device")}
        </button>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        onConfirm={approve}
        title={t("Authorize your new device?")}
        description={
          <>
            {error ? (
              <span role="alert">
                {error}
                <br />
              </span>
            ) : null}
            {t(
              "Only approve a code you copied from your own device. This gives it access to your encrypted notes and your Carpe Diem key.",
            )}
          </>
        }
        confirmLabel={t("Authorize this device")}
        cancelLabel={t("Cancel")}
      />
    </div>
  );
}

/** The fragment never reaches HTTP or Referer. Only the configured account
 * origin is used, with no token in a query or an arbitrary pasted destination. */
export function pairingQrValue(transferCode: string, serverUrl: string | null) {
  if (!serverUrl) return transferCode;
  try {
    const url = new URL("/account/pair", serverUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
      return transferCode;
    url.hash = transferCode;
    return url.toString();
  } catch {
    return transferCode;
  }
}
