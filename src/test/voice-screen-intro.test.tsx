// The screen-share explanation (src/components/voice/ScreenShareIntro.tsx)
// says what the system will ask on the computer it runs on: macOS asks for
// Screen Recording, Windows asks nothing (the Windows capture is a GDI copy
// of the primary display, voice/screen_windows.rs).

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const os = vi.hoisted(() => ({ name: "macos" }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => os.name }));

async function renderIntro() {
  // The platform is cached per module load.
  vi.resetModules();
  const { ScreenShareIntro } = await import("../components/voice/ScreenShareIntro");
  render(<ScreenShareIntro onShare={() => {}} onCancel={() => {}} />);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the screen-share explanation", () => {
  it("on a Mac, names the Screen Recording permission", async () => {
    os.name = "macos";
    await renderIntro();
    expect(screen.getByText(/macOS asks to allow Screen Recording/)).toBeTruthy();
    expect(screen.queryByText(/Windows does not ask/)).toBeNull();
  });

  it("on Windows, says no permission is asked and how to stop", async () => {
    os.name = "windows";
    await renderIntro();
    expect(screen.getByText(/Windows does not ask for permission/)).toBeTruthy();
    expect(screen.queryByText(/Screen Recording/)).toBeNull();
    expect(screen.getByText(/without this app's own windows/)).toBeTruthy();
  });
});
