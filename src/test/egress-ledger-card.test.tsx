import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EgressLedgerCard,
  egressSentence,
  relativeTime,
} from "../components/settings/EgressLedgerCard";

const mocks = vi.hoisted(() => ({ egressLedger: vi.fn() }));

vi.mock("../lib/tauri", () => ({ egressLedger: mocks.egressLedger }));

describe("the egress sentence", () => {
  it("says nothing left when nothing did", () => {
    expect(
      egressSentence(
        { requests: 0, requestBytes: 0, responseBytes: 0, hosts: [], purposes: [] },
        7,
      ),
    ).toBe("Nothing left this machine in the last 7 days.");
  });

  it("counts requests, bytes each way, and names a single host", () => {
    expect(
      egressSentence(
        {
          requests: 42,
          requestBytes: 3_145_728,
          responseBytes: 524_288,
          hosts: ["api.carpe-diem.xyz"],
          purposes: [["chat", 40]],
        },
        7,
      ),
    ).toBe(
      "42 requests in the last 7 days, 3.0 MB sent and 512 KB received, to api.carpe-diem.xyz.",
    );
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  it("reads the way a person scans a timeline", () => {
    expect(relativeTime("2026-09-03T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-03T11:45:00Z", now)).toBe("15 min ago");
    expect(relativeTime("2026-09-03T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-02T11:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-08-30T11:00:00Z", now)).toBe("4 days ago");
  });
});

describe("the ledger card", () => {
  beforeEach(() => {
    mocks.egressLedger.mockReset().mockResolvedValue({
      rows: [
        {
          id: 2,
          at: new Date(Date.now() - 30_000).toISOString(),
          host: "api.carpe-diem.xyz",
          purpose: "chat",
          method: "POST",
          requestBytes: 2048,
          responseBytes: 0,
          status: 200,
          durationMs: 0,
          model: "qwen3-235b",
          noteId: null,
        },
        {
          id: 1,
          at: new Date(Date.now() - 3_600_000).toISOString(),
          host: "api.carpe-diem.xyz",
          purpose: "transcription",
          method: "POST",
          requestBytes: 1_048_576,
          responseBytes: 4096,
          status: 200,
          durationMs: 0,
          model: null,
          noteId: "n1",
        },
      ],
      summary: {
        requests: 2,
        requestBytes: 1_050_624,
        responseBytes: 4096,
        hosts: ["api.carpe-diem.xyz"],
        purposes: [
          ["chat", 1],
          ["transcription", 1],
        ],
      },
      retentionDays: 90,
    });
  });

  it("shows the sentence, the purposes, and one row per request", async () => {
    render(<EgressLedgerCard />);
    expect(await screen.findByText(/2 requests in the last 7 days/)).toBeInTheDocument();
    expect(screen.getByText("chat ×1 · transcription ×1")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("qwen3-235b", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    expect(mocks.egressLedger).toHaveBeenCalledWith({ limit: 30, noteId: undefined, days: 7 });
  });
});
