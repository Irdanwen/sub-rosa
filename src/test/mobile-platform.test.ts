import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ platform: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: mocks.platform }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  mocks.platform.mockReset();
  mocks.invoke.mockReset();
  window.history.replaceState({}, "", "/");
});

describe("mobile platform boundaries", () => {
  it.each(["ios", "android"])("selects the mobile shell on %s", async (platform) => {
    mocks.platform.mockReturnValue(platform);
    const { isMobilePlatform } = await import("../lib/mobile");
    expect(isMobilePlatform()).toBe(true);
  });

  it("does not invoke the iOS audio session from Android", async () => {
    mocks.platform.mockReturnValue("android");
    const { markMediaPlayback } = await import(
      "../components/mobile/screens/studio/StudioControls"
    );
    markMediaPlayback(true);
    markMediaPlayback(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps the native iOS audio session transitions", async () => {
    mocks.platform.mockReturnValue("ios");
    const { markMediaPlayback } = await import(
      "../components/mobile/screens/studio/StudioControls"
    );
    markMediaPlayback(true);
    expect(mocks.invoke).toHaveBeenCalledWith("set_playback_audio_session", { active: true });
  });

  it("a browser mobile preview does not claim native iOS capabilities", async () => {
    mocks.platform.mockImplementation(() => {
      throw new Error("browser");
    });
    window.history.replaceState({}, "", "/?mobile=1");
    const { isMobilePlatform, isIosPlatform } = await import("../lib/mobile");
    expect(isMobilePlatform()).toBe(true);
    expect(isIosPlatform()).toBe(false);
  });
});
