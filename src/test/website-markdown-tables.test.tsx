import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBody } from "../../website/src/lib/chat-blocks";
import { Markdown } from "../../website/src/lib/markdown";

function draw(text: string) {
  return render(<Markdown text={text} />).container;
}

describe("pipe tables on the website reader", () => {
  it("draws the header, the alignment and the body, inside a scroll box", () => {
    const view = draw(
      [
        "Here is the comparison:",
        "| Model | Price | Notes |",
        "| :--- | ---: | :---: |",
        "| Alpha | 1.5 | **fast** |",
        "| Beta | 12 | `slow` and [docs](https://example.com) |",
        "",
        "After the table.",
      ].join("\n"),
    );
    const scroll = view.querySelector(".reader > .reader-table-scroll");
    expect(scroll).not.toBeNull();
    const table = scroll?.querySelector("table.reader-table");
    expect(table).not.toBeNull();
    const headers = [...(table?.querySelectorAll("thead th") ?? [])];
    expect(headers.map((cell) => cell.textContent)).toEqual(["Model", "Price", "Notes"]);
    expect(headers.map((cell) => cell.className)).toEqual([
      "align-left",
      "align-right",
      "align-center",
    ]);
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("td.align-right")?.textContent).toBe("1.5");
    expect(rows[0].querySelector("strong")?.textContent).toBe("fast");
    expect(rows[1].querySelector("code")?.textContent).toBe("slow");
    expect(rows[1].querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(view.querySelectorAll("p")[0]?.textContent).toBe("Here is the comparison:");
    expect(view.querySelectorAll("p")[1]?.textContent).toBe("After the table.");
    expect(view.querySelector("[style]")).toBeNull();
  });

  it("leaves default-aligned columns without a class and accepts rows without outer pipes", () => {
    const view = draw(["a | b", "--- | ---", "1 | 2"].join("\n"));
    const cells = [...view.querySelectorAll("td")];
    expect(cells.map((cell) => cell.textContent)).toEqual(["1", "2"]);
    expect(cells.every((cell) => !cell.hasAttribute("class"))).toBe(true);
  });

  it("keeps markup in a cell as text", () => {
    const view = draw(
      ["| Input |", "| --- |", '| <img src=x onerror="alert(1)"><script>x()</script> |'].join("\n"),
    );
    const cell = view.querySelector("td");
    expect(cell?.textContent).toBe('<img src=x onerror="alert(1)"><script>x()</script>');
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("script")).toBeNull();
  });

  it("reads an escaped pipe as text, inline code included", () => {
    const view = draw(
      ["| Operator | Meaning |", "| --- | --- |", "| a \\| b | `x \\|\\| y` is or |"].join("\n"),
    );
    const cells = [...view.querySelectorAll("td")];
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe("a | b");
    expect(cells[1].querySelector("code")?.textContent).toBe("x || y");
  });

  it("pads a short row and cuts a long one to the header", () => {
    const view = draw(["| a | b |", "| - | - |", "| 1 |", "| 1 | 2 | 3 |"].join("\n"));
    const rows = [...view.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("keeps a line of pipes with no delimiter row a paragraph", () => {
    const view = draw(["| not | a table |", "| still | not |"].join("\n"));
    expect(view.querySelector("table")).toBeNull();
    expect(view.querySelector("p")?.textContent).toBe("| not | a table |\n| still | not |");
  });

  it("refuses a delimiter row whose width differs from the header", () => {
    const view = draw(["| a | b |", "| --- |"].join("\n"));
    expect(view.querySelector("table")).toBeNull();
  });

  it("keeps a table inside a code fence as code", () => {
    const view = draw(["```", "| a | b |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n"));
    expect(view.querySelector("table")).toBeNull();
    expect(view.querySelector("pre code")?.textContent).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("does not crash on a table still streaming in", () => {
    const full = ["| Model | Price |", "| :--- | ---: |", "| Alpha | 1.5 |", "| Beta | 1"].join(
      "\n",
    );
    for (let end = 0; end <= full.length; end += 1) {
      expect(() => draw(full.slice(0, end))).not.toThrow();
    }
    const partial = draw(full);
    expect(partial.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("draws a table in an assistant reply", () => {
    const view = render(
      <MessageBody content={["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n")} />,
    ).container;
    expect(view.querySelector(".reader-table-scroll table")).not.toBeNull();
  });
});
