/**
 * Connector sources in deep research, on the web (ADR-0089's
 * `connector_sources`, `connectors/research.rs`): every connector that can
 * search (a tool that reads, runs without asking, is named for searching and
 * takes a text query) is offered to a run; a run the person gave it asks it
 * each query, and what comes back is a source like a page.
 */
import type { FeatureHost } from "../feature";
import { registerResearchProviders, type ResearchProvider } from "../research/providers";
import { anySignal, resultLinks, resultText } from "./mcp";
import { searchTool } from "./rules";
import { forget, relayedConnectors, requestCall, waitForAnswer } from "./relay";
import { callTool, type ConnectorEnv, hasCredential } from "./runtime";
import { getConnector, listConnectors, localState } from "./store";
import { reachableFromWeb } from "./turn";
import { CONNECTORS } from "./words";

const PER_SOURCE_MS = 20_000;
/** A source made by another device waits for its pick-up as well. */
const PER_RELAYED_SOURCE_MS = 45_000;

export async function connectorProviders(env: ConnectorEnv): Promise<ResearchProvider[]> {
  const out: ResearchProvider[] = [];
  for (const connector of listConnectors(env.sync)) {
    if (out.length >= CONNECTORS.limits.researchMaxConnectors) break;
    if (!connector.enabled || !reachableFromWeb(connector)) continue;
    if (!(await hasCredential(env, connector))) continue;
    const found = searchTool(
      (await localState(env.store, connector.id)).tools,
      connector.toolPolicy,
    );
    if (!found) continue;
    out.push({
      id: connector.id,
      label: connector.name,
      async search(_host, query, signal) {
        const timeout = AbortSignal.timeout(PER_SOURCE_MS);
        const result = await callTool(
          env,
          connector,
          found.tool.name,
          { [found.field]: query },
          anySignal([signal, timeout]),
        );
        const text = resultText(result, CONNECTORS.limits.researchExcerptChars);
        if (text.startsWith("The tool returned nothing") || text.startsWith("No ")) return [];
        return [
          {
            title: Array.from(`${connector.name} search: ${query.trim()}`).slice(0, 200).join(""),
            url: resultLinks(result)[0]?.url ?? `connector:${connector.id}`,
            text,
          },
        ];
      },
    });
  }
  // A connector one of the person's apps searches for this tab (ADR-0107).
  const here = new Set(out.map((provider) => provider.id));
  for (const offer of relayedConnectors(env.sync, env.deviceId ?? null)) {
    if (out.length >= CONNECTORS.limits.researchMaxConnectors) break;
    if (here.has(offer.connectorId)) continue;
    if (getConnector(env.sync, offer.connectorId)?.enabled === false) continue;
    const relayed = searchTool(
      offer.tools.filter((tool) => tool.rule === "allow"),
      {},
    );
    if (!relayed) continue;
    const label = offer.connectorName || offer.connectorId;
    out.push({
      id: offer.connectorId,
      label,
      async search(_host, query, signal) {
        const id = await requestCall(env.sync, {
          offer,
          tool: relayed.tool.name,
          args: { [relayed.field]: query },
          approved: false,
          requestedBy: env.deviceId ?? "browser",
        });
        const answer = await waitForAnswer(env.sync, id, { signal, waitMs: PER_RELAYED_SOURCE_MS });
        // An unanswered one is swept once its device settles it.
        if (answer !== "timeout") await forget(env.sync, id).catch(() => undefined);
        if (answer === "timeout" || answer.state !== "done") return [];
        const text = Array.from(answer.result.text)
          .slice(0, CONNECTORS.limits.researchExcerptChars)
          .join("");
        if (text.startsWith("The tool returned nothing") || text.startsWith("No ")) return [];
        return [
          {
            title: Array.from(`${label} search: ${query.trim()}`).slice(0, 200).join(""),
            url: answer.result.links[0]?.url ?? `connector:${offer.connectorId}`,
            text,
          },
        ];
      },
    });
  }
  return out;
}

/** Offers the connectors to every research run, through `envFor`. */
export function registerConnectorResearch(envFor: (host: FeatureHost) => ConnectorEnv) {
  registerResearchProviders(async (host) => connectorProviders(envFor(host)));
}
