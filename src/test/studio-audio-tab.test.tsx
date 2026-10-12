import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioStudio } from "../components/studio/AudioStudio";
import type { MediaCatalog } from "../lib/studio/types";

// Each desk draws the mode switch above its scene, so the doubles do too.
vi.mock("../components/studio/MusicStudio", () => ({
  MusicStudio: ({ tools }: { tools?: React.ReactNode }) => (
    <>
      {tools}
      <p>Music workshop</p>
    </>
  ),
}));
vi.mock("../components/studio/SpeechStudio", () => ({
  SpeechStudio: ({ tools }: { tools?: React.ReactNode }) => (
    <>
      {tools}
      <p>Speech workshop</p>
    </>
  ),
}));
vi.mock("../components/studio/SoundFxStudio", () => ({
  SoundFxStudio: ({ tools }: { tools?: React.ReactNode }) => (
    <>
      {tools}
      <p>Effects workshop</p>
    </>
  ),
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

describe("the audio tab", () => {
  it("honors an explicit audio destination then remembers subsequent choices", () => {
    localStorage.setItem("os-june:studio-audio-mode", "music");
    const view = render(<AudioStudio catalog={catalog} requestedMode="speech" />);
    expect(screen.getByText("Speech workshop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Sound effects" }));
    expect(screen.getByText("Effects workshop")).toBeInTheDocument();
    view.unmount();
    render(<AudioStudio catalog={catalog} />);
    expect(screen.getByText("Effects workshop")).toBeInTheDocument();
  });
});
