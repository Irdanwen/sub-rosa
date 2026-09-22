/**
 * The addresses the app answers to, as a list both shells can show.
 *
 * On the iPhone the same three verbs are also Shortcuts actions (App Intents,
 * `gen/apple/Sources/os-june/Intents`): they appear in the Shortcuts app by
 * themselves, ready for the Action button, a widget or the Home Screen, with
 * no address to type. The addresses stay for everything else: an "Open URL"
 * shortcut on another platform, or a link in another app.
 */

import { t } from "./i18n";
import { destinationUrl } from "./destinations";

export type Automation = { label: string; detail: string; url: string };

export const AUTOMATION_ADDRESSES: readonly Automation[] = [
  {
    label: t("New audio note"),
    detail: t("Opens Sub Rosa on a new note and starts recording."),
    url: destinationUrl({ kind: "record" }),
  },
  {
    label: t("Dictate"),
    detail: t("Opens dictation and starts listening."),
    url: destinationUrl({ kind: "dictation", start: true }),
  },
  {
    label: t("Ask Sub Rosa"),
    detail: t(
      "Opens a new chat with the question already typed. From an address, replace the text after q=.",
    ),
    url: `${destinationUrl({ kind: "chat" })}?q=what%20did%20I%20decide%20about`,
  },
];
