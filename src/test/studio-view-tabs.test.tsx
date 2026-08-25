import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioView } from "../components/studio/StudioView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("../components/studio/useMediaCatalog", () => ({
  useMediaCatalog: () => ({
    catalog: { backend: "carpe-diem", models: [] },
    loading: false,
    error: undefined,
    reload: vi.fn(),
  }),
}));
vi.mock("../components/studio/ImageStudio", () => ({ ImageStudio: () => <p>image tab</p> }));
vi.mock("../components/studio/VideoStudio", () => ({ VideoStudio: () => <p>video tab</p> }));
vi.mock("../components/studio/AudioStudio", () => ({ AudioStudio: () => <p>audio tab</p> }));
vi.mock("../components/studio/AssembleStudio", () => ({
  AssembleStudio: () => <p>assemble tab</p>,
}));
vi.mock("../components/studio/BibleStudio", () => ({
  BibleStudio: ({ onMakeAFilm }: { onMakeAFilm?: () => void }) => (
    <button type="button" onClick={onMakeAFilm}>
      make a film
    </button>
  ),
}));
vi.mock("../components/studio/WorkflowStudio", () => ({
  WorkflowStudio: ({ scriptRequested }: { scriptRequested?: boolean }) => (
    <p>{scriptRequested ? "workflows tab, script asked for" : "workflows tab"}</p>
  ),
}));

beforeEach(() => window.localStorage.clear());

describe("the studio's tabs", () => {
  it("offers no Films tab: the remote studio is gone", () => {
    render(<StudioView />);
    expect(screen.queryByText("Films")).not.toBeInTheDocument();
    expect(screen.getByText("Bible")).toBeInTheDocument();
  });

  it("lands somebody who was last on Films where films are made now", async () => {
    // Not on a blank panel, and not silently back on Image either: the tab
    // they wanted still exists, it just moved.
    window.localStorage.setItem("os-june:studio-tab", "films");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("workflows tab")).toBeInTheDocument());
  });

  it("carries somebody from the bible to where a film is made", async () => {
    // The two live on different tabs and nothing joined them: a user who had
    // just built a bible was left staring at a list.
    window.localStorage.setItem("os-june:studio-tab", "bible");
    render(<StudioView />);
    fireEvent.click(await screen.findByRole("button", { name: "make a film" }));
    await waitFor(() =>
      expect(screen.getByText("workflows tab, script asked for")).toBeInTheDocument(),
    );
  });

  it("still resolves the pre-audio name of the audio tab", async () => {
    window.localStorage.setItem("os-june:studio-tab", "music");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("audio tab")).toBeInTheDocument());
  });
});
