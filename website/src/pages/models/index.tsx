import { t, type SiteLocale } from "../../lib/i18n";
import { categoryTitle, familyBySlug, familyName } from "../../models/catalog";
import { preloadDetails } from "../../models/details";
import { read } from "../docs-content";
import { CategoryPage, isCategory } from "./category";
import { ComparePage } from "./compare";
import { FamilyMissing, FamilyPage } from "./family";
import { GuidePage } from "./guide";
import { CatalogHome } from "./hub";

/** The page title for a catalog path, in the current language. */
export function modelCatalogTitle(path: string) {
  const catalog = t("Model catalog", "Catalogue des modèles");
  const slug = path.startsWith("/models/") ? path.slice(8) : "";
  if (slug === "guide")
    return `${t("Understanding models", "Comprendre les modèles")} · ${catalog}`;
  if (slug === "compare") return `${t("Compare models", "Comparer les modèles")} · ${catalog}`;
  if (isCategory(slug)) return `${read(categoryTitle(slug))} · ${catalog}`;
  const family = familyBySlug(slug);
  return family ? `${familyName(family)} · ${catalog}` : catalog;
}

export function ModelCatalog({
  path,
  query = "",
  locale,
}: {
  path: string;
  query?: string;
  locale: SiteLocale;
}) {
  const slug = path === "/models" ? "" : path.slice("/models/".length);
  if (!slug) return <CatalogHome locale={locale} />;
  if (slug === "guide") return <GuidePage locale={locale} />;
  if (slug === "compare") return <ComparePage query={query} locale={locale} />;
  if (isCategory(slug)) return <CategoryPage category={slug} locale={locale} key={slug} />;
  const family = familyBySlug(slug);
  if (!family) return <FamilyMissing locale={locale} />;
  return <FamilyPage family={family} locale={locale} key={family.slug} />;
}

/** Everything a catalog path needs before its first render: used by `main.tsx` and the prerender. */
export const prepareCatalogPath = (path: string, query: string) => preloadDetails(path, query);
