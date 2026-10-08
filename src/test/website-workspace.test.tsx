// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChats, messagesOf } from "../../website/src/client/library";
import { addMemory, allMemories } from "../../website/src/client/memories";
import { listProjects, projectIdOfChat } from "../../website/src/client/projects";
import { listSaved } from "../../website/src/client/saved";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { WebClient } from "../../website/src/client/ui/WebClient";
import { setAccountScope } from "../../website/src/lib/api";
import { FakeJournal, fakeOperator, text } from "./website-client-fakes";

const ACCOUNT = {
  id: "0191d1a4-0000-7000-8000-00000000a11c",
  email: "a@example.test",
  created_at: "",
};
const KEY = () => new Uint8Array(32).fill(5);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAccountScope(null);
});

const systemOf = (body: Record<string, unknown>) =>
  String((body.messages as { content: unknown }[])[0]?.content ?? "");
const lastUser = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user").at(-1)
    ?.content;

function setup(replies: string[]) {
  const journal = new FakeJournal();
  const store = memoryClientStore();
  let index = 0;
  const { operator, calls } = fakeOperator(() =>
    text(replies[Math.min(index++, replies.length - 1)]),
  );
  render(
    <WebClient
      account={ACCOUNT}
      vaultKey={KEY()}
      openKey={async () => "cdm_test"}
      operator={operator}
      store={store}
      transport={journal.transport()}
    />,
  );
  /** Another device's view of the account, after everything was sent. */
  const reader = async () => {
    const other = new SyncClient(ACCOUNT.id, KEY(), memoryClientStore(), journal.transport());
    await other.pull();
    return other;
  };
  return { journal, calls, reader };
}

async function ask(user: ReturnType<typeof userEvent.setup>, question: string) {
  const box = await screen.findByLabelText("Message");
  await user.type(box, question);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("the web client's workspace (WP20)", () => {
  it("attaches a file to one turn and keeps only its name in the chat", async () => {
    const user = userEvent.setup();
    const { calls, reader } = setup(["It says hello."]);
    await screen.findByLabelText("Message");
    const input = screen.getByLabelText("Attach") as HTMLInputElement;
    await user.upload(
      input,
      new File(["hello from the file"], "notes.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    await ask(user, "What does it say?");
    expect(await screen.findByText("It says hello.")).toBeInTheDocument();
    const request = calls.find((call) => call.path === "/v1/chat/completions")?.body ?? {};
    expect(lastUser(request)).toBe(
      "What does it say?\n[File: notes.txt]\n\n[File: notes.txt]\n```\nhello from the file\n```",
    );
    await waitFor(async () => {
      const other = await reader();
      const [chat] = listChats(other);
      expect(messagesOf(other, chat.id)[0].content).toBe("What does it say?\n[File: notes.txt]");
    });
  });

  it("shares a chat by link through the account service", async () => {
    const user = userEvent.setup();
    setAccountScope(ACCOUNT.id);
    const requests: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    setup(["Shared answer."]);
    await ask(user, "Share me");
    await screen.findByText("Shared answer.");
    await user.click(await screen.findByRole("button", { name: "Share link" }));
    await user.click(screen.getByRole("button", { name: "Create link" }));
    const link = (await screen.findByLabelText("Link")) as HTMLInputElement;
    expect(link.value).toMatch(/\/s\/[0-9a-f-]{36}#k=[A-Za-z0-9_-]{43}$/);
    expect(
      requests.map(
        (request) => `${request.method} ${request.url.replace(/[0-9a-f-]{36}/, "{id}")}`,
      ),
    ).toEqual(["PUT /api/v1/blobs/{id}", "POST /api/v1/shares"]);
  });

  it("starts a chat in a new project, which then speaks with the project's instructions", async () => {
    const user = userEvent.setup();
    const { calls, reader } = setup(["Planted."]);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.type(screen.getByLabelText("New project name"), "Garden");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(
      await screen.findByLabelText("Instructions for this project"),
      "Answer as a gardener.",
    );
    await user.click(screen.getByRole("button", { name: "Save project" }));
    await user.click(screen.getByRole("button", { name: "New chat in this project" }));
    expect(
      await screen.findByText("This new chat will be in the project Garden."),
    ).toBeInTheDocument();
    await ask(user, "Where do tomatoes go?");
    await screen.findByText("Planted.");
    const system = systemOf(calls.find((call) => call.path === "/v1/chat/completions")?.body ?? {});
    expect(system).toContain('project "Garden"');
    expect(system).toContain("Answer as a gardener.");
    await waitFor(async () => {
      const other = await reader();
      const [project] = listProjects(other);
      expect(project).toMatchObject({ name: "Garden", instructions: "Answer as a gardener." });
      expect(projectIdOfChat(other, listChats(other)[0].id)).toBe(project.id);
    });
  });

  it("forgets a memory everywhere from the settings", async () => {
    const user = userEvent.setup();
    const { reader, journal } = setup(["Hi."]);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Personalization and memory" }));
    await user.type(screen.getByLabelText("A fact to remember"), "Has a cat.");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Has a cat.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Forget" }));
    await user.click(screen.getByRole("button", { name: "Forget everywhere" }));
    await waitFor(() => expect(screen.queryByText("Has a cat.")).not.toBeInTheDocument());
    await waitFor(async () => {
      expect(journal.pushes.some((push) => push.kind === "memory" && push.deleted)).toBe(true);
      expect(allMemories(await reader())).toEqual([]);
    });
    expect(addMemory).toBeDefined();
  });

  it("opens a drafted canvas beside the chat and saves a reply to the library", async () => {
    const user = userEvent.setup();
    const draft = [
      "Here is a draft:",
      "```subrosa:canvas",
      JSON.stringify({ v: 1, title: "Letter", kind: "document", content: "Dear Ana," }),
      "```",
    ].join("\n");
    const { reader } = setup([draft]);
    await ask(user, "Draft a letter");
    await user.click(await screen.findByRole("button", { name: "Open in canvas" }));
    const canvas = await screen.findByRole("complementary", { name: "Canvas" });
    expect(within(canvas).getByLabelText("Canvas text, in Markdown")).toHaveValue("Dear Ana,");
    await user.click(screen.getByRole("button", { name: "Save to library" }));
    await waitFor(async () =>
      expect(listSaved(await reader()).map((item) => item.kind)).toEqual(["reply"]),
    );
    await user.click(screen.getByRole("button", { name: "Library" }));
    const library = await screen.findByRole("region", { name: "Library" });
    expect(within(library).getByText("Show the reply")).toBeInTheDocument();
    expect(within(library).getAllByText("Here is a draft:").length).toBeGreaterThan(0);
  });

  it("creates an assistant and chats with it on its own prompt", async () => {
    const user = userEvent.setup();
    const { calls } = setup(["Run three times."]);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Assistants" }));
    await user.click(screen.getByRole("button", { name: "New assistant" }));
    await user.type(screen.getByLabelText("Name"), "Coach");
    await user.type(screen.getByLabelText("Instructions"), "Coach my running.");
    await user.click(screen.getByRole("button", { name: "Save assistant" }));
    await user.click(await screen.findByRole("button", { name: "Back to your assistants" }));
    await user.click(screen.getByRole("button", { name: "Chat with Coach" }));
    await ask(user, "What is week one?");
    await screen.findByText("Run three times.");
    const system = systemOf(calls.find((call) => call.path === "/v1/chat/completions")?.body ?? {});
    expect(system.startsWith("You are Coach, a private assistant in Sub Rosa.")).toBe(true);
  });
  it("brings what the sidebar opened into view on a phone, where it sits below", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
    }));
    const scrolled = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrolled,
    });
    try {
      setup(["Hi."]);
      await screen.findByLabelText("Message");
      await user.click(screen.getByRole("button", { name: "Projects" }));
      await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ block: "start" }));
      expect((scrolled.mock.contexts.at(-1) as Element).classList.contains("wc-view")).toBe(true);
      scrolled.mockClear();
      await user.click(screen.getByRole("button", { name: "Finances" }));
      await waitFor(() => expect(scrolled).toHaveBeenCalled());
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
