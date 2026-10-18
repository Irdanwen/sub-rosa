// The kinds of work the shipped templates are sorted by, in the order the
// library and the phone's apps list show them. A kind with no template yet
// is not shown.

import { t } from "../../../i18n";

export type TemplateCategory = "pictures" | "video" | "sound" | "retouch" | "products" | "brand";

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  "pictures",
  "video",
  "sound",
  "retouch",
  "products",
  "brand",
];

export function templateCategoryLabel(category: TemplateCategory): string {
  switch (category) {
    case "pictures":
      return t("Pictures");
    case "video":
      return t("Video");
    case "sound":
      return t("Sound");
    case "retouch":
      return t("Retouch");
    case "products":
      return t("Products and ads");
    case "brand":
      return t("Brand and design");
  }
}
