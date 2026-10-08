/**
 * The seam ADR-0089 left for connected apps inside deep research
 * (`connector_sources`), on the web: a feature that can search something of
 * the person's (the connectors) registers a provider, and a run whose person
 * picked it asks it for sources beside the web. Nothing is asked of a
 * provider the person did not pick for that run.
 */
import type { FeatureHost } from "../feature";

export interface ResearchSource {
  title: string;
  /** Where it came from: a web address, or the connector's own reference. */
  url: string;
  text: string;
}

export interface ResearchProvider {
  /** Stable id (a connector's id), kept on the run. */
  id: string;
  /** What the picker shows. */
  label: string;
  search(host: FeatureHost, query: string, signal?: AbortSignal): Promise<ResearchSource[]>;
}

/** Returns the providers a run may offer, asked when the plan is shown. */
export type ResearchProviderSource = (host: FeatureHost) => Promise<ResearchProvider[]>;

const sources: ResearchProviderSource[] = [];

export function registerResearchProviders(source: ResearchProviderSource) {
  if (!sources.includes(source)) sources.push(source);
}

export async function researchProviders(host: FeatureHost): Promise<ResearchProvider[]> {
  const all: ResearchProvider[] = [];
  for (const source of sources) {
    try {
      all.push(...(await source(host)));
    } catch {
      // A provider that cannot list itself is simply not offered.
    }
  }
  return all;
}
