/**
 * The desktop sidebar's top and its pages under the Library and Today
 * (ADR-0111 addendum): what the New menu starts, the Library's way to Health
 * and Finances and back, and Today's way to the routines.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryPage, PersonalDataPage } from "../app/library-pages";
import { SidebarCreateMenu } from "../components/sidebar/SidebarCreateMenu";
import { requestStudioTab, STUDIO_TAB_STORAGE_KEY } from "../components/studio/studio-keys";

vi.mock("../components/library/LibraryView", () => ({
  LibraryView: ({ header }: { header: React.ReactNode }) => <div>{header}</div>,
}));
vi.mock("../components/personal-data/HealthView", () => ({
  HealthView: ({ header }: { header: React.ReactNode }) => <div>{header}health body</div>,
}));
vi.mock("../components/personal-data/FinancesView", () => ({
  FinancesView: ({ header }: { header: React.ReactNode }) => <div>{header}finances body</div>,
}));

beforeEach(() => localStorage.clear());

describe("the New menu", () => {
  it("starts a note, an import, an image or a video", async () => {
    const onCreateNote = vi.fn();
    const onImportMedia = vi.fn();
    const onOpenStudio = vi.fn();
    render(
      <SidebarCreateMenu
        onCreateNote={onCreateNote}
        onImportMedia={onImportMedia}
        onOpenStudio={onOpenStudio}
      />,
    );
    const open = () =>
      userEvent.click(screen.getByRole("button", { name: "Create something else" }));
    await open();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("New note"),
      "Import audio or video",
      "New image",
      "New video",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: /New note/ }));
    expect(onCreateNote).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "New video" }));
    expect(onOpenStudio).toHaveBeenCalledWith("video");
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Import audio or video" }));
    expect(onImportMedia).toHaveBeenCalled();
  });

  it("offers only what the shell can do", async () => {
    render(<SidebarCreateMenu onOpenStudio={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create something else" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("asks the Studio for a tab whether or not it is open", () => {
    const heard = vi.fn();
    window.addEventListener("subrosa:studio:open-tab", heard);
    requestStudioTab("video");
    window.removeEventListener("subrosa:studio:open-tab", heard);
    expect(localStorage.getItem(STUDIO_TAB_STORAGE_KEY)).toBe("video");
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe("video");
  });
});

describe("the pages under the Library", () => {
  it("reaches Health and Finances from the Library", async () => {
    const onOpen = vi.fn();
    render(<LibraryPage onOpen={onOpen} />);
    const links = screen.getByRole("navigation", { name: "Personal data" });
    expect(links).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Health" }));
    await userEvent.click(screen.getByRole("button", { name: "Finances" }));
    expect(onOpen.mock.calls.map(([view]) => view)).toEqual(["health", "finances"]);
  });

  it("goes back to the Library from Health and Finances", async () => {
    const onBack = vi.fn();
    const view = render(<PersonalDataPage view="health" onBack={onBack} />);
    expect(screen.getByRole("heading", { name: "Health" })).toBeInTheDocument();
    expect(screen.getByText("health body")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(onBack).toHaveBeenCalled();
    view.unmount();
    render(<PersonalDataPage view="finances" onBack={onBack} />);
    expect(screen.getByText("finances body")).toBeInTheDocument();
  });
});
