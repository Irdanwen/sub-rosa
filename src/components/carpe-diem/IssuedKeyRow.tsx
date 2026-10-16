import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IssuedKeyHealth,
  carpeDiemIssueCancel,
  carpeDiemIssuedKeyHealth,
  carpeDiemRevokeIssuedKey,
  useOnReturn,
} from "../../lib/carpe-diem-issue";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineNotice } from "../ui/InlineNotice";
import { DeviceKeyIssue } from "./DeviceKeyIssue";

/**
 * Settings, for a device whose key was created from the account (ADR-0069).
 * Renewing makes a new key for this device and Carpe Diem retires the old one
 * in the same step; revoking ends it here and at Carpe Diem. Either way the
 * credits stay on the account.
 */
export function IssuedKeyRow({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [renewing, setRenewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<IssuedKeyHealth>("unknown");
  const mounted = useRef(true);

  // Carpe Diem says nothing when the key is revoked from its own dashboard or
  // the account behind it is closed: ask while this row is in sight.
  const check = useCallback(() => {
    carpeDiemIssuedKeyHealth().then(
      (next) => {
        if (mounted.current) setHealth(next);
      },
      () => undefined,
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    check();
    return () => {
      mounted.current = false;
    };
  }, [check]);
  useOnReturn(check);

  return (
    <div className="settings-row issued-key-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{t("This device's key, linked to your account")}</h3>
        <p className="settings-row-description">
          {t(
            "Carpe Diem created it for this device. It draws on your account's credits, and it stops working if this device leaves your account.",
          )}
        </p>
        {health === "refused" && !renewing ? (
          <InlineNotice
            role="alert"
            body={t(
              "Carpe Diem no longer accepts this key. It may have been revoked from your Carpe Diem account. Renew it to keep going.",
            )}
          />
        ) : null}
        {renewing ? (
          <DeviceKeyIssue
            autoStart
            onIssued={() => {
              setRenewing(false);
              setHealth("accepted");
              void onChanged();
            }}
          />
        ) : null}
        {error ? (
          <p
            role="alert"
            className="settings-row-description settings-row-substatus"
            data-ok="false"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control">
        {renewing ? (
          // A renewal that failed or waits on a mail must never leave both
          // buttons dead: closing it drops the attempt.
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void carpeDiemIssueCancel().catch(() => undefined);
              setRenewing(false);
              check();
            }}
          >
            {t("Close")}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setError(null);
              setRenewing(true);
            }}
          >
            {t("Renew")}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={renewing}
          onClick={() => setConfirming(true)}
        >
          {t("Revoke")}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            await carpeDiemRevokeIssuedKey();
            setConfirming(false);
            await onChanged();
          } catch (cause) {
            setError(messageFromError(cause));
            setConfirming(false);
          }
        }}
        title={t("Revoke this device's key?")}
        description={t(
          "It stops working at once. Your credits stay on your account, and you can create a new key for this device from Settings.",
        )}
        confirmLabel={t("Revoke")}
        cancelLabel={t("Cancel")}
        destructive
      />
    </div>
  );
}
