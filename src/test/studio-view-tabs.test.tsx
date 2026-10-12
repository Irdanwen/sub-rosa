import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../components/studio/ProjectStudio", () => ({
  ProjectStudio: () => <p>project workspace</p>,
}));
vi.mock("../components/studio/BibleStudio", () => ({
  BibleStudio: ({ onMakeAFilm }: { onMakeAFilm?: () => void }) => (
    <button type="button" onClick={onMakeAFilm}>
      make a film
    </button>
  ),
}));
vi.mock("../components/studio/retouch/RetouchStudio", () => ({
  RetouchStudio: ({ pendingArtifactId }: { pendingArtifactId?: string }) => (
    <p>{pendingArtifactId ? `retouching ${pendingArtifactId}` : "retouch tab"}</p>
  ),
}));
vi.mock("../components/studio/compose/ComposeStudio", () => ({
  ComposeStudio: ({ pendingArtifactId }: { pendingArtifactId?: string }) => (
    <p>{pendingArtifactId ? `composing from ${pendingArtifactId}` : "compose tool"}</p>
  ),
}));
vi.mock("../components/studio/StudioGalleryDesktop", () => ({
  StudioGalleryDesktop: () => <p>gallery tab</p>,
}));
vi.mock("../components/studio/WorkflowStudio", () => ({
  WorkflowStudio: ({ scriptRequested }: { scriptRequested?: boolean }) => (
    <p>{scriptRequested ? "workflows tab, script asked for" : "workflows tab"}</p>
  ),
}));

beforeEach(() => window.localStorage.clear());

describe("the studio's tabs", () => {
  it("opens on the image desk, with five tabs (ADR-0110)", () => {
    render(<StudioView />);
    expect(screen.getByText("image tab")).toBeInTheDocument();
    const tabs = screen.getByRole("group", { name: "Studio section" });
    expect([...tabs.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Image",
      "Video",
      "Audio",
      "Projects",
      "Gallery",
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: "Projects" })[0]);
    expect(screen.getByText("project workspace")).toBeInTheDocument();
  });

  it("finds the old Assemble and Workflows tabs inside Projects", async () => {
    window.localStorage.setItem("os-june:studio-tab", "assemble");
    const view = render(<StudioView />);
    await waitFor(() => expect(screen.getByText("assemble tab")).toBeInTheDocument());
    view.unmount();
    window.localStorage.setItem("os-june:studio-tab", "workflows");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("workflows tab")).toBeInTheDocument());
  });

  it("lands somebody who was last on the old Films tab where films are made now", async () => {
    window.localStorage.setItem("os-june:studio-tab", "films");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("project workspace")).toBeInTheDocument());
  });

  it("carries somebody from the bible to where a film is made", async () => {
    // The two live on different tabs and nothing joined them: a user who had
    // just built a bible was left staring at a list.
    window.localStorage.setItem("os-june:studio-tab", "bible");
    render(<StudioView />);
    fireEvent.click(await screen.findByRole("button", { name: "make a film" }));
    await waitFor(() => expect(screen.getByText("project workspace")).toBeInTheDocument());
    expect(window.localStorage.getItem("os-june:studio-tab")).toBe("projects");
  });

  it("still resolves the pre-audio name of the audio tab", async () => {
    window.localStorage.setItem("os-june:studio-tab", "music");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("audio tab")).toBeInTheDocument());
  });

  it("remembers the retouch tab", async () => {
    window.localStorage.setItem("os-june:studio-tab", "retouch");
    render(<StudioView />);
    await waitFor(() => expect(screen.getByText("retouch tab")).toBeInTheDocument());
  });

  it("opens an image handed over from anywhere in the studio in the retouch tab", async () => {
    render(<StudioView />);
    const { requestRetouch } = await import("../lib/studio/retouch/jobs");
    act(() => requestRetouch("photo.png"));
    await waitFor(() => expect(screen.getByText("retouching photo.png")).toBeInTheDocument());
    expect(window.localStorage.getItem("os-june:studio-tab")).toBe("retouch");
  });

  it("opens an image handed over from anywhere in the compose tool", async () => {
    render(<StudioView />);
    const { requestCompose } = await import("../lib/studio/compose/jobs");
    act(() => requestCompose("still.png"));
    await waitFor(() => expect(screen.getByText("composing from still.png")).toBeInTheDocument());
    expect(window.localStorage.getItem("os-june:studio-tab")).toBe("compose");
  });

  it("opens the gallery without waiting for the model catalog", () => {
    window.localStorage.setItem("os-june:studio-tab", "gallery");
    render(<StudioView />);
    expect(screen.getByText("gallery tab")).toBeInTheDocument();
  });
});
