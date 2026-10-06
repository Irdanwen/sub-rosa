/**
 * The audio panels on the stage: a music render in flight is the veil over
 * the scene, named in its own words; a narration runs synchronously behind
 * the same veil, with a Cancel within reach, and lands as a track on the
 * scene.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioScreen } from "../components/mobile/screens/StudioScreen";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const studio = vi.hoisted(() => ({
  catalog: vi.fn(),
  artifacts: vi.fn(),
  speech: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: studio.catalog,
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: studio.artifacts,
  saveArtifactFromBase64: studio.save,
}));
vi.mock("../lib/studio/speech", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/speech")>()),
  generateSpeech: studio.speech,
}));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: () => null }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

function catalog() {
  return {
    backend: "carpe-diem" as const,
    priceMultiplier: 1,
    models: [
      { id: "eleven-music", name: "Eleven Music", mediaType: "music" as const, offline: false },
      {
        id: "kokoro",
        name: "Kokoro",
        mediaType: "tts" as const,
        offline: false,
        voices: ["af_sky"],
      },
    ],
  };
}

async function openAudioTab() {
  render(<StudioScreen />);
  await userEvent.click(screen.getByRole("tab", { name: "Audio" }));
  await screen.findByRole("button", { name: /^Music model/ });
}

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(catalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  studio.save.mockReset().mockResolvedValue({ id: "a1", path: "a1.mp3" });
  studio.speech.mockReset();
  window.localStorage.clear();
});

describe("the audio panels on the stage", () => {
  it("shows a track being composed as the veil over the scene", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "media_job_list"
        ? [
            {
              id: "m1",
              kind: "music",
              model: "eleven-music",
              prompt: "a slow waltz",
              extension: "mp3",
              status: "processing",
              createdAt: new Date(Date.now() - 20_000).toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]
        : undefined,
    );
    await openAudioTab();
    const scene = screen.getByRole("region", { name: "Latest result" });
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeTruthy());
    expect(scene.textContent).toContain("Composing your track");
    expect(screen.getByRole("button", { name: "Generate" }).hasAttribute("disabled")).toBe(true);
  });

  it("narrates behind the veil, with Cancel in reach, and lands the track on the scene", async () => {
    await openAudioTab();
    await userEvent.click(screen.getByRole("tab", { name: "Speech" }));
    await screen.findByRole("button", { name: /^Speech model/ });
    let finish: (value: { base64: string }) => void = () => undefined;
    studio.speech.mockImplementation(
      () => new Promise<{ base64: string }>((resolve) => (finish = resolve)),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Text to narrate" }), "Good evening.");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    const scene = screen.getByRole("region", { name: "Latest result" });
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeTruthy());
    expect(scene.textContent).toContain("Narrating");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // Recent shows the narration in flight, though no job row exists for it.
    expect(document.querySelector(".mobile-music-row-pending")).toBeTruthy();

    await act(async () => {
      finish({ base64: "AAAA" });
    });
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeNull());
    const track = scene.querySelector("audio") as HTMLAudioElement;
    expect(track).toBeTruthy();
    // Played from the saved file: WKWebView leaves a data: audio element silent.
    expect(track.src).not.toContain("data:");
    expect(track.src).toContain("a1.mp3");
    expect(scene.querySelector(".mobile-studio-scene-wave")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
