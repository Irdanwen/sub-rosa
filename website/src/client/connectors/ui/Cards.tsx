import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { BlockProps, ComposerControlProps, FeatureHost } from "../../feature";
import {
  type AppRecord,
  ConfirmNeeded,
  framedDocument,
  getApp,
  handleBridgeMessage,
  originOf,
  parseBridgeMessage,
  viewHostUrl,
} from "../apps";
import { type CallRecord, getCall, pendingCalls } from "../calls";
import { envFor } from "../env";
import { effectiveRule } from "../rules";
import { callTool } from "../runtime";
import { getConnector, localState } from "../store";
import { decide } from "../turn";
import { relayError, relayStatus } from "./relay-words";

function statusText(call: CallRecord) {
  const waiting = relayStatus(call);
  if (waiting) return waiting;
  switch (call.status) {
    case "pending":
      return t("Waiting for your approval", "En attente de votre accord");
    case "running":
      return t("Running…", "En cours…");
    case "done":
      return t("Done", "Terminé");
    case "failed":
      return t("Failed", "Échec");
    case "denied":
      return t("Declined", "Refusé");
  }
}

function CallView({
  host,
  call,
  onDecided,
}: {
  host: FeatureHost;
  call: CallRecord;
  onDecided: () => void;
}) {
  const connector = getConnector(host.sync, call.connectorId);
  const [working, setWorking] = useState(false);
  const answer = async (approve: boolean) => {
    setWorking(true);
    try {
      await decide(envFor(host), host, call.id, approve);
    } finally {
      setWorking(false);
      onDecided();
    }
  };
  return (
    <section className="cn-card" aria-label={t("Connector action", "Action de connecteur")}>
      <div className="wc-row">
        <strong>
          {connector?.name ?? call.connectorId} · {call.tool}
        </strong>
        <span className="quiet">{statusText(call)}</span>
      </div>
      <details>
        <summary>{t("What it sends", "Ce qui est envoyé")}</summary>
        <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
      </details>
      {call.status === "pending" && (
        <div className="wc-row">
          <button
            className="button primary"
            type="button"
            disabled={working}
            onClick={() => void answer(true)}
          >
            {t("Approve", "Approuver")}
          </button>
          <button
            className="button"
            type="button"
            disabled={working}
            onClick={() => void answer(false)}
          >
            {t("Decline", "Refuser")}
          </button>
        </div>
      )}
      {call.result && <pre>{call.result.text}</pre>}
      {call.result?.links.map((link) => (
        <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">
          {link.title}
        </a>
      ))}
      {call.error && <p className="quiet">{relayError(call)}</p>}
      {call.appId && <AppFrame host={host} appId={call.appId} />}
    </section>
  );
}

/** `subrosa:connector`: one call, its state, and Approve when it asks. */
export function ConnectorCallBlock({ payload, host }: BlockProps) {
  const id = typeof payload.callId === "string" ? payload.callId : "";
  const [call, setCall] = useState<CallRecord | null | undefined>(undefined);
  const load = useCallback(async () => {
    setCall(id ? ((await getCall(host.storeFor("connectors"), id)) ?? null) : null);
  }, [host, id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (call === undefined) return null;
  if (!call)
    return (
      <p className="quiet">
        {t(
          "This action was proposed on another device. Review it there.",
          "Cette action a été proposée sur un autre appareil. Examinez-la là-bas.",
        )}
      </p>
    );
  return <CallView host={host} call={call} onDecided={() => void load()} />;
}

/** `subrosa:app`: a connector's interactive view. */
export function ConnectorAppBlock({ payload, host }: BlockProps) {
  const id = typeof payload.appId === "string" ? payload.appId : "";
  return id ? <AppFrame host={host} appId={id} /> : null;
}

/** The actions waiting for the person in the open chat, beside the
 * composer, so an ask is never lost when its card is not in the reply. */
export function PendingActions({ host, chatId }: ComposerControlProps) {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const busy = host.busy;
  const load = useCallback(async () => {
    setCalls(chatId ? await pendingCalls(host.storeFor("connectors"), chatId) : []);
  }, [host, chatId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished turn may have filed asks.
  useEffect(() => {
    void load();
  }, [load, busy]);
  if (!calls.length) return null;
  return (
    <fieldset className="cn-pending">
      <legend className="sr-only">{t("Actions waiting for you", "Actions en attente")}</legend>
      {calls.map((call) => (
        <CallView key={call.id} host={host} call={call} onDecided={() => void load()} />
      ))}
    </fieldset>
  );
}

function prefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** A view in the sandboxed frame, and the bridge that answers it. */
function AppFrame({ host, appId }: { host: FeatureHost; appId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [app, setApp] = useState<AppRecord | null | undefined>(undefined);
  const [height, setHeight] = useState(240);
  const [confirming, setConfirming] = useState<{
    tool: string;
    done: (ok: boolean) => void;
  } | null>(null);
  useEffect(() => {
    void getApp(host.storeFor("connectors"), appId).then((found) => setApp(found ?? null));
  }, [host, appId]);

  useEffect(() => {
    if (!app) return;
    const env = envFor(host);
    const connector = getConnector(host.sync, app.connectorId);
    const origin = connector ? originOf(connector.url) : "";
    const theme = prefersDark() ? "dark" : "light";
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
    const listener = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== "null") return;
      if ((event.data as { type?: unknown } | null)?.type === "subrosa-view-ready") {
        post({ type: "subrosa-view", document: framedDocument(app, origin, theme) });
        return;
      }
      const message = parseBridgeMessage(event, target);
      if (!message) return;
      void handleBridgeMessage(message, {
        theme,
        toolInput: app.toolInput,
        toolOutput: app.toolOutput,
        post,
        setHeight,
        openLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
        confirm: (tool) => new Promise((done) => setConfirming({ tool, done })),
        // On the view's own connector only, under the same rules.
        async callTool(name, args, confirmed) {
          const current = getConnector(host.sync, app.connectorId);
          if (!current?.enabled) throw new Error("connector_denied");
          const info = (await localState(env.store, current.id)).tools.find(
            (tool) => tool.name === name,
          );
          if (!info) throw new Error("connector_tool_unknown");
          const rule = effectiveRule(current.toolPolicy, info);
          if (rule === "deny") throw new Error("connector_denied");
          if (rule === "ask" && !confirmed) throw new ConfirmNeeded();
          const value = (await callTool(env, current, name, args)) as Record<
            string,
            unknown
          > | null;
          return {
            content: value?.content ?? null,
            structuredContent: value?.structuredContent ?? null,
            isError: value?.isError ?? false,
          };
        },
      });
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [app, host]);

  if (app === undefined) return null;
  if (!app)
    return (
      <p className="quiet">
        {t(
          "This view was made on another device and stays there.",
          "Cette vue a été créée sur un autre appareil et y reste.",
        )}
      </p>
    );
  const connector = getConnector(host.sync, app.connectorId);
  return (
    <div className="cn-section">
      <p className="quiet">
        {t(
          `A view from ${connector?.name ?? app.connectorId}. It can reach ${originOf(connector?.url ?? "") || "nothing"} and nothing else.`,
          `Une vue de ${connector?.name ?? app.connectorId}. Elle peut joindre ${originOf(connector?.url ?? "") || "rien"} et rien d’autre.`,
        )}
      </p>
      <iframe
        ref={frame}
        className="cn-frame"
        title={t("Connector view", "Vue du connecteur")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={viewHostUrl()}
        height={height}
      />
      {confirming && (
        <div
          className="cn-card"
          role="alertdialog"
          aria-label={t("Confirm the action", "Confirmer l’action")}
        >
          <p>
            {t(
              `The view wants to run ${confirming.tool}. Allow it this once?`,
              `La vue veut lancer ${confirming.tool}. L’autoriser cette fois ?`,
            )}
          </p>
          <div className="wc-row">
            <button
              className="button primary"
              type="button"
              onClick={() => {
                confirming.done(true);
                setConfirming(null);
              }}
            >
              {t("Allow once", "Autoriser une fois")}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                confirming.done(false);
                setConfirming(null);
              }}
            >
              {t("Decline", "Refuser")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
