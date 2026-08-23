/**
 * The addresses the app answers to, as a list both shells can show.
 *
 * The destination router already makes every one of these usable from
 * Shortcuts (an "Open URL" action), which is what App Intents would buy for
 * these three verbs — without a Swift target, an app group, or a
 * provisioning change. The only thing missing was that nobody can guess a
 * URL scheme, so both shells list them.
 */

import { destinationUrl } from "./destinations";

export const AUTOMATION_ADDRESSES = [
  {
    label: "Start recording",
    detail: "Opens Sub Rosa on a new note and starts capturing.",
    url: destinationUrl({ kind: "record" }),
  },
  {
    label: "Dictate",
    detail: "Opens the dictation surface, ready to speak.",
    url: destinationUrl({ kind: "dictation" }),
  },
  {
    label: "Ask my notes",
    detail: "Opens the chat with a question already typed. Replace the text after q=.",
    url: `${destinationUrl({ kind: "chat" })}?q=what%20did%20I%20decide%20about`,
  },
] as const;
