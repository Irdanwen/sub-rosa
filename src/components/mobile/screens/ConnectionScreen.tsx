import { intlLocale, t } from "../../../lib/i18n";
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
  placesClearGoogleKey,
  placesGetSettings,
  placesSetGoogleKey,
} from "../../../lib/tauri";
import { CarpeDiemStatusPill, useCarpeDiem } from "../../settings/CarpeDiemSettings";
import { SettingsActionRow, SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";

type EndpointChoice = "v1" | "router";

/** Short enough for three segments to share a 390 pt track. The full name
 * ("Prepaid account") is what the balance row below says. */
function railLabel(rail: CarpeDiemRail): string {
  return { auto: t("Automatic"), credits: t("Credits"), prepaid: t("Prepaid") }[rail];
}

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
      setNotice(t("API key saved. Connecting."));
      setTestResult(null);
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [keyDraft, refresh, setSettings]);

  const removeKey = useCallback(async () => {
    try {
      setSettings(await carpeDiemClearApiKey());
      setNotice(t("API key removed."));
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
      <StackHeader title={t("Connection")} onBack={onBack} backLabel={t("Settings")} />
      <div className="mobile-settings-scroll">
        <SettingsGroup>
          <SettingsRow label={t("Status")}>
            <CarpeDiemStatusPill status={status} />
          </SettingsRow>
          <SettingsActionRow
            label={testing ? t("Testing") : t("Test connection")}
            disabled={testing || !hasApiKey}
            onClick={() => void runTest()}
          />
          {status?.status === "failed" ? (
            <SettingsActionRow
              label={t("Restart the backend")}
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
          title={t("API key")}
          footer={
            <>
              {t(
                "Stored in your device keychain, never on disk in plain text. Keys start with {prefix}.",
                { prefix: CARPE_DIEM_KEY_PREFIX },
              )}
            </>
          }
        >
          <SettingsRow
            label={hasApiKey ? t("Replace your key") : t("Paste your key")}
            align="stack"
          >
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
                placeholder={hasApiKey ? t("Saved key hidden") : `${CARPE_DIEM_KEY_PREFIX}…`}
                aria-label={t("Carpe Diem API key")}
                onChange={(event) => setKeyDraft(event.currentTarget.value)}
              />
              <button type="submit" disabled={keyDraft.trim().length === 0}>
                {t("Save")}
              </button>
            </form>
          </SettingsRow>
          <SettingsActionRow label={t("Get a key")} onClick={() => void carpeDiemOpenDashboard()} />
          {hasApiKey ? (
            <SettingsActionRow
              label={t("Remove key")}
              tone="destructive"
              onClick={() => void removeKey()}
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title={t("Endpoint")}
          footer={
            endpoint === "router"
              ? t(
                  "Router is served by the cheapest market, so some requests may leave Carpe Diem's confidential network.",
                )
              : t(
                  "V1 keeps every request inside Carpe Diem's confidential network, at standard price.",
                )
          }
        >
          <SettingsRow label={t("Route requests through")} align="stack">
            <div
              className="mobile-segmented mobile-segmented-flush"
              role="radiogroup"
              aria-label={t("Carpe Diem endpoint")}
            >
              {(
                [
                  { id: "v1" as const, label: "V1", hint: t("V1 (private)") },
                  { id: "router" as const, label: t("Router"), hint: t("Router (best price)") },
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

        <PlacesKeyGroup />

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
      title={t("Payment")}
      footer={
        view.activeRailEmpty
          ? view.fundsElsewhere
            ? view.effectiveRail === "prepaid"
              ? t(
                  "Your active rail is out of funds, so requests will fail. Your credits still have {balance}, so switch rails above.",
                  { balance: formatUsd(view.otherBalanceUsdc) },
                )
              : t(
                  "Your active rail is out of funds, so requests will fail. Your prepaid account still has {balance}, so switch rails above.",
                  { balance: formatUsd(view.otherBalanceUsdc) },
                )
            : t(
                "Your active rail is out of funds, so requests will fail. Add funds on the Carpe Diem site.",
              )
          : t(
              "Carpe Diem bills one rail at a time. Your prepaid account and credits are separate balances, and the active rail is what actually pays.",
            )
      }
    >
      <SettingsRow label={t("Paying with")} align="stack">
        <div
          className="mobile-segmented mobile-segmented-flush"
          role="radiogroup"
          aria-label={t("Rail")}
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
              {busy === rail ? "…" : railLabel(rail)}
            </button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        label={t("Credits")}
        detail={t("{count} available", {
          count: billing.availableCredits.toLocaleString(intlLocale()),
        })}
      >
        <span className="mobile-settings-row-detail">{formatUsd(billing.availableUsdc)}</span>
      </SettingsRow>
      <SettingsRow
        label={t("Prepaid account")}
        detail={
          billing.rail === "auto"
            ? t("Automatic picks {balance}", { balance: railLabel(view.effectiveRail) })
            : undefined
        }
      >
        <span className="mobile-settings-row-detail">
          {billing.prepaidRegistered ? formatUsd(billing.prepaidUsdcBalance) : t("Not set up")}
        </span>
      </SettingsRow>
      {error ? <SettingsRow label={t("Could not switch rails")} detail={error} /> : null}
    </SettingsGroup>
  );
}

/**
 * The optional Google Places key behind the chat's place cards: without it
 * they run on OpenStreetMap data; with it they gain ratings, reviews and
 * photos. Same keychain discipline as the Carpe Diem key above.
 */
function PlacesKeyGroup() {
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    placesGetSettings()
      .then((settings) => {
        if (!cancelled) setKeyPresent(settings.googleKeyPresent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    try {
      const settings = await placesSetGoogleKey(keyDraft.trim());
      setKeyPresent(settings.googleKeyPresent);
      setKeyDraft("");
      hapticSelection();
    } catch {
      // The field keeps the draft; the user can correct and retry.
    }
  };

  const removeKey = async () => {
    try {
      const settings = await placesClearGoogleKey();
      setKeyPresent(settings.googleKeyPresent);
      hapticSelection();
    } catch {
      // Best-effort; the row re-reads on next visit.
    }
  };

  return (
    <SettingsGroup
      title={t("Place search")}
      footer={t(
        "Place cards work without any key, using OpenStreetMap data. Your own Google Places key adds ratings, reviews and photos; it stays in the keychain and is only sent with place searches.",
      )}
    >
      <SettingsRow
        label={keyPresent ? t("Replace your key") : t("Google Places key")}
        align="stack"
      >
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
            placeholder={keyPresent ? t("Saved key hidden") : "AIza…"}
            aria-label={t("Google Places API key")}
            onChange={(event) => setKeyDraft(event.currentTarget.value)}
          />
          <button type="submit" disabled={keyDraft.trim().length === 0}>
            {t("Save")}
          </button>
        </form>
      </SettingsRow>
      {keyPresent ? (
        <SettingsActionRow
          label={t("Remove key")}
          tone="destructive"
          onClick={() => void removeKey()}
        />
      ) : null}
    </SettingsGroup>
  );
}
