/**
 * The web client's connectors (ADR-0092): remote MCP servers the browser
 * reaches itself, signed in with OAuth and PKCE through the site's own
 * `/app`, their access sealed in this browser and their definitions on the
 * account. A catalog server that refuses web pages is shown as unavailable
 * here, with the reason; it is never reached through the account service.
 */
import { t } from "../../lib/i18n";
import type { WebFeature } from "../feature";
import { connectorOptions, envFor } from "./env";
import { reconcileRelayed } from "./relay";
import { registerConnectorResearch } from "./research";
import { completeSignIn } from "./runtime";
import { checkTriggers } from "./triggers";
import { connectorTurn } from "./turn";
import { ConnectorAppBlock, ConnectorCallBlock, PendingActions } from "./ui/Cards";
import { ConnectorsPanel } from "./ui/ConnectorsPanel";
import { failureText } from "./ui/words";
import { OAuthError } from "./oauth";

export { configureConnectors } from "./env";
export { registerTriggerRunner, type TriggerRunner } from "./triggers";

registerConnectorResearch(envFor);

export const connectorsFeature: WebFeature = {
  id: "connectors",
  label: () => t("Connectors", "Connecteurs"),
  Panel: ConnectorsPanel,
  ComposerControl: PendingActions,
  blocks: { connector: ConnectorCallBlock, app: ConnectorAppBlock },
  /** A sign-in coming back to `/app?code=…&state=…` is finished here, once
   * the vault is open, and the address bar cleaned of it. */
  async start(host) {
    const options = connectorOptions();
    const outcome = await completeSignIn(envFor(host), options.location());
    if (outcome.kind === "none") return;
    options.cleanLocation();
    if (outcome.kind === "connected") {
      host.notify(t("The connector is signed in.", "Le connecteur est connecté."));
      host.openPanel("connectors");
    } else host.notify(failureText(new OAuthError(outcome.reason)));
  },
  turn: (host, turn) => connectorTurn(envFor(host), turn),
  async tick(host, signal) {
    // A relayed call's late answer reaches its card (ADR-0107).
    await reconcileRelayed(envFor(host)).catch(() => undefined);
    await checkTriggers(envFor(host), signal);
  },
};
