import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssembleStudio } from "../components/studio/AssembleStudio";
import { chainCuts } from "../lib/studio/chain";
import type { StudioArtifact } from "../lib/studio/types";

function shot(id: string, overrides: Partial<StudioArtifact> = {}): StudioArtifact {
  return {
    id,
    kind: "video",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1000,
    model: "seedance-2-0-image-to-video",
    prompt: `prompt for ${id}`,
    createdAt: 1,
    ...overrides,
  };
}

const A = shot("a.mp4");
const B = shot("b.mp4", { createdAt: 2, parentId: "a.mp4", parentHandoffSeconds: 9.5 });

const artifacts = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: artifacts.list,
  deleteArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  saveArtifactFromBase64: vi.fn(),
}));

describe("a shot chain handed to the assemble tab", () => {
  beforeEach(() => {
    artifacts.list.mockReset();
    artifacts.list.mockResolvedValue([]);
  });

  it("loads the chain as the cut list, in order and already trimmed", async () => {
    const applied = vi.fn();
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} onPendingCutsApplied={applied} />);

    // Both shots staged, oldest first.
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());
    expect(screen.getByText("2. prompt for b.mp4")).toBeInTheDocument();

    // The first shot is cut where the second took over; the last plays out.
    expect((screen.getByLabelText("Clip 1 end seconds") as HTMLInputElement).value).toBe("9.5");
    expect((screen.getByLabelText("Clip 2 end seconds") as HTMLInputElement).value).toBe("");

    // The hand-off is consumed once, so switching tabs does not re-stage it.
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("stages nothing when no chain was handed over", async () => {
    render(<AssembleStudio />);
    await waitFor(() => expect(artifacts.list).toHaveBeenCalled());
    expect(screen.queryByText("1. prompt for a.mp4")).toBeNull();
  });
});
