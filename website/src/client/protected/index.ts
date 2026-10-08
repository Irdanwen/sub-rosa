/**
 * The web client's protected mode (ADR-0084), held per browser. It starts
 * first (`features.ts`) and sets the page's guards before any turn can
 * leave, then again every minute, since quiet hours follow the clock.
 */
import { t } from "../../lib/i18n";
import type { FeatureHost, WebFeature } from "../feature";
import { ProtectedPanel } from "./ProtectedPanel";
import { guardsFor } from "./rules";
import { ProtectedMode } from "./state";

async function apply(host: FeatureHost) {
  const settings = await new ProtectedMode(host.storeFor("protected")).load();
  host.setGuards(guardsFor(settings.enabled, settings.restrictions));
}

export const protectedFeature: WebFeature = {
  id: "protected",
  label: () => t("Protected mode", "Mode protégé"),
  Panel: ProtectedPanel,
  start: apply,
  tick: apply,
};
