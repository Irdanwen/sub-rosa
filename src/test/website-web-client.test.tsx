// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operator } from "../../website/src/client/carpe-diem";
import { LocalState } from "../../website/src/client/local";
import { memoryClientStore } from "../../website/src/client/store";
import { WebClient } from "../../website/src/client/ui/WebClient";
import { FakeJournal, fakeOperator, text } from "./website-client-fakes";

const ACCOUNT = {
  id: "0191d1a4-0000-7000-8000-00000000a11c",
  email: "a@example.test",
  created_at: "",
};
const KEY = () => new Uint8Array(32).fill(5);

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(replies: string[], operatorOverride?: Operator) {
  const journal = new FakeJournal();
  const store = memoryClientStore();
  let index = 0;
  const { operator, calls } = fakeOperator(() =>
    text(replies[Math.min(index++, replies.length - 1)]),
  );
  const view = render(
    <WebClient
      account={ACCOUNT}
      vaultKey={KEY()}
      openKey={async () => "cdm_test"}
      operator={operatorOverride ?? operator}
      store={store}
      transport={journal.transport()}
    />,
  );
  return { journal, store, calls, view };
}

async function ask(user: ReturnType<typeof userEvent.setup>, question: string) {
  const box = await screen.findByLabelText("Message");
  await user.type(box, question);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

/** A reply is in once it is a message with its controls, not while the
 * stream that shows it is still running. */
async function answered(reply: string) {
  await screen.findByText(reply);
  await screen.findByRole("button", { name: "Regenerate" });
}

describe("the web client", () => {
  it("chats, streams a reply and writes it to the account", async () => {
    const user = userEvent.setup();
    const { journal, calls } = setup(["Hello from Sub Rosa."]);
    await ask(user, "Hello");
    expect(await screen.findByText("Hello from Sub Rosa.")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/v1/chat/completions")?.body.model).toBe(
      "zai-org-glm-5-2",
    );
    await waitFor(() => expect(journal.changes.length).toBeGreaterThanOrEqual(3));
    const sidebar = screen.getByRole("complementary", { name: "Your chats" });
    expect(within(sidebar).getByText("Hello")).toBeInTheDocument();
    // The context gauge reads the chosen model's window.
    expect(screen.getByRole("img", { name: /Context used/ })).toBeInTheDocument();
  });

  it("regenerates, edits, rates, copies and branches like the app", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { store } = setup(["First answer.", "Second answer.", "Edited answer."]);
    await ask(user, "Question one");
    await answered("First answer.");

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await answered("Second answer.");
    expect(screen.queryByText("First answer.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Good reply" }));
    expect(screen.getByRole("button", { name: "Good reply" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const local = new LocalState(ACCOUNT.id, KEY(), store);
    const replyId = [...(store.areas.get("local")?.keys() ?? [])]
      .find((key) => key.includes(":rating:"))
      ?.split(":rating:")[1];
    expect(replyId && (await local.rating(replyId))).toBe("up");

    await user.click(screen.getAllByRole("button", { name: "Copy" })[1]);
    expect(writeText).toHaveBeenCalledWith("Second answer.");

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const edit = screen.getByLabelText("Edit your message");
    await user.clear(edit);
    await user.type(edit, "Question one, edited");
    await user.click(
      within(edit.closest("form") as HTMLElement).getByRole("button", { name: "Send" }),
    );
    expect(await screen.findByText("Edited answer.")).toBeInTheDocument();
    expect(screen.getByText("Question one, edited")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Branch" }));
    const sidebar = screen.getByRole("complementary", { name: "Your chats" });
    await waitFor(() =>
      expect(within(sidebar).getAllByRole("button", { name: /Question one/ })).toHaveLength(2),
    );
  });

  it("archives a chat into the shared Archive folder and brings it back", async () => {
    const user = userEvent.setup();
    const { journal } = setup(["Done."]);
    await ask(user, "Archive me");
    await answered("Done.");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(journal.changes.some((change) => change.kind === "folder")).toBe(true),
    );
    const sidebar = screen.getByRole("complementary", { name: "Your chats" });
    expect(within(sidebar).queryByRole("button", { name: /Archive me/ })).not.toBeInTheDocument();
    await user.click(within(sidebar).getByRole("button", { name: "Archived" }));
    expect(within(sidebar).getByRole("button", { name: /Archive me/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.click(within(sidebar).getByRole("button", { name: "Chats" }));
    expect(within(sidebar).getByRole("button", { name: /Archive me/ })).toBeInTheDocument();
  });

  it("keeps a temporary chat out of the account entirely", async () => {
    const user = userEvent.setup();
    const { journal, store } = setup(["Gone when you leave."]);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Temporary chat" }));
    await ask(user, "Off the record");
    expect(await screen.findByText("Gone when you leave.")).toBeInTheDocument();
    expect(journal.pushes).toHaveLength(0);
    expect(store.areas.get("outbox")?.size).toBe(0);
  });

  it("stops a reply and keeps what was already shown", async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    const stalling: Operator = {
      root: "https://operator.test",
      fetch: async (input, init) => {
        if (String(input).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [] }));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`,
              ),
            );
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    };
    setup([], stalling);
    await ask(user, "Talk at length");
    expect(await screen.findByText("Partial")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });

  it("exports Markdown and keeps personalization sealed in this browser", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return "blob:test";
    };
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { store } = setup(["An answer."]);
    await ask(user, "Export this");
    await answered("An answer.");
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    const markdown = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    expect(markdown).toMatch(/^# Export this\n/);
    expect(markdown).toContain("## You\n\nExport this");
    expect(markdown).toContain("## Sub Rosa\n\nAn answer.");

    await user.click(screen.getByRole("button", { name: "Personalization and memory" }));
    await user.type(screen.getByLabelText("What should Sub Rosa know about you?"), "I am a nurse.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect((await new LocalState(ACCOUNT.id, KEY(), store).personalization()).aboutYou).toBe(
        "I am a nurse.",
      ),
    );
    for (const value of store.areas.get("local")?.values() ?? [])
      expect(JSON.stringify(value)).not.toContain("nurse");
  });
});
