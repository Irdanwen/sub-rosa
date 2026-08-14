/**
 * The mobile video form, against the real catalog.
 *
 * The reported bug was about what a phone shows, so the unit suites cannot
 * close it on their own: `seedance-2-5-reference-to-video-basic` was in the
 * catalog, in the right family slot, and resolved correctly by `variantFor` -
 * and still nowhere to be seen. These render the screen and look.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioScreen } from "../components/mobile/screens/StudioScreen";
import { seedanceCatalog } from "./fixtures/seedance-catalog";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const studio = vi.hoisted(() => ({ catalog: vi.fn(), artifacts: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: studio.catalog,
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: studio.artifacts,
}));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: () => null }));
vi.mock("../lib/studio/reference-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/reference-media")>()),
  // jsdom decodes no media, so the real one would only spend its timeout. The
  // limit checks it feeds stay real; how the number is obtained is not the
  // subject here (see `studio-reference-media.test.ts`).
  mediaSeconds: vi.fn().mockResolvedValue(5),
}));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  // No quote: it would only add a pending request to every assertion.
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

/** Open the video tab and wait for the catalog to land. */
async function openVideoTab() {
  render(<StudioScreen />);
  await userEvent.click(screen.getByRole("tab", { name: "Video" }));
  return await screen.findByRole("button", { name: /^Video model/ });
}

/** Pick a family through the model sheet, searching for it the way a user would. */
async function chooseFamily(picker: HTMLElement, query: string, name: string) {
  await userEvent.click(picker);
  await userEvent.type(await screen.findByPlaceholderText("Search models"), query);
  await userEvent.click(screen.getByText(name));
  await waitFor(() => expect(screen.queryByPlaceholderText("Search models")).toBeNull());
}

beforeEach(() => {
  // jsdom implements neither, and the picker measures through an object URL.
  URL.createObjectURL = vi.fn(() => "blob:clip");
  URL.revokeObjectURL = vi.fn();
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(seedanceCatalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

describe("finding seedance 2.5 reference-to-video on a phone", () => {
  it("turns up in the model sheet when searched for by a spelling of its variant", async () => {
    // The reported search. The row says "Seedance 2.5" and its id is the family
    // key `seedance 2.5`, so nothing on screen contains "rtv".
    const picker = await openVideoTab();
    await userEvent.click(picker);
    await userEvent.type(await screen.findByPlaceholderText("Search models"), "rtv");

    expect(screen.getByText("Seedance 2.5")).toBeTruthy();
    expect(screen.queryByText("Seedance 1.5 Pro")).toBeNull();
  });

  it("offers what that model takes: reference photos and audio, never clips", async () => {
    const picker = await openVideoTab();
    await chooseFamily(picker, "rtv", "Seedance 2.5");

    // It publishes `audio_input: true` and `video_input: false`.
    expect(screen.getByRole("button", { name: "Add a track" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a clip" })).toBeNull();
    // And the prompt opening it can honour, without the three that need a clip.
    expect(screen.getByRole("button", { name: "Reference" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Extend a clip" })).toBeNull();
  });

  it("offers clips on the full tier, which declares a video input", async () => {
    const picker = await openVideoTab();
    await chooseFamily(picker, "seedance-2-0-fast", "Seedance 2.0 Fast (full)");

    expect(screen.getByRole("button", { name: "Add a clip" })).toBeTruthy();
    for (const label of ["Reference", "Edit a clip", "Extend a clip", "Stitch clips"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });
});

describe("writing a prompt the router will read", () => {
  it("writes the canonical opening rather than describing it", async () => {
    // Seedance routes from the prompt's first words: an opening written from
    // memory runs another workflow and still bills.
    const picker = await openVideoTab();
    await chooseFamily(picker, "rtv", "Seedance 2.5");
    await userEvent.click(screen.getByRole("button", { name: "Reference" }));

    const prompt = screen.getByPlaceholderText("Describe the video to generate");
    expect((prompt as HTMLTextAreaElement).value).toBe(
      "Refer to <Subject 1> in <Image 1> to generate ",
    );
  });

  it("says which variant the inputs resolved to, with the backend's own name", async () => {
    const picker = await openVideoTab();
    await chooseFamily(picker, "seedance-2-0-fast", "Seedance 2.0 Fast (full)");

    // Nothing filled in yet: plain text-to-video, nothing to say.
    expect(within(picker).queryByText(/reference to video/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add a clip" }));
    // The file input is what a tap opens; feed it the way the webview would.
    const input = document.querySelector<HTMLInputElement>('input[accept="video/*"]');
    if (!input) throw new Error("no clip input");
    await userEvent.upload(input, new File(["clip"], "alley.mp4", { type: "video/mp4" }));

    await waitFor(() => expect(within(picker).getByText(/reference to video/)).toBeTruthy());
  });
});
