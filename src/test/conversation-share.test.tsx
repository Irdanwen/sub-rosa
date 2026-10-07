// Sharing a conversation by link (ADR-0053, addendum): the desktop chat menu
// offers it for an ordinary chat and never for a temporary one, and the
// dialog asks the account for a conversation share with the chosen window.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountStatus: vi.fn(),
  accountShareConversation: vi.fn(),
}));

vi.mock("../lib/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/account")>()),
  accountStatus: mocks.accountStatus,
  onAccountStatus: () => () => undefined,
  accountShareConversation: mocks.accountShareConversation,
}));

import {
  ConversationShareHost,
  ShareConversationMenuItem,
} from "../components/agent/ConversationShare";
import { markTemporaryChat, resetTemporaryChats } from "../lib/temporary-chat";

beforeEach(() => {
  resetTemporaryChats();
  mocks.accountStatus.mockResolvedValue({ account: { email: "you@example.test" } });
  mocks.accountShareConversation.mockResolvedValue({
    id: "share-1",
    url: "https://example.test/s/share-1#k=key",
    expires_at: "2026-10-08T10:00:00Z",
  });
});

describe("Share link in the chat menu", () => {
  it("makes a link to the session with the chosen window", async () => {
    const onDone = vi.fn();
    render(
      <>
        <ShareConversationMenuItem id="session-1" title="Trip plans" onDone={onDone} />
        <ConversationShareHost />
      </>,
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Share link" }));
    expect(onDone).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Create the link" }));
    await waitFor(() =>
      expect(mocks.accountShareConversation).toHaveBeenCalledWith(
        { sessionId: "session-1", title: "Trip plans" },
        168,
      ),
    );
    expect(
      await screen.findByDisplayValue("https://example.test/s/share-1#k=key"),
    ).toBeInTheDocument();
  });

  it("is never offered for a temporary chat", async () => {
    markTemporaryChat("temp-session");
    render(<ShareConversationMenuItem id="temp-session" title="x" onDone={vi.fn()} />);
    await waitFor(() => expect(mocks.accountStatus).toHaveBeenCalled());
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("is not offered without an account", async () => {
    mocks.accountStatus.mockResolvedValue({ account: null });
    render(<ShareConversationMenuItem id="session-2" title="x" onDone={vi.fn()} />);
    await waitFor(() => expect(mocks.accountStatus).toHaveBeenCalled());
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
