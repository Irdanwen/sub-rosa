import { describe, expect, it } from "vitest";
import { historySection } from "../lib/chat-titles";

describe("historySection", () => {
  const now = new Date(2026, 8, 22, 15, 0);
  it("groups by calendar day, not by 24-hour spans", () => {
    expect(historySection(new Date(2026, 8, 22, 0, 5).toISOString(), now)).toBe("today");
    expect(historySection(new Date(2026, 8, 21, 23, 55).toISOString(), now)).toBe("yesterday");
    expect(historySection(new Date(2026, 8, 17, 9, 0).toISOString(), now)).toBe("week");
    expect(historySection(new Date(2026, 8, 10, 9, 0).toISOString(), now)).toBe("older");
    expect(historySection("not a date", now)).toBe("older");
  });
});
