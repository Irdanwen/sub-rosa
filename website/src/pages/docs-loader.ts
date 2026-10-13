import { useEffect, useState } from "react";

/** The documentation (22 guides in two languages, and its page) is its own
 * chunk, fetched only by the pages that show it: the home page used to pay
 * for every guide. `main.tsx` and the prerender wait for it before a first
 * render on those pages, as they do for the model catalog. */
type DocsModule = typeof import("./docs");

export const documentationPath = (path: string) =>
  path === "/docs" || path.startsWith("/docs/") || path === "/help";

let loaded: DocsModule | null = null;
let pending: Promise<DocsModule> | null = null;

export function loadDocs() {
  pending ??= import("./docs").then((module) => {
    loaded = module;
    return module;
  });
  return pending;
}

export function useDocs(wanted: boolean) {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (!wanted || module) return;
    let live = true;
    loadDocs().then((next) => live && setModule(next));
    return () => {
      live = false;
    };
  }, [wanted, module]);
  return module;
}
