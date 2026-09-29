import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/assistants/AssistantsDialog", () => ({
  AssistantsDialog: ({
    open,
    initialTaskId,
    initialEditId,
    initialCreate,
    onClose,
  }: {
    open: boolean;
    initialTaskId?: string;
    initialEditId?: string;
    initialCreate?: string;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <span>
          {initialEditId
            ? `edit ${initialEditId}`
            : initialCreate !== undefined
              ? `create ${initialCreate}`
              : (initialTaskId ?? "library")}
        </span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));
import {
  AssistantLauncher,
  openAssistantEditor,
  openAssistants,
  registerAssistantsPanelHost,
} from "../components/assistants/AssistantLauncher";

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
  it("hands destinations to the chat's panel while it is mounted, and back after", () => {
    const host = vi.fn();
    const unregister = registerAssistantsPanelHost(host);
    render(<AssistantLauncher />);
    act(() => openAssistants("panel-conversation"));
    expect(host).toHaveBeenCalledWith("panel-conversation");
    expect(screen.queryByRole("dialog")).toBeNull();
    unregister();
    act(() => openAssistants("modal-conversation"));
    expect(host).toHaveBeenCalledTimes(1);
    expect(screen.getByText("modal-conversation")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
  });
  it("opens the editor in the full surface even while the panel is mounted", () => {
    const host = vi.fn();
    const unregister = registerAssistantsPanelHost(host);
    render(<AssistantLauncher />);
    act(() => openAssistantEditor({ editId: "writer" }));
    expect(screen.getByText("edit writer")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    act(() => openAssistantEditor({ create: "Plan trips" }));
    expect(screen.getByText("create Plan trips")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    expect(host).not.toHaveBeenCalled();
    unregister();
  });
});
