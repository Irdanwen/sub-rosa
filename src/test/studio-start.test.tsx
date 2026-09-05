import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStart } from "../components/studio/StudioStart";
import { AudioStudio } from "../components/studio/AudioStudio";
import type { MediaCatalog } from "../lib/studio/types";

vi.mock("../components/studio/MusicStudio", () => ({ MusicStudio: () => <p>Music workshop</p> }));
vi.mock("../components/studio/SpeechStudio", () => ({
  SpeechStudio: () => <p>Speech workshop</p>,
}));
vi.mock("../components/studio/SoundFxStudio", () => ({
  SoundFxStudio: () => <p>Effects workshop</p>,
}));

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    { id: "picture", name: "Picture", mediaType: "image", offline: false },
    { id: "retired", name: "Retired", mediaType: "image", offline: true },
    { id: "voice", name: "Voice", mediaType: "tts", offline: false },
    { id: "movie-text-to-video", name: "Movie", mediaType: "video", offline: false },
    { id: "movie-image-to-video", name: "Movie", mediaType: "imageToVideo", offline: false },
  ],
};

beforeEach(() => localStorage.clear());

describe("Studio exploration", () => {
  it("offers only available outcomes and counts video families rather than duplicate variants", () => {
    render(<StudioStart catalog={catalog} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Create an image/ })).toHaveTextContent(
      "1 model available",
    );
    expect(screen.getByRole("button", { name: /Bring a scene/ })).toHaveTextContent(
      "1 video family",
    );
    expect(screen.getByRole("button", { name: /Compose a soundtrack/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Make a complete film/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Assemble your clips" })).toBeEnabled();
  });

  it("opens narration directly rather than the last-used audio tool", () => {
    const onOpen = vi.fn();
    render(<StudioStart catalog={catalog} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Give your words a voice/ }));
    expect(onOpen).toHaveBeenCalledWith({ tab: "audio", audioMode: "speech" });
  });

  it("honors an explicit audio destination then remembers subsequent choices", () => {
    localStorage.setItem("os-june:studio-audio-mode", "music");
    const view = render(<AudioStudio catalog={catalog} requestedMode="speech" />);
    expect(screen.getByText("Speech workshop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(screen.getByText("Effects workshop")).toBeInTheDocument();
    view.unmount();
    render(<AudioStudio catalog={catalog} />);
    expect(screen.getByText("Effects workshop")).toBeInTheDocument();
  });
});
