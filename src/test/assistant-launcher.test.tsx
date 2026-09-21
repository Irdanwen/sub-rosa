import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/assistants/AssistantsDialog", () => ({
  AssistantsDialog: ({
    open,
    initialTaskId,
    onClose,
  }: {
    open: boolean;
    initialTaskId?: string;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <span>{initialTaskId ?? "library"}</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));
import { AssistantLauncher, openAssistants } from "../components/assistants/AssistantLauncher";

describe("assistant destination launcher", () => {
  it("retains a cold-launch conversation until the shell mounts, then reuses one modal", () => {
    openAssistants("archived-conversation");
    render(<AssistantLauncher />);
    expect(screen.getByText("archived-conversation")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      render(
        <button type="button" onClick={() => openAssistants("next-conversation")}>
          Notification
        </button>,
      ).getByText("Notification"),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("next-conversation")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
  });
});
