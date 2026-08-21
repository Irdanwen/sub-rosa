import { useCallback, useEffect, useId, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  type CarpeDiemBillingDto,
  carpeDiemCacheStats,
  carpeDiemClearApiKey,
  carpeDiemGetBilling,
  carpeDiemGetSettings,
  type CarpeDiemRail,
  carpeDiemRestartSidecar,
  carpeDiemSetApiKey,
  carpeDiemSetBaseUrl,
  carpeDiemSetRail,
  type CarpeDiemSettingsDto,
  type CarpeDiemSidecarStatusDto,
  type CarpeDiemTestConnectionResult,
  carpeDiemSidecarStatus,
  carpeDiemTestConnection,
} from "../../lib/tauri";
import { deriveBilling, formatUsd } from "../../lib/carpe-diem-billing";
import { type CacheUsage, hasMeasuredTurns, parseCacheUsage } from "../../lib/carpe-diem-cache";
import { messageFromError } from "../../lib/errors";
import { CARPE_DIEM_DASHBOARD_URL, CARPE_DIEM_KEY_PREFIX } from "../../lib/branding";
import { SegmentedControl } from "../ui/SegmentedControl";

/** The two Carpe Diem endpoint rails the user chooses between. */
type EndpointChoice = "v1" | "router";

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

const RAIL_LABELS: Record<CarpeDiemRail, string> = {
  auto: "Automatic",
  credits: "Credits",
  prepaid: "Prepaid account",
};

/** Rail-aware payment panel. Carpe Diem bills one rail at a time — a prepaid
 * account and a credits pool are separate balances, and the active rail can be
 * empty while the other has funds (a 402 that "top up" doesn't fix). Shows both
 * balances + the active rail, warns when the active rail is out of funds, and
 * lets the user switch rails. Renders nothing for Venice keys (no rails) or
 * before the first successful fetch. */
function CarpeDiemPayment({ hasApiKey }: { hasApiKey: boolean }) {
  const [billing, setBilling] = useState<CarpeDiemBillingDto | null>(null);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState<CarpeDiemRail | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setBilling(await carpeDiemGetBilling());
      setSupported(true);
    } catch {
      // Venice key (no rails) or unreachable — hide the panel silently.
      setSupported(false);
    }
  }, []);

  useEffect(() => {
    if (hasApiKey) void load();
    else setBilling(null);
  }, [hasApiKey, load]);

  const switchRail = useCallback(async (rail: CarpeDiemRail) => {
    setBusy(rail);
    setError(undefined);
    try {
      setBilling(await carpeDiemSetRail(rail));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(null);
    }
  }, []);

  if (!hasApiKey || !supported || !billing) return null;
  const view = deriveBilling(billing);
  const rails: CarpeDiemRail[] = billing.hasPrepaidAccount
    ? ["auto", "credits", "prepaid"]
    : ["auto", "credits"];

  return (
    <div className="settings-card carpe-diem-payment">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Payment</h3>
            <p className="settings-row-description">
              Carpe Diem bills one rail at a time. Your prepaid account and credits are separate
              balances — the active rail is what actually pays.
            </p>
            {view.activeRailEmpty ? (
              <p className="settings-row-description carpe-diem-payment-warning" role="status">
                Your active rail ({RAIL_LABELS[view.effectiveRail].toLowerCase()}) is out of funds,
                so requests will fail.{" "}
                {view.fundsElsewhere
                  ? `Your ${
                      view.effectiveRail === "prepaid" ? "credits" : "prepaid account"
                    } still has ${formatUsd(view.otherBalanceUsdc)} — switch rails below.`
                  : "Add funds on the Carpe Diem site."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Balances</h3>
            <p className="settings-row-description">
              Prepaid account:{" "}
              {billing.prepaidRegistered ? formatUsd(billing.prepaidUsdcBalance) : "not set up"}
              {" · "}
              Credits: {formatUsd(billing.availableUsdc)} (
              {billing.availableCredits.toLocaleString()} credits)
            </p>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Active rail</h3>
            <p className="settings-row-description">
              {RAIL_LABELS[billing.rail]}
              {billing.rail === "auto" ? ` — paying via ${view.effectiveRail}` : ""}
            </p>
            {error ? (
              <p className="settings-row-description settings-row-substatus" data-ok="false">
                {error}
              </p>
            ) : null}
          </div>
          <div className="settings-row-control carpe-diem-rail-choices">
            {rails.map((rail) => (
              <button
                key={rail}
                type="button"
                className="btn btn-secondary"
                aria-pressed={billing.rail === rail}
                disabled={busy !== null || billing.rail === rail}
                onClick={() => void switchRail(rail)}
              >
                {busy === rail ? "…" : RAIL_LABELS[rail]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the provider's prompt cache did for this run of the app.
 *
 * Sub Rosa sends the same standing instructions on every turn, so most of a
 * warm conversation's prompt is served from the provider's cache and billed at
 * a lower rate. This is the only place either shell says so. It counts every
 * request the app makes, not one conversation, and it resets when the app
 * restarts, so the copy says exactly that rather than implying a lifetime
 * total. Renders nothing until a turn has actually been measured: an empty card
 * is honest, a 0 % hit rate on a fresh launch is not. */
function CarpeDiemCache({ hasApiKey }: { hasApiKey: boolean }) {
  const [cache, setCache] = useState<CacheUsage | null>(null);

  useEffect(() => {
    if (!hasApiKey) {
      setCache(null);
      return;
    }
    let live = true;
    // Best effort: a ledger read that fails leaves the card hidden. It is
    // telemetry, and it must never be the reason Settings shows an error.
    carpeDiemCacheStats().then(
      (stats) => {
        if (live) setCache(parseCacheUsage(stats));
      },
      () => {
        if (live) setCache(null);
      },
    );
    return () => {
      live = false;
    };
  }, [hasApiKey]);

  if (!cache || !hasMeasuredTurns(cache)) return null;
  const pct = cache.hitRatio === undefined ? null : Math.round(cache.hitRatio * 100);

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Prompt cache</h3>
            <p className="settings-row-description">
              {(cache.cachedTokens ?? 0).toLocaleString()} of{" "}
              {(cache.promptTokens ?? 0).toLocaleString()} prompt tokens came from the provider's
              cache{pct === null ? "" : ` (${pct}%)`} across {(cache.turns ?? 0).toLocaleString()}{" "}
              requests since the app started.
              {cache.savedUsd !== undefined && cache.savedUsd > 0
                ? ` The provider reports that saved ${formatUsd(cache.savedUsd)}.`
                : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Carpe Diem connection controls: base URL + API key + Test connection + the
 * rail-aware Payment panel, with live sidecar status. Reused in the Settings
 * tab and (compact) in onboarding.
 */
export function CarpeDiemSettings({ compact = false }: { compact?: boolean }) {
  const { settings, status, refresh, setSettings } = useCarpeDiem();
  const [keyDraft, setKeyDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const keyInputId = useId();

  // Advancing past the onboarding gate is driven by App.tsx, which watches the
  // sidecar status event and re-derives `carpeDiemRequired` from `hasApiKey` +
  // status — so this component doesn't need an onConnected callback.

  // The stored base is one of the two known rails; default to Router (the app
  // default) while settings are still loading so the control doesn't flash.
  const endpoint: EndpointChoice =
    settings && settings.baseUrl === settings.v1BaseUrl ? "v1" : "router";

  const selectEndpoint = useCallback(
    async (choice: EndpointChoice) => {
      if (!settings) return;
      const url = choice === "router" ? settings.routerBaseUrl : settings.v1BaseUrl;
      if (url === settings.baseUrl) return;
      try {
        const next = await carpeDiemSetBaseUrl(url);
        setSettings(next);
        setNotice(
          choice === "router" ? "Switched to the Router endpoint." : "Switched to the V1 endpoint.",
        );
        setTest({ kind: "idle" });
      } catch (err) {
        setNotice(messageFromError(err));
      }
    },
    [settings, setSettings],
  );

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

  return (
    <div className={compact ? "carpe-diem-connect" : "settings-group"}>
      {!compact ? <h2 className="settings-group-heading">Carpe Diem</h2> : null}
      <div className="settings-card">
        <div className="settings-rows">
          {/* Endpoint (V1 vs Router) */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Endpoint</h3>
              <p className="settings-row-description">
                {endpoint === "router"
                  ? "Router: served by the cheapest market, so some requests may leave Carpe Diem's confidential network."
                  : "V1: every request stays inside Carpe Diem's confidential network, at standard price."}
              </p>
            </div>
            <div className="settings-row-control">
              <SegmentedControl<EndpointChoice>
                aria-label="Carpe Diem endpoint"
                value={endpoint}
                onValueChange={(value) => void selectEndpoint(value)}
                options={[
                  { value: "v1", label: "V1", ariaLabel: "V1 (private)" },
                  { value: "router", label: "Router", ariaLabel: "Router (best price)" },
                ]}
              />
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
      <CarpeDiemPayment hasApiKey={hasApiKey} />
      <CarpeDiemCache hasApiKey={hasApiKey} />
      {notice ? <p className="settings-row-description settings-row-substatus">{notice}</p> : null}
    </div>
  );
}
