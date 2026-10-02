// One-tap retouches: what a person most often wants from a photo, written out
// as an instruction they can still edit before sending. On a phone they save
// the typing; on any screen they show what the tool is good at.

import { t } from "../../i18n";

export interface RetouchPreset {
  id: string;
  /** The chip, a few words. */
  label: () => string;
  /** What lands in the field, in the reader's language. */
  instruction: () => string;
  /** The retouch only makes sense on a painted zone. */
  zone?: boolean;
  /** Where to put the caret after filling the field, from the end. */
  caretFromEnd?: number;
}

export const RETOUCH_PRESETS: RetouchPreset[] = [
  {
    id: "remove",
    label: () => t("Remove something"),
    instruction: () => t("Remove what is painted and rebuild what was behind it, naturally."),
    zone: true,
  },
  {
    id: "light",
    label: () => t("Golden light"),
    instruction: () => t("Change the lighting to warm golden hour light, keep everything else."),
  },
  {
    id: "sky",
    label: () => t("Dramatic sky"),
    instruction: () => t("Replace the sky with a dramatic sunset sky, keep everything else."),
  },
  {
    id: "text",
    label: () => t("Change the text"),
    instruction: () => t("Replace the text in the image with “…”"),
    caretFromEnd: 1,
  },
  {
    id: "enhance",
    label: () => t("Sharper, richer"),
    instruction: () =>
      t(
        "Enhance clarity, color and contrast like a professional photo edit, without changing the content.",
      ),
  },
  {
    id: "watercolor",
    label: () => t("Watercolor"),
    instruction: () => t("Turn the picture into a delicate watercolor painting."),
  },
];
