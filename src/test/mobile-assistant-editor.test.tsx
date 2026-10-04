import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantCreator } from "../components/mobile/screens/assistants/AssistantCreator";
import { AssistantEditor } from "../components/mobile/screens/assistants/AssistantEditor";
import { AssistantReferencesScreen } from "../components/mobile/screens/assistants/AssistantReferencesScreen";
import { readEditorDraft, writeEditorDraft } from "../lib/assistant-draft";
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

const plume: AssistantDefinition = {
  ...emptyAssistant(),
  id: "a1",
  name: "Plume",
  description: "Writes travel letters",
  instructions: "Write warmly.",
  revision: 3,
};

function backend(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (overrides[command]) return overrides[command](args);
    switch (command) {
      case "assistant_list":
        return [plume];
      case "assistant_reference_list":
        return [];
      case "list_venice_models":
        return { models: [] };
      case "assistant_save": {
        const definition = args.definition as AssistantDefinition;
        return { ...definition, id: definition.id || "a-new", revision: definition.revision + 1 };
      }
      default:
        return null;
    }
  });
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

describe("the assistant editor on the phone", () => {
  it("keeps unsaved edits when the screen goes away, and offers them back", async () => {
    backend();
    const user = userEvent.setup();
    const props = {
      assistantId: "a1",
      onBack: vi.fn(),
      onTry: vi.fn(),
      onOpenReferences: vi.fn(),
      onDeleted: vi.fn(),
    };
    const first = render(<AssistantEditor {...props} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Plume de voyage");
    await waitFor(() => expect(readEditorDraft("a1", 3)?.definition.name).toBe("Plume de voyage"));
    first.unmount();

    render(<AssistantEditor {...props} />);
    expect(await screen.findByText("Your unsaved changes were restored.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Plume de voyage");
  });

  it("drops edits written against a revision saved over since", async () => {
    backend();
    writeEditorDraft("a1", { baseRevision: 2, definition: { ...plume, name: "Stale" } });
    render(
      <AssistantEditor
        assistantId="a1"
        onBack={vi.fn()}
        onTry={vi.fn()}
        onOpenReferences={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Plume");
    expect(screen.queryByText("Your unsaved changes were restored.")).toBeNull();
  });

  it("asks before leaving with changes, and discarding forgets them", async () => {
    backend();
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <AssistantEditor
        assistantId="a1"
        onBack={onBack}
        onTry={vi.fn()}
        onOpenReferences={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "!");
    await waitFor(() => expect(readEditorDraft("a1", 3)).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Assistants" }));
    const sheet = await screen.findByRole("dialog", { name: "Save your changes?" });
    expect(onBack).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole("button", { name: "Discard changes" }));
    expect(onBack).toHaveBeenCalled();
    expect(readEditorDraft("a1", 3)).toBeNull();
  });

  it("saves from the header, with the tools in the order the definition keeps them", async () => {
    backend();
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
    await user.click(screen.getByRole("switch", { name: "Video" }));
    await user.click(screen.getByRole("switch", { name: "Web search" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_save", {
        definition: expect.objectContaining({ id: "a1", tools: ["video", "web"] }),
      }),
    );
    await waitFor(() => expect(readEditorDraft("a1", 3)).toBeNull());
  });

  it("a picture needs a saved assistant, and says so", async () => {
    backend();
    const user = userEvent.setup();
    render(
      <AssistantEditor
        onBack={vi.fn()}
        onTry={vi.fn()}
        onOpenReferences={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Change the avatar" }));
    expect(await screen.findByRole("dialog", { name: "Save your assistant first" })).toBeTruthy();
  });
});

describe("the guided creator on the phone", () => {
  it("asks one question per screen and keeps the answers across a tab switch", async () => {
    backend();
    const user = userEvent.setup();
    const props = { onBack: vi.fn(), onDrafted: vi.fn(), onWriteMyself: vi.fn() };
    const first = render(<AssistantCreator {...props} />);
    await user.type(screen.getByRole("textbox", { name: "Your idea" }), "Travel letters");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("progressbar", { name: "Question 1 of 4" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Just me" }));
    expect(screen.getByRole("button", { name: "Just me" })).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    render(<AssistantCreator {...props} />);
    expect(screen.getByRole("progressbar", { name: "Question 1 of 4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Just me" })).toHaveAttribute("aria-pressed", "true");
  });

  it("drafts the assistant into the editor's new draft", async () => {
    backend({
      assistant_draft: () => ({
        name: "Plume",
        description: "Letters",
        instructions: "Write.",
        openingMessage: "Hello",
        tools: ["web"],
      }),
    });
    const onDrafted = vi.fn();
    const user = userEvent.setup();
    render(<AssistantCreator onBack={vi.fn()} onDrafted={onDrafted} onWriteMyself={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "Your idea" }), "Travel letters");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    for (let step = 0; step < 3; step += 1)
      await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Prepare my draft" }));
    await waitFor(() => expect(onDrafted).toHaveBeenCalled());
    expect(readEditorDraft("", 0)?.definition).toMatchObject({
      name: "Plume",
      opening_message: "Hello",
    });
  });
});

describe("an assistant's references on the phone", () => {
  it("removes a reference only after the sheet confirms it", async () => {
    backend({
      assistant_reference_list: () => [
        { id: "r1", name: "Itinerary.pdf", format: "pdf", status: "ready", note_id: null },
      ],
    });
    const user = userEvent.setup();
    render(<AssistantReferencesScreen assistantId="a1" onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Itinerary\.pdf/ }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove this reference?" });
    expect(invoke).not.toHaveBeenCalledWith("assistant_reference_delete", expect.anything());
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assistant_reference_delete", { id: "r1" }),
    );
  });
});
