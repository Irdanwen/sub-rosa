import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveSection } from "../components/settings/ArchiveSection";

const mocks = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  importArchive: vi.fn(),
  isMobilePlatform: vi.fn(() => false),
}));

vi.mock("../lib/tauri", () => ({
  exportArchive: mocks.exportArchive,
  importArchive: mocks.importArchive,
}));

vi.mock("../lib/mobile", () => ({
  isMobilePlatform: mocks.isMobilePlatform,
}));

describe("Settings › Archive", () => {
  beforeEach(() => {
    mocks.exportArchive.mockReset();
    mocks.importArchive.mockReset();
    mocks.isMobilePlatform.mockReturnValue(false);
  });

  it("exports with the passphrase and the recordings choice, and says where it went", async () => {
    const user = userEvent.setup();
    mocks.exportArchive.mockResolvedValue({
      path: "/tmp/Sub Rosa.subrosa.age",
      bytes: 4096,
      sealed: true,
    });
    render(<ArchiveSection />);
    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.click(screen.getByLabelText("Include the recordings"));
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(mocks.exportArchive).toHaveBeenCalledWith({
        includeRecordings: true,
        passphrase: "correct horse",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Sealed archive written to /tmp/Sub Rosa.subrosa.age (4 KB).",
    );
  });

  it("asks for a passphrase when the archive is sealed, then imports", async () => {
    const user = userEvent.setup();
    mocks.importArchive
      .mockResolvedValueOnce({ summary: null, needsPassphrase: true })
      .mockResolvedValueOnce({
        summary: { notes: 12, rows: 80, recordings: 0, appVersion: "1.58.0" },
        needsPassphrase: false,
      });
    render(<ArchiveSection />);
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/sealed/);
    await user.type(screen.getByLabelText("Passphrase"), "open sesame");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(mocks.importArchive).toHaveBeenLastCalledWith({ passphrase: "open sesame" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Imported 12 notes and 80 rows from Sub Rosa 1.58.0.",
    );
  });

  it("offers only the import on the phone", () => {
    mocks.isMobilePlatform.mockReturnValue(true);
    render(<ArchiveSection />);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Include the recordings")).toBeNull();
  });
});
