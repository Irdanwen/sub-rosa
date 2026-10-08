import { AccountConflictList } from "./AccountConflictList";
import { AccountPairingSection } from "./AccountPairingSection";
import { PublishingCard } from "../publishing/PublishingCard";
import { SharedProjectsCard } from "../spaces/SharedProjectsCard";
import { AccountSecurityHistory } from "./AccountSecurityHistory";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { accountNextStep } from "../../lib/account-next-step";
import { accountSyncError } from "../../lib/account-sync-error";
import { AccountNextStep } from "./AccountNextStep";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import {
  type AccountStatus,
  type AccountLogin,
  type AccountNativeLogin,
  type AccountDevice,
  type AccountConflict,
  accountStatus,
  accountConfigure,
  accountLoginStart,
  accountLoginExchange,
  accountLoginOpen,
  accountLoginPasskey,
  accountLoginPending,
  accountLoginCancel,
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
  accountSyncRetryIssues,
  accountSyncConflicts,
} from "../../lib/account";
import { errorCode } from "../../lib/errors";
import { isMobilePlatform, supportsNativePasskeys } from "../../lib/mobile";
import { t, intlLocale } from "../../lib/i18n";
import {
  type CarpeDiemSidecarStatusDto,
  carpeDiemGetSettings,
  openExternalUrl,
} from "../../lib/tauri";
import { SIDECAR_STATUS_EVENT } from "./CarpeDiemSettings";
import { keyOrigin, useIssuanceStatus, withSignupIntent } from "../../lib/carpe-diem-issue";
import { DeviceKeyIssue } from "../carpe-diem/DeviceKeyIssue";
import { InlineNotice } from "../ui/InlineNotice";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import "./account-settings.css";

/** How a restore from the vault is going, in the phone's first-run path. */
type KeyRestore = "idle" | "restoring" | "restored" | "missing" | "failed";

/** An optional, identical account boundary in both shells and first run.
 * Only the short-lived login is polled here. Durable synchronization is native.
 *
 * `mode="restore"` is the phone's "I already use Sub Rosa" path at the key
 * gate: sign in, open the vault, and the Carpe Diem key comes back by itself.
 * Everything that only matters once the app runs (sync, devices, sharing,
 * deletion) waits for Settings, so the way out is never below the fold.
 *
 * `mode="create"` is the new person's path (ADR-0069): the account page opens
 * on its registration form, and once they are back the device's Carpe Diem key
 * is created from the account. No vault, no key to paste. */
export function AccountSettingsSection({
  mode = "settings",
  onUseKey,
  onKeyIssued,
}: {
  mode?: "settings" | "restore" | "create";
  /** Restore and create modes: leave for the paste-a-key path. */
  onUseKey?: () => void;
  /** A device key was just created for this device. */
  onKeyIssued?: () => void;
} = {}) {
  const creating = mode === "create";
  const restoring = mode === "restore" || creating;
  const issuance = useIssuanceStatus();
  const canIssue = issuance?.keyIssuance === true;
  const [issuedKey, setIssuedKey] = useState(false);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  // `null` until the keychain answers: an unknown key must not trigger a
  // restore that would replace one.
  const [hasLocalKey, setHasLocalKey] = useState<boolean | null>(null);
  const [keyRestore, setKeyRestore] = useState<KeyRestore>("idle");
  const restoreAttempted = useRef(false);
  const [serverUrl, setServerUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [native, setNative] = useState<AccountNativeLogin | null>(null);
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
    // A native sign-in finishes in Rust, off a deep link, with nothing for this
    // screen to poll. It says so, and the panel catches up.
    const finished = listen("subrosa://account-updated", () => {
      if (cancelled) return;
      setNative(null);
      void refresh().catch(() => {});
    }).catch(() => () => {});
    const failed = listen<string>("subrosa://account-login-failed", (event) => {
      if (cancelled) return;
      setNative(null);
      setError(accountError({ code: event.payload }));
    }).catch(() => () => {});
    const resumed = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", resumed);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", resumed);
      for (const pending of [subscription, finished, failed]) {
        void pending.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [refresh]);

  // A sign-in can outlive the window that started it: the person quits while
  // they are in the browser. The verifier is durable, so the waiting state is
  // too, rather than showing a fresh button that would strand the request.
  useEffect(() => {
    let cancelled = false;
    void accountLoginPending()
      .then((pending) => {
        if (!cancelled && pending) setNative(pending);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // A guided step asks whether this device has a Carpe Diem key of its own.
  // Failing to read it only costs the step its certainty, never the panel. It
  // is followed afterwards, because a key restored or pasted elsewhere on the
  // screen changes the answer.
  useEffect(() => {
    const read = () =>
      carpeDiemGetSettings()
        .then((settings) => {
          if (!mounted.current) return;
          setHasLocalKey(settings.hasApiKey);
          setIssuedKey(keyOrigin(settings) === "issued");
        })
        .catch(() => undefined);
    void read();
    const unlisten = listen<CarpeDiemSidecarStatusDto>(SIDECAR_STATUS_EVENT, (event) => {
      if (!mounted.current) return;
      setHasLocalKey(event.payload.hasApiKey);
      // Where the key came from is not in the event; ask again.
      void read();
    }).catch(() => () => {});
    return () => {
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  // Opening the vault is the out-of-band admission (ADR 0050); the key it
  // holds follows without another question on a device that has none. The
  // gate lifts on its own once the engine reports the key.
  const restoreKey = useCallback(async () => {
    setKeyRestore("restoring");
    setError(null);
    try {
      await accountVaultRestoreCarpeDiem();
      if (mounted.current) setKeyRestore("restored");
    } catch (cause) {
      if (!mounted.current) return;
      if (errorCode(cause) === "vault_credential_missing") {
        setKeyRestore("missing");
      } else {
        setKeyRestore("failed");
        setError(accountError(cause));
      }
    }
  }, []);

  useEffect(() => {
    if (!restoring || !status?.vault_unlocked || hasLocalKey !== false) return;
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    void restoreKey();
  }, [restoring, status?.vault_unlocked, hasLocalKey, restoreKey]);

  function chosenDeviceName() {
    return deviceName.trim() || (isMobilePlatform() ? t("My iPhone") : t("My computer"));
  }
  const nativePasskey =
    serverUrl.trim() === "https://subrosa.furetier.com" && supportsNativePasskeys();

  /** The ordinary way in: the real page opens, and it hands the app back.
   * `signup` opens it on the registration form instead. */
  async function startLogin(signup = false) {
    await accountConfigure(serverUrl.trim());
    const opened_ = await accountLoginOpen(chosenDeviceName());
    const next = signup ? { ...opened_, start_url: withSignupIntent(opened_.start_url) } : opened_;
    if (mounted.current) setNative(next);
    const opened = await openExternalUrl(next.start_url);
    if (!opened && mounted.current) {
      setNotice(t("Your browser did not open. Open this address yourself to continue."));
    }
  }

  async function startPasskeyLogin() {
    await accountConfigure(serverUrl.trim());
    try {
      await accountLoginPasskey(chosenDeviceName());
    } catch (cause) {
      // The PKCE verifier was stored before the system picker appeared. Its
      // browser fallback remains usable if the picker was cancelled or failed.
      if (mounted.current) setNative(await accountLoginPending());
      throw cause;
    }
  }

  /** The fallback, for when nothing comes back: a code approved on the site. */
  async function startCodeLogin() {
    await accountConfigure(serverUrl.trim());
    await accountLoginCancel();
    if (mounted.current) setNative(null);
    const next = await accountLoginStart(chosenDeviceName());
    if (mounted.current) setLogin(next);
    const opened = await openExternalUrl(next.verification_uri);
    if (!opened && mounted.current) {
      setNotice(t("Your browser did not open. Open this address yourself to continue."));
    }
  }

  async function cancelLogin() {
    await accountLoginCancel();
    if (mounted.current) setNative(null);
  }

  async function confirmAction() {
    if (!confirmation) return;
    const succeeded = await run(async () => {
      if (confirmation.kind === "delete") {
        await accountDelete();
      } else if (confirmation.kind === "logout") {
        await accountLogout();
        // Another account may hold another vault: its key gets its own try.
        restoreAttempted.current = false;
        setKeyRestore("idle");
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

  /** Both ways into a locked vault. Shared by Settings and the phone's
   * first-run restore path, so the two can never drift apart. */
  function renderVaultUnlock(current: AccountStatus) {
    return (
      <div className="account-form">
        {/* Both ways in, in one place, with the one that types nothing
            first. A recovery key pulled out of a password manager and
            pasted is the moment it is most likely to leak, so the
            order here is a security choice, not a layout one. */}
        {current.vault_exists === true ? (
          <>
            <AccountPairingSection
              unlocked={false}
              serverUrl={current.server_url}
              onUnlocked={refresh}
            />
            <p className="settings-row-description">{t("Or, if you have your recovery key:")}</p>
          </>
        ) : null}
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            const key = recoveryKey.trim();
            setRecoveryKey("");
            void run(() => accountVaultUnlock(key), t("Your vault is unlocked on this device."));
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
        {current.vault_exists !== true ? (
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
    );
  }

  /** The phone's first-run path once signed in: open the vault, and the key
   * follows. Only what that needs is here; the rest waits for Settings. */
  function renderRestore(current: AccountStatus) {
    const email = current.account?.email;
    const header = (
      <div className="settings-card account-card">
        <div className="account-heading-row">
          <IconShieldCheck size={20} />
          <strong>{email}</strong>
        </div>
        <div className="account-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || keyRestore === "restoring"}
            onClick={() => setConfirmation({ kind: "logout" })}
          >
            {t("Use another account")}
          </button>
        </div>
      </div>
    );
    const keyFromAccount = (lead: string) => (
      <>
        {header}
        <AccountCard title={t("Your Carpe Diem key")}>
          <p className="settings-row-description">{lead}</p>
          <DeviceKeyIssue autoStart onUseKey={onUseKey} onIssued={onKeyIssued} />
        </AccountCard>
      </>
    );
    if (creating) {
      // Only a device with no key at all gets one without being asked: a key
      // that is already here is never replaced behind the person's back.
      if (canIssue && hasLocalKey === false) {
        return keyFromAccount(
          t(
            "Carpe Diem creates a key for this device from your account. Nothing to copy, nothing to paste.",
          ),
        );
      }
      return (
        <>
          {header}
          {hasLocalKey ? (
            <AccountCard title={t("Your Carpe Diem key")}>
              <p role="status" className="settings-row-description">
                {issuedKey
                  ? t("This device has its own key now. It draws on your account's credits.")
                  : t("This device already has a Carpe Diem key. It stays as it is.")}
              </p>
            </AccountCard>
          ) : issuance === null || hasLocalKey === null ? (
            <p role="status" className="settings-row-description">
              {t("Checking Carpe Diem…")}
            </p>
          ) : (
            <AccountCard title={t("Your Carpe Diem key")}>
              <InlineNotice
                body={t(
                  "Creating a key from your account is not available yet. Paste a Carpe Diem key instead.",
                )}
              />
              {onUseKey ? (
                <div className="account-actions">
                  <button type="button" className="primary-action primary-solid" onClick={onUseKey}>
                    {t("Paste a key instead")}
                  </button>
                </div>
              ) : null}
            </AccountCard>
          )}
        </>
      );
    }
    // A vault may hold the key this person already paid into, so it comes
    // first when there is one. A device key from the account is the answer
    // when there is none, or when the vault turns out to be empty.
    if (canIssue && hasLocalKey === false && current.vault_unlocked && keyRestore === "missing") {
      return keyFromAccount(
        t("Your vault holds no key, so this device gets its own from your account."),
      );
    }
    if (
      canIssue &&
      hasLocalKey === false &&
      current.vault_exists === false &&
      !current.vault_unlocked
    ) {
      return keyFromAccount(
        t("This device gets its own key from your account. It draws on your account's credits."),
      );
    }
    return (
      <>
        {header}
        {current.vault_unlocked ? (
          <AccountCard title={t("Your Carpe Diem key")}>
            {keyRestore === "missing" ? (
              <InlineNotice
                body={t(
                  "Your vault does not hold a Carpe Diem key yet. On a device where Sub Rosa already works, open Settings, then Account, and choose Share this device's key. Then try again here.",
                )}
              />
            ) : (
              <p role="status" className="settings-row-description">
                {keyRestore === "restored"
                  ? t("Your key is back on this device. Sub Rosa is starting.")
                  : keyRestore === "failed"
                    ? t("Your key could not be brought back from your vault.")
                    : t("Bringing your key back from your vault…")}
              </p>
            )}
            {keyRestore === "missing" || keyRestore === "failed" ? (
              <div className="account-actions">
                <button
                  type="button"
                  className="primary-action primary-solid"
                  onClick={() => void restoreKey()}
                >
                  {t("Try again")}
                </button>
                {onUseKey ? (
                  <button type="button" className="btn btn-secondary" onClick={onUseKey}>
                    {t("Paste a key instead")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </AccountCard>
        ) : current.vault_exists === false ? (
          <AccountCard title={t("No vault on this account yet")}>
            <p className="settings-row-description">
              {t(
                "There is no key to bring back yet. Start with your Carpe Diem key; you can create your vault later in Settings.",
              )}
            </p>
            {onUseKey ? (
              <div className="account-actions">
                <button type="button" className="primary-action primary-solid" onClick={onUseKey}>
                  {t("Start with a key")}
                </button>
              </div>
            ) : null}
          </AccountCard>
        ) : (
          <AccountCard title={t("Open your vault")}>
            <p className="settings-row-description">
              {t(
                "Signing in alone cannot unlock your data. Use a device that is already open, or your recovery key.",
              )}
            </p>
            {renderVaultUnlock(current)}
            {canIssue ? (
              <details className="account-advanced">
                <summary>{t("Or create a new key for this device")}</summary>
                <p className="settings-row-description">
                  {t(
                    "Opening your vault brings back the key you used before, with its credits. A new key draws on your account's credits instead.",
                  )}
                </p>
                <DeviceKeyIssue
                  onUseKey={onUseKey}
                  onIssued={onKeyIssued}
                  actionLabel={t("Create a new key")}
                />
              </details>
            ) : null}
          </AccountCard>
        )}
      </>
    );
  }

  return (
    <section
      className="settings-group account-settings"
      data-mode={mode}
      aria-labelledby={restoring ? undefined : "account-heading"}
      aria-label={restoring ? t("Your Sub Rosa account") : undefined}
    >
      {restoring ? null : (
        <>
          <h2 id="account-heading" className="settings-group-heading">
            {t("Account and sync")}
          </h2>
          <p className="settings-group-description">
            {t(
              "Find your work and your Carpe Diem key on your other devices. Your account is optional; you can keep working locally.",
            )}
          </p>
        </>
      )}
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
          <h3 className="settings-row-title">
            {creating ? t("Create your account") : t("Sign in to Sub Rosa")}
          </h3>
          <p className="settings-row-description">
            {creating
              ? t(
                  "The page opens in your browser. Enter your email address and choose a password, confirm the address, and it brings you back here with your Carpe Diem key ready.",
                )
              : nativePasskey
                ? t(
                    "Use a passkey on this device, or continue in your browser to create an account.",
                  )
                : t(
                    "The page opens in your browser. Enter your address and password there, and it brings you straight back here.",
                  )}
          </p>
          {native ? (
            <div className="account-form">
              <p role="status" className="settings-row-description">
                {t("Finish signing in in your browser. This screen updates by itself.")}
              </p>
              <p className="settings-row-description">
                {t("This request expires at {time}.", {
                  time: formatAccountDate(native.expires_at),
                })}
              </p>
              <div className="account-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void openExternalUrl(native.start_url)}
                >
                  {t("Reopen the page")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void run(cancelLogin)}
                >
                  {t("Cancel")}
                </button>
              </div>
            </div>
          ) : (
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => startLogin(creating));
              }}
            >
              {nativePasskey && !creating && (
                <button
                  type="button"
                  className="primary-action primary-solid"
                  disabled={busy || !serverUrl.trim()}
                  onClick={() => void run(startPasskeyLogin)}
                >
                  {t("Sign in with a passkey")}
                </button>
              )}
              <button
                type="submit"
                className={
                  nativePasskey && !creating ? "btn btn-secondary" : "primary-action primary-solid"
                }
                disabled={busy || !serverUrl.trim()}
              >
                {busy
                  ? t("Opening…")
                  : creating
                    ? t("Create my account")
                    : t("Sign in or create an account")}
              </button>
              {creating ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !serverUrl.trim()}
                  onClick={() => void run(() => startLogin(false))}
                >
                  {t("I already have an account")}
                </button>
              ) : null}
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
          )}
          {/* The way in when the page cannot hand the app back: a browser that
              refuses to open a scheme, or a desktop that never registered one.
              It is a declared fallback, not a leftover. */}
          <details className="account-advanced">
            <summary>{t("The page did not come back?")}</summary>
            {login ? (
              <div className="account-form">
                <p className="settings-row-description">
                  {t("Approve this code in your browser only if it matches:")}
                </p>
                <code className="account-login-code">{login.user_code}</code>
                <p className="settings-row-description account-login-uri">
                  {login.verification_uri}
                </p>
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
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setLogin(null)}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="account-form">
                <p className="settings-row-description">
                  {t("Sign in on the website instead, and approve a code shown here.")}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !serverUrl.trim()}
                  onClick={() => void run(startCodeLogin)}
                >
                  {t("Show me a code")}
                </button>
              </div>
            )}
          </details>
        </div>
      ) : restoring ? (
        renderRestore(status)
      ) : (
        <>
          <AccountNextStep
            step={accountNextStep({
              signedIn: true,
              vaultExists: status.vault_exists,
              vaultUnlocked: status.vault_unlocked,
              recoveryConfirmed: status.recovery_confirmed,
              syncEnabled: status.sync_enabled,
              hasLocalKey: hasLocalKey ?? false,
              keyIssuance: canIssue,
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
            {status.connection === "renewable" ? (
              <p role="status" className="settings-row-description">
                {t(
                  "This device will reconnect automatically when the account service is available.",
                )}
              </p>
            ) : null}
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
              renderVaultUnlock(status)
            )}
          </AccountCard>

          {/* The half that hands access over lives here, on a device that is
              already open. The half that asks for it moved into the vault
              card, next to the recovery key, so a new device never has to go
              looking in another section for the easier way in. */}
          {status.vault_unlocked && status.recovery_confirmed && !newRecoveryKey ? (
            <AccountCard title={t("Connect your devices")}>
              <AccountPairingSection unlocked serverUrl={status.server_url} onUnlocked={refresh} />
            </AccountCard>
          ) : null}

          <AccountCard title={t("Sync your work")}>
            <p role="status" className="settings-row-description">
              {status.sync_enabled
                ? status.last_sync_error || status.sync_issue_count || status.sync_issues?.length
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
            {status.sync_enabled && status.sync_issues?.length ? (
              <div className="account-form">
                <p className="settings-row-description">
                  {t("{count} items need your attention. Other changes continue to sync.", {
                    count: String(status.sync_issue_count ?? status.sync_issues.length),
                  })}
                </p>
                {status.sync_issues.map((issue) => (
                  <div key={`${issue.lane}:${issue.item_id}`}>
                    <strong>
                      {issue.label || t("Item {id}", { id: issue.item_id.slice(0, 8) })}
                    </strong>
                    <InlineNotice body={accountSyncError(issue.code)} />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void run(accountSyncRetryIssues)}
                >
                  {t("Retry blocked items")}
                </button>
              </div>
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
            <AccountConflictList
              conflicts={conflicts}
              onResolved={refresh}
              formatDate={formatAccountDate}
            />
          </AccountCard>

          <AccountCard title={t("Carpe Diem on your devices")}>
            <p className="settings-row-description">
              {issuedKey
                ? t(
                    "This device's key was created for it from your account, and stays on it. Your other devices get their own when they sign in.",
                  )
                : t(
                    "Share the key already saved on this device through your encrypted vault, or use the key you saved from another device.",
                  )}
            </p>
            <div className="account-actions">
              {issuedKey ? null : (
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
              )}
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
                      {/* A device authorization does not expire, so how often
                          it renewed itself is what makes a copied one visible:
                          two copies cut each other off, and the count climbs
                          on a device nobody touched (ADR 0056). */}
                      {device.renewed_at ? (
                        <p className="settings-row-description">
                          {t("Reconnected on its own {count} times, last on {time}.", {
                            count: String(device.renew_count ?? 0),
                            time: formatAccountDate(device.renewed_at),
                          })}
                        </p>
                      ) : null}
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
          <AccountSecurityHistory serverUrl={status.server_url} />
          <PublishingCard />
          <SharedProjectsCard />
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
            {issuedKey &&
            (confirmation?.kind === "logout" ||
              confirmation?.kind === "delete" ||
              (confirmation?.kind === "revoke" && confirmation.device.id === status?.device_id)) ? (
              <>
                <br />
                {t(
                  "This device's Carpe Diem key stops working too. Your credits stay on your account; signing in again creates a new key.",
                )}
              </>
            ) : null}
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

export { securityHistoryUrl } from "./AccountSecurityHistory";

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
    case "account_login_unsolicited":
      return t("A sign-in finished that this app did not start. Nothing was connected.");
    case "account_passkey_unavailable":
    case "passkey_unavailable":
      return t("The passkey could not be used. Try again or continue in your browser.");
    case "account_offline":
      return t("Your account service could not be reached. Your work is safe and will sync later.");
    case "account_revoked":
      return t("This device was signed out from your account. Sign in again to reconnect it.");
    case "vault_credential_missing":
      return t(
        "Your vault has no Carpe Diem key yet. Share it from a device where it is configured.",
      );
    case "carpe_diem_no_api_key":
      return t("Configure Carpe Diem on this device before sharing its key.");
    case "account_conflict":
      return t("Your account changed on another device. Refresh and try again.");
    case "share_window_invalid":
      return t("Choose how long the link should work.");
    case "share_too_large":
      return t("This is too large to share as a link.");
    case "share_temporary":
      return t("A temporary chat cannot be shared.");
    case "share_empty":
      return t("This conversation has nothing to share yet.");
    case "share_failed":
      return t("The link could not be created. Try again.");
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
