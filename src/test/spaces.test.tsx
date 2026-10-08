// Shared projects (ADR-0098): the Preview switch stays off until turned on,
// joining shows the safety number before anything is accepted, the owner
// admits only a verified acceptance, and a reply says whose key paid.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: calls.writeText }));

import { JoinSpaceDialog } from "../components/spaces/JoinSpaceDialog";
import { ShareProjectButton } from "../components/spaces/ShareProjectButton";
import { SharedProjectsCard } from "../components/spaces/SharedProjectsCard";
import { authorLine } from "../components/spaces/SpaceChat";
import { SpaceDialog } from "../components/spaces/SpaceDialog";
import {
  formatSafetyNumber,
  looksLikeInvitation,
  type Space,
  type SpaceMessage,
  type SpaceSummary,
} from "../lib/spaces";

const SPACE_ID = "0191d1a4-5a00-7000-8000-00000000a001";
const CODE = `srspace1.0191d1a4-1000-7000-8000-00000000f001.${"A".repeat(43)}`;
const GROUPS = [
  "12345",
  "67890",
  "11111",
  "22222",
  "33333",
  "44444",
  "55555",
  "66666",
  "77777",
  "88888",
  "99999",
  "00000",
];

function summary(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: SPACE_ID,
    name: "Launch plan",
    role: "owner",
    state: "active",
    sourceFolderId: "folder-1",
    unread: 0,
    lastError: null,
    updatedAt: "2026-10-08T12:00:00Z",
    ...over,
  };
}
function space(over: Partial<Space> = {}): Space {
  return {
    summary: summary(),
    instructions: "Answer in French.",
    isOwner: true,
    members: [
      {
        accountId: "me",
        name: "Alice",
        role: "owner",
        isMe: true,
        verified: false,
        safetyNumber: [],
      },
      {
        accountId: "bob",
        name: "Bob",
        role: "member",
        isMe: false,
        verified: false,
        safetyNumber: GROUPS,
      },
    ],
    notes: [],
    files: [],
    conversations: [{ id: "c1", title: "Planning", messages: 1, lastAt: "2026-10-08T12:00:00Z" }],
    turns: [],
    pendingWrites: 0,
    ...over,
  };
}
function route(table: Record<string, (args: Record<string, unknown>) => unknown>) {
  calls.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = table[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args ?? {});
  });
}

async function openCard() {
  const details = screen.getByText("Shared projects").closest("details");
  if (!details) throw new Error("card");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}

beforeEach(() => {
  calls.invoke.mockReset();
  calls.writeText.mockClear();
});

describe("shared projects in settings", () => {
  it("says it is a preview and stays off until the person turns it on", async () => {
    let enabled = false;
    route({
      spaces_status: () => ({ enabled, displayName: "", spaces: [] }),
      spaces_set_enabled: (args) => {
        enabled = args.enabled as boolean;
        return { enabled, displayName: args.displayName, spaces: [] };
      },
    });
    render(<SharedProjectsCard />);
    expect(screen.getByText(/has not been independently reviewed yet/)).toBeTruthy();
    // Nothing is read until the card is opened.
    expect(calls.invoke).not.toHaveBeenCalled();
    await openCard();
    const toggle = await screen.findByRole("checkbox", { name: "Turn on shared projects" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("Join with a link")).toBeNull();
    await userEvent.click(toggle);
    await screen.findByText("Join with a link");
    expect(calls.invoke).toHaveBeenCalledWith("spaces_set_enabled", {
      enabled: true,
      displayName: "",
    });
  });

  it("tells a removed member that what they received stays, and lets them forget it", async () => {
    route({
      spaces_status: () => ({
        enabled: true,
        displayName: "Bob",
        spaces: [summary({ role: "member", state: "removed" })],
      }),
      spaces_forget: () => undefined,
    });
    render(<SharedProjectsCard />);
    await openCard();
    await screen.findByText(/You are no longer a member. What you already received stays/);
    await userEvent.click(screen.getByRole("button", { name: "Forget on this device" }));
    expect(calls.invoke).toHaveBeenCalledWith("spaces_forget", { spaceId: SPACE_ID });
  });
});

describe("joining with a link", () => {
  it("shows the safety number before anything is accepted", async () => {
    route({
      spaces_open_invitation: () => ({
        invitationId: "i",
        spaceId: SPACE_ID,
        spaceName: "Launch plan",
        expiresAt: "2026-10-15T12:00:00Z",
        safetyNumber: GROUPS,
      }),
      spaces_accept_invitation: () => summary({ role: "member", state: "pending" }),
    });
    const joined = vi.fn();
    render(<JoinSpaceDialog open onClose={() => undefined} onJoined={joined} />);
    const next = screen.getByRole("button", { name: "Continue" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      screen.getByLabelText("Invitation link"),
      `https://example.test/app#join=${CODE}`,
    );
    await userEvent.click(next);
    await screen.findByText("12345");
    expect(calls.invoke).not.toHaveBeenCalledWith("spaces_accept_invitation", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByText(/The owner lets you in from their device/);
    expect(joined).toHaveBeenCalled();
  });
});

describe("the shared project", () => {
  it("lets the owner admit only an acceptance that verified, after its safety number", async () => {
    route({
      spaces_get: () => space(),
      spaces_mark_read: () => undefined,
      spaces_sync: () => undefined,
      spaces_messages: () => [],
      spaces_invitations: () => [
        { id: "ready-1", expiresAt: "x", state: "ready", safetyNumber: GROUPS },
        { id: "odd-1", expiresAt: "x", state: "unverifiable", safetyNumber: [] },
      ],
      spaces_admit: () => undefined,
    });
    render(<SpaceDialog spaceId={SPACE_ID} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Members" }));
    const ready = (await screen.findByText(/Someone accepted/)).closest(".spaces-list-item");
    if (!(ready instanceof HTMLElement)) throw new Error("row");
    expect(within(ready).getByText("12345")).toBeTruthy();
    await userEvent.click(within(ready).getByRole("button", { name: "Let them in" }));
    expect(calls.invoke).toHaveBeenCalledWith("spaces_admit", {
      spaceId: SPACE_ID,
      invitationId: "ready-1",
    });
    const odd = screen.getByText(/cannot be verified on this device/).closest(".spaces-list-item");
    if (!(odd instanceof HTMLElement)) throw new Error("row");
    expect(within(odd).queryByRole("button", { name: "Let them in" })).toBeNull();
  });

  it("asks before removing someone and says what they keep", async () => {
    route({
      spaces_get: () => space(),
      spaces_mark_read: () => undefined,
      spaces_sync: () => undefined,
      spaces_messages: () => [],
      spaces_invitations: () => [],
      spaces_remove_member: () => undefined,
    });
    render(<SpaceDialog spaceId={SPACE_ID} onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Members" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/they keep what they already received/)).toBeTruthy();
    expect(calls.invoke).not.toHaveBeenCalledWith("spaces_remove_member", expect.anything());
    const buttons = screen.getAllByRole("button", { name: "Remove" });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(calls.invoke).toHaveBeenCalledWith("spaces_remove_member", {
      spaceId: SPACE_ID,
      accountId: "bob",
    });
  });

  it("sends to everyone, and asks the assistant only on request", async () => {
    route({
      spaces_get: () => space(),
      spaces_mark_read: () => undefined,
      spaces_sync: () => undefined,
      spaces_messages: () => [],
      spaces_send_message: () => undefined,
    });
    render(<SpaceDialog spaceId={SPACE_ID} onClose={() => undefined} />);
    await userEvent.type(await screen.findByLabelText("Message"), "Who brings the projector?");
    await userEvent.click(screen.getByRole("button", { name: "Send and ask the assistant" }));
    expect(calls.invoke).toHaveBeenCalledWith("spaces_send_message", {
      spaceId: SPACE_ID,
      conversationId: "c1",
      text: "Who brings the projector?",
      askAssistant: true,
    });
    expect(screen.getByText(/you pay for that reply/)).toBeTruthy();
  });
});

describe("the group chat", () => {
  it("opens on its newest message, whatever the height left to the thread", async () => {
    const message = (id: string): SpaceMessage => ({
      id,
      role: "user",
      text: `Message ${id}`,
      authorId: "bob",
      authorName: "Bob",
      isMine: false,
      model: null,
      paidByName: null,
      pending: false,
      createdAt: "x",
    });
    const height = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("spaces-messages") ? 900 : 0;
      });
    route({
      spaces_get: () => space(),
      spaces_mark_read: () => undefined,
      spaces_sync: () => undefined,
      spaces_messages: () => ["1", "2", "3"].map(message),
    });
    render(<SpaceDialog spaceId={SPACE_ID} onClose={() => undefined} />);
    await screen.findByText("Message 3");
    const thread = document.querySelector(".spaces-messages");
    expect(thread?.scrollTop).toBe(900);
    height.mockRestore();
  });
});

describe("small rules", () => {
  it("names whose key paid for a reply", () => {
    const reply: SpaceMessage = {
      id: "m",
      role: "assistant",
      text: "Nobody yet.",
      authorId: "carol",
      authorName: "Carol",
      isMine: false,
      model: "m",
      paidByName: "Carol",
      pending: false,
      createdAt: "x",
    };
    expect(authorLine(reply)).toBe("Assistant, answered with Carol's key");
    expect(authorLine({ ...reply, role: "user", isMine: true })).toBe("You");
    expect(authorLine({ ...reply, role: "user", authorName: null })).toBe("A member");
  });

  it("recognises an invitation code in a link and formats a safety number", () => {
    expect(looksLikeInvitation(`https://x.test/app#join=${CODE}`)).toBe(true);
    expect(looksLikeInvitation("srspace1.nope")).toBe(false);
    expect(formatSafetyNumber(GROUPS).split(" ")).toHaveLength(12);
  });

  it("hides the share button while the preview is off", async () => {
    route({ spaces_status: () => ({ enabled: false, displayName: "", spaces: [] }) });
    const { container } = render(<ShareProjectButton folderId="folder-1" />);
    await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith("spaces_status"));
    expect(container.textContent).toBe("");
  });
});
