import "../../styles/connectors.css";
import { IconApps } from "central-icons/IconApps";
import { useEffect, useRef, useState } from "react";
import { PRODUCT_NAME } from "../../lib/branding";
import type { ConnectorAppChatBlock } from "../../lib/chat-blocks";
import {
  connectorAppUrl,
  handleBridgeMessage,
  parseBridgeMessage,
} from "../../lib/connector-app-bridge";
import { type ConnectorApp, connectorAppCallTool, connectorAppGet } from "../../lib/connectors";
import { t } from "../../lib/i18n";
import { openExternalUrl } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * A `subrosa:app` block (ADR-0092): a connector's interactive view, in a
 * frame sandboxed without `allow-same-origin`, served from the app's own
 * scheme under a policy that lets it reach its server's origin and nothing
 * else. What it may ask of the app goes through the checked bridge.
 */
export function ConnectorAppCard({ block }: { block: ConnectorAppChatBlock }) {
  const [app, setApp] = useState<ConnectorApp | null>(null);
  const [missing, setMissing] = useState(false);
  const [height, setHeight] = useState(320);
  const [asking, setAsking] = useState<{ tool: string; resolve: (ok: boolean) => void } | null>(
    null,
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const [theme] = useState(currentTheme);

  useEffect(() => {
    let cancelled = false;
    connectorAppGet(block.appId)
      .then((value) => {
        if (!cancelled) setApp(value);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [block.appId]);

  useEffect(() => {
    if (!app) return;
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow ?? null;
      const message = parseBridgeMessage(event, target);
      if (!message || !target) return;
      void handleBridgeMessage(message, {
        callTool: (tool, args, confirmed) =>
          connectorAppCallTool(block.appId, tool, args, confirmed),
        confirm: (tool) => new Promise<boolean>((resolve) => setAsking({ tool, resolve })),
        openLink: async (url) => {
          await openExternalUrl(url);
        },
        setHeight,
        post: (reply) => target.postMessage(reply, "*"),
        hostName: PRODUCT_NAME,
        theme,
        toolInput: app.toolInput,
        toolOutput: app.toolOutput,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app, block.appId, theme]);

  if (missing) {
    return (
      <section className="chat-block" aria-label={t("Interactive view")}>
        <p className="connector-app-note">{t("This view is no longer available.")}</p>
      </section>
    );
  }
  if (!app) return null;
  return (
    <section className="chat-block" aria-label={t("Interactive view")}>
      <header className="connector-card-head">
        <span className="chat-block-row-icon" aria-hidden>
          <IconApps size={16} />
        </span>
        <span className="chat-block-row-body">
          <span className="chat-block-row-title">{app.connectorName}</span>
          <span className="chat-block-row-meta">{app.tool}</span>
        </span>
      </header>
      <iframe
        ref={frame}
        className="connector-app-frame"
        title={t("{name} view", { name: app.connectorName })}
        src={connectorAppUrl(app.id, theme)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        height={height}
      />
      <p className="connector-app-note">
        {app.origin
          ? t("Runs apart from Sub Rosa and can only reach {origin}.", { origin: app.origin })
          : t("Runs apart from Sub Rosa and cannot reach the network.")}
      </p>
      <ConfirmDialog
        open={asking !== null}
        title={t("Allow this action?")}
        description={t("The view wants to run {tool} on {name}.", {
          tool: asking?.tool ?? "",
          name: app.connectorName,
        })}
        confirmLabel={t("Allow")}
        cancelLabel={t("Decline")}
        onConfirm={() => {
          asking?.resolve(true);
          setAsking(null);
        }}
        onClose={() => {
          asking?.resolve(false);
          setAsking(null);
        }}
      />
    </section>
  );
}
