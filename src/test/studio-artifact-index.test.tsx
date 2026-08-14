// The editor's one gallery listing, behind the surfaces that only store an
// `artifactId` (a workflow's asset nodes). Two behaviours are load-bearing and
// easy to get wrong: an item picked while a listing is in flight must survive
// that listing landing, and a gallery that cannot be listed at all must never
// be read as "your asset is gone".

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: () => list(),
}));

import { useArtifactIndex } from "../lib/artifact-media";
import type { StudioArtifact } from "../lib/studio/types";

function artifact(id: string): StudioArtifact {
  return {
    id,
    kind: "image",
    path: `/g/${id}.png`,
    fileName: `${id}.png`,
    bytes: 1,
    model: "m",
    prompt: id,
    createdAt: 0,
  };
}

/** Reports the index's state, and can file an item into it on demand. */
function Probe({ pick }: { pick?: StudioArtifact }) {
  const index = useArtifactIndex();
  return (
    <div>
      <span data-testid="loaded">{String(index.loaded)}</span>
      <span data-testid="ids">{[...index.byId.keys()].sort().join(",")}</span>
      <button type="button" onClick={() => pick && index.remember(pick)}>
        pick
      </button>
    </div>
  );
}

describe("useArtifactIndex", () => {
  beforeEach(() => {
    list.mockReset();
  });

  it("indexes the gallery by id", async () => {
    list.mockResolvedValue([artifact("a"), artifact("b")]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("ids").textContent).toBe("a,b"));
    expect(screen.getByTestId("loaded").textContent).toBe("true");
  });

  it("keeps an item picked before the listing landed", async () => {
    // The pick happens while `listArtifacts` is still in flight. Replacing the
    // map with the listing would drop it, and the node that just pointed at it
    // would render "this gallery item is gone".
    let settle: (entries: StudioArtifact[]) => void = () => {};
    list.mockReturnValue(
      new Promise<StudioArtifact[]>((resolve) => {
        settle = resolve;
      }),
    );
    render(<Probe pick={artifact("fresh")} />);
    screen.getByRole("button", { name: "pick" }).click();
    await waitFor(() => expect(screen.getByTestId("ids").textContent).toBe("fresh"));
    settle([artifact("a")]);
    await waitFor(() => expect(screen.getByTestId("ids").textContent).toBe("a,fresh"));
  });

  it("stays unloaded when the gallery cannot be listed", async () => {
    // `loaded` is what licenses "your asset is gone"; a failed listing must
    // never earn that licence.
    list.mockRejectedValue(new Error("no gallery"));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("ids").textContent).toBe(""));
    expect(screen.getByTestId("loaded").textContent).toBe("false");
  });
});
