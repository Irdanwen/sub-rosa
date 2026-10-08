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
import { callTool, type ConnectorEnv, hasCredential } from "./runtime";
import { listConnectors, localState } from "./store";
import { reachableFromWeb } from "./turn";
import { CONNECTORS } from "./words";

const PER_SOURCE_MS = 20_000;

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
  return out;
}

/** Offers the connectors to every research run, through `envFor`. */
export function registerConnectorResearch(envFor: (host: FeatureHost) => ConnectorEnv) {
  registerResearchProviders(async (host) => connectorProviders(envFor(host)));
}
