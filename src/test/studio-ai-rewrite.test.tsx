import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiRewrite } from "../components/studio/AiRewrite";
import { rewriteTargetModel, type StudioRewriteInput } from "../lib/studio/studio-rewrite";
import type { MediaModel } from "../lib/studio/types";

/**
 * Studio's "improve with AI", and the rule it shares with the note editor
 * (ADR-0038): nothing reaches the project without Accept.
 */

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
  reply: null as null | ((request: StudioRewriteInput) => Promise<{ text: string }>),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    backend.calls.push({ command, args });
    if (command === "studio_rewrite") {
      const request = args.request as StudioRewriteInput & { requestId: string };
      return (backend.reply?.(request) ?? Promise.resolve({ text: "" })).then((result) => ({
        ...result,
        requestId: request.requestId,
        promptVersion: "test",
      }));
    }
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

beforeEach(() => {
  backend.calls = [];
  backend.reply = null;
});

function Harness({
  initial,
  request,
}: {
  initial: string;
  request?: (intent?: string, instruction?: string) => StudioRewriteInput | undefined;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <output data-testid="saved">{value}</output>
      <AiRewrite
        label="Script"
        value={value}
        onAccept={setValue}
        intents={[
          { value: "filmable", label: "Make it filmable" },
          { value: "custom", label: "Your own instruction" },
        ]}
        request={
          request ??
          ((intent, instruction) => ({
            kind: "scenario",
            text: value,
            intent: intent as never,
            instruction,
          }))
        }
      />
    </>
  );
}

describe("AiRewrite", () => {
  it("proposes, and only Accept changes the text; Undo brings it back", async () => {
    backend.reply = () => Promise.resolve({ text: "Scene 1. The kitchen, night." });
    const user = userEvent.setup();
    render(<Harness initial="a kitchen at night" />);

    await user.click(screen.getByRole("button", { name: /Improve with AI/ }));
    expect(await screen.findByText("Scene 1. The kitchen, night.")).toBeTruthy();
    expect(screen.getByTestId("saved").textContent).toBe("a kitchen at night");
    expect(backend.calls[0]?.args.request).toMatchObject({ kind: "scenario", intent: "filmable" });

    await user.click(screen.getByRole("button", { name: /Accept/ }));
    expect(screen.getByTestId("saved").textContent).toBe("Scene 1. The kitchen, night.");
    expect(screen.queryByText("Proposal")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("saved").textContent).toBe("a kitchen at night");
  });

  it("leaves the text alone when the proposal is discarded", async () => {
    backend.reply = () => Promise.resolve({ text: "Something else." });
    const user = userEvent.setup();
    render(<Harness initial="mine" />);
    await user.click(screen.getByRole("button", { name: /Improve with AI/ }));
    await screen.findByText("Something else.");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByTestId("saved").textContent).toBe("mine");
    expect(screen.queryByText("Something else.")).toBeNull();
  });

  it("shows a failure without touching the text", async () => {
    backend.reply = () =>
      Promise.reject({ code: "studio_rewrite_failed", message: "The model returned status 500." });
    const user = userEvent.setup();
    render(<Harness initial="mine" />);
    await user.click(screen.getByRole("button", { name: /Improve with AI/ }));
    expect(await screen.findByText("The model returned status 500.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    expect(screen.getByTestId("saved").textContent).toBe("mine");
  });

  it("asks for the instruction before a custom rewrite", async () => {
    const user = userEvent.setup();
    render(<Harness initial="mine" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "What to do" }), "custom");
    const start = screen.getByRole("button", { name: /Improve with AI/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Your instruction" }), "darker");
    expect((start as HTMLButtonElement).disabled).toBe(false);
    backend.reply = () => Promise.resolve({ text: "Darker." });
    await user.click(start);
    await waitFor(() =>
      expect(backend.calls[0]?.args.request).toMatchObject({
        intent: "custom",
        instruction: "darker",
      }),
    );
  });

  it("offers to write when the field is empty, and nothing when there is nothing to work from", () => {
    const { unmount } = render(
      <Harness initial="" request={() => ({ kind: "shotPrompt", text: "" })} />,
    );
    expect(screen.getByRole("button", { name: /Write with AI/ })).toBeTruthy();
    unmount();
    render(<Harness initial="" request={() => undefined} />);
    expect(
      (screen.getByRole("button", { name: /Write with AI/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("rewriteTargetModel", () => {
  const model = (id: string, extra: Partial<MediaModel> = {}): MediaModel => ({
    id,
    name: id,
    mediaType: "video",
    offline: false,
    ...extra,
  });

  it("gives a Seedance model its sixty words and its reference syntax", () => {
    expect(rewriteTargetModel(model("seedance-2-0-text-to-video"))).toMatchObject({
      wordLimit: 60,
      referenceMention: "<Image {n}>",
    });
  });

  it("passes the published character limit and the plain syntax elsewhere", () => {
    expect(
      rewriteTargetModel(model("kling-2-6", { constraints: { promptCharacterLimit: 2500 } })),
    ).toMatchObject({ charLimit: 2500, wordLimit: undefined, referenceMention: "image {n}" });
    expect(rewriteTargetModel(undefined)).toBeUndefined();
  });
});
