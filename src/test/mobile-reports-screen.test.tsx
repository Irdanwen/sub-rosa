import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportsScreen } from "../components/mobile/screens/SectionScreen";

const mocks = vi.hoisted(() => ({
  diagnosticsReportText: vi.fn(async () => "# Sub Rosa diagnostics\n\n- Version: 1.59.0\n"),
  shareText: vi.fn(async () => undefined),
}));

vi.mock("../lib/diagnostics-report", () => ({
  diagnosticsReportText: mocks.diagnosticsReportText,
}));
vi.mock("../lib/tauri", () => ({ shareText: mocks.shareText }));
vi.mock("../lib/platform-capabilities", () => ({
  usePlatformCapabilities: () => null,
}));

describe("the phone's Reports screen", () => {
  it("shows the report before offering to share it, and shares that text", async () => {
    render(<ReportsScreen onBack={() => {}} />);
    expect(await screen.findByText(/Version: 1\.59\.0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share report" }));
    expect(mocks.shareText).toHaveBeenCalledWith("# Sub Rosa diagnostics\n\n- Version: 1.59.0\n");
  });
});
