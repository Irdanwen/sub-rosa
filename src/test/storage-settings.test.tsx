import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageSettingsSection, formatBytes } from "../components/settings/StorageSettingsSection";

const mocks = vi.hoisted(() => ({
  storageReport: vi.fn(),
  purgeTranscribedRecordings: vi.fn(),
  recordingsRetention: vi.fn(),
  setRecordingsRetention: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  storageReport: mocks.storageReport,
  purgeTranscribedRecordings: mocks.purgeTranscribedRecordings,
}));
vi.mock("../lib/recording-retention", () => ({
  recordingsRetention: mocks.recordingsRetention,
  setRecordingsRetention: mocks.setRecordingsRetention,
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
      .mockResolvedValue({ recordings: 2, bytes: 200_000_000, dryRun: true });
    mocks.recordingsRetention.mockReset().mockResolvedValue(null);
    mocks.setRecordingsRetention
      .mockReset()
      .mockResolvedValue({ recordings: 2, bytes: 200_000_000, dryRun: false });
  });

  it("shows every bucket with the size the backend measured, and the total", async () => {
    render(<StorageSettingsSection />);
    expect(await screen.findByText("Recordings")).toBeInTheDocument();
    expect(screen.getByText("618 MB")).toBeInTheDocument();
    expect(screen.getByText("5.0 GB")).toBeInTheDocument();
    expect(screen.getByText("12,000 files")).toBeInTheDocument();
    expect(screen.getByText("5.6 GB")).toBeInTheDocument();
  });

  it("keeps recordings until a person chooses an age", async () => {
    render(<StorageSettingsSection />);
    const select = await screen.findByRole("combobox", { name: "Delete recordings automatically" });
    await waitFor(() => expect(select).toHaveValue("never"));
    expect(mocks.setRecordingsRetention).not.toHaveBeenCalled();
  });

  it("asks before an age that deletes recordings at once, and says what went", async () => {
    const user = userEvent.setup();
    render(<StorageSettingsSection />);
    const select = await screen.findByRole("combobox", { name: "Delete recordings automatically" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "7");
    expect(mocks.purgeTranscribedRecordings).toHaveBeenCalledWith({
      olderThanDays: 7,
      dryRun: true,
    });
    expect(
      await screen.findByText(/2 recordings, 191 MB, will be deleted on every device/),
    ).toBeInTheDocument();
    expect(mocks.setRecordingsRetention).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.setRecordingsRetention).toHaveBeenCalledWith(7));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Removed 2 recordings and freed 191 MB.",
    );
    expect(select).toHaveValue("7");
  });

  it("applies an age with nothing to delete, and going back to never, without asking", async () => {
    mocks.purgeTranscribedRecordings.mockResolvedValue({ recordings: 0, bytes: 0, dryRun: true });
    mocks.setRecordingsRetention.mockResolvedValue({ recordings: 0, bytes: 0, dryRun: false });
    const user = userEvent.setup();
    render(<StorageSettingsSection />);
    const select = await screen.findByRole("combobox", { name: "Delete recordings automatically" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "365");
    await waitFor(() => expect(mocks.setRecordingsRetention).toHaveBeenCalledWith(365));
    await user.selectOptions(select, "never");
    await waitFor(() => expect(mocks.setRecordingsRetention).toHaveBeenLastCalledWith(null));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
