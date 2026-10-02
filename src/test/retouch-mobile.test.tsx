import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioArtifact } from "../lib/studio/types";

const mocks = vi.hoisted(() => ({
  artifacts: [] as StudioArtifact[],
  workspace: vi.fn(),
}));

vi.mock("../lib/studio/artifacts", () => ({
  listArtifacts: vi.fn(async () => mocks.artifacts),
}));
vi.mock("../lib/studio/catalog", () => ({
  fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
}));
vi.mock("../components/studio/retouch/RetouchWorkspace", () => ({
  RetouchWorkspace: (props: { rootId: string; layout: string }) => {
    mocks.workspace(props);
    return <p>{`${props.layout} session ${props.rootId}`}</p>;
  },
}));

import { RetouchScreen } from "../components/mobile/screens/studio/RetouchScreen";
import { OPEN_RETOUCH_EVENT, requestRetouch } from "../lib/studio/retouch/jobs";

function image(id: string, edit?: StudioArtifact["edit"]): StudioArtifact {
  return {
    id,
    kind: "image",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1,
    model: "",
    prompt: "",
    createdAt: 1,
    ...(edit ? { edit } : {}),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.workspace.mockReset();
  mocks.artifacts = [
    image("root.png"),
    image("v2.png", { of: "root.png", root: "root.png", op: "prompt", n: 2 }),
  ];
});

describe("the phone's retouch screen", () => {
  it("opens a picked version inside its session, on that version", async () => {
    render(<RetouchScreen artifactId="v2.png" onBack={vi.fn()} />);
    expect(await screen.findByText("phone session root.png")).toBeTruthy();
    const sessions = JSON.parse(window.localStorage.getItem("os-june:retouch-sessions") ?? "{}");
    expect(sessions["root.png"].cursor).toBe("v2.png");
  });

  it("starts a session on an image that has none", async () => {
    render(<RetouchScreen artifactId="root.png" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("phone session root.png")).toBeTruthy());
  });

  it("is reached from any picture through one event", () => {
    const heard: string[] = [];
    const onOpen = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_RETOUCH_EVENT, onOpen);
    requestRetouch("v2.png");
    window.removeEventListener(OPEN_RETOUCH_EVENT, onOpen);
    expect(heard).toEqual(["v2.png"]);
  });
});
