import { useEffect, useState } from "react";
import { requireWebsiteMessages } from "../lib/i18n";

/** The catalog weighs more than the rest of the site, so it is its own chunk,
 * fetched only by the pages that show it. `main.tsx` and the prerender wait
 * for it before a first render on those pages, so nothing flashes. */
type CatalogModule = typeof import("../pages/models");

export const modelsPath = (path: string) => path === "/models" || path.startsWith("/models/");

let loaded: CatalogModule | null = null;
let pending: Promise<CatalogModule> | null = null;

export function loadModelCatalog() {
  pending ??= Promise.all([import("../pages/models"), requireWebsiteMessages("models")]).then(
    ([module]) => {
      loaded = module;
      return module;
    },
  );
  return pending;
}

export function useModelCatalog(wanted: boolean) {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (!wanted || module) return;
    let live = true;
    loadModelCatalog().then((next) => live && setModule(next));
    return () => {
      live = false;
    };
  }, [wanted, module]);
  return module;
}
