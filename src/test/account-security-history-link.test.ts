import { describe, expect, it } from "vitest";
import { securityHistoryUrl } from "../components/settings/AccountSettingsSection";

describe("the account's security history link", () => {
  it("opens the account site's section on the service the device signed in to", () => {
    expect(securityHistoryUrl("https://subrosa.example.test")).toBe(
      "https://subrosa.example.test/account#security-history",
    );
    expect(securityHistoryUrl("https://subrosa.example.test/some/path/")).toBe(
      "https://subrosa.example.test/account#security-history",
    );
  });
});
