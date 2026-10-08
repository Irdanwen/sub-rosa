// Protected mode (ADR-0084): the shared predicate that hides adult families,
// the Studio helpers that apply it (including to the passthroughs the webview
// adds past Rust's filter), and the PIN flow in Settings › Privacy.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let enabled = false;
let restrictions: Record<string, unknown> = {
  memoryOff: false,
  mediaOff: false,
  voiceOff: false,
  pastChatsOff: false,
};
const PIN = "2580";
const invokeMock = vi.fn(async (command: string, args?: unknown) => {
  const pin = (args as { request?: { pin?: string } } | undefined)?.request?.pin;
  if (command === "protected_mode_status") return { enabled, restrictions, quietNow: false };
  if (command === "protected_mode_set_restrictions") {
    if (pin !== PIN) throw { code: "protected_mode_wrong_pin", message: "That PIN is not right." };
    restrictions = (args as { request: { restrictions: Record<string, unknown> } }).request
      .restrictions;
    return { enabled, restrictions, quietNow: false };
  }
  if (command === "protected_mode_enable") {
    enabled = true;
    return { enabled };
  }
  if (command === "protected_mode_disable") {
    if (pin !== PIN) throw { code: "protected_mode_wrong_pin", message: "That PIN is not right." };
    enabled = false;
    return { enabled };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));

import { ProtectedModeSection } from "../components/settings/ProtectedModeSection";
import { isAdultModel, withoutAdultModels } from "../lib/adult-models";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";
import { isValidPin } from "../lib/protected-mode";
import { imageEditModels, imageGenerationModels, modelsOfType } from "../lib/studio/catalog";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

function model(overrides: Partial<MediaModel> & Pick<MediaModel, "id" | "mediaType">): MediaModel {
  return { name: overrides.id, offline: false, ...overrides };
}

function catalog(protectedMode: boolean): MediaCatalog {
  return {
    backend: "carpe-diem",
    protectedMode,
    models: [
      model({ id: "gpt-image-2", mediaType: "image", name: "GPT Image 2" }),
      model({ id: "lustify-v8", mediaType: "image", name: "Lustify v8" }),
      model({ id: "plain-id", mediaType: "image", name: "Plain", traits: ["most_uncensored"] }),
      model({ id: "venice-uncensored", mediaType: "text", name: "Venice Uncensored" }),
      model({ id: "zai-org-glm-5-2", mediaType: "text", name: "GLM 5.2" }),
      model({ id: "flux-2-max-edit", mediaType: "imageEdit", name: "Flux 2 Max edit" }),
    ],
  };
}

beforeEach(() => {
  enabled = false;
  restrictions = { memoryOff: false, mediaOff: false, voiceOff: false, pastChatsOff: false };
  invokeMock.mockClear();
});

describe("the adult model predicate", () => {
  it("matches by id, name or trait, and mirrors the Rust markers", () => {
    for (const id of [
      "venice-uncensored",
      "lustify-sdxl",
      "qwen-edit-uncensored",
      "olafangensan-glm-4.7-flash-heretic",
      "abliteration-abliterated-model-large-v2",
      "some-NSFW-model",
    ]) {
      expect(isAdultModel({ id }), id).toBe(true);
    }
    expect(isAdultModel({ id: "qwen-3-6-plus", name: "Qwen 3.6 Plus Uncensored" })).toBe(true);
    expect(isAdultModel({ id: "x", traits: ["most_uncensored"] })).toBe(true);
    for (const id of ["zai-org-glm-5-2", "venice-sd35", "gpt-image-2", "chroma"]) {
      expect(isAdultModel({ id, name: id, traits: ["default"] }), id).toBe(false);
    }
    const list = [{ id: "venice-uncensored" }, { id: "gpt-image-2" }];
    expect(withoutAdultModels(list, false)).toEqual(list);
    expect(withoutAdultModels(list, true)).toEqual([{ id: "gpt-image-2" }]);
  });

  it("accepts only a PIN of four to six digits", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });
});

describe("the Studio and chat pickers under protected mode", () => {
  it("keep every family while off", () => {
    const off = catalog(false);
    expect(imageGenerationModels(off).map((m) => m.id)).toContain("lustify-v8");
    expect(modelsOfType(off, "text").map((m) => m.id)).toContain("venice-uncensored");
    expect(imageEditModels(off).map((m) => m.id)).toContain("qwen-edit-uncensored");
  });

  it("drop adult families, including the passthroughs added in the webview", () => {
    const on = catalog(true);
    expect(imageGenerationModels(on).map((m) => m.id)).toEqual(["gpt-image-2"]);
    expect(modelsOfType(on, "text").map((m) => m.id)).toEqual(["zai-org-glm-5-2"]);
    expect(imageEditModels(on).map((m) => m.id)).toEqual(["flux-2-max-edit"]);
  });
});

describe("Settings › Privacy › Protected mode", () => {
  it("turns on with a confirmed PIN and refreshes the model pickers", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, changed);
    render(<ProtectedModeSection />);
    expect(await screen.findByText("Off")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on protected mode" });
    expect(dialog).toBeInTheDocument();
    await user.type(screen.getByLabelText("PIN"), "25a80");
    expect(screen.getByLabelText("PIN")).toHaveValue("2580");
    await user.type(screen.getByLabelText("Confirm the PIN"), "2581");
    await user.click(screen.getAllByRole("button", { name: "Turn on" }).at(-1) as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("The two PINs do not match.");
    expect(invokeMock).not.toHaveBeenCalledWith("protected_mode_enable", expect.anything());

    await user.clear(screen.getByLabelText("Confirm the PIN"));
    await user.type(screen.getByLabelText("Confirm the PIN"), PIN);
    await user.click(screen.getAllByRole("button", { name: "Turn on" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("protected_mode_enable", { request: { pin: PIN } }),
    );
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, changed);
  });

  it("turns off only with the right PIN, and says when it is wrong", async () => {
    enabled = true;
    const user = userEvent.setup();
    render(<ProtectedModeSection />);
    expect(await screen.findByText("On")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await screen.findByRole("dialog", { name: "Turn off protected mode" });
    expect(screen.queryByLabelText("Confirm the PIN")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("PIN"), "0000");
    await user.click(screen.getAllByRole("button", { name: "Turn off" }).at(-1) as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("That PIN is not right.");
    expect(screen.getByLabelText("PIN")).toHaveValue("");
    expect(enabled).toBe(true);

    await user.type(screen.getByLabelText("PIN"), PIN);
    await user.click(screen.getAllByRole("button", { name: "Turn off" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(enabled).toBe(false);
  });

  it("closes on Escape through the shared modal rules", async () => {
    const user = userEvent.setup();
    render(<ProtectedModeSection />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("protected mode limits", () => {
  it("are shown while on and change only with the PIN", async () => {
    enabled = true;
    const user = userEvent.setup();
    render(<ProtectedModeSection />);
    await user.click(await screen.findByRole("button", { name: "Change limits" }));
    await user.click(screen.getByRole("switch", { name: "Image and video generation" }));
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    const from = screen.getByLabelText("From") as HTMLInputElement;
    const until = screen.getByLabelText("Until") as HTMLInputElement;
    expect(from.value).toBe("21:00");
    expect(until.value).toBe("07:00");
    await user.type(screen.getByLabelText("PIN"), "1111");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That PIN is not right.");
    expect(restrictions.mediaOff).toBe(false);
    await user.type(screen.getByLabelText("PIN"), PIN);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(restrictions).toEqual({
      memoryOff: false,
      mediaOff: true,
      voiceOff: false,
      pastChatsOff: false,
      quietHours: { startMinute: 21 * 60, endMinute: 7 * 60 },
    });
    expect(screen.getByText("21:00 to 07:00")).toBeTruthy();
  });

  it("refuses quiet hours that start and end at the same time", async () => {
    enabled = true;
    const user = userEvent.setup();
    render(<ProtectedModeSection />);
    await user.click(await screen.findByRole("button", { name: "Change limits" }));
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    const until = screen.getByLabelText("Until");
    await user.clear(until);
    await user.type(until, "21:00");
    await user.type(screen.getByLabelText("PIN"), PIN);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "start and end at different times",
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "protected_mode_set_restrictions",
      expect.anything(),
    );
  });

  it("are hidden while protected mode is off", async () => {
    render(<ProtectedModeSection />);
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change limits" })).toBeNull();
  });
});
