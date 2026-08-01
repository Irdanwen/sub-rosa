import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../lib/branding";
import {
  appendLiveHermesEvent,
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  completedHermesMessageText,
  displayedComposerUserMessageText,
  HERMES_LIVE_EVENT_LIMIT,
  hermesMessagesEndInterrupted,
  hermesMessagesHaveAssistantReply,
  hermesMessagesShowCompletedTurn,
  isProcessNoticeTurn,
  type AgentChatTurn,
  type LiveHermesEvent,
  repairContractionSpacing,
  toolEventKey,
  withInterruptedTurnNotice,
} from "../lib/agent-chat-runtime";
import { categoryPrompt } from "../lib/issue-report-prompt";
import { explicitSkillInvocationPrompt } from "../lib/skill-slash-commands";
import type { AgentMessageDto, HermesSessionMessage } from "../lib/tauri";

describe("repairContractionSpacing", () => {
  it("re-inserts the space the gateway drops after a contraction", () => {
    // Real cases pulled from the persisted Hermes store.
    expect(repairContractionSpacing("it'snot")).toBe("it's not");
    expect(repairContractionSpacing("you'rereferring")).toBe("you're referring");
    expect(repairContractionSpacing("Mac'scamera")).toBe("Mac's camera");
    expect(repairContractionSpacing("here'swhat'sthere:")).toBe("here's what's there:");
    expect(repairContractionSpacing("we'vechecked and they'lldo it")).toBe(
      "we've checked and they'll do it",
    );
    expect(repairContractionSpacing("I'mdone, don'tworry")).toBe("I'm done, don't worry");
  });

  it("leaves correctly spaced and non-contraction text untouched", () => {
    // Idempotent: already-spaced text has no match.
    expect(repairContractionSpacing("it's not there")).toBe("it's not there");
    expect(repairContractionSpacing("its not a contraction")).toBe("its not a contraction");
    // Trailing punctuation, not a following word, isn't a dropped space.
    expect(repairContractionSpacing("that's it.")).toBe("that's it.");
    // Names with apostrophes aren't contraction enclitics.
    expect(repairContractionSpacing("d'Artagnan and O'Brien")).toBe("d'Artagnan and O'Brien");
  });

  it("does not corrupt a plural possessive glued to the next word", () => {
    // "kids' toys" glued is ambiguous with "kids'" + a "t…" word; the 's'
    // guard keeps it untouched rather than mis-splitting into "kids't oys".
    expect(repairContractionSpacing("kids'toys")).toBe("kids'toys");
    expect(repairContractionSpacing("the cars'doors")).toBe("the cars'doors");
  });
});

describe("Agent chat runtime", () => {
  it("strips the cron preamble and flags a scheduled-run turn", () => {
    const preamble =
      "[IMPORTANT: You are running as a scheduled cron job. SILENT: respond " +
      'with exactly "[SILENT]" if nothing is new. Never combine [SILENT] ' +
      "with content — say [SILENT] and nothing more.]";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: `${preamble}\n\nSummarize GitHub activity for the team.`,
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.isScheduledRun).toBe(true);
    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "Summarize GitHub activity for the team.",
        status: "complete",
      },
    ]);
  });

  it("leaves an ordinary user turn unflagged", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Summarize GitHub activity for the team.",
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.isScheduledRun).toBeUndefined();
  });

  it("renders an injected background-process notification as a process row", () => {
    // Hermes wakes the agent by submitting the process output as a prompt, so
    // this lands in the transcript as a `user` message the user never wrote.
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content:
          '[IMPORTANT: Background process proc_a8f9b7e429b2 matched watch pattern "Serving HTTP on".\nCommand: python3 -m http.server 8765\nMatched output:\nServing HTTP on 127.0.0.1 port 8765]',
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    // The role stays `user`: it is what Hermes stored, and the transcript's
    // "the agent owes a reply" heuristics key off it. Only the rendering
    // changes, and the part carries no text part to copy or edit.
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.parts).toEqual([
      {
        type: "process",
        kind: "watch-match",
        label: 'Background process matched "Serving HTTP on"',
        detail: expect.stringContaining("Command: python3 -m http.server 8765"),
      },
    ]);
    expect(isProcessNoticeTurn(turns[0] as AgentChatTurn)).toBe(true);
  });

  it("keeps a real user message out of the process-row path", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Start the build in the background",
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts[0]?.type).toBe("text");
    expect(isProcessNoticeTurn(turns[0] as AgentChatTurn)).toBe(false);
  });

  it("renders persisted Hermes user and assistant messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Hi",
        timestamp: 1_780_590_879,
      },
      {
        id: "2",
        role: "assistant",
        content: "Hi! How can I help?",
        timestamp: 1_780_590_880,
        reasoning: "The user greeted me.",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Hi", status: "complete" }]);
    expect(turns[1]?.parts).toEqual([
      {
        type: "reasoning",
        text: "The user greeted me.",
        status: "complete",
      },
      { type: "text", text: "Hi! How can I help?", status: "complete" },
    ]);
  });

  it("preserves same-timestamp Hermes user-before-assistant source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "user-message",
        role: "user",
        content: "Please check this.",
        timestamp: createdAt,
      },
      {
        id: "assistant-message",
        role: "assistant",
        content: "Thinking about it.",
        timestamp: createdAt,
      },
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("preserves same-timestamp task user-before-assistant source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "user-message",
        taskId: "task-1",
        role: "user",
        content: "Please check this.",
        createdAt,
      },
      {
        id: "assistant-message",
        taskId: "task-1",
        role: "assistant",
        content: "Thinking about it.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("preserves same-timestamp Hermes assistant-before-user source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "assistant-message",
        role: "assistant",
        content: "Here is the answer.",
        timestamp: createdAt,
      },
      {
        id: "user-follow-up",
        role: "user",
        content: "One more thing.",
        timestamp: createdAt,
      },
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  });

  it("preserves same-timestamp task assistant-before-user source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "assistant-message",
        taskId: "task-1",
        role: "assistant",
        content: "Here is the answer.",
        createdAt,
      },
      {
        id: "user-follow-up",
        taskId: "task-1",
        role: "user",
        content: "One more thing.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  });

  it("preserves same-timestamp Hermes same-role source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "z-message",
        role: "assistant",
        content: "First assistant row.",
        timestamp: createdAt,
      },
      {
        id: "a-message",
        role: "assistant",
        content: "Second assistant row.",
        timestamp: createdAt,
      },
    ]);

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(["First assistant row.", "Second assistant row."]);
  });

  it("preserves same-timestamp task same-role source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "z-message",
        taskId: "task-1",
        role: "assistant",
        content: "First assistant row.",
        createdAt,
      },
      {
        id: "a-message",
        taskId: "task-1",
        role: "assistant",
        content: "Second assistant row.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(["First assistant row.", "Second assistant row."]);
  });

  it("keeps synthetic same-timestamp assistant turns in source order", () => {
    const receivedAt = "2026-06-11T12:00:00.000Z";
    const turns = buildAgentChatTurns(
      [],
      [],
      Array.from({ length: 12 }, (_, index) => ({
        type: "message.complete",
        receivedAt,
        payload: { text: `Reply ${index}` },
      })),
    );

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(Array.from({ length: 12 }, (_, index) => `Reply ${index}`));
  });

  it("strips explicit skill context from persisted Hermes user messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: explicitSkillInvocationPrompt(
          [
            {
              name: "repo-build-pr",
              relativePath: "repo-build-pr/SKILL.md",
              content: "# Repo build PR\n\nOpen a draft PR.",
            },
          ],
          "implement issue JUN-46",
        ),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "implement issue JUN-46",
        status: "complete",
      },
    ]);
  });

  it("strips report prompts that contain explicit skill context", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: categoryPrompt(
          "feature",
          explicitSkillInvocationPrompt(
            [
              {
                name: "repo-build-pr",
                relativePath: "repo-build-pr/SKILL.md",
                content: "# Repo build PR\n\nOpen a draft PR.",
              },
            ],
            "add slash commands",
          ),
        ),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "add slash commands",
        status: "complete",
      },
    ]);
  });

  it("strips image-analysis failure scaffolding from persisted Hermes user messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: [
          "[The user attached an image but analysis failed.]",
          "[You can examine it with vision_analyze using image_url:",
          "/Users/alex/Library/Application Support/co.opensoftware.june-dev/hermes/images/upload_20260629_144756_1.png]",
          "",
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: [
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        status: "complete",
      },
    ]);
  });

  it("hides attachment and image-analysis scaffolding from composer user display text", () => {
    expect(
      displayedComposerUserMessageText(
        [
          "[The user attached an image but analysis failed.]",
          "[You can examine it with vision_analyze using image_url:",
          "/Users/alex/Library/Application Support/co.opensoftware.june-dev/hermes/images/upload_20260629_144756_1.png]",
          "",
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
      ),
    ).toBe("wdyt?");
  });

  it("hides attachment scaffolding written under the current product name", () => {
    // The block above is what pre-rebrand transcripts carry ("June
    // workspace"); this is what the composer emits today. Both spellings must
    // strip, so the matcher stays loose about the workspace name.
    expect(
      displayedComposerUserMessageText(
        [
          "wdyt?",
          "",
          `Attached files copied into the ${PRODUCT_NAME} workspace:`,
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
      ),
    ).toBe("wdyt?");
  });

  it("keeps attachment paths in turn data but hides them from the rendered user bubble", () => {
    // The user bubble renders each part through displayedComposerUserMessageText
    // (AgentWorkspace), so it must show only the user's words. The built turn
    // data must still retain the attachment-path block, because
    // assignArtifactsToTurns attributes workspace artifacts by matching those
    // paths against the turn text. This pins both halves of that contract.
    const content = [
      "wdyt?",
      "",
      "Attached files copied into the June workspace:",
      "- screenshot.png (Workspace): uploads/screenshot.png",
      "",
      "Use these file paths when inspecting or operating on the files.",
      "",
      "--- Attached Context ---",
      "GLM 5.2 does not support image input in June.",
      "Reply directly and briefly.",
    ].join("\n");
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content,
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);
    const part = turns[0]?.parts[0];
    const turnText = part?.type === "text" ? part.text : "";
    // Turn data retains the attachment path (artifact attribution reads this)…
    expect(turnText).toContain("uploads/screenshot.png");
    // …but the provider/vision scaffolding after the marker is already gone.
    expect(turnText).not.toContain("--- Attached Context ---");
    expect(turnText).not.toContain("does not support image input");
    // The rendered bubble shows only the user's words — no attachment block.
    expect(displayedComposerUserMessageText(turnText)).toBe("wdyt?");
  });

  it("extracts text from Hermes structured content payloads", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content:
          'Say hello\n\n--- Attached Context ---\n{"ignored":true}\n\n--- Context Warnings ---\nwarning',
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: JSON.stringify([{ type: "output_text", text: "Hello there" }]),
        timestamp: "2026-06-04T10:00:01.000Z",
      },
      {
        id: "3",
        role: "assistant",
        content: { message: { content: "Nested reply" } },
        timestamp: "2026-06-04T10:00:02.000Z",
      } as HermesSessionMessage,
    ]);

    const textParts = turns.map((turn) =>
      turn.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );

    expect(textParts).toEqual(["Say hello", "Hello there", "Nested reply"]);
  });

  it("classifies Hermes context compaction summaries as system context", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "compact-1",
        role: "assistant",
        content:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.\n\n" +
          "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("system");
    expect(turns[0]?.parts).toEqual([
      {
        type: "context",
        text:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.",
        preview:
          "Earlier turns were compacted; fallback summary generated without the LLM summarizer.",
        status: "complete",
      },
    ]);
  });

  it("appends live reasoning deltas without inserting log line breaks", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "thinking.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "I should prefer" },
        },
        {
          type: "thinking.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "ably use Homebrew." },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "reasoning",
        text: "I should preferably use Homebrew.",
        status: "running",
      },
    ]);
  });

  it("renders live clarify requests as answerable chat parts", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-1", name: "clarify" },
        },
        {
          type: "clarify.request",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: {
            request_id: "clarify-1",
            question: "Which email provider should I configure?",
            choices: ["Gmail", "Fastmail"],
          },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        sessionId: "runtime-session",
        question: "Which email provider should I configure?",
        choices: ["Gmail", "Fastmail"],
        status: "pending",
      },
    ]);
  });

  it("marks clarify requests resolved after responses or tool completion", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "clarify.request",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            request_id: "clarify-1",
            question: "Use Gmail?",
            choices: ["Yes", "No"],
          },
        },
        {
          type: "clarify.response",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { request_id: "clarify-1", answer: "Yes" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          payload: { tool_id: "tool-1", name: "clarify" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        question: "Use Gmail?",
        choices: ["Yes", "No"],
        answer: "Yes",
        status: "resolved",
      },
    ]);
  });

  it("marks approval requests resolved after responses", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "approval.request",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            request_id: "approval-1",
            command: "python script.py",
            description: "Run this command?",
            allow_permanent: true,
          },
        },
        {
          type: "approval.response",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { request_id: "approval-1", choice: "session" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "approval",
        id: "approval-1",
        sessionId: "runtime-session",
        command: "python script.py",
        description: "Run this command?",
        allowPermanent: true,
        choice: "session",
        status: "resolved",
      },
    ]);
  });

  it("preserves whitespace-only message deltas", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Hello" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "\n\n" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.300Z",
          payload: { text: "World" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Hello\n\nWorld", status: "running" }]);
  });

  it("appends repeated deltas verbatim instead of dropping them", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "no" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "no" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: "nono", status: "running" }]);
  });

  it("keeps legitimate repeated lines and paragraphs in persisted messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: "Run:\n\nfoo();\nfoo();\nbar();",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: "Yes.\n\nYes.",
        timestamp: "2026-06-04T10:00:01.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "Run:\n\nfoo();\nfoo();\nbar();",
        status: "complete",
      },
    ]);
    expect(turns[1]?.parts).toEqual([{ type: "text", text: "Yes.\n\nYes.", status: "complete" }]);
  });

  it("returns the raw completed message text for persistence", () => {
    const text = completedHermesMessageText([
      {
        type: "message.start",
        receivedAt: "2026-06-04T10:00:00.000Z",
        payload: {},
      },
      {
        type: "message.delta",
        receivedAt: "2026-06-04T10:00:00.100Z",
        payload: { text: "Yes.\n\nYes." },
      },
      {
        type: "message.complete",
        receivedAt: "2026-06-04T10:00:01.000Z",
        payload: { text: "Yes.\n\nYes." },
      },
    ]);

    expect(text).toBe("Yes.\n\nYes.");
  });

  it("does not duplicate the opening text on interleaved text/tool turns", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Let me check." },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:00.300Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.400Z",
          payload: { text: "Here is the answer." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Let me check.Here is the answer." },
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Let me check.",
      "tool",
      "Here is the answer.",
    ]);
  });

  it("replaces streamed text wholesale when the complete text disagrees", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Partial garble" },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "more" },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "The authoritative answer." },
        },
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "tool",
      "The authoritative answer.",
    ]);
  });

  it("keeps the verbatim stream when the complete text drops a boundary space", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Let me explore it." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Let me exploreit." },
        },
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Let me explore it.",
    ]);
  });

  it("honors a complete payload that corrects streamed whitespace", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "return\nvalue" },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "return value" },
        },
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "return value",
    ]);
  });

  it("does not truncate streamed text when the complete payload lags behind", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Here is the full answer." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Here is the full" },
        },
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Here is the full answer.",
    ]);
  });

  it("assigns unique turn ids to turns created in the same millisecond", () => {
    const receivedAt = "2026-06-04T10:00:00.000Z";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        { type: "message.start", receivedAt, payload: {} },
        { type: "message.complete", receivedAt, payload: { text: "One" } },
        { type: "message.start", receivedAt, payload: {} },
        { type: "message.complete", receivedAt, payload: { text: "Two" } },
      ],
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).not.toBe(turns[1]?.id);
  });

  it("keys tool events by tool_id so terminal events update the same part", () => {
    expect(toolEventKey({ type: "tool.start", payload: { tool_id: "tool-9" } })).toBe("tool-9");

    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-9", name: "search", text: "Searching" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { tool_id: "tool-9" },
        },
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts?.[0]?.status).toBe("complete");
  });

  it("does not merge same-name tool calls with distinct tool ids", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-a", name: "search", text: "First" },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { tool_id: "tool-b", name: "search", text: "Second" },
        },
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts?.map((part) => part.id)).toEqual(["tool-a", "tool-b"]);
  });

  it("attributes persisted tool events to the assistant turn they belong to", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "user",
        content: "First question",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "m2",
        taskId: "task-1",
        role: "assistant",
        content: "First answer",
        createdAt: "2026-06-04T10:00:10.000Z",
      },
      {
        id: "m3",
        taskId: "task-1",
        role: "user",
        content: "Second question",
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "m4",
        taskId: "task-1",
        role: "assistant",
        content: "Second answer",
        createdAt: "2026-06-04T10:01:10.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:00:05.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    const firstAssistant = turns.find((turn) => turn.id === "m2");
    const secondAssistant = turns.find((turn) => turn.id === "m4");
    expect(firstAssistant?.parts.filter((part) => part.type === "tool")).toEqual([
      {
        type: "tool",
        id: "evt-1",
        name: "Search",
        text: "Searched the web",
        status: "complete",
      },
    ]);
    expect(secondAssistant?.parts.filter((part) => part.type === "tool")).toEqual([
      {
        type: "tool",
        id: "evt-2",
        name: "Fetch",
        text: "Fetched a page",
        status: "complete",
      },
    ]);
  });

  it("groups trailing persisted tool events into one in-flight turn", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "assistant",
        content: "Earlier answer",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Earlier answer", status: "complete" }]);
    expect(turns[1]?.parts.filter((part) => part.type === "tool")).toHaveLength(2);
    expect(turns[1]?.status).toBe("complete");
  });

  it("does not leave a turn created by a terminal tool event running", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-1", name: "search", text: "Done" },
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
  });

  it("labels live terminal tool rows by the activity in their payload", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            tool_id: "tool-1",
            name: "terminal",
            command: "curl https://example.com/docs",
          },
        },
      ],
    );

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Browsing",
      status: "running",
    });
  });

  it("keeps inferred tool labels when progress frames omit the tool name", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            tool_id: "tool-1",
            name: "terminal",
            command: "curl https://example.com/docs",
          },
        },
        {
          type: "tool.progress",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: {
            tool_id: "tool-1",
            output: "Fetched 42 lines",
          },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          payload: {
            tool_id: "tool-1",
            result: "Done",
          },
        },
      ],
    );

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Browsing",
      status: "complete",
    });
    expect(tool?.type === "tool" ? tool.text : "").toContain("Fetched 42 lines");
  });

  it("keeps inferred labels when persisted tool result messages arrive", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-04T10:00:00.000Z",
        tool_calls: JSON.stringify([
          {
            id: "call-1",
            function: {
              name: "list_files",
              arguments: { path: "src" },
            },
          },
        ]),
      },
      {
        id: "tool-1",
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "list_files",
        content: "src/App.tsx",
        timestamp: "2026-06-04T10:00:01.000Z",
      },
    ]);

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Reading files",
      status: "complete",
    });
    expect(tool?.type === "tool" ? tool.text : "").toContain("src/App.tsx");
  });

  it("marks the in-flight turn errored even when the error has no text", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Working on it" },
        },
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: {},
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts).toContainEqual({
      type: "tool",
      id: "error:2026-06-04T10:00:01.000Z",
      name: "Error",
      text: "The agent reported an error.",
      status: "failed",
    });
  });

  // The raw provider error a turn dies with when the wallet is empty — this
  // exact shape reaches us as persisted assistant text and as live event text.
  const CREDITS_ERROR =
    "Error: Error code: 402 - {'data': None, 'success': False, 'error_code': 4301, 'message': 'insufficient_credits'}";

  it("folds a live insufficient-credits error event into a credits notice", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: CREDITS_ERROR },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("folds a persisted insufficient-credits error turn into a credits notice", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: CREDITS_ERROR,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("drops partially streamed text when the turn completes as a credits failure", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Let me check" },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: CREDITS_ERROR, status: "error" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("folds an insufficient-credits message.complete into a credits notice", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: CREDITS_ERROR, status: "error" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("keeps assistant prose about credits as ordinary text", () => {
    const prose = "If you see insufficient_credits errors, upgrade from settings.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  // The terminal error Hermes surfaces when a single oversized turn cannot be
  // compressed below the window (JUN-169) — reaches us as a live error event,
  // a failed message.complete, and persisted assistant text.
  const OVERFLOW_ERROR = "Context length exceeded (66,919 tokens). Cannot compress further.";

  it("folds a live context-overflow error event into a context-overflow notice", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: OVERFLOW_ERROR },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("folds a live string_too_long rejection into a context-overflow notice", () => {
    // A single oversized string (per-string cap) is a hard size failure too;
    // the classifier catches the raw token so it degrades like the aggregate
    // overflow instead of surfacing raw (JUN-169 review).
    const text = "string_too_long: a single field exceeded the size limit.";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: text },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "context-overflow", text }]);
  });

  it("folds a failed context-overflow message.complete into a context-overflow notice", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: OVERFLOW_ERROR, status: "error" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("folds a persisted context-overflow assistant turn into a context-overflow notice", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: OVERFLOW_ERROR,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("keeps a persisted assistant answer that mentions context length as prose", () => {
    // A saved answer, not an error — the persisted path has no failure flag, so
    // it must fold only on unambiguous error sentinels, never on prose that
    // merely discusses context length (JUN-169 review: persisted prose
    // misclassification would drop the real answer on reload).
    const prose = "The maximum context length for GLM 5.2 is 200k tokens.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("keeps a persisted answer that explains the error tokens as prose", () => {
    // June discussing its own error codes in a saved answer must not reload as
    // an overflow notice: the sentinel is anchored to the start of the message,
    // so a mid-sentence mention of prompt_too_long/string_too_long stays text
    // (JUN-169 review).
    const prose =
      "The agent API can return prompt_too_long or string_too_long when a request is too big.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("folds a persisted prefixed overflow error into a context-overflow notice", () => {
    // Hermes persists a provider failure with the runtime "Error:" prefix (the
    // same shape as the credits path); a prefixed prompt_too_long must still
    // fold on reload, not fall back to the raw dead-end (JUN-169 review).
    const persisted =
      "Error: Error code: 400 - {'message': 'prompt_too_long: the request exceeds the maximum context length'}";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: persisted,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: persisted },
    ]);
  });

  it("folds a live upstream rate-limit error event into an upstream-busy notice", () => {
    // The exact shape the Hermes runtime surfaces when the June API sidecar
    // returns the new 429 upstream_rate_limited (the reported incident: a busy
    // model wrongly read as a hard provider failure).
    const rateLimited = "API call failed after 3 retries: HTTP 429: upstream_rate_limited";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: rateLimited },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "upstream-busy", text: rateLimited }]);
  });

  it("folds a failed rate-limit message.complete into an upstream-busy notice", () => {
    const text = "Venice rate limit reached — please retry in a few seconds.";
    const turns = buildHermesSessionChatTurns(
      [],
      [
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text, status: "error" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "upstream-busy", text }]);
  });

  it("surfaces a live error event even when the turn already persisted tool calls", () => {
    // Bug: a model call that fails AFTER tool use dies silently. Hermes persists
    // the assistant tool-call message (empty content) but never persists the
    // error, so the rebuilt transcript is reasoning+tools with no failure. The
    // only record is the live `error` frame — it must still fold onto the
    // persisted turns and render (a notice here) rather than vanish.
    const turns = buildHermesSessionChatTurns(
      [
        {
          id: "u1",
          role: "user",
          content: "read the config",
          timestamp: "2026-06-04T10:00:00.000Z",
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "t1", type: "function", function: { name: "read_files", arguments: "{}" } },
          ],
          timestamp: "2026-06-04T10:00:01.000Z",
        },
        {
          id: "t1",
          role: "tool",
          tool_call_id: "t1",
          content: "config contents",
          timestamp: "2026-06-04T10:00:02.000Z",
        },
      ] as unknown as HermesSessionMessage[],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:03.000Z",
          payload: { message: "API call failed after 3 retries: HTTP 503: upstream_rate_limited" },
        },
      ],
    );

    const allParts = turns.flatMap((turn) => turn.parts);
    expect(allParts.some((part) => part.type === "notice" && part.kind === "upstream-busy")).toBe(
      true,
    );
    // The tool activity the user already saw is preserved too.
    expect(allParts.some((part) => part.type === "tool")).toBe(true);
  });

  it("folds a live 503 capacity-saturation error event into an upstream-busy notice", () => {
    // A hot model returns 503 MODEL_INFRA_SATURATED far more often than a 429;
    // it is the same transient "busy" condition and must fold the same way, not
    // collapse into the opaque upstream_provider_failed (ADR-0012 addendum).
    const saturated = "Model kimi-k3 is currently saturated upstream. Retry after 9s.";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: saturated },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "upstream-busy", text: saturated }]);
  });

  it("folds a persisted prefixed rate-limit error into an upstream-busy notice", () => {
    const persisted = "Error: HTTP 429: upstream_rate_limited";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: persisted,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "upstream-busy", text: persisted }]);
  });

  it("keeps a persisted answer that discusses rate limits as prose", () => {
    // A saved answer, not an error — the persisted path has no failure flag, so
    // a mid-sentence mention of a rate limit must stay text, never reload as a
    // notice that drops the real answer (mirrors the context-overflow guard).
    const prose = "Most providers enforce a rate limit of a few requests per second.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("folds a live provider-failure error event into a provider-failed notice", () => {
    // The exact shape the Hermes runtime surfaces when the June API sidecar's
    // backed-off retries could not clear an upstream 500/502/504. It used to
    // render as a raw "Error" part dumping upstream_provider_failed; it must
    // fold into an actionable notice without ever claiming the model is merely
    // busy (ADR-0012).
    const failed = "API call failed after 3 retries: HTTP 502: upstream_provider_failed";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: failed },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "provider-failed", text: failed }]);
  });

  it("folds the loopback proxy's transport wrapper into a provider-failed notice", () => {
    // The Tauri proxy's own wrapper when the sidecar call itself dies (the
    // "June agent provider failed: <transport error>" 502 body).
    const failed = "June agent provider failed: error sending request for url";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { message: failed },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "provider-failed", text: failed }]);
  });

  it("folds a persisted prefixed provider failure into a provider-failed notice", () => {
    const persisted = "Error: HTTP 502: upstream_provider_failed";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: persisted,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "provider-failed", text: persisted }]);
  });

  it("keeps a persisted answer that discusses provider failures as prose", () => {
    // Mirrors the rate-limit guard above: a saved answer that merely mentions
    // the upstream_provider_failed token mid-sentence must stay text.
    const prose = "The upstream_provider_failed message means the gateway had a problem.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("keeps a successful message.complete that mentions context length as prose", () => {
    const prose = "The maximum context length for GLM 5.2 is 200k tokens.";
    const turns = buildHermesSessionChatTurns(
      [],
      [
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: prose, status: "complete" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("renders delegated subagents as live tool rows (regression: silently dropped)", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "subagent.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            subagent_id: "sa-1",
            task_index: 0,
            task_count: 2,
            goal: "Write the privacy page",
          },
        },
        {
          type: "subagent.start",
          receivedAt: "2026-06-04T10:00:00.050Z",
          payload: {
            subagent_id: "sa-2",
            task_index: 1,
            task_count: 2,
            goal: "Write the terms page",
          },
        },
        {
          type: "subagent.tool",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: {
            subagent_id: "sa-1",
            goal: "Write the privacy page",
            tool_preview: "edit privacy.tsx",
          },
        },
        {
          type: "subagent.complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          payload: {
            subagent_id: "sa-1",
            goal: "Write the privacy page",
            summary: "Done: 1 file written",
          },
        },
      ],
    );

    const tools = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(tools).toHaveLength(2);
    // Two parallel subagents, keyed by id, each labeled by its goal.
    expect(tools?.[0]).toMatchObject({
      id: "subagent:sa-1",
      name: "Subagent: Write the privacy page",
      status: "complete",
    });
    expect(tools?.[1]).toMatchObject({
      id: "subagent:sa-2",
      name: "Subagent: Write the terms page",
      status: "running",
    });
    // The first subagent's row accumulated its activity then its summary.
    expect((tools?.[0] as { text?: string }).text).toContain("edit privacy.tsx");
    expect((tools?.[0] as { text?: string }).text).toContain("Done: 1 file written");
  });

  it("keeps the goal label when a later subagent event omits it", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "subagent.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { subagent_id: "sa-1", goal: "Write the privacy page" },
        },
        // A tool event carrying only the id + preview, no goal.
        {
          type: "subagent.tool",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { subagent_id: "sa-1", tool_preview: "edit privacy.tsx" },
        },
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    // The richer label must survive the goal-less follow-up (no flicker).
    expect(tool).toMatchObject({
      name: "Subagent: Write the privacy page",
      status: "running",
    });
  });

  it("resolves a failure-flavored terminal subtype instead of staying running", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "subagent.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { subagent_id: "sa-1", goal: "Write the privacy page" },
        },
        // A subtype not in the documented union; must still terminate the row.
        {
          type: "subagent.timeout",
          receivedAt: "2026-06-04T10:00:05.000Z",
          payload: { subagent_id: "sa-1" },
        },
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Subagent: Write the privacy page",
      status: "failed",
    });
  });

  it("labels a goal-less subagent by its task position and marks failures", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "subagent.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { task_index: 2, task_count: 5 },
        },
        {
          type: "subagent.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { task_index: 2, task_count: 5, status: "failed" },
        },
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      id: "subagent:task-2",
      name: "Subagent 3 of 5",
      status: "failed",
    });
  });
});

describe("interrupted-turn detection", () => {
  // The exact tail an aborted turn persists: a user prompt, an assistant
  // preamble + tool call, and the tool result — with no assistant answer after,
  // because the follow-up model call 502'd and the runtime wrote no error row.
  const interruptedMessages = (): HermesSessionMessage[] =>
    [
      {
        id: "u1",
        role: "user",
        content: "compare the sites",
        timestamp: "2026-07-17T20:24:00.000Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Real benchmark data found. Let me get accurate model counts.",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "terminal", arguments: "{}" } },
        ],
        timestamp: "2026-07-17T20:34:40.000Z",
      },
      {
        id: "t1",
        role: "tool",
        tool_call_id: "t1",
        content: "carpe-models.json count 296",
        timestamp: "2026-07-17T20:34:41.000Z",
      },
    ] as unknown as HermesSessionMessage[];

  const answeredMessages = (): HermesSessionMessage[] =>
    [
      { id: "u1", role: "user", content: "hi", timestamp: "2026-07-17T20:24:00.000Z" },
      {
        id: "a1",
        role: "assistant",
        content: "Here is the comparison.",
        timestamp: "2026-07-17T20:24:01.000Z",
      },
    ] as unknown as HermesSessionMessage[];

  it("detects a transcript that ends on an unanswered tool result", () => {
    expect(hermesMessagesEndInterrupted(interruptedMessages())).toBe(true);
  });

  it("detects a transcript that ends on an unresolved assistant tool call", () => {
    const messages = interruptedMessages().slice(0, 2); // drop the tool result
    expect(hermesMessagesEndInterrupted(messages)).toBe(true);
  });

  it("does not flag a session that ends on a normal assistant answer", () => {
    expect(hermesMessagesEndInterrupted(answeredMessages())).toBe(false);
    expect(hermesMessagesEndInterrupted([])).toBe(false);
  });

  it("appends an interrupted notice to the last turn when cut off", () => {
    const turns = withInterruptedTurnNotice(buildHermesSessionChatTurns(interruptedMessages()), {
      interrupted: true,
    });
    expect(turns.at(-1)?.parts.at(-1)).toEqual({ type: "notice", kind: "interrupted", text: "" });
    // The tool activity the user already saw is preserved alongside the notice.
    expect(turns.at(-1)?.parts.some((part) => part.type === "tool")).toBe(true);
  });

  it("is a no-op when not interrupted, and for an empty transcript", () => {
    const answered = buildHermesSessionChatTurns(answeredMessages());
    expect(withInterruptedTurnNotice(answered, { interrupted: false })).toBe(answered);
    expect(withInterruptedTurnNotice([], { interrupted: true })).toEqual([]);
  });

  it("does not stack on top of a more specific live error notice", () => {
    // A live upstream-busy frame already folded a notice onto the turn; the
    // structural interrupted check must not add a second, less specific one.
    const turns = withInterruptedTurnNotice(
      buildHermesSessionChatTurns(interruptedMessages(), [
        {
          type: "error",
          receivedAt: "2026-07-17T20:39:51.000Z",
          payload: { message: "API call failed after 3 retries: HTTP 503: upstream_rate_limited" },
        },
      ]),
      { interrupted: true },
    );
    const notices = turns.flatMap((turn) => turn.parts).filter((part) => part.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "upstream-busy" });
  });
});

describe("turn settlement (ADR-0016)", () => {
  const user = (): HermesSessionMessage =>
    ({
      id: "u1",
      role: "user",
      content: "run the benchmark",
      timestamp: "2026-07-24T10:00:00.000Z",
    }) as unknown as HermesSessionMessage;

  // Hermes 0.19 seals mid-turn commentary as its own persisted assistant row,
  // and every tool-calling step persists one too. Both land in the transcript
  // while the loop is still running.
  const commentary = (): HermesSessionMessage =>
    ({
      id: "a1",
      role: "assistant",
      content: "Le run est toujours en cours, mais il y a déjà un point important :",
      timestamp: "2026-07-24T10:00:20.000Z",
    }) as unknown as HermesSessionMessage;

  const toolCall = (): HermesSessionMessage =>
    ({
      id: "a2",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "t1", type: "function", function: { name: "terminal", arguments: "{}" } }],
      timestamp: "2026-07-24T10:00:21.000Z",
    }) as unknown as HermesSessionMessage;

  const toolResult = (): HermesSessionMessage =>
    ({
      id: "t1",
      role: "tool",
      tool_call_id: "t1",
      content: "40/117 appels lancés",
      timestamp: "2026-07-24T10:00:32.000Z",
    }) as unknown as HermesSessionMessage;

  const answer = (): HermesSessionMessage =>
    ({
      id: "a3",
      role: "assistant",
      content: "Le benchmark est terminé.",
      timestamp: "2026-07-24T10:40:00.000Z",
    }) as unknown as HermesSessionMessage;

  it("does not settle a turn with work still dangling", () => {
    // The regression this rule exists for: settling on "an assistant row exists"
    // declared a running turn finished a couple of seconds in — the stop button
    // reverted to send, the live buffer was dropped, and the interrupted notice
    // rendered over a turn that then carried on.
    expect(hermesMessagesShowCompletedTurn([user(), commentary(), toolCall()])).toBe(false);
    expect(hermesMessagesShowCompletedTurn([user(), commentary(), toolCall(), toolResult()])).toBe(
      false,
    );
  });

  it("cannot tell mid-turn commentary apart from a final answer", () => {
    // The limit that makes this test a FALLBACK and not the authority: Hermes
    // persists sealed mid-turn commentary as a plain assistant row, so a loop
    // pausing between steps is shape-identical to a finished turn. Only the
    // runtime's session.active_list separates them, which is why the poll asks
    // it first and reaches for this shape only when the runtime cannot answer.
    expect(hermesMessagesShowCompletedTurn([user(), commentary()])).toBe(true);
  });

  it("settles a turn that ended on a plain assistant answer", () => {
    expect(hermesMessagesShowCompletedTurn([user(), answer()])).toBe(true);
    expect(
      hermesMessagesShowCompletedTurn([user(), commentary(), toolCall(), toolResult(), answer()]),
    ).toBe(true);
  });

  it("does not settle a prompt that has no reply yet", () => {
    expect(hermesMessagesShowCompletedTurn([user()])).toBe(false);
    expect(hermesMessagesShowCompletedTurn([])).toBe(false);
    // A follow-up sent after a finished turn re-opens the session.
    expect(hermesMessagesShowCompletedTurn([user(), answer(), user()])).toBe(false);
  });

  it("keeps the weaker assistant-reply test available and honest about its meaning", () => {
    // shouldResumeSessionActivity still needs "has the model said anything yet";
    // the point of the split is that this is true mid-loop, which is exactly why
    // it must not decide whether a turn is over.
    expect(hermesMessagesHaveAssistantReply([user(), commentary(), toolResult()])).toBe(true);
    expect(hermesMessagesShowCompletedTurn([user(), commentary(), toolResult()])).toBe(false);
    expect(hermesMessagesHaveAssistantReply([user()])).toBe(false);
    expect(hermesMessagesHaveAssistantReply([answer()])).toBe(true);
  });
});

describe("appendLiveHermesEvent", () => {
  const delta = (messageId: string, text: string, session = "s1"): LiveHermesEvent => ({
    type: "message.delta",
    session_id: session,
    payload: { message_id: messageId, delta: text },
    receivedAt: "2026-07-21T00:00:00.000Z",
  });

  function fold(events: LiveHermesEvent[]): LiveHermesEvent[] {
    return events.reduce<LiveHermesEvent[]>((acc, event) => appendLiveHermesEvent(acc, event), []);
  }

  it("compacts consecutive deltas of the same message into one accumulated event", () => {
    const events = fold([delta("m1", "Hello"), delta("m1", " "), delta("m1", "world")]);
    expect(events).toHaveLength(1);
    expect((events[0].payload as { delta: string }).delta).toBe("Hello world");
    // The opening frame's timestamp is preserved.
    expect(events[0].receivedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("keeps a long streamed reply as a single event so it never evicts its own prefix", () => {
    const deltas = Array.from({ length: 500 }, (_, index) => delta("m1", `${index} `));
    const events = fold([
      { type: "message.start", session_id: "s1", payload: { message_id: "m1" }, receivedAt: "t" },
      ...deltas,
    ]);
    // message.start + one folded delta — never the 200-cap eviction that used to
    // drop the opening chunks of a long response.
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("message.start");
    expect((events[1].payload as { delta: string }).delta).toContain("0 ");
    expect((events[1].payload as { delta: string }).delta).toContain("499 ");
  });

  it("does not merge across a different message id", () => {
    const events = fold([delta("m1", "a"), delta("m2", "b")]);
    expect(events).toHaveLength(2);
    expect((events[0].payload as { delta: string }).delta).toBe("a");
    expect((events[1].payload as { delta: string }).delta).toBe("b");
  });

  it("does not merge across a different session", () => {
    const events = fold([delta("m1", "a", "s1"), delta("m1", "b", "s2")]);
    expect(events).toHaveLength(2);
  });

  it("still bounds unrelated events to the limit", () => {
    const events = fold(
      Array.from(
        { length: HERMES_LIVE_EVENT_LIMIT + 50 },
        (_, index): LiveHermesEvent => ({
          type: "tool.progress",
          session_id: "s1",
          payload: { id: `t${index}` },
          receivedAt: "t",
        }),
      ),
    );
    expect(events).toHaveLength(HERMES_LIVE_EVENT_LIMIT);
  });
});
