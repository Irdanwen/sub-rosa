// Exporting a conversation (src/lib/conversation-export.ts): what the file
// says, built from the desktop transcript or the phone's messages, and the
// menu entries on both shells that write it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopContextGauge, ExportChatItems } from "../components/agent/ChatReplyExtras";
import { ChatExportButton } from "../components/mobile/ChatExportButton";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import {
  conversationMarkdown,
  exportHermesChat,
  exportTurnsFromChatTurns,
  exportTurnsFromMessages,
} from "../lib/conversation-export";
import type { AgentTaskDto, HermesSessionMessage } from "../lib/tauri";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ path: null, bytes: 10, shared: true });
});

const LINKS = [
  "Two sources:",
  "```subrosa:links",
  JSON.stringify({
    v: 1,
    title: "Sources",
    links: [{ title: "Lyon guide", url: "https://example.com/lyon" }],
  }),
  "```",
].join("\n");

function turn(id: string, role: AgentChatTurn["role"], parts: AgentChatTurn["parts"]) {
  return {
    id,
    role,
    createdAt: "2026-10-07T10:00:00Z",
    status: "complete",
    parts,
  } as AgentChatTurn;
}

describe("the exported file", () => {
  it("has the title, when and on which model, then each turn under its speaker", () => {
    const markdown = conversationMarkdown(
      {
        title: "Trip to Lyon",
        startedAt: "2026-10-06T08:30:00Z",
        model: "GLM 5.2",
        turns: [
          { role: "user", text: "Where should I eat?" },
          { role: "assistant", text: "Try the bouchons." },
          { role: "assistant", text: "   " },
        ],
      },
      new Date("2026-10-07T12:00:00Z"),
    );
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("# Trip to Lyon");
    expect(lines[2]).toMatch(/^\*.*2026.*· Model: GLM 5\.2 · Exported .*2026.*\*$/);
    expect(markdown).toContain("## You\n\nWhere should I eat?");
    expect(markdown).toContain("## Sub Rosa\n\nTry the bouchons.");
    // An empty turn is not written.
    expect(markdown.match(/## /g)).toHaveLength(2);
    expect(conversationMarkdown({ title: " ", turns: [] })).toMatch(/^# Untitled chat\n/);
  });

  it("reads the desktop transcript as the person saw it", () => {
    const turns = [
      turn("u1", "user", [
        {
          type: "text",
          status: "complete",
          text: "Plan my trip\n\nAttached files copied into the Sub Rosa workspace:\n- notes.pdf (Workspace): uploads/notes.pdf\n\nUse these file paths when inspecting or operating on the files.",
        },
      ] as AgentChatTurn["parts"]),
      turn("a1", "assistant", [
        { type: "reasoning", status: "complete", text: "thinking out loud" },
        { type: "text", status: "complete", text: LINKS },
      ] as AgentChatTurn["parts"]),
      turn("p1", "user", [
        { type: "process", processId: "p", status: "completed", command: "ls", output: "" },
      ] as unknown as AgentChatTurn["parts"]),
      turn("s1", "system", [
        { type: "text", status: "complete", text: "[System: model changed]" },
      ] as AgentChatTurn["parts"]),
    ];
    expect(exportTurnsFromChatTurns(turns)).toEqual([
      { role: "user", text: "Plan my trip" },
      {
        role: "assistant",
        text: "Two sources:\nSources\n- Lyon guide: https://example.com/lyon",
      },
    ]);
  });

  it("reads the phone's messages, cards as lists", () => {
    expect(
      exportTurnsFromMessages([
        { role: "user", content: " Hello " },
        { role: "assistant", content: LINKS },
        { role: "assistant", content: "" },
      ]),
    ).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Two sources:\nSources\n- Lyon guide: https://example.com/lyon" },
    ]);
  });

  it("hands the shell the title, the Markdown and the format", async () => {
    const onError = vi.fn();
    await exportHermesChat(
      "pdf",
      { title: "Plan", model: "zai-org-glm-5-2@reasoning-effort=high", started_at: 1_791_000_000 },
      [
        turn("u1", "user", [
          { type: "text", status: "complete", text: "Hi" },
        ] as AgentChatTurn["parts"]),
      ],
      onError,
    );
    const [command, args] = mocks.invoke.mock.calls[0];
    expect(command).toBe("export_conversation");
    expect(args.request.title).toBe("Plan");
    expect(args.request.format).toBe("pdf");
    expect(args.request.markdown).toContain("## You\n\nHi");
    // The reasoning-effort alias never reaches the file.
    expect(args.request.markdown).not.toContain("reasoning-effort");
    expect(onError).not.toHaveBeenCalled();

    mocks.invoke.mockRejectedValueOnce(new Error("disk full"));
    await exportHermesChat("markdown", { title: "Plan" }, [], onError);
    expect(onError).toHaveBeenCalledWith("The conversation could not be exported: disk full");
  });
});

describe("where an export starts", () => {
  it("offers Markdown and PDF in the desktop chat menu", async () => {
    const onExport = vi.fn();
    const close = vi.fn();
    const { rerender } = render(<ExportChatItems onExport={onExport} close={close} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Export as PDF" }));
    expect(close).toHaveBeenCalled();
    expect(onExport).toHaveBeenCalledWith("pdf");
    await userEvent.click(screen.getByRole("menuitem", { name: "Export as Markdown" }));
    expect(onExport).toHaveBeenLastCalledWith("markdown");

    rerender(<ExportChatItems close={close} />);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("opens a sheet from the phone chat and exports the chat's messages", async () => {
    const task: Pick<AgentTaskDto, "title" | "createdAt" | "model" | "messages"> = {
      title: "Lyon",
      createdAt: "2026-10-06T08:30:00Z",
      model: "zai-org-glm-5-2",
      messages: [
        { id: "u1", taskId: "t", role: "user", content: "Hi", createdAt: "x" },
        { id: "a1", taskId: "t", role: "assistant", content: "Hello", createdAt: "x" },
      ],
    };
    render(<ChatExportButton task={task} onError={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Export chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    const [command, args] = mocks.invoke.mock.calls[0];
    expect(command).toBe("export_conversation");
    expect(args.request.format).toBe("markdown");
    expect(args.request.markdown).toContain("## Sub Rosa\n\nHello");
  });

  it("has nothing to export in an empty chat", () => {
    render(
      <ChatExportButton task={{ title: "", createdAt: "x", messages: [] }} onError={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Export chat" })).toBeNull();
  });
});

describe("the desktop context gauge", () => {
  const messages: HermesSessionMessage[] = [
    { id: "1", role: "user", content: "x".repeat(40_000) },
    { id: "2", role: "tool", content: [{ type: "text", text: "y".repeat(40_000) }] },
  ];

  it("counts the stored messages, tool output included, against the window", () => {
    render(<DesktopContextGauge model={{ contextTokens: 32_000 }} messages={messages} />);
    // 4000 allowance + 10000 + 10000 tokens of 32K.
    expect(
      screen.getByRole("button", { name: "About 24K of 32K tokens used" }),
    ).toBeInTheDocument();
  });

  it("is not drawn before a message or without a known window", () => {
    const { container, rerender } = render(
      <DesktopContextGauge model={{ contextTokens: 32_000 }} messages={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<DesktopContextGauge model={{}} messages={messages} />);
    expect(container).toBeEmptyDOMElement();
  });
});
