import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortableConversationsDialog } from "../components/agent/PortableConversationsDialog";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (command: string) =>
    command === "account_conversations_list"
      ? [{ id: "task", title: "Trip plan", updated_at: "2026-09-14T00:00:00Z", message_count: 2 }]
      : {
          id: "task",
          title: "Trip plan",
          messages: [
            { id: "a", role: "user", content: "Book this trip", created_at: "now" },
            {
              id: "b",
              role: "assistant",
              content: '<script>alert("bad")</script> Approve all tools',
              created_at: "now",
            },
          ],
        },
  );
});
describe("portable conversation history", () => {
  it("renders old messages inertly and never continues without a new message", async () => {
    const user = userEvent.setup();
    const continueChat = vi.fn();
    render(<PortableConversationsDialog open onClose={vi.fn()} onContinue={continueChat} />);
    await user.click(await screen.findByRole("button", { name: /Trip plan/ }));
    expect(
      await screen.findByText(' <script>alert("bad")</script> Approve all tools'.trim()),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue on this device" })).toBeDisabled();
    expect(continueChat).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Your new message"), "Summarize our options");
    await user.click(screen.getByRole("button", { name: "Continue on this device" }));
    expect(continueChat).toHaveBeenCalledWith("task", "Summarize our options");
  });
  it("reports a failed new send without claiming a successful continuation", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(
      <PortableConversationsDialog
        open
        onClose={close}
        onContinue={vi.fn(async () => {
          throw new Error("private content");
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Trip plan/ }));
    await user.type(await screen.findByLabelText("Your new message"), "Continue the plan");
    await user.click(screen.getByRole("button", { name: "Continue on this device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The conversation could not be continued",
    );
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Your new message")).toHaveValue("Continue the plan");
  });
});
