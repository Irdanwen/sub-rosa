import { useCallback, useEffect, useId, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  carpeDiemClearApiKey,
  carpeDiemGetSettings,
  carpeDiemRestartSidecar,
  carpeDiemSetApiKey,
  carpeDiemSetBaseUrl,
  carpeDiemSidecarStatus,
  carpeDiemTestConnection,
  type CarpeDiemSettingsDto,
  type CarpeDiemSidecarStatusDto,
  type CarpeDiemTestConnectionResult,
} from "../../lib/tauri";
import { messageFromError } from "../../lib/errors";
import { CARPE_DIEM_DASHBOARD_URL, CARPE_DIEM_KEY_PREFIX } from "../../lib/branding";

export const SIDECAR_STATUS_EVENT = "carpe-diem://sidecar-status";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; result: CarpeDiemTestConnectionResult };

/** Live sidecar status, kept in sync via the backend event. Exposed so the
 * onboarding gate and the settings section share one subscription pattern. */
export function useCarpeDiem() {
  const [settings, setSettings] = useState<CarpeDiemSettingsDto | null>(null);
  const [status, setStatus] = useState<CarpeDiemSidecarStatusDto | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [next, nextStatus] = await Promise.all([
        carpeDiemGetSettings(),
        carpeDiemSidecarStatus(),
      ]);
      setSettings(next);
      setStatus(nextStatus);
      setError(undefined);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<CarpeDiemSidecarStatusDto>(SIDECAR_STATUS_EVENT, (event) => {
      setStatus(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return { settings, status, error, refresh, setSettings };
}

const STATUS_COPY: Record<CarpeDiemSidecarStatusDto["status"], string> = {
  unconfigured: "Not connected",
  starting: "Starting…",
  ready: "Connected",
  failed: "Backend error",
};

export function CarpeDiemStatusPill({ status }: { status: CarpeDiemSidecarStatusDto | null }) {
  const state = status?.status ?? "unconfigured";
  return (
    <span className="settings-row-substatus carpe-diem-status" role="status" aria-live="polite">
      <span className="carpe-diem-status-dot" data-state={state} aria-hidden />
      {STATUS_COPY[state]}
      {status?.message ? `: ${status.message}` : ""}
    </span>
  );
}

/**
 * Carpe Diem connection controls: base URL + API key + Test connection, with
 * live sidecar status. Reused in the Settings tab and (compact) in onboarding.
 */
export function CarpeDiemSettings({ compact = false }: { compact?: boolean }) {
  const { settings, status, refresh, setSettings } = useCarpeDiem();
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const keyInputId = useId();

  // Seed the base URL field once settings load, without clobbering edits.
  useEffect(() => {
    if (settings && baseUrlDraft === "") {
      setBaseUrlDraft(settings.baseUrl);
    }
  }, [settings, baseUrlDraft]);

  // Advancing past the onboarding gate is driven by App.tsx, which watches the
  // sidecar status event and re-derives `carpeDiemRequired` from `hasApiKey` +
  // status — so this component doesn't need an onConnected callback.

  const saveBaseUrl = useCallback(async () => {
    try {
      const next = await carpeDiemSetBaseUrl(baseUrlDraft);
      setSettings(next);
      setNotice("Base URL saved.");
      setTest({ kind: "idle" });
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [baseUrlDraft, setSettings]);

  const resetBaseUrl = useCallback(async () => {
    if (!settings) return;
    setBaseUrlDraft(settings.defaultBaseUrl);
    try {
      const next = await carpeDiemSetBaseUrl(settings.defaultBaseUrl);
      setSettings(next);
      setNotice("Base URL reset to the default.");
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [settings, setSettings]);

  const saveKey = useCallback(async () => {
    try {
      const next = await carpeDiemSetApiKey(keyDraft);
      setSettings(next);
      setKeyDraft("");
      setNotice("API key saved. Connecting…");
      setTest({ kind: "idle" });
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [keyDraft, refresh, setSettings]);

  const removeKey = useCallback(async () => {
    try {
      const next = await carpeDiemClearApiKey();
      setSettings(next);
      setNotice("API key removed.");
      setTest({ kind: "idle" });
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [refresh, setSettings]);

  const runTest = useCallback(async () => {
    setTest({ kind: "testing" });
    try {
      const result = await carpeDiemTestConnection();
      setTest({ kind: "done", result });
    } catch (err) {
      setTest({
        kind: "done",
        result: { ok: false, message: messageFromError(err) },
      });
    }
  }, []);

  const hasApiKey = settings?.hasApiKey ?? false;
  const canSaveKey = keyDraft.trim().length > 0;
  const canSaveBaseUrl =
    baseUrlDraft.trim().length > 0 && baseUrlDraft.trim() !== settings?.baseUrl;

  return (
    <div className={compact ? "carpe-diem-connect" : "settings-group"}>
      {!compact ? <h2 className="settings-group-heading">Carpe Diem</h2> : null}
      <div className="settings-card">
        <div className="settings-rows">
          {/* Base URL */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Base URL</h3>
              <p className="settings-row-description">
                The Carpe Diem endpoint. Leave the default unless you were told to change it.
              </p>
            </div>
            <div className="settings-row-control settings-secret-control">
              <input
                className="settings-secret-input"
                type="text"
                value={baseUrlDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder={settings?.defaultBaseUrl ?? "https://…"}
                aria-label="Carpe Diem base URL"
                onChange={(event) => setBaseUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSaveBaseUrl) void saveBaseUrl();
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canSaveBaseUrl}
                onClick={() => void saveBaseUrl()}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void resetBaseUrl()}
              >
                Reset
              </button>
            </div>
          </div>

          {/* API key */}
          <div className="settings-row settings-row-venice-key">
            <div className="settings-row-info">
              <h3 className="settings-row-title">API key</h3>
              <p className="settings-row-description">
                Your Carpe Diem key ({CARPE_DIEM_KEY_PREFIX}…). Stored in your system keychain,
                never on disk in plain text.{" "}
                <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
                  Get a key
                </a>
                .
              </p>
              <CarpeDiemStatusPill status={status} />
            </div>
            <div className="settings-row-control settings-secret-control">
              <input
                id={keyInputId}
                className="settings-secret-input"
                type="password"
                value={keyDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder={hasApiKey ? "Saved key hidden" : `${CARPE_DIEM_KEY_PREFIX}…`}
                aria-label="Carpe Diem API key"
                onChange={(event) => setKeyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSaveKey) void saveKey();
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canSaveKey}
                onClick={() => void saveKey()}
              >
                Save
              </button>
              {hasApiKey ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void removeKey()}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>

          {/* Test connection */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Test connection</h3>
              <p className="settings-row-description">
                Checks the base URL, key, and available credits.
              </p>
              {test.kind === "done" ? (
                <p
                  className="settings-row-description settings-row-substatus carpe-diem-test-result"
                  data-ok={test.result.ok ? "true" : "false"}
                >
                  {test.result.message}
                </p>
              ) : null}
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={test.kind === "testing" || !hasApiKey}
                onClick={() => void runTest()}
              >
                {test.kind === "testing" ? "Testing…" : "Test connection"}
              </button>
              {status?.status === "failed" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void carpeDiemRestartSidecar()}
                >
                  Retry
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {notice ? <p className="settings-row-description settings-row-substatus">{notice}</p> : null}
    </div>
  );
}
