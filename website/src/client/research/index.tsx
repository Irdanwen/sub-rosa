/**
 * Deep research on the web (ADR-0089): the engine of `engine.ts` driven by
 * this tab, a panel to start, plan, follow and read a run, and a composer
 * button that hands the draft to it. A run whose tab closed is picked up by
 * the next `/app` tab's tick (ADR-0091: an agent runs only while an app is
 * open).
 */
import { t } from "../../lib/i18n";
import type { ComposerControlProps, WebFeature } from "../feature";
import { drive, unfinished } from "./engine";
import { liveBackend, runStore } from "./live";
import { ResearchPanel } from "./ResearchPanel";
import { changed, handOff } from "./state";

function ResearchButton({ host, draft, setDraft, temporary }: ComposerControlProps) {
  if (temporary) return null;
  return (
    <button
      className="button"
      type="button"
      onClick={() => {
        handOff(draft.trim());
        setDraft("");
        host.openPanel("research");
      }}
    >
      {t("Deep research", "Recherche approfondie")}
    </button>
  );
}

export const researchFeature: WebFeature = {
  id: "research",
  label: () => t("Deep research", "Recherche approfondie"),
  Panel: ResearchPanel,
  ComposerControl: ResearchButton,
  async tick(host) {
    const store = runStore(host.storeFor("research"));
    for (const id of await unfinished(store)) {
      const run = await store.get(id);
      if (run) void drive(store, liveBackend(host, run.model), id, changed);
    }
  },
};
