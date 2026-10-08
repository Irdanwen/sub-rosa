// Office files as an assistant permission (ADR-0090, ADR-0058): off for an
// assistant saved before it existed, and saved as `documents` once turned on,
// in the editor of both shells.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantsDialog } from "../components/assistants/AssistantsDialog";
import { AssistantEditor } from "../components/mobile/screens/assistants/AssistantEditor";
import { type AssistantDefinition, emptyAssistant } from "../lib/assistants";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/keyboard-inset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));
vi.mock("../components/chat-blocks/AssistantMediaCard", () => ({ AssistantMediaList: () => null }));

// Saved before the permission existed: web search on, nothing else.
const existing: AssistantDefinition = {
  ...emptyAssistant(),
  id: "a1",
  name: "Analyst",
  instructions: "Answer with figures.",
  tools: ["web"],
  revision: 2,
};

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "assistant_list":
        return [existing];
      case "list_venice_models":
        return { models: [] };
      case "assistant_save": {
        const definition = args.definition as AssistantDefinition;
        return { ...definition, revision: definition.revision + 1 };
      }
      default:
        return [];
    }
  });
});

function savedTools(): string[] | undefined {
  const call = invoke.mock.calls.find(([command]) => command === "assistant_save");
  return (call?.[1] as { definition: AssistantDefinition } | undefined)?.definition.tools;
}

describe("office files as an assistant permission", () => {
  it("is off for an existing assistant on the computer, and saved once turned on", async () => {
    const user = userEvent.setup();
    render(<AssistantsDialog open initialEditId="a1" onClose={vi.fn()} />);
    await screen.findByDisplayValue("Analyst");
    await user.click(screen.getByRole("button", { name: "Tools" }));
    const office = screen.getByRole("checkbox", { name: /Office files/ });
    expect(office).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Web search/ })).toBeChecked();
    await user.click(office);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedTools()).toEqual(expect.arrayContaining(["web", "documents"])));
  });

  it("is off for an existing assistant on the phone, and saved once turned on", async () => {
    const user = userEvent.setup();
    render(
      <AssistantEditor
        assistantId="a1"
        onBack={vi.fn()}
        onTry={vi.fn()}
        onOpenReferences={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "Name" });
    const office = screen.getByRole("switch", { name: /Office files/ });
    expect(office).toHaveAttribute("aria-checked", "false");
    await user.click(office);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedTools()).toEqual(["documents", "web"]));
  });
});
