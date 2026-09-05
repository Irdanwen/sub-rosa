/** The bible as the webview sees it. Mirrors `src-tauri/src/bible.rs`. */
import { t } from "../../i18n";

export const BIBLE_KINDS = ["character", "location", "prop", "look"] as const;
export type BibleKind = (typeof BIBLE_KINDS)[number];

/**
 * The roles a reference can play.
 *
 * The five image roles are the ordered stack a reference-to-video model wants:
 * the identity anchor first, then the other angles, then the place it happens
 * in. `voice` is the odd one out - it points at an audio artifact and rides as
 * a voice donor rather than as a picture.
 */
export const BIBLE_ROLES = ["portrait", "profile", "wide", "medium", "detail", "voice"] as const;
export type BibleRole = (typeof BIBLE_ROLES)[number];

export const BIBLE_KIND_LABELS: Record<BibleKind, string> = {
  get character() {
    return t("Character");
  },
  get location() {
    return t("Location");
  },
  get prop() {
    return t("Prop");
  },
  get look() {
    return t("Look");
  },
};

export const BIBLE_ROLE_LABELS: Record<BibleRole, string> = {
  get portrait() {
    return t("Portrait");
  },
  get profile() {
    return t("Profile");
  },
  get wide() {
    return t("Wide");
  },
  get medium() {
    return t("Medium");
  },
  get detail() {
    return t("Detail");
  },
  get voice() {
    return t("Voice");
  },
};

/** Which roles make sense for a kind, in the order a surface should offer them. */
export const ROLES_BY_KIND: Record<BibleKind, readonly BibleRole[]> = {
  character: ["portrait", "profile", "detail", "voice"],
  location: ["wide", "medium", "detail"],
  prop: ["detail", "portrait"],
  look: ["wide", "medium", "detail"],
};

export interface BibleRef {
  id: string;
  entryId: string;
  /** A gallery artifact id, which is its file name. */
  artifactId: string;
  role: BibleRole;
  label: string;
  ordinal: number;
}

export interface BibleEntry {
  id: string;
  kind: BibleKind;
  name: string;
  /** What must not drift between shots: palette, wardrobe, relative height. */
  traits: string;
  note: string;
  refs: BibleRef[];
  createdAt: string;
  updatedAt: string;
}
