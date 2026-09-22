import { describe, expect, it } from "vitest";
import { shouldPollProcessingStatus } from "../app/processing-polling";

describe("shouldPollProcessingStatus", () => {
  it("polls while backend processing is still running", () => {
    expect(shouldPollProcessingStatus("transcribing")).toBe(true);
    expect(shouldPollProcessingStatus("generating")).toBe(true);
  });

  it("does not poll terminal or recording statuses", () => {
    expect(shouldPollProcessingStatus("ready")).toBe(false);
    expect(shouldPollProcessingStatus("failed")).toBe(false);
    expect(shouldPollProcessingStatus("recording")).toBe(false);
  });

  it("does not poll a note the user stopped", () => {
    // Nothing is running on it; polling would only spend a request a second
    // on a note that will not change until the user presses Resume.
    expect(shouldPollProcessingStatus("stopped")).toBe(false);
  });
});
