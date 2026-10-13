import { t } from "./i18n";

/** A sentence in English and French; the other languages read from the catalogs. */
export type Copy = readonly [en: string, fr: string];
export const read = ([en, fr]: Copy) => t(en, fr);
