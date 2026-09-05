import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  MediaModelPicker,
  mediaModelOption,
  videoFamilyOption,
} from "../components/studio/MediaModelPicker";
import { ModelSelect } from "../components/studio/controls";
import { videoFamilies } from "../lib/studio/catalog";
import { seedanceCatalog } from "./fixtures/seedance-catalog";

describe("Studio model discovery", () => {
  it("finds a reference variant by its own name and selects its family", async () => {
    const onChange = vi.fn();
    render(
      <MediaModelPicker
        options={videoFamilies(seedanceCatalog()).map(videoFamilyOption)}
        value={null}
        onChange={onChange}
        ariaLabel="Video model"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Video model" });
    await userEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());
    await userEvent.type(search, "Seedance 2.5 RTV");
    expect(screen.getByRole("status")).toHaveTextContent("1 model");
    await userEvent.click(screen.getByRole("button", { name: /Seedance 2.5.*Reference images/ }));
    expect(onChange).toHaveBeenCalledWith("seedance 2.5");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("explains an empty search and lets the user recover without closing", async () => {
    render(
      <ModelSelect
        models={[{ id: "image-one", name: "Image One", mediaType: "image", offline: false }]}
        value="image-one"
        onChange={vi.fn()}
        ariaLabel="Image model"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Image model" }));
    await userEvent.type(screen.getByRole("searchbox"), "unknown");
    expect(screen.getByText("No models match your search.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: /Image One/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows published limits and prices, and hides offline models", async () => {
    render(
      <ModelSelect
        models={[
          {
            id: "voice",
            name: "Voice model",
            mediaType: "tts",
            offline: false,
            voices: ["alice", "bob"],
            costCredits: 0.05,
            privacy: "private",
          },
          { id: "offline", name: "Offline model", mediaType: "tts", offline: true },
        ]}
        value={null}
        onChange={vi.fn()}
        ariaLabel="Speech model"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Speech model" }));
    expect(
      screen.getByText(/Zero data retention.*2 voices.*0.05 credits per generation/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Offline model")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "alice");
    expect(screen.getByRole("status")).toHaveTextContent("1 model");
  });

  it("does not invent capabilities or a zero price for unknown metadata", () => {
    expect(
      mediaModelOption({
        id: "new-vision-audio-model",
        name: "New model",
        mediaType: "image",
        offline: false,
      }).details,
    ).toEqual([]);
    expect(
      mediaModelOption({
        id: "invalid",
        name: "Invalid",
        mediaType: "image",
        offline: false,
        costCredits: Number.NaN,
      }).details,
    ).toEqual([]);
  });

  it("keeps anonymized privacy distinct from private traits and preserves tiny rates", () => {
    const option = mediaModelOption({
      id: "new-model",
      name: "",
      mediaType: "image",
      offline: false,
      privacy: "anonymized",
      traits: ["private"],
      costCredits: 0.00001,
    });
    expect(option.name).toBe("new-model");
    expect(option.details).toContain("Anonymous mode");
    expect(option.details).not.toContain("Zero data retention");
    expect(option.details).toContain("~0.00001 credits per generation");
  });
});
