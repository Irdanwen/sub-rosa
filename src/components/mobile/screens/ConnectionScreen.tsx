import { useCallback, useEffect, useState } from "react";
import { CARPE_DIEM_KEY_PREFIX } from "../../../lib/branding";
import { deriveBilling, formatUsd } from "../../../lib/carpe-diem-billing";
import { messageFromError } from "../../../lib/errors";
import { hapticSelection } from "../../../lib/haptics";
import {
  type CarpeDiemBillingDto,
  type CarpeDiemRail,
  type CarpeDiemTestConnectionResult,
  carpeDiemClearApiKey,
  carpeDiemGetBilling,
  carpeDiemOpenDashboard,
  carpeDiemRestartSidecar,
  carpeDiemSetApiKey,
  carpeDiemSetBaseUrl,
  carpeDiemSetRail,
  carpeDiemTestConnection,
} from "../../../lib/tauri";
import { CarpeDiemStatusPill, useCarpeDiem } from "../../settings/CarpeDiemSettings";
import { SettingsActionRow, SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";

type EndpointChoice = "v1" | "router";

/** Short enough for three segments to share a 390 pt track. The full name
 * ("Prepaid account") is what the balance row below says. */
const RAIL_LABELS: Record<CarpeDiemRail, string> = {
  auto: "Automatic",
  credits: "Credits",
  prepaid: "Prepaid",
};

/**
 * The Carpe Diem connection, as its own pushed screen.
 *
 * The desktop `CarpeDiemSettings` is still what onboarding and the desktop
 * Settings tab use; this is the same set of controls in the phone's own shape.
 * Sharing the component meant sharing its two-column `settings-row` grid,
 * which on a 390 pt screen pushed "Remove" onto its own line and squeezed
 * every description into half the width.
 */
export function ConnectionScreen({ onBack }: { onBack: () => void }) {
  const { settings, status, refresh, setSettings } = useCarpeDiem();
  const [keyDraft, setKeyDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CarpeDiemTestConnectionResult | null>(null);

  const endpoint: EndpointChoice =
    settings && settings.baseUrl === settings.v1BaseUrl ? "v1" : "router";
  const hasApiKey = settings?.hasApiKey ?? false;

  const selectEndpoint = useCallback(
    async (choice: EndpointChoice) => {
      if (!settings) return;
      const url = choice === "router" ? settings.routerBaseUrl : settings.v1BaseUrl;
      if (url === settings.baseUrl) return;
      hapticSelection();
      try {
        setSettings(await carpeDiemSetBaseUrl(url));
        setTestResult(null);
        setNotice(undefined);
      } catch (err) {
        setNotice(messageFromError(err));
      }
    },
    [settings, setSettings],
  );

  const saveKey = useCallback(async () => {
    try {
      setSettings(await carpeDiemSetApiKey(keyDraft));
      setKeyDraft("");
      setNotice("API key saved. Connecting.");
      setTestResult(null);
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [keyDraft, refresh, setSettings]);

  const removeKey = useCallback(async () => {
    try {
      setSettings(await carpeDiemClearApiKey());
      setNotice("API key removed.");
      setTestResult(null);
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [refresh, setSettings]);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      setTestResult(await carpeDiemTestConnection());
    } catch (err) {
      setTestResult({ ok: false, message: messageFromError(err) });
    } finally {
      setTesting(false);
    }
  }, []);

  return (
    <div className="mobile-screen-root">
      <StackHeader title="Connection" onBack={onBack} backLabel="Settings" />
      <div className="mobile-settings-scroll">
        <SettingsGroup>
          <SettingsRow label="Status">
            <CarpeDiemStatusPill status={status} />
          </SettingsRow>
          <SettingsActionRow
            label={testing ? "Testing" : "Test connection"}
            disabled={testing || !hasApiKey}
            onClick={() => void runTest()}
          />
          {status?.status === "failed" ? (
            <SettingsActionRow
              label="Restart the backend"
              onClick={() => void carpeDiemRestartSidecar()}
            />
          ) : null}
        </SettingsGroup>
        {testResult ? (
          <p
            className="mobile-settings-footnote mobile-settings-result"
            data-ok={testResult.ok ? "true" : "false"}
            role="status"
          >
            {testResult.message}
          </p>
        ) : null}

        <SettingsGroup
          title="API key"
          footer={
            <>
              Stored in your device keychain, never on disk in plain text. Keys start with{" "}
              {CARPE_DIEM_KEY_PREFIX}.
            </>
          }
        >
          <SettingsRow label={hasApiKey ? "Replace your key" : "Paste your key"} align="stack">
            <form
              className="mobile-memory-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (keyDraft.trim()) void saveKey();
              }}
            >
              <input
                type="password"
                value={keyDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder={hasApiKey ? "Saved key hidden" : `${CARPE_DIEM_KEY_PREFIX}…`}
                aria-label="Carpe Diem API key"
                onChange={(event) => setKeyDraft(event.currentTarget.value)}
              />
              <button type="submit" disabled={keyDraft.trim().length === 0}>
                Save
              </button>
            </form>
          </SettingsRow>
          <SettingsActionRow label="Get a key" onClick={() => void carpeDiemOpenDashboard()} />
          {hasApiKey ? (
            <SettingsActionRow
              label="Remove key"
              tone="destructive"
              onClick={() => void removeKey()}
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title="Endpoint"
          footer={
            endpoint === "router"
              ? "Router is served by the cheapest market, so some requests may leave Carpe Diem's confidential network."
              : "V1 keeps every request inside Carpe Diem's confidential network, at standard price."
          }
        >
          <SettingsRow label="Route requests through" align="stack">
            <div
              className="mobile-segmented mobile-segmented-flush"
              role="radiogroup"
              aria-label="Carpe Diem endpoint"
            >
              {(
                [
                  { id: "v1" as const, label: "V1", hint: "V1 (private)" },
                  { id: "router" as const, label: "Router", hint: "Router (best price)" },
                ] satisfies Array<{ id: EndpointChoice; label: string; hint: string }>
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="mobile-segmented-item"
                  role="radio"
                  aria-label={option.hint}
                  aria-checked={endpoint === option.id}
                  data-active={endpoint === option.id ? "true" : undefined}
                  onClick={() => void selectEndpoint(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>

        <PaymentGroup hasApiKey={hasApiKey} />

        {notice ? (
          <p className="mobile-settings-footnote" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Rail-aware payment. Carpe Diem bills one rail at a time, and the active
 * rail can be empty while the other holds funds, so the balances and the
 * switch belong together. Renders nothing for Venice keys (no rails). */
function PaymentGroup({ hasApiKey }: { hasApiKey: boolean }) {
  const [billing, setBilling] = useState<CarpeDiemBillingDto | null>(null);
  const [busy, setBusy] = useState<CarpeDiemRail | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!hasApiKey) {
      setBilling(null);
      return;
    }
    carpeDiemGetBilling()
      .then(setBilling)
      // Venice key (no rails) or unreachable: the whole group stays hidden.
      .catch(() => setBilling(null));
  }, [hasApiKey]);

  const switchRail = useCallback(async (rail: CarpeDiemRail) => {
    hapticSelection();
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

  if (!billing) return null;
  const view = deriveBilling(billing);
  const rails: CarpeDiemRail[] = billing.hasPrepaidAccount
    ? ["auto", "credits", "prepaid"]
    : ["auto", "credits"];

  return (
    <SettingsGroup
      title="Payment"
      footer={
        view.activeRailEmpty
          ? `Your active rail is out of funds, so requests will fail. ${
              view.fundsElsewhere
                ? `Your ${
                    view.effectiveRail === "prepaid" ? "credits" : "prepaid account"
                  } still has ${formatUsd(view.otherBalanceUsdc)}, so switch rails above.`
                : "Add funds on the Carpe Diem site."
            }`
          : "Carpe Diem bills one rail at a time. Your prepaid account and credits are separate balances, and the active rail is what actually pays."
      }
    >
      <SettingsRow label="Paying with" align="stack">
        <div
          className="mobile-segmented mobile-segmented-flush"
          role="radiogroup"
          aria-label="Rail"
        >
          {rails.map((rail) => (
            <button
              key={rail}
              type="button"
              className="mobile-segmented-item"
              role="radio"
              aria-checked={billing.rail === rail}
              data-active={billing.rail === rail ? "true" : undefined}
              disabled={busy !== null}
              onClick={() => void switchRail(rail)}
            >
              {busy === rail ? "…" : RAIL_LABELS[rail]}
            </button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        label="Credits"
        detail={`${billing.availableCredits.toLocaleString()} available`}
      >
        <span className="mobile-settings-row-detail">{formatUsd(billing.availableUsdc)}</span>
      </SettingsRow>
      <SettingsRow
        label="Prepaid account"
        detail={billing.rail === "auto" ? `Automatic picks ${view.effectiveRail}` : undefined}
      >
        <span className="mobile-settings-row-detail">
          {billing.prepaidRegistered ? formatUsd(billing.prepaidUsdcBalance) : "Not set up"}
        </span>
      </SettingsRow>
      {error ? <SettingsRow label="Could not switch rails" detail={error} /> : null}
    </SettingsGroup>
  );
}
