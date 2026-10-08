/**
 * The research engine's world in the browser: Carpe Diem's routes with the
 * browser's own key (completions, `/v1/augment/search`, `/v1/augment/scrape`,
 * `/v1/pricing`), the notes this tab decrypted, the connectors the person
 * picked for the run, and a report written as an ordinary synchronised note.
 */
import {
  CarpeDiemError,
  type Completion,
  failure,
  fetchPage,
  type Operator,
  streamCompletion,
  webSearch,
} from "../carpe-diem";
import { timestamp } from "../codec";
import type { FeatureHost, FeatureStore } from "../feature";
import { listNotes } from "../library";
import { searchNotes } from "../search";
import type { SyncClient } from "../sync";
import { type ResearchPrices, pricesFrom, sourceKey } from "./core";
import type { Backend, Found, Run, RunStore } from "./engine";
import { researchProviders } from "./providers";

/** A network failure, or a refusal about the key or the balance: the run
 * fails with its reason and the person resumes it once it is fixed. Anything
 * else the operator refuses about one search or one page leaves that one
 * empty, as the app's engine does. */
function stopsTheRun(error: unknown): boolean {
  return !(error instanceof CarpeDiemError) || [401, 402, 403, 429].includes(error.status);
}

export function runStore(store: FeatureStore): RunStore {
  return {
    get: (id) => store.get<Run>(`run:${id}`),
    put: (run) => store.put(`run:${run.id}`, run),
    delete: (id) => store.delete(`run:${id}`),
    list: async () => (await store.list<Run>("run:")).map((entry) => entry.value),
  };
}

const MAX_TITLE_CHARS = 200;

/** `agent_notes::put`: the note under `id`, created or rewritten. */
export async function putNote(sync: SyncClient, id: string, title: string, body: string) {
  const existing = sync.objects.get(id);
  const stamp = timestamp();
  const line = title.split("\n")[0]?.trim().slice(0, MAX_TITLE_CHARS) || "Untitled note";
  await sync.write("notes", {
    ...(existing && existing.table === "notes" ? existing.row : {}),
    id,
    title: line,
    generated_content: existing?.row.generated_content ?? null,
    edited_content: body,
    active_tab: "notes",
    processing_status: existing?.row.processing_status ?? "draft",
    created_at: existing?.row.created_at ?? stamp,
    updated_at: stamp,
    calendar_event_id: existing?.row.calendar_event_id ?? null,
    scheduled_start: existing?.row.scheduled_start ?? null,
    attendees_json: existing?.row.attendees_json ?? null,
  });
}

export function liveBackend(
  host: Pick<FeatureHost, "operator" | "openKey" | "sync"> & Partial<FeatureHost>,
  model: string,
): Backend {
  const key = async () => {
    const value = await host.openKey();
    if (!value)
      throw new Error("This browser has no Carpe Diem key yet. Get one from your devices page.");
    return value;
  };
  return {
    async complete(system, user, maxTokens, signal) {
      const reply: Completion = await streamCompletion(
        host.operator,
        await key(),
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.3,
          max_tokens: maxTokens,
        },
        () => undefined,
        signal,
      );
      const text = reply.content.trim();
      if (!text) throw new Error("The model returned no text.");
      return text;
    },
    async webSearch(query, limit, signal) {
      try {
        const results = await webSearch(host.operator, await key(), query, limit, signal);
        return results
          .filter((result) => /^https?:\/\//i.test(result.url.trim()))
          .map(
            (result): Found => ({
              kind: "web",
              key: sourceKey(result.url),
              title: Array.from(result.title.trim() || result.url)
                .slice(0, 200)
                .join(""),
              url: result.url.trim(),
              noteId: null,
              excerpt: result.snippet ? Array.from(result.snippet).slice(0, 500).join("") : null,
            }),
          );
      } catch (error) {
        if (signal?.aborted || stopsTheRun(error)) throw error;
        return [];
      }
    },
    async fetchPage(url, signal) {
      try {
        const text = await fetchPage(host.operator, await key(), url, signal);
        return text.trim() ? text : null;
      } catch (error) {
        if (signal?.aborted || stopsTheRun(error)) throw error;
        return null;
      }
    },
    async ownSources(run: Run, query, signal) {
      const found: Found[] = searchNotes(listNotes(host.sync), query, 4).map((snippet) => ({
        kind: "note",
        key: `note:${snippet.noteId}`,
        title: snippet.title.trim() || "Untitled note",
        url: null,
        noteId: snippet.noteId,
        excerpt: snippet.snippet,
      }));
      if (run.providers.length && host.account) {
        const providers = await researchProviders(host as FeatureHost);
        for (const provider of providers.filter((item) => run.providers.includes(item.id))) {
          try {
            for (const source of await provider.search(host as FeatureHost, query, signal))
              found.push({
                kind: "connector",
                key: `connector:${provider.id}:${source.url || source.title}`,
                title: source.title || provider.label,
                url: /^https?:\/\//i.test(source.url) ? source.url : null,
                noteId: null,
                excerpt: Array.from(source.text).slice(0, 6_000).join(""),
              });
          } catch {
            // A connector that fails is a source fewer, not a failed run.
          }
        }
      }
      return found;
    },
    async saveReport(noteId, title, body) {
      await putNote(host.sync, noteId, title, body);
    },
  };
}

/** What a run's model, a search and a page read cost, from the operator's
 * table (`/v1/pricing`, the routes a browser key may read). Nothing known
 * when it does not answer. */
export async function researchPrices(
  operator: Operator,
  key: string | null,
  model: string,
  signal?: AbortSignal,
): Promise<ResearchPrices> {
  if (!key) return {};
  try {
    const response = await operator.fetch(`${operator.root}/v1/pricing`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw await failure(response);
    return pricesFrom(await response.json(), model);
  } catch {
    return {};
  }
}
