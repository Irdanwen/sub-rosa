import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  keyCaps,
  requestShortcutsSheet,
  ShortcutsSheetHost,
  shortcutGroups,
} from "../components/shortcuts/ShortcutsSheet";

describe("the shortcuts sheet (D7)", () => {
  it("writes keys the way each platform does", () => {
    expect(keyCaps(["mod", "shift", "N"], true)).toEqual(["⇧", "⌘", "N"]);
    expect(keyCaps(["alt", "mod", "I"], true)).toEqual(["⌥", "⌘", "I"]);
    expect(keyCaps(["mod", "shift", "N"], false)).toEqual(["Ctrl", "Shift", "N"]);
    expect(keyCaps(["shift", "Enter"], false)).toEqual(["Shift", "Enter"]);
  });

  it("lists the shortcuts the window binds, grouped", () => {
    const groups = shortcutGroups();
    expect(groups.map((group) => group.title)).toEqual(["General", "Tabs", "Chat", "Studio"]);
    const labels = groups.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.label));
    expect(labels).toContain("Search and commands");
    expect(labels).toContain("Show or hide the settings panel");
  });

  it("opens on ? and closes on Escape", () => {
    render(<ShortcutsSheetHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves ? alone while somebody is typing", () => {
    render(
      <>
        <input aria-label="Search" />
        <ShortcutsSheetHost />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Search" });
    field.focus();
    fireEvent.keyDown(field, { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the command palette, and sends the dictation shortcuts to Settings", () => {
    const openSettings = vi.fn();
    const settingsTab = vi.fn();
    render(<ShortcutsSheetHost onSettingsTab={settingsTab} onOpenSettings={openSettings} />);
    act(() => requestShortcutsSheet());
    fireEvent.click(screen.getByRole("button", { name: "Dictation shortcuts are in Settings" }));
    expect(settingsTab).toHaveBeenCalledWith("shortcuts");
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
