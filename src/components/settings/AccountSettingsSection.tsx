import { AccountConflictReview } from "./AccountConflictReview";
import { AccountPairingSection } from "./AccountPairingSection";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { accountNextStep } from "../../lib/account-next-step";
import { AccountNextStep } from "./AccountNextStep";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import {
  type AccountStatus,
  type AccountLogin,
  type AccountDevice,
  type AccountConflict,
  accountStatus,
  accountConfigure,
  accountLoginStart,
  accountLoginExchange,
  accountLogout,
  accountDevices,
  accountRevokeDevice,
  accountDelete,
  accountVaultCreate,
  accountVaultConfirmRecovery,
  accountVaultRecoveryKit,
  accountVaultUnlock,
  accountVaultShareCarpeDiem,
  accountVaultRestoreCarpeDiem,
  accountSyncSetEnabled,
  accountSyncNow,
  accountSyncConflicts,
} from "../../lib/account";
import { errorCode } from "../../lib/errors";
import { isMobilePlatform } from "../../lib/mobile";
import { t, intlLocale } from "../../lib/i18n";
import { carpeDiemGetSettings, openExternalUrl } from "../../lib/tauri";
import { InlineNotice } from "../ui/InlineNotice";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import "./account-settings.css";

/** An optional, identical account boundary in both shells and first run.
 * Only the short-lived login is polled here. Durable synchronization is native. */
export function AccountSettingsSection() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [hasLocalKey, setHasLocalKey] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [conflicts, setConflicts] = useState<AccountConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newRecoveryKey, setNewRecoveryKey] = useState("");
  const [recoveryCheck, setRecoveryCheck] = useState("");
  const [consent, setConsent] = useState(false);
  const [confirmation, setConfirmation] = useState<
    { kind: "logout" | "delete" | "restore-key" } | { kind: "revoke"; device: AccountDevice } | null
  >(null);
  const mounted = useRef(false);
  const mutation = useRef(false);

  const refresh = useCallback(async () => {
    const next = await accountStatus();
    if (mounted.current) {
      setStatus(next);
      setServerUrl(next.server_url ?? next.default_server_url);
    }
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {
      if (mounted.current) setError(t("Could not load your account. Try again."));
    });
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const subscription = listen("subrosa://sync-updated", () => {
      if (!cancelled) void refresh().catch(() => {});
    }).catch(() => () => {});
    const resumed = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", resumed);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", resumed);
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh]);

  const loadDevices = useCallback(async () => {
    const next = await accountDevices();
    if (mounted.current) setDevices(next);
  }, []);

  useEffect(() => {
    if (!status?.account?.id) {
      setDevices(null);
      setConflicts([]);
      return;
    }
    let cancelled = false;
    void accountDevices()
      .then((next) => {
        if (!cancelled) setDevices(next);
      })
      .catch(() => {
        if (!cancelled) setDevices(null);
      });
    const conflictCount = status?.conflicts ?? 0;
    if (conflictCount === 0) setConflicts([]);
    void accountSyncConflicts()
      .then((next) => {
        if (!cancelled) setConflicts(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status?.account?.id, status?.conflicts]);

  // Visiting the website never approves a device. The person compares this
  // code and approves there; the verifier remains in the native keychain.
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const interval = Math.max(5, login.interval_seconds) * 1000;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= new Date(login.expires_at).getTime()) {
        setLogin(null);
        setError(t("This sign-in request expired. Start again to get a new code."));
        return;
      }
      if (document.visibilityState !== "hidden") {
        try {
          const next = await accountLoginExchange(login.request_id);
          if (!cancelled) {
            setStatus(next);
            setLogin(null);
            setNotice(t("You are signed in. Unlock your vault to connect this device."));
          }
          return;
        } catch (cause) {
          if (cancelled) return;
          const code = errorCode(cause);
          if (code !== "authorization_pending" && code !== "slow_down") {
            setLogin(null);
            setError(accountError(cause));
            return;
          }
        }
      }
      timer = setTimeout(() => void poll(), interval);
    };
    timer = setTimeout(() => void poll(), interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login]);

  async function run(action: () => Promise<unknown>, success?: string) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      if (mounted.current && success) setNotice(success);
      return true;
    } catch (cause) {
      if (mounted.current) setError(accountError(cause));
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // The last guided step asks whether this device has a Carpe Diem key of its
  // own. Failing to read it only costs the step its certainty, never the panel.
  useEffect(() => {
    carpeDiemGetSettings()
      .then((settings) => setHasLocalKey(settings.hasApiKey))
      .catch(() => undefined);
  }, []);

  async function startLogin() {
    await accountConfigure(serverUrl.trim());
    const next = await accountLoginStart(
      deviceName.trim() || (isMobilePlatform() ? t("My iPhone") : t("My computer")),
    );
    if (mounted.current) setLogin(next);
    await openExternalUrl(next.verification_uri);
  }

  async function confirmAction() {
    if (!confirmation) return;
    const succeeded = await run(async () => {
      if (confirmation.kind === "delete") {
        await accountDelete();
      } else if (confirmation.kind === "logout") {
        await accountLogout();
      } else if (confirmation.kind === "restore-key") {
        await accountVaultRestoreCarpeDiem();
      } else if (confirmation.kind === "revoke") {
        await accountRevokeDevice(confirmation.device.id);
        if (confirmation.device.id !== status?.device_id) await loadDevices();
      }
      setRecoveryKey("");
      setNewRecoveryKey("");
      setRecoveryCheck("");
      setConfirmation(null);
    });
    if (!succeeded) throw new Error("account_action_failed");
  }

  return (
    <section className="settings-group account-settings" aria-labelledby="account-heading">
      <h2 id="account-heading" className="settings-group-heading">
        {t("Account and sync")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Find your work and your Carpe Diem key on your other devices. Your account is optional; you can keep working locally.",
        )}
      </p>
      {error && !confirmation ? (
        <InlineNotice role="alert" tone="destructive" body={error} />
      ) : null}
      {notice ? (
        <p role="status" className="settings-row-description">
          {notice}
        </p>
      ) : null}
      {!status ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          {error ? t("Try again") : t("Loading account…")}
        </button>
      ) : !status.account ? (
        <div className="settings-card account-card">
          <h3 className="settings-row-title">{t("Continue on another device")}</h3>
          <p className="settings-row-description">
            {t("Sign in or create an account in your browser, then approve the code shown here.")}
          </p>
          {!login ? (
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(startLogin);
              }}
            >
              <button
                type="submit"
                className="primary-action primary-solid"
                disabled={busy || !serverUrl.trim()}
              >
                {busy ? t("Connecting…") : t("Sign in or create an account")}
              </button>
              <p className="settings-row-description">
                {t("Continue securely at {address}.", { address: serverUrl })}
              </p>
              <details className="account-advanced">
                <summary>{t("Advanced settings")}</summary>
                <label className="account-field">
                  <span>{t("Account service address")}</span>
                  <input
                    type="url"
                    value={serverUrl}
                    required
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                    onChange={(event) => setServerUrl(event.target.value)}
                  />
                </label>
                <p className="settings-row-description">
                  {t("Use the HTTPS address provided by your Sub Rosa account service.")}
                </p>
                <label className="account-field">
                  <span>{t("Name this device")}</span>
                  <input
                    value={deviceName}
                    maxLength={100}
                    autoComplete="off"
                    placeholder={isMobilePlatform() ? t("My iPhone") : t("My computer")}
                    disabled={busy}
                    onChange={(event) => setDeviceName(event.target.value)}
                  />
                </label>
              </details>
            </form>
          ) : (
            <div className="account-form">
              <p className="settings-row-description">
                {t("Approve this code in your browser only if it matches:")}
              </p>
              <code className="account-login-code">{login.user_code}</code>
              <p role="status" className="settings-row-description">
                {t("Waiting for your approval. This request expires at {time}.", {
                  time: formatAccountDate(login.expires_at),
                })}
              </p>
              <div className="account-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void openExternalUrl(login.verification_uri)}
                >
                  {t("Open sign-in page")}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setLogin(null)}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <AccountNextStep
            step={accountNextStep({
              signedIn: true,
              vaultExists: status.vault_exists,
              vaultUnlocked: status.vault_unlocked,
              recoveryConfirmed: status.recovery_confirmed,
              hasLocalKey,
            })}
            busy={busy}
            onRestoreKey={() => setConfirmation({ kind: "restore-key" })}
          />
          <div className="settings-card account-card">
            <div className="account-heading-row">
              <IconShieldCheck size={20} />
              <strong>{status.account.email}</strong>
            </div>
            <p className="settings-row-description">{status.server_url}</p>
            <div className="account-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                {t("Refresh status")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setConfirmation({ kind: "logout" })}
              >
                {t("Sign out on this device")}
              </button>
            </div>
          </div>

          <AccountCard title={t("Your encrypted vault")}>
            <p className="settings-row-description">
              {t(
                "Your notes and key are encrypted before they leave this device. Keep your recovery key somewhere safe: signing in alone cannot unlock your data.",
              )}
            </p>
            {newRecoveryKey ? (
              <div className="account-form">
                <label className="account-field">
                  <span>{t("Save your recovery key")}</span>
                  <textarea readOnly rows={3} value={newRecoveryKey} spellCheck={false} />
                </label>
                <p className="settings-row-description">
                  {t(
                    "Save this key in your password manager or write it down. Anyone with this key and access to your account can unlock your vault.",
                  )}
                </p>
                <label className="account-field">
                  <span>{t("Enter the saved key to confirm")}</span>
                  <input
                    type="password"
                    value={recoveryCheck}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setRecoveryCheck(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || recoveryCheck.trim() !== newRecoveryKey}
                  onClick={() =>
                    void run(async () => {
                      await accountVaultConfirmRecovery(recoveryCheck.trim());
                      setNewRecoveryKey("");
                      setRecoveryCheck("");
                    }, t("Recovery key confirmed. You can now enable sync."))
                  }
                >
                  {t("I have saved my recovery key")}
                </button>
              </div>
            ) : status.vault_unlocked ? (
              <>
                <p role="status" className="settings-row-description">
                  {t("Your vault is unlocked on this device.")}
                </p>
                {!status.recovery_confirmed ? (
                  <InlineNotice
                    body={t("Save and confirm your recovery key before sharing your data.")}
                  />
                ) : null}
                {status.recovery_available ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const kit = await accountVaultRecoveryKit();
                        setNewRecoveryKey(kit.recovery_key);
                      })
                    }
                  >
                    {t("Show my recovery key")}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="account-form">
                <form
                  className="account-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const key = recoveryKey.trim();
                    setRecoveryKey("");
                    void run(
                      () => accountVaultUnlock(key),
                      t("Your vault is unlocked on this device."),
                    );
                  }}
                >
                  <label className="account-field">
                    <span>{t("Recovery key")}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={recoveryKey}
                      onChange={(event) => setRecoveryKey(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <button
                    className="primary-action primary-solid"
                    type="submit"
                    disabled={busy || !recoveryKey.trim()}
                  >
                    {t("Unlock your vault")}
                  </button>
                </form>
                {status.vault_exists !== true ? (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const kit = await accountVaultCreate();
                        setNewRecoveryKey(kit.recovery_key);
                      })
                    }
                  >
                    {t("Create a vault for this account")}
                  </button>
                ) : null}
              </div>
            )}
          </AccountCard>

          {status.vault_exists !== false && !newRecoveryKey ? (
            <AccountCard title={t("Connect your devices")}>
              <AccountPairingSection
                unlocked={status.vault_unlocked && status.recovery_confirmed}
                serverUrl={status.server_url}
                onUnlocked={refresh}
              />
            </AccountCard>
          ) : null}

          <AccountCard title={t("Sync your work")}>
            <p role="status" className="settings-row-description">
              {status.sync_enabled
                ? status.last_sync_error
                  ? t("Some items could not sync. Your local copies are preserved.")
                  : status.pending_changes > 0
                    ? t("{count} changes waiting to sync", { count: status.pending_changes })
                    : status.last_synced_at
                      ? t("Last synced: {time}", { time: formatAccountDate(status.last_synced_at) })
                      : t("Waiting for the first sync")
                : t("Sync is paused. Your changes stay on this device.")}
            </p>
            {status.sync_enabled && status.last_sync_error ? (
              <InlineNotice body={accountSyncError(status.last_sync_error)} />
            ) : null}
            {!status.sync_enabled ? (
              <label className="account-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={
                    busy ||
                    !status.vault_unlocked ||
                    !status.recovery_confirmed ||
                    Boolean(newRecoveryKey)
                  }
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  {t(
                    "Sync my existing notes and supported data with this account. Keep my local copies.",
                  )}
                </span>
              </label>
            ) : null}
            <div className="account-actions">
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={
                  busy ||
                  (!status.sync_enabled &&
                    (!status.vault_unlocked ||
                      !status.recovery_confirmed ||
                      Boolean(newRecoveryKey) ||
                      !consent))
                }
                onClick={() => void run(() => accountSyncSetEnabled(!status.sync_enabled))}
              >
                {status.sync_enabled ? t("Pause sync") : t("Enable encrypted sync")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !status.sync_enabled}
                onClick={() => void run(accountSyncNow)}
              >
                {t("Sync now")}
              </button>
            </div>
            {status.conflicts > 0 ? (
              <InlineNotice
                body={t(
                  "Some changes were made on both devices. Your versions have been preserved.",
                )}
              />
            ) : null}
            {conflicts.map((conflict) => (
              <div className="account-device" key={conflict.id}>
                <p className="settings-row-description">
                  {t("Preserved version from {time}", {
                    time: formatAccountDate(conflict.created_at),
                  })}
                </p>
                <AccountConflictReview conflict={conflict} onResolved={refresh} />
              </div>
            ))}
          </AccountCard>

          <AccountCard title={t("Carpe Diem on your devices")}>
            <p className="settings-row-description">
              {t(
                "Share the key already saved on this device through your encrypted vault, or use the key you saved from another device.",
              )}
            </p>
            <div className="account-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={
                  busy ||
                  !status.vault_unlocked ||
                  !status.recovery_confirmed ||
                  Boolean(newRecoveryKey)
                }
                onClick={() =>
                  void run(
                    accountVaultShareCarpeDiem,
                    t("Your saved Carpe Diem key has been shared through your vault."),
                  )
                }
              >
                {t("Share this device's key")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !status.vault_unlocked}
                onClick={() => setConfirmation({ kind: "restore-key" })}
              >
                {t("Use the key from my vault")}
              </button>
            </div>
          </AccountCard>

          <AccountCard title={t("Your devices")}>
            <p className="settings-row-description">
              {t(
                "Revoking a device stops its access to new data. It cannot erase copies already downloaded. Replace your Carpe Diem key if a device was lost.",
              )}
            </p>
            {devices ? (
              devices
                .filter((device) => !device.revoked_at)
                .map((device) => (
                  <div className="account-device" key={device.id}>
                    <div>
                      <strong>{device.name}</strong>
                      {device.id === status.device_id ? (
                        <span className="settings-row-description"> {t("This device")}</span>
                      ) : null}
                      <p className="settings-row-description">
                        {device.last_seen_at
                          ? t("Last seen: {time}", { time: formatAccountDate(device.last_seen_at) })
                          : t("No recent activity")}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setConfirmation({ kind: "revoke", device })}
                    >
                      {t("Revoke access")}
                    </button>
                  </div>
                ))
            ) : (
              <p className="settings-row-description">
                {t("Your device list is unavailable. Refresh when you are connected.")}
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void run(loadDevices)}
            >
              {t("Refresh devices")}
            </button>
          </AccountCard>
          <AccountCard title={t("Delete your account")}>
            <p className="settings-row-description">
              {t(
                "Delete your Sub Rosa account and its synced data. Your local notes and your separate Carpe Diem account are kept.",
              )}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setConfirmation({ kind: "delete" })}
            >
              {t("Delete my account")}
            </button>
          </AccountCard>
        </>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onClose={() => {
          if (!busy) setConfirmation(null);
        }}
        onConfirm={confirmAction}
        title={
          confirmation?.kind === "delete"
            ? t("Delete your account?")
            : confirmation?.kind === "revoke"
              ? t("Revoke access for {device}?", { device: confirmation.device.name })
              : confirmation?.kind === "restore-key"
                ? t("Use your vault's Carpe Diem key?")
                : t("Sign out on this device?")
        }
        description={
          <>
            {error ? (
              <span role="alert">
                {error}
                <br />
              </span>
            ) : null}
            {confirmation?.kind === "delete"
              ? t(
                  "This deletes your synced data and signs out every device. Export your notes first if you need a separate backup. You may need to sign in again to confirm this action.",
                )
              : confirmation?.kind === "revoke"
                ? t(
                    "This device will lose access to your account. Copies it already downloaded will remain on it.",
                  )
                : confirmation?.kind === "restore-key"
                  ? t(
                      "This replaces the Carpe Diem configuration saved on this device with the one in your encrypted vault.",
                    )
                  : status?.pending_changes
                    ? t(
                        "You have {count} changes waiting to sync. They will remain on this device after you sign out.",
                        { count: status.pending_changes },
                      )
                    : t(
                        "Your local notes stay on this device. Your account session and access to encrypted sync will be removed.",
                      )}
          </>
        }
        confirmLabel={
          confirmation?.kind === "delete"
            ? t("Delete my account")
            : confirmation?.kind === "revoke"
              ? t("Revoke access")
              : confirmation?.kind === "restore-key"
                ? t("Use this key")
                : t("Sign out")
        }
        cancelLabel={t("Cancel")}
        destructive={confirmation?.kind !== "restore-key"}
      />
    </section>
  );
}

function AccountCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-card account-card">
      <h3 className="settings-row-title">{title}</h3>
      {children}
    </div>
  );
}

function formatAccountDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? t("Unavailable")
    : new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
        date,
      );
}

/** Never render provider response text, URLs containing tokens, or credentials. */
export function accountError(cause: unknown): string {
  switch (errorCode(cause)) {
    case "recent_auth_required":
    case "reauthentication_required":
      return t("Sign in again, then retry this action.");
    case "vault_locked":
      return t("Unlock your vault with your recovery key first.");
    case "vault_exists":
      return t("This account already has a vault. Unlock it with your recovery key.");
    case "vault_not_found":
      return t("This account has no vault yet. Create one to get started.");
    case "vault_invalid":
    case "invalid_recovery_key":
      return t("This recovery key could not unlock your vault. Check it and try again.");
    case "account_not_connected":
    case "unauthorized":
    case "session_expired":
      return t("Your session has expired. Sign in again to continue.");
    case "account_bound":
    case "account_mismatch":
      return t(
        "This device contains data linked to another account. Sign in to that account to continue.",
      );
    case "account_server_invalid":
    case "invalid_server_url":
      return t("Enter a valid HTTPS account service address.");
    case "recovery_unconfirmed":
      return t("Save and confirm your recovery key before sharing your data.");
    case "account_login_expired":
      return t("This sign-in request expired. Start again to get a new code.");
    case "vault_credential_missing":
      return t(
        "Your vault has no Carpe Diem key yet. Share it from a device where it is configured.",
      );
    case "carpe_diem_no_api_key":
      return t("Configure Carpe Diem on this device before sharing its key.");
    case "account_conflict":
      return t("Your account changed on another device. Refresh and try again.");
    default:
      return t("Your account request could not be completed. Check your connection and try again.");
  }
}

export function AccountSetupOffer() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="account-setup-offer"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("Create a Sub Rosa account or sign in")}</summary>
      {open ? <AccountSettingsSection /> : null}
    </details>
  );
}

/** Never expose native/server error details or filenames through sync status. */
export function accountSyncError(code: string): string {
  switch (code) {
    case "sync_file_too_large":
      return t(
        "A file exceeds the sync size limit and remains on this device. Use a smaller copy to sync it.",
      );
    case "sync_object_too_large":
      return t(
        "Some content exceeds the sync size limit and remains on this device. Reduce its size to sync it.",
      );
    case "account_network":
    case "sync_timeout":
      return t(
        "The sync service is unavailable or did not respond in time. Your changes will retry automatically.",
      );
    case "account_not_connected":
      return t("Sign in again to resume synchronization.");
    case "vault_locked":
      return t("Open your vault to resume synchronization.");
    case "sync_file_unavailable":
      return t(
        "A file could not be read on this device. Check that it is available, then try again.",
      );
    default:
      return t("Synchronization could not finish. Your local copies are preserved. Try again.");
  }
}
