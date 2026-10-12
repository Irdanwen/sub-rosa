import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSheet } from "../components/mobile/ModelSheet";

vi.mock("../lib/haptics", () => ({ hapticSelection: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the phone's model sheet, favourites and the pinned row", () => {
  it("searches, filters, keeps a star and picks, with the shared list rules", async () => {
    const onSelect = vi.fn();
    render(
      <ModelSheet
        title="Video model"
        selectedId="b"
        pinnedId="c"
        entries={[
          { id: "a", name: "Alpha", groups: ["text"] },
          { id: "b", name: "Bravo", groups: ["image"] },
          { id: "c", name: "Charlie", groups: ["text"], tags: [{ label: "Recommended" }] },
        ]}
        filters={[
          { id: "text", label: "From a prompt" },
          { id: "image", label: "Animate an image" },
        ]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const sheet = screen.getByRole("dialog", { name: "Video model" });
    const names = () =>
      within(sheet)
        .getAllByRole("button", { name: /^(Alpha|Bravo|Charlie)/ })
        .map((button) => button.textContent?.slice(0, 5));
    expect(names()[0]).toBe("Charl");
    await userEvent.click(within(sheet).getByRole("button", { name: "Animate an image" }));
    expect(names()).toEqual(["Bravo"]);
    await userEvent.click(within(sheet).getByRole("button", { name: "All" }));
    await userEvent.click(within(sheet).getAllByRole("button", { name: "Add favorite" })[1]);
    expect(localStorage.getItem("subrosa:mobile:model-favorites")).toContain('"a"');
    await userEvent.type(within(sheet).getByRole("searchbox"), "brav");
    expect(names()).toEqual(["Bravo"]);
    await userEvent.click(within(sheet).getByRole("button", { name: /^Bravo/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
