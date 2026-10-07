// Thumbs up and down on a reply (ADR-0082): kept on the device through the
// shared commands, shown again on reload, changed and cleared in place, and a
// thumbs down asks why without insisting.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateReply } from "../components/chat/RateReply";
import { resetReplyRatingsCache } from "../lib/reply-ratings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

type Row = { messageId: string; rating: string; reason?: string | null; note?: string | null };
let stored: Row[];

beforeEach(() => {
  resetReplyRatingsCache();
  stored = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(
    async (command: string, args: { request: Row & { rating: string | null } }) => {
      if (command === "reply_ratings_list")
        return stored.map((row) => ({ ...row, conversationId: "chat" }));
      if (command === "reply_rating_set") {
        const { messageId, rating, reason, note } = args.request;
        stored = stored.filter((row) => row.messageId !== messageId);
        if (!rating) return null;
        const row = { messageId, rating, reason, note };
        stored.push(row);
        return { ...row, conversationId: "chat", updatedAt: "now" };
      }
      throw new Error(`unexpected ${command}`);
    },
  );
});

function rate(messageId = "m1") {
  return render(<RateReply conversationId="chat" messageId={messageId} className="action" />);
}

describe("rating a reply", () => {
  it("shows the stored rating on load and toggles a thumbs up", async () => {
    stored = [{ messageId: "m1", rating: "up" }];
    rate();
    const up = screen.getByRole("button", { name: "Good reply" });
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(up);
    expect(up).toHaveAttribute("aria-pressed", "false");
    expect(mocks.invoke).toHaveBeenCalledWith("reply_rating_set", {
      request: { conversationId: "chat", messageId: "m1", rating: null, reason: null, note: null },
    });
    expect(stored).toEqual([]);
  });

  it("asks why on a thumbs down, and keeps the reason and a note of one's own", async () => {
    rate();
    await userEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    expect(screen.getByText("What went wrong?")).toBeInTheDocument();
    expect(screen.getByText("Kept on this device only.")).toBeInTheDocument();
    for (const label of ["Not accurate", "Not helpful", "Too long", "Wrong language", "Other"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("button", { name: "Other" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your reason" }), "Wrong year");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.queryByText("What went wrong?")).toBeNull();
    expect(stored).toEqual([
      { messageId: "m1", rating: "down", reason: "other", note: "Wrong year" },
    ]);
    expect(screen.getByRole("button", { name: "Bad reply" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a thumbs down without a reason when the person skips", async () => {
    rate();
    await userEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(stored).toEqual([{ messageId: "m1", rating: "down", reason: null, note: null }]);

    // Switching to a thumbs up replaces it.
    await userEvent.click(screen.getByRole("button", { name: "Good reply" }));
    expect(stored).toEqual([{ messageId: "m1", rating: "up", reason: null, note: null }]);
  });

  it("puts the previous rating back when the store refuses the change", async () => {
    stored = [{ messageId: "m1", rating: "up" }];
    rate();
    const up = screen.getByRole("button", { name: "Good reply" });
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "true"));
    mocks.invoke.mockRejectedValueOnce(new Error("storage_unavailable"));

    await userEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Bad reply" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("reads a conversation's ratings once for all its replies", async () => {
    render(
      <>
        <RateReply conversationId="chat" messageId="m1" className="action" />
        <RateReply conversationId="chat" messageId="m2" className="action" />
      </>,
    );
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.filter(([command]) => command === "reply_ratings_list"),
      ).toHaveLength(1),
    );
  });
});
