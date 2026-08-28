/**
 * What to tell someone who just sent a report.
 *
 * For as long as the fork had no tracker configured, this was one sentence
 * thanking them for a report "sent to the Sub Rosa team", printed whenever the
 * call did not throw. Every one of those reports became a line in a local log
 * file. The sentence was the bug, not the delivery.
 *
 * So the copy is derived from what actually happened, and each arm says only
 * what is true of it. The browser arm is the one to watch: the form is open
 * and filled in, and nothing is filed until the user presses Submit, so it must
 * never read as "sent".
 */

import type { IssueReportDelivery } from "./tauri";

export function issueReportOutcomeMessage(
  delivery: IssueReportDelivery | null | undefined,
): string {
  if (delivery === "browser") {
    return "Your report is filled in and waiting in your browser. Press Submit on GitHub to file it.";
  }
  if (delivery && typeof delivery === "object" && "filed" in delivery) {
    const urls = delivery.filed.urls;
    const [first] = urls;
    if (!first) return "Your report was filed on the tracker. Thank you.";
    return urls.length > 1
      ? `Your report was filed as ${urls.length} issues, starting at ${first}. Thank you.`
      : `Your report was filed at ${first}. Thank you.`;
  }
  if (delivery && typeof delivery === "object" && "logged" in delivery) {
    return `Your report was saved on this device but not filed. ${delivery.logged.reason}`;
  }
  // No delivery field at all: an older backend, or a shape this build does not
  // recognize. Say what is certain and nothing more.
  return "Your report was submitted.";
}
