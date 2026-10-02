import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RetouchComposer } from "../components/studio/retouch/RetouchComposer";

function composer(overrides: Partial<Parameters<typeof RetouchComposer>[0]> = {}) {
  const props: Parameters<typeof RetouchComposer>[0] = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    rendering: false,
    zoneActive: false,
    refs: [],
    maxRefs: 2,
    onRemoveRef: vi.fn(),
    onAddFiles: vi.fn(),
    onPickGallery: vi.fn(),
    models: [],
    onModel: vi.fn(),
    variants: 1,
    onVariants: vi.fn(),
    aspectLabel: "Auto",
    onOpenSettings: vi.fn(),
    settingsOpen: false,
    presets: [],
    onPreset: vi.fn(),
    ...overrides,
  };
  render(<RetouchComposer {...props} />);
  return props;
}

describe("the retouch composer's attach menu", () => {
  it("opens outside the tools strip that scrolls on a phone", () => {
    composer({ compact: true, onDictate: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Add an image to the instruction" }));
    const menu = screen.getByRole("menu");
    // The phone's tools strip scrolls sideways, which clips anything that
    // overflows it: a menu inside it opens invisibly.
    expect(menu.closest(".retouch-bar-tools")).toBeNull();
  });

  it("offers the gallery from the phone", () => {
    const props = composer({ compact: true });
    fireEvent.click(screen.getByRole("button", { name: "Add an image to the instruction" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "From the gallery" }));
    expect(props.onPickGallery).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
