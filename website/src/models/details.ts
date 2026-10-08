import { useEffect, useState } from "react";
import { requireWebsiteMessages } from "../lib/i18n";
import { type Category, type FamilyDetail, familyBySlug } from "./catalog";

/** A family's depth (versions, specs, use cases, rivals) is the heaviest part of
 * the catalog, so each kind of work is its own chunk, fetched by the pages that
 * show it. `main.tsx` and the prerender wait for the chunks a page needs before
 * its first render, so a family page never paints without its history. */
const chunks = import.meta.glob<{ default: { families: FamilyDetail[] } }>([
  "./details/*.json",
  "!./details/index.json",
]);

const loaded = new Map<Category, Map<string, FamilyDetail>>();
const pending = new Map<Category, Promise<void>>();

export function loadDetails(category: Category) {
  const known = pending.get(category);
  if (known) return known;
  const load = chunks[`./details/${category}.json`];
  const next = Promise.all([
    load ? load() : Promise.resolve({ default: { families: [] } }),
    requireWebsiteMessages(`models:${category}`),
  ]).then(([module]) => {
    loaded.set(category, new Map(module.default.families.map((detail) => [detail.slug, detail])));
  });
  pending.set(category, next);
  return next;
}

export const detailOf = (slug: string) => {
  const family = familyBySlug(slug);
  return family ? loaded.get(family.category)?.get(slug) : undefined;
};

/** The kinds of work a catalog path needs depth for. */
export function categoriesFor(path: string, query: string): Category[] {
  if (path === "/models/compare")
    return [
      ...new Set(
        compareSelection(query)
          .map((slug) => familyBySlug(slug)?.category)
          .filter((category): category is Category => Boolean(category)),
      ),
    ];
  const family = path.startsWith("/models/") ? familyBySlug(path.slice(8)) : undefined;
  return family ? [family.category] : [];
}

export const preloadDetails = (path: string, query: string) =>
  Promise.all(categoriesFor(path, query).map(loadDetails));

/** Up to three families named in `?m=a,b,c`, the ones that exist. */
export function compareSelection(query: string) {
  const named = new URLSearchParams(query).get("m")?.split(",") ?? [];
  return [...new Set(named)].filter((slug) => familyBySlug(slug)).slice(0, 3);
}

export function useDetails(wanted: Category[]) {
  const key = [...wanted].sort().join(",");
  const ready = () => wanted.every((category) => loaded.has(category));
  const [, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the list
  useEffect(() => {
    if (ready()) return;
    let live = true;
    Promise.all(wanted.map(loadDetails)).then(() => live && setVersion((value) => value + 1));
    return () => {
      live = false;
    };
  }, [key]);
  return ready();
}
