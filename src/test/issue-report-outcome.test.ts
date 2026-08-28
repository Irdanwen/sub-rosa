import { describe, expect, it } from "vitest";
import { issueReportOutcomeMessage } from "../lib/issue-report-outcome";

/** The regression this file exists for: the app thanked people for reports it
 * had not delivered. Every assertion here is about a sentence being true of
 * the outcome it describes. */
describe("what a reporter is told", () => {
  it("gives the issue's link when the app filed it", () => {
    const message = issueReportOutcomeMessage({
      filed: { urls: ["https://github.com/Irdanwen/sub-rosa/issues/12"] },
    });
    expect(message).toContain("https://github.com/Irdanwen/sub-rosa/issues/12");
    expect(message).toContain("filed");
  });

  it("counts the issues when one report covered several problems", () => {
    const message = issueReportOutcomeMessage({
      filed: {
        urls: [
          "https://github.com/Irdanwen/sub-rosa/issues/12",
          "https://github.com/Irdanwen/sub-rosa/issues/13",
        ],
      },
    });
    expect(message).toContain("2 issues");
    expect(message).toContain("issues/12");
  });

  it("never says a report waiting in the browser was sent", () => {
    // The form is open and filled in; nothing exists on the tracker until the
    // user presses Submit. This is the arm most likely to drift back into a
    // comfortable lie.
    const message = issueReportOutcomeMessage("browser");
    expect(message).toMatch(/browser/i);
    expect(message).toMatch(/Submit/);
    expect(message).not.toMatch(/\bsent\b/i);
    expect(message).not.toMatch(/\bfiled at\b/i);
    expect(message).not.toMatch(/thank/i);
  });

  it("says a logged report went nowhere, and why", () => {
    const message = issueReportOutcomeMessage({
      logged: { reason: "GitHub refused the token." },
    });
    expect(message).toContain("not filed");
    expect(message).toContain("GitHub refused the token.");
    expect(message).not.toMatch(/\bsent\b/i);
  });

  it("claims nothing when the backend said nothing", () => {
    // An older build, or a shape this one does not know. "Submitted" is the
    // most that can be honestly said about a call that returned.
    for (const value of [undefined, null]) {
      const message = issueReportOutcomeMessage(value);
      expect(message).toBe("Your report was submitted.");
      expect(message).not.toMatch(/team|filed|thank/i);
    }
  });
});
