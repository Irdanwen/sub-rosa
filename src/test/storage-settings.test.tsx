import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageSettingsSection, formatBytes } from "../components/settings/StorageSettingsSection";

const mocks = vi.hoisted(() => ({
  storageReport: vi.fn(),
  purgeTranscribedRecordings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  storageReport: mocks.storageReport,
  purgeTranscribedRecordings: mocks.purgeTranscribedRecordings,
}));

const report = {
  buckets: [
    {
      id: "database",
      label: "Notes, transcripts and memories",
      note: "The SQLite database.",
      bytes: 987_136,
      files: 1,
      purgeable: false,
    },
    {
      id: "recordings",
      label: "Recordings",
      note: "The audio behind your notes.",
      bytes: 648_019_968,
      files: 6,
      purgeable: true,
    },
    {
      id: "agent-workspace",
      label: "Agent workspace",
      note: "Yours; the app never deletes them.",
      bytes: 5_368_709_120,
      files: 12_000,
      purgeable: false,
    },
  ],
  totalBytes: 6_017_716_224,
  measuredAt: "2026-09-03T08:00:00Z",
};

describe("formatBytes", () => {
  it("picks the unit a person would", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(987_136)).toBe("964 KB");
    expect(formatBytes(648_019_968)).toBe("618 MB");
    expect(formatBytes(5_368_709_120)).toBe("5.0 GB");
  });
});

describe("Settings › Storage", () => {
  beforeEach(() => {
    mocks.storageReport.mockReset().mockResolvedValue(report);
    mocks.purgeTranscribedRecordings
      .mockReset()
      .mockImplementation(async ({ dryRun }) =>
        dryRun
          ? { recordings: 2, bytes: 200_000_000, dryRun: true }
          : { recordings: 2, bytes: 200_000_000, dryRun: false },
      );
  });

  it("shows every bucket with the size the backend measured, and the total", async () => {
    render(<StorageSettingsSection />);
    expect(await screen.findByText("Recordings")).toBeInTheDocument();
    expect(screen.getByText("618 MB")).toBeInTheDocument();
    expect(screen.getByText("5.0 GB")).toBeInTheDocument();
    expect(screen.getByText("12,000 files")).toBeInTheDocument();
    expect(screen.getByText("5.6 GB")).toBeInTheDocument();
  });

  it("previews what a purge would remove and only removes on a click", async () => {
    const user = userEvent.setup();
    render(<StorageSettingsSection />);
    await screen.findByText(/2 recordings, 191 MB/);
    expect(mocks.purgeTranscribedRecordings).toHaveBeenCalledWith({
      olderThanDays: 90,
      dryRun: true,
    });
    expect(mocks.purgeTranscribedRecordings).not.toHaveBeenCalledWith({ olderThanDays: 90 });

    await user.selectOptions(screen.getByRole("combobox"), "365");
    await waitFor(() =>
      expect(mocks.purgeTranscribedRecordings).toHaveBeenCalledWith({
        olderThanDays: 365,
        dryRun: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(mocks.purgeTranscribedRecordings).toHaveBeenCalledWith({ olderThanDays: 365 }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Removed 2 recordings and freed 191 MB.",
    );
    // The report is measured again after a removal.
    expect(mocks.storageReport).toHaveBeenCalledTimes(2);
  });

  it("keeps the button off when nothing matches", async () => {
    mocks.purgeTranscribedRecordings.mockResolvedValue({ recordings: 0, bytes: 0, dryRun: true });
    render(<StorageSettingsSection />);
    await screen.findByText(/Nothing matches right now/);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });
});
