import { describe, expect, it, vi } from "vitest";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import type { HermesGatewayClient } from "../lib/hermes-gateway";
import {
  findBranchStoredId,
  messagesAfterUndo,
  planUserTurnEdit,
  questionCarriesImages,
  questionImages,
  regenerableTurnId,
  rewriteTargetsFor,
  undoPrefillText,
  undoTurnsFor,
} from "../lib/hermes-turn-rewrite";
import {
  branchFromMessage,
  editSentMessage,
  regenerateLastReply,
  sendArgs,
  type TurnRewriteDeps,
} from "../lib/hermes-turn-rewrite-actions";
import type { HermesSessionMessage } from "../lib/tauri";

const messages: HermesSessionMessage[] = [
  { id: "1", role: "user", content: "First question" },
  { id: "2", role: "assistant", content: "First answer" },
  { id: "3", role: "system", content: "[System: The active model changed]" },
  { id: "4", role: "user", content: "Second question" },
  { id: "5", role: "assistant", content: "Calling a tool", tool_calls: [] },
  { id: "6", role: "tool", content: "tool output" },
  { id: "7", role: "assistant", content: "Second answer" },
  { id: "8", role: "user", content: "Third question" },
  { id: "9", role: "assistant", content: "Third answer" },
];

function turn(id: string, role: AgentChatTurn["role"], extra: Partial<AgentChatTurn> = {}) {
  return {
    id,
    role,
    createdAt: `2026-10-07T10:00:0${id}Z`,
    status: "complete",
    parts: [{ type: "text", text: id, status: "complete" }],
    ...extra,
  } as AgentChatTurn;
}

describe("planning a rewrite", () => {
  it("counts the user turns /undo must back up", () => {
    // Replacing a message removes it and every exchange after it.
    expect(undoTurnsFor(messages, "8", "replace")).toBe(1);
    expect(undoTurnsFor(messages, "4", "replace")).toBe(2);
    expect(undoTurnsFor(messages, "1", "replace")).toBe(3);
    // Branching from a message keeps its whole exchange.
    expect(undoTurnsFor(messages, "1", "keep")).toBe(2);
    expect(undoTurnsFor(messages, "7", "keep")).toBe(1);
    expect(undoTurnsFor(messages, "9", "keep")).toBe(0);
    expect(undoTurnsFor(messages, "missing", "keep")).toBeUndefined();
  });

  it("mirrors the rewind locally: everything before the earliest removed question", () => {
    expect(messagesAfterUndo(messages, 1).map((m) => m.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    expect(messagesAfterUndo(messages, 2).map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(messagesAfterUndo(messages, 9)).toEqual([]);
    expect(messagesAfterUndo(messages, 0)).toHaveLength(messages.length);
  });

  it("edits the last question in place and an earlier one in a branch", () => {
    expect(planUserTurnEdit(messages, "8", "Third, better", "Third question")).toEqual({
      kind: "in-place",
      text: "Third, better",
    });
    expect(planUserTurnEdit(messages, "4", " Second, better ", "Second question")).toEqual({
      kind: "branch",
      text: "Second, better",
      undoTurns: 2,
    });
  });

  it("has nothing to do for an unchanged, empty, unsaved or non-user message", () => {
    expect(planUserTurnEdit(messages, "8", "Third question ", "Third question")).toBeUndefined();
    expect(planUserTurnEdit(messages, "8", "   ", "Third question")).toBeUndefined();
    expect(planUserTurnEdit(messages, "pending:abc", "New", "Old")).toBeUndefined();
    expect(planUserTurnEdit(messages, "9", "New", "Third answer")).toBeUndefined();
    expect(planUserTurnEdit(messages, "missing", "New", "Old")).toBeUndefined();
  });

  it("offers Regenerate on a finished, stored last reply only", () => {
    expect(regenerableTurnId([turn("1", "user"), turn("2", "assistant")])).toBe("2");
    expect(regenerableTurnId([turn("1", "user")])).toBeUndefined();
    expect(regenerableTurnId([turn("2", "assistant")])).toBeUndefined();
    expect(
      regenerableTurnId([turn("1", "user"), turn("2", "assistant", { status: "running" })]),
    ).toBeUndefined();
    expect(
      regenerableTurnId([turn("1", "user"), turn("assistant:live", "assistant")]),
    ).toBeUndefined();
    // A dead turn already carries its own Retry.
    expect(
      regenerableTurnId([
        turn("1", "user"),
        turn("2", "assistant", {
          parts: [{ type: "notice", kind: "upstream-busy", text: "Busy" }],
        }),
      ]),
    ).toBeUndefined();
  });

  it("reads the text /undo hands back", () => {
    expect(undoPrefillText({ type: "prefill", message: "Again" })).toBe("Again");
    expect(undoPrefillText({ type: "prefill", message: "  " })).toBeUndefined();
    expect(undoPrefillText(null)).toBeUndefined();
  });

  it("finds the fork the gateway made among the source's children", () => {
    const sessions = [
      { id: "old-fork", parent_session_id: "source", started_at: "2026-10-07T09:00:00Z" },
      { id: "new-fork", parent_session_id: "source", started_at: "2026-10-07T10:00:00Z" },
      { id: "elsewhere", parent_session_id: "other", started_at: "2026-10-07T11:00:00Z" },
    ];
    expect(findBranchStoredId(sessions, "source", new Set(["old-fork"]))).toBe("new-fork");
    expect(findBranchStoredId(sessions, "source", new Set(["old-fork", "new-fork"]))).toBe(
      undefined,
    );
  });
});

function fakeDeps(overrides: Partial<TurnRewriteDeps> = {}) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "session.branch") return { session_id: "fork-runtime", parent: "source" };
    if (method === "command.dispatch" && params?.name === "undo") {
      return { type: "prefill", message: "Third question" };
    }
    return {};
  });
  const gateway = { request } as unknown as HermesGatewayClient;
  const stored: Record<string, HermesSessionMessage[]> = { source: [...messages] };
  const deps: TurnRewriteDeps = {
    withLiveSession: async (storedSessionId, call) =>
      call(gateway, storedSessionId === "source" ? "source-runtime" : `${storedSessionId}-runtime`),
    isBusy: () => false,
    storedMessages: (id) => stored[id] ?? [],
    replaceStoredMessages: vi.fn((id, kept) => {
      stored[id] = kept;
    }),
    send: vi.fn(async () => undefined),
    sessionModel: () => "zai-org-glm-5-2",
    runtimeModel: (id) => `${id}@reasoning-effort=high`,
    knownSessionIds: () => new Set(["source"]),
    listSessions: async () => [
      { id: "source" },
      { id: "fork", parent_session_id: "source", started_at: "2026-10-07T10:00:00Z" },
    ],
    openBranch: vi.fn(async () => undefined),
    restoreDraft: vi.fn(),
    notice: vi.fn(),
    ...overrides,
  };
  return { deps, request, stored };
}

describe("rewriting through the gateway", () => {
  it("regenerates: one /undo on the runtime, the local copy trimmed, the question re-sent", async () => {
    const { deps, request, stored } = fakeDeps();

    await regenerateLastReply(deps, "source");

    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "source-runtime",
      name: "undo",
      arg: "",
    });
    expect(stored.source?.map((m) => m.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(deps.send).toHaveBeenCalledWith("source", "Third question");
  });

  it("refuses to rewrite while a reply is still coming", async () => {
    const { deps, request } = fakeDeps({ isBusy: () => true });

    await expect(regenerateLastReply(deps, "source")).rejects.toThrow(
      "Wait for the current reply to finish, then try again.",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("edits the last message in place", async () => {
    const { deps, request } = fakeDeps();

    const sent = await editSentMessage(deps, "source", "8", "Third, sharper", "Third question");

    expect(sent).toBe("source");
    expect(request).not.toHaveBeenCalledWith("session.branch", expect.anything());
    expect(deps.send).toHaveBeenCalledWith("source", "Third, sharper");
  });

  it("edits an earlier message in a fork rewound to just before it, on the source's model", async () => {
    const { deps, request } = fakeDeps();

    const sent = await editSentMessage(deps, "source", "4", "Second, sharper", "Second question");

    expect(sent).toBe("fork");
    // The runtime branches from its RUNTIME id; the fork is then rewound by
    // its own runtime id and put back on the source's model.
    expect(request).toHaveBeenCalledWith("session.branch", { session_id: "source-runtime" });
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "fork-runtime",
      name: "undo",
      arg: "2",
    });
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "fork-runtime",
      key: "model",
      value: "zai-org-glm-5-2@reasoning-effort=high --session",
    });
    expect(deps.openBranch).toHaveBeenCalledWith({
      storedSessionId: "fork",
      runtimeSessionId: "fork-runtime",
      sourceSessionId: "source",
    });
    expect(deps.send).toHaveBeenCalledWith("fork", "Second, sharper", "zai-org-glm-5-2");
    // The source conversation is never rewound.
    expect(request).not.toHaveBeenCalledWith("command.dispatch", {
      session_id: "source-runtime",
      name: "undo",
      arg: expect.anything(),
    });
  });

  it("does nothing for an unchanged message", async () => {
    const { deps, request } = fakeDeps();

    expect(await editSentMessage(deps, "source", "8", "Third question", "Third question")).toBe(
      undefined,
    );
    expect(request).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("branches from a message keeping its exchange, and skips /undo at the tip", async () => {
    const { deps, request } = fakeDeps();

    await branchFromMessage(deps, "source", "2");
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "fork-runtime",
      name: "undo",
      arg: "2",
    });

    request.mockClear();
    await branchFromMessage(deps, "source", "9");
    expect(request.mock.calls.some(([, params]) => params?.name === "undo")).toBe(false);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("fails honestly when the fork cannot be found", async () => {
    const { deps } = fakeDeps({ listSessions: async () => [] });

    await expect(branchFromMessage(deps, "source", "2")).rejects.toThrow(
      "Hermes did not return a branched session.",
    );
    expect(deps.openBranch).not.toHaveBeenCalled();
  });

  it("puts the question back in the composer when the send after a rewind fails", async () => {
    const { deps } = fakeDeps({
      send: vi.fn(async () => {
        throw new Error("The provider is busy.");
      }),
    });

    await expect(regenerateLastReply(deps, "source")).rejects.toThrow(
      "Your message is back in the composer. The provider is busy.",
    );
    expect(deps.restoreDraft).toHaveBeenCalledWith("source", "Third question");

    const earlier = fakeDeps({ send: deps.send });
    await expect(
      editSentMessage(earlier.deps, "source", "4", "Second, sharper", "Second question"),
    ).rejects.toThrow("Your message is back in the composer.");
    // The edit went to the fork, so that is where its text comes back.
    expect(earlier.deps.restoreDraft).toHaveBeenCalledWith("fork", "Second, sharper");
  });

  const pictureQuestion =
    "What is this?\n\nAttached files copied into the Sub Rosa workspace:\n- photo.jpg (Workspace): uploads/photo.jpg\n- notes.pdf (Workspace): uploads/notes.pdf\n\nUse these file paths when inspecting or operating on the files.";
  const withImage: HermesSessionMessage[] = [
    ...messages.slice(0, 7),
    { id: "8", role: "user", content: pictureQuestion },
    { id: "9", role: "assistant", content: "A cat." },
  ];

  it("asks a question with pictures again with its pictures attached", async () => {
    const imagesReadable = vi.fn(async () => true);
    const { deps, request } = fakeDeps({ storedMessages: () => withImage, imagesReadable });
    request.mockImplementation(async (method: string, params?: Record<string, unknown>) =>
      method === "command.dispatch" && params?.name === "undo"
        ? { type: "prefill", message: pictureQuestion }
        : {},
    );

    await regenerateLastReply(deps, "source");

    const photo = { name: "photo.jpg", path: "uploads/photo.jpg" };
    expect(imagesReadable).toHaveBeenCalledWith([photo]);
    expect(deps.send).toHaveBeenCalledWith("source", pictureQuestion, undefined, [photo]);
  });

  it("will not rewind a question whose pictures are gone, and leaves the transcript alone", async () => {
    const { deps, request } = fakeDeps({
      storedMessages: () => withImage,
      imagesReadable: async () => false,
    });

    await expect(regenerateLastReply(deps, "source")).rejects.toThrow(
      "The images of this question are no longer in the workspace.",
    );
    expect(request).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("will not ask again a question whose picture its text does not name", async () => {
    const noticeOnly: HermesSessionMessage[] = [
      ...messages.slice(0, 7),
      { id: "8", role: "user", content: "[The user attached an image but analysis failed] Hi" },
      { id: "9", role: "assistant", content: "Hello." },
    ];
    const { deps, request } = fakeDeps({ storedMessages: () => noticeOnly });

    await expect(regenerateLastReply(deps, "source")).rejects.toThrow(
      "A question with images cannot be asked again.",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("hands the workspace's send the question's pictures as attachments", () => {
    const [text, session, options] = sendArgs(
      [{ id: "source", title: "A chat" }],
      "source",
      "What is this?",
      "kimi",
      [{ name: "chart", path: "/Users/me/Pictures/chart.webp" }],
    );
    expect(text).toBe("What is this?");
    expect(session).toEqual({ id: "source", title: "A chat", model: "kimi" });
    expect(options.attachments).toHaveLength(1);
    expect(options.attachments[0]).toMatchObject({
      name: "chart",
      path: "/Users/me/Pictures/chart.webp",
      attach: { kind: "image", status: "imported", workspacePath: "/Users/me/Pictures/chart.webp" },
    });
    expect(sendArgs([], "new", "Hi")[2].attachments).toEqual([]);
  });

  it("says so when a branch cannot be put back on its source's model", async () => {
    const { deps, request } = fakeDeps();
    request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "session.branch") return { session_id: "fork-runtime", parent: "source" };
      if (method === "config.set") throw new Error("model not found");
      if (method === "command.dispatch" && params?.name === "undo") return {};
      return {};
    });

    await branchFromMessage(deps, "source", "2");

    expect(deps.openBranch).toHaveBeenCalled();
    expect(deps.notice).toHaveBeenCalledWith(
      "fork",
      expect.stringContaining("answers on your default model"),
    );
  });
});

describe("what Regenerate can resend", () => {
  it("recognises a question that carried pictures", () => {
    const block = (line: string) =>
      `Look\n\nAttached files copied into the Sub Rosa workspace:\n${line}\n\nUse these file paths when inspecting or operating on the files.`;
    expect(questionCarriesImages(block("- shot.PNG (Workspace): a/shot.PNG"))).toBe(true);
    expect(questionCarriesImages(block("- notes.pdf (Workspace): a/notes.pdf"))).toBe(false);
    expect(
      questionCarriesImages('Fix it\n\n- Image "chart": attached to this message, look at it.'),
    ).toBe(true);
    expect(questionCarriesImages("[The user attached an image but analysis failed] Hi")).toBe(true);
    expect(questionCarriesImages("Rename image.png to cover.png")).toBe(false);
  });

  it("finds the pictures again from the question's text", () => {
    const block = (line: string) =>
      `Look\n\nAttached files copied into the Sub Rosa workspace:\n${line}\n\nUse these file paths when inspecting or operating on the files.`;
    expect(questionImages(block("- cat (1).png (Workspace): uploads/cat (1).png"))).toEqual([
      { name: "cat (1).png", path: "uploads/cat (1).png" },
    ]);
    // A HEIC was never attached as pixels: it is resent as it went, as text.
    expect(questionImages(block("- shot.heic (Workspace): uploads/shot.heic"))).toEqual([]);
    expect(
      questionImages(
        'Fix it\n\n- Image "chart": attached to this message, look at it directly. Saved at `/Users/me/chart.png`.',
      ),
    ).toEqual([{ name: "chart", path: "/Users/me/chart.png" }]);
    expect(questionImages("[The user attached an image but analysis failed] Hi")).toBeUndefined();
    expect(questionImages("Rename image.png to cover.png")).toEqual([]);
  });

  it("blocks Regenerate only for such a question, and names the open chat", () => {
    const question = turn("1", "user", {
      parts: [
        {
          type: "text",
          text: '- Image "chart": attached to this message, look at it directly.',
          status: "complete",
        },
      ] as AgentChatTurn["parts"],
    });
    const reply = turn("2", "assistant");
    expect(rewriteTargetsFor([question, reply], "s1")).toEqual({
      regenerable: "2",
      lastUser: "1",
      regenerateBlocked: true,
      sessionId: "s1",
    });
    expect(rewriteTargetsFor([turn("1", "user"), reply]).regenerateBlocked).toBe(false);
  });

  it("judges the question as stored, not as the bubble shows it", () => {
    const reply = turn("2", "assistant");
    // The bubble drops the notice Hermes wrote about a picture it could not see.
    const stored: HermesSessionMessage[] = [
      { id: "1", role: "user", content: "[The user attached an image but analysis failed] Hi" },
    ];
    expect(rewriteTargetsFor([turn("1", "user"), reply], "s1", stored).regenerateBlocked).toBe(
      true,
    );
    const named: HermesSessionMessage[] = [
      {
        id: "1",
        role: "user",
        content:
          "Hi\n\nAttached files copied into the Sub Rosa workspace:\n- a.png (Workspace): uploads/a.png\n\nUse these file paths when inspecting or operating on the files.",
      },
    ];
    expect(rewriteTargetsFor([turn("1", "user"), reply], "s1", named).regenerateBlocked).toBe(
      false,
    );
  });
});
