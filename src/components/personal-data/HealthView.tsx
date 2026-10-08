import "../../styles/personal-data.css";
import "../../styles/chat-data.css";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ACCOUNT_SYNC_UPDATED_EVENT } from "../../lib/account-sync-events";
import { messageFromError } from "../../lib/errors";
import {
  dayRange,
  formatHealthValue,
  HEALTH_METRICS,
  type HealthDay,
  type HealthMetric,
  type HealthStatus,
  healthAverage,
  healthChart,
  healthChoose,
  healthDays,
  healthForget,
  healthMetricLabel,
  healthRefresh,
  healthSetSync,
  healthStatus,
} from "../../lib/health";
import { t } from "../../lib/i18n";
import { ChartCard } from "../chat-blocks/ChartCard";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Switch } from "../ui/Switch";

type Span = "7" | "30" | "90";

/**
 * Health (ADR-0099): the daily summaries of the measures the person picked,
 * as charts, with the choice of what to read and what may travel. The same
 * view on both shells. A phone reads its own health store; a computer has
 * none and shows only what a phone sent with the person's consent.
 */
export function HealthView({ header }: { header?: ReactNode }) {
  const [status, setStatus] = useState<HealthStatus | null>(null);
  const [days, setDays] = useState<HealthDay[]>([]);
  const [span, setSpan] = useState<Span>("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => dayRange(Number(span)), [span]);
  const phone = status !== null && status.source !== "none";

  const load = useCallback(async () => {
    try {
      const [next, read] = await Promise.all([
        healthStatus(),
        healthDays(range[0], range[range.length - 1]),
      ]);
      setStatus(next);
      setDays(read);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // A phone reads its store again whenever the view opens.
  const source = status?.source;
  useEffect(() => {
    if (!source || source === "none") return;
    let cancelled = false;
    void healthRefresh()
      .then((next) => {
        if (!cancelled) setStatus(next);
        return healthDays(range[0], range[range.length - 1]);
      })
      .then((read) => {
        if (!cancelled && read) setDays(read);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, range]);

  // On a computer, what a phone sends arrives through the account.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen(ACCOUNT_SYNC_UPDATED_EVENT, () => void load()).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [load]);

  const run = async (work: () => Promise<HealthStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await work());
      setDays(await healthDays(range[0], range[range.length - 1]));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const enabled = new Set(status?.metrics.filter((m) => m.enabled).map((m) => m.metric) ?? []);
  const withData = HEALTH_METRICS.filter((metric) => days.some((day) => day.metric === metric));
  const toggle = (metric: HealthMetric) => {
    const next = new Set(enabled);
    if (next.has(metric)) next.delete(metric);
    else next.add(metric);
    void run(() => healthChoose(HEALTH_METRICS.filter((key) => next.has(key))));
  };

  return (
    <div className="personal-view">
      {header}
      <p className="personal-view-lead">
        {phone
          ? t(
              "Sub Rosa reads only the measures you pick, never writes to your health app, and keeps one summary a day on this phone.",
            )
          : t(
              "This computer has no health app. It shows what your phone sends, only for the measures you chose to sync there.",
            )}
      </p>
      {error ? (
        <p className="personal-error" role="alert">
          {error}
        </p>
      ) : null}
      {phone && status?.availability !== "available" ? (
        <p className="personal-quiet">
          {status?.availability === "update_required"
            ? t("Update Health Connect from the Play Store to read your health data.")
            : t("Health data cannot be read on this device.")}
        </p>
      ) : null}

      {withData.length > 0 ? (
        <section className="personal-section" aria-label={t("Charts")}>
          <div className="personal-row personal-row-spread">
            <SegmentedControl
              value={span}
              onValueChange={setSpan}
              aria-label={t("Time range")}
              options={[
                { value: "7", label: t("7 days") },
                { value: "30", label: t("30 days") },
                { value: "90", label: t("90 days") },
              ]}
            />
            {phone ? (
              <button
                type="button"
                className="personal-button"
                disabled={busy}
                onClick={() => void run(healthRefresh)}
              >
                <IconArrowRotateClockwise size={16} />
                {t("Refresh")}
              </button>
            ) : null}
          </div>
          <div className="personal-charts">
            {withData.map((metric) => {
              const average = healthAverage(metric, days);
              return (
                <div key={metric} className="personal-section">
                  <ChartCard block={healthChart(metric, days, range)} />
                  {average !== null ? (
                    <p className="personal-quiet">
                      {t("Average: {value}", { value: formatHealthValue(metric, average) })}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : status ? (
        <EmptyState
          icon={<IconHeartBeat size={28} />}
          title={t("No health data yet")}
          description={
            phone
              ? t("Pick the measures Sub Rosa may read below.")
              : t(
                  "On your phone, open Health in Sub Rosa and switch on sync for the measures you want here.",
                )
          }
        />
      ) : (
        <p className="personal-quiet">{t("Loading")}</p>
      )}

      {status ? (
        <section className="personal-section">
          <h2 className="personal-section-title">{t("Measures")}</h2>
          <ul className="personal-metric-list">
            {status.metrics.map((state) => (
              <li key={state.metric} className="personal-list-row">
                <div className="personal-list-main">
                  <span className="personal-list-title">{healthMetricLabel(state.metric)}</span>
                  <span className="personal-list-meta">
                    {state.days === 0
                      ? t("Nothing stored")
                      : state.days === 1
                        ? t("1 day stored")
                        : t("{count} days stored", { count: state.days })}
                  </span>
                </div>
                {phone ? (
                  <>
                    <span className="personal-check">
                      <Switch
                        checked={state.enabled}
                        disabled={busy || status.availability !== "available"}
                        onCheckedChange={() => toggle(state.metric)}
                        aria-label={t("Read {measure}", {
                          measure: healthMetricLabel(state.metric),
                        })}
                      />
                      {t("Read")}
                    </span>
                    <span className="personal-check">
                      <Switch
                        checked={state.sync}
                        disabled={busy}
                        onCheckedChange={(sync) =>
                          void run(() => healthSetSync(state.metric, sync))
                        }
                        aria-label={t("Sync {measure} with your account", {
                          measure: healthMetricLabel(state.metric),
                        })}
                      />
                      {t("Sync")}
                    </span>
                  </>
                ) : null}
                {state.days > 0 ? (
                  <button
                    type="button"
                    className="personal-button"
                    data-tone="danger"
                    disabled={busy}
                    onClick={() => void run(() => healthForget(state.metric))}
                  >
                    {t("Delete")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="personal-quiet">
            {t(
              "Sync is off for every measure until you switch it on. A synced measure is encrypted with your account like your notes. Deleting here never touches your health app.",
            )}
          </p>
        </section>
      ) : null}
    </div>
  );
}
