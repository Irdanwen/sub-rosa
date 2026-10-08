import { t } from "../../lib/i18n";
import type { CatalogCategory } from "../../lib/publishing";

/** A catalog category, as a person reads it. Literal `t()` calls, so the
 * catalogs carry each one. */
export function categoryLabel(category: CatalogCategory | string): string {
  switch (category) {
    case "writing":
      return t("Writing and editing");
    case "research":
      return t("Research");
    case "learning":
      return t("Learning");
    case "productivity":
      return t("Productivity");
    case "creative":
      return t("Creative work");
    case "coding":
      return t("Code");
    case "lifestyle":
      return t("Everyday life");
    default:
      return t("Other");
  }
}

/** A permission a published assistant asks for, as a person reads it. */
export function permissionLabel(key: string): string {
  switch (key) {
    case "web":
      return t("Search the web");
    case "image":
      return t("Propose images");
    case "video":
      return t("Propose videos");
    case "music":
      return t("Propose music");
    case "speech":
      return t("Propose speech");
    case "documents":
      return t("Write Office files");
    case "notes":
      return t("Read your notes");
    case "memory":
      return t("Use your memory");
    default:
      return key;
  }
}
