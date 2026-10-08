import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (_command: string, _args?: unknown) => ({
  path: null,
  bytes: 1,
  shared: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));
const writeTextMock = vi.fn(async (_text: string) => undefined);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeTextMock(text),
}));

beforeEach(() => {
  invokeMock.mockClear();
  writeTextMock.mockClear();
});

import {
  arcPath,
  barPath,
  labelStride,
  niceTicks,
  stackSeries,
  valueExtent,
} from "../lib/chart-geometry";
import { chatBlocksToClipboardText, parseChatBlock } from "../lib/chat-blocks";
import {
  type ChartChatBlock,
  chartAsTable,
  type TableChatBlock,
  tableToCsv,
  tableToMarkdown,
} from "../lib/chat-blocks-data";
import { speakableMarkdown } from "../lib/speakable-text";
import { SimpleMarkdown } from "../lib/simple-markdown";
import { ChatBlockView } from "../components/chat-blocks/ChatBlockView";

const BAR = {
  v: 1,
  type: "bar",
  title: "Revenue by quarter",
  x: { title: "Quarter" },
  y: { title: "Revenue", unit: "€" },
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { name: "2025", values: [120, 135, 150] },
    { name: "2026", values: [130, null, 170] },
  ],
};

const TABLE = {
  v: 1,
  title: "Regions",
  columns: ["Region", { label: "Revenue", unit: "€" }],
  rows: [
    ["North", 1200],
    ["South", 900],
    ["East", 1500],
  ],
};

function chart(payload: unknown): ChartChatBlock {
  const block = parseChatBlock("subrosa:chart", JSON.stringify(payload));
  if (block?.kind !== "chart") throw new Error("expected a chart");
  return block;
}

function table(payload: unknown): TableChatBlock {
  const block = parseChatBlock("subrosa:table", JSON.stringify(payload));
  if (block?.kind !== "table") throw new Error("expected a table");
  return block;
}

describe("chart block parsing", () => {
  it("parses a valid bar chart with its axes and gaps", () => {
    const block = chart(BAR);
    expect(block.type).toBe("bar");
    expect(block.unit).toBe("€");
    expect(block.xTitle).toBe("Quarter");
    expect(block.series[1].values).toEqual([130, null, 170]);
    expect(block.dropped).toBeUndefined();
  });

  it("rejects what is not a chart, so the fence stays a code block", () => {
    for (const payload of [
      { ...BAR, v: 2 },
      { ...BAR, type: "radar" },
      { ...BAR, categories: [] },
      { ...BAR, series: [{ name: "x", values: [null, "12", Number.NaN] }] },
      { v: 1, type: "scatter", series: [{ name: "x", points: [["a", 1]] }] },
    ]) {
      expect(parseChatBlock("subrosa:chart", JSON.stringify(payload))).toBeNull();
    }
    expect(parseChatBlock("subrosa:chart", "{not json")).toBeNull();
  });

  it("caps series at the palette and says what it left out", () => {
    const series = Array.from({ length: 11 }, (_, index) => ({
      name: `S${index}`,
      values: [index, index + 1, index + 2],
    }));
    const block = chart({ ...BAR, series });
    expect(block.series).toHaveLength(8);
    expect(block.dropped?.series).toBe(3);
  });

  it("pads short series, cuts long ones, and caps bar categories", () => {
    const categories = Array.from({ length: 80 }, (_, index) => `C${index}`);
    const block = chart({
      ...BAR,
      categories,
      series: [{ name: "a", values: [1, 2] }],
    });
    expect(block.categories).toHaveLength(60);
    expect(block.series[0].values).toHaveLength(60);
    expect(block.series[0].values[2]).toBeNull();
    expect(block.dropped?.categories).toBe(20);
  });

  it("folds a pie's smallest slices into Other and drops non-positive ones", () => {
    const categories = Array.from({ length: 12 }, (_, index) => `P${index}`);
    const values = [50, 40, 30, 20, 10, 9, 8, 7, 3, 2, 1, -4];
    const block = chart({ v: 1, type: "pie", categories, series: [{ name: "Share", values }] });
    expect(block.categories).toHaveLength(8);
    expect(block.categories.at(-1)).toBe("Other");
    expect(block.series[0].values.at(-1)).toBe(3 + 2 + 1 + 7);
    expect(block.dropped?.slices).toBe(4);
  });

  it("keeps three scatter series at most and bounds its points", () => {
    const series = Array.from({ length: 5 }, (_, index) => ({
      name: `S${index}`,
      points: [
        [index, 1],
        [index + 1, 2],
      ],
    }));
    const block = chart({ v: 1, type: "scatter", series, x: { title: "Age", unit: "y" } });
    expect(block.scatter).toHaveLength(3);
    expect(block.xUnit).toBe("y");
    expect(block.dropped?.series).toBe(2);
    const many = chart({
      v: 1,
      type: "scatter",
      series: [{ name: "a", points: Array.from({ length: 2_500 }, (_, i) => [i, i]) }],
    });
    expect(many.scatter[0].points).toHaveLength(2_000);
    expect(many.dropped?.points).toBe(500);
  });

  it("caps every string the model wrote", () => {
    const block = chart({
      ...BAR,
      title: "t".repeat(400),
      categories: ["c".repeat(300), "b", "a"],
    });
    expect(block.title?.length).toBe(120);
    expect(block.categories[0].length).toBe(60);
  });
});

describe("table block parsing", () => {
  it("parses columns, units and numeric columns", () => {
    const block = table(TABLE);
    expect(block.columns.map((column) => column.label)).toEqual(["Region", "Revenue"]);
    expect(block.columns[1]).toMatchObject({ unit: "€", numeric: true });
    expect(block.columns[0].numeric).toBe(false);
  });

  it("rejects tables without columns or rows, or with an unlabelled column", () => {
    expect(parseChatBlock("subrosa:table", JSON.stringify({ ...TABLE, rows: [] }))).toBeNull();
    expect(parseChatBlock("subrosa:table", JSON.stringify({ ...TABLE, columns: [] }))).toBeNull();
    expect(
      parseChatBlock("subrosa:table", JSON.stringify({ ...TABLE, columns: ["A", { unit: "x" }] })),
    ).toBeNull();
    expect(parseChatBlock("subrosa:table", JSON.stringify({ ...TABLE, v: 0 }))).toBeNull();
  });

  it("caps rows and columns and pads short rows", () => {
    const columns = Array.from({ length: 15 }, (_, index) => `C${index}`);
    const rows = Array.from({ length: 620 }, (_, index) => [index]);
    const block = table({ v: 1, columns, rows });
    expect(block.columns).toHaveLength(12);
    expect(block.rows).toHaveLength(500);
    expect(block.rows[0]).toHaveLength(12);
    expect(block.rows[0][1]).toBeNull();
    expect(block.dropped).toEqual({ rows: 120, columns: 3 });
  });

  it("writes CSV that survives commas, quotes and formulas, and Markdown that escapes pipes", () => {
    const block = table({
      v: 1,
      columns: ["Name", "Note"],
      rows: [
        ['Smith, "Jo"', "=SUM(A1)"],
        ["a|b", null],
      ],
    });
    expect(tableToCsv(block)).toBe('Name,Note\r\n"Smith, ""Jo""",\'=SUM(A1)\r\na|b,\r\n');
    expect(tableToMarkdown(block)).toContain("| a\\|b |  |");
  });

  it("copies a reply with its cards as Markdown tables, and speaks them as a card", () => {
    const reply = `Here.\n\n\`\`\`subrosa:table\n${JSON.stringify(TABLE)}\n\`\`\``;
    const copied = chatBlocksToClipboardText(reply);
    expect(copied).toContain("| Region | Revenue (€) |");
    expect(copied).not.toContain("subrosa:table");
    expect(speakableMarkdown(reply, { fences: "label" })).toContain("There is a table here.");
  });

  it("turns a chart into the rows its data view shows", () => {
    const rows = chartAsTable(chart(BAR));
    expect(rows.columns.map((column) => column.label)).toEqual(["Quarter", "2025", "2026"]);
    expect(rows.rows[1]).toEqual(["Q2", 135, null]);
  });
});

describe("chart geometry", () => {
  it("picks round ticks that cover the data", () => {
    expect(niceTicks(0, 170)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(0.1, 0.3)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });

  it("stacks positives up and negatives down, and bars include zero", () => {
    const block = chart({
      ...BAR,
      stacked: true,
      series: [
        { name: "a", values: [10, -5, 3] },
        { name: "b", values: [5, -5, 2] },
      ],
    });
    expect(stackSeries(block)[1]).toEqual([
      [10, 15],
      [-5, -10],
      [3, 5],
    ]);
    expect(valueExtent(block)).toEqual([-10, 15]);
  });

  it("draws bars with a rounded data end and arcs that close", () => {
    expect(barPath(0, 20, 100, 40)).toContain("Q");
    expect(barPath(0, 20, 100, 40, false)).not.toContain("Q");
    expect(arcPath(50, 50, 40, 0, 0, Math.PI)).toMatch(/^M 50 50 L .* Z$/);
    expect(arcPath(50, 50, 40, 20, 0, Math.PI * 2)).toContain("A 20 20");
    expect(labelStride(60, 300, 40)).toBe(8);
  });
});

describe("chart card", () => {
  const fence = (kind: string, body: unknown) =>
    `Intro.\n\n\`\`\`subrosa:${kind}\n${JSON.stringify(body)}\n\`\`\``;

  it("renders through the shared markdown renderer with a legend and one mark per value", () => {
    const { container } = render(<SimpleMarkdown text={fence("chart", BAR)} />);
    expect(screen.getByRole("region", { name: "Revenue by quarter" })).toBeInTheDocument();
    // Five values (one gap), and the legend's two swatches.
    expect(container.querySelectorAll("svg path[class^='chat-chart-s']")).toHaveLength(5);
    expect(container.querySelectorAll(".chat-chart-legend rect")).toHaveLength(2);
    expect(container.querySelector(".chat-chart-axis-title")?.textContent).toBe("Revenue (€)");
  });

  it("reads values with the keyboard and shows them in a tooltip", () => {
    const { container } = render(<ChatBlockView block={chart(BAR)} />);
    const plot = screen.getByRole("figure");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    const tooltip = container.querySelector(".chat-chart-tooltip");
    expect(tooltip?.textContent).toContain("Q1");
    expect(tooltip?.textContent).toContain("2025");
    fireEvent.keyDown(plot, { key: "End" });
    expect(container.querySelector(".chat-data-live")?.textContent).toMatch(/^Q3\. 2025: 150/);
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(container.querySelector(".chat-chart-tooltip")).toBeNull();
  });

  it("draws lines, areas, a donut and a scatter plot", () => {
    const line = render(<ChatBlockView block={chart({ ...BAR, type: "line" })} />);
    expect(line.container.querySelectorAll(".chat-chart-line")).toHaveLength(2);
    // The gap splits the second line into two runs.
    expect(line.container.querySelectorAll(".chat-chart-line")[1].getAttribute("d")).toMatch(
      /M .* M /,
    );
    line.unmount();
    const area = render(<ChatBlockView block={chart({ ...BAR, type: "area", stacked: true })} />);
    expect(area.container.querySelectorAll(".chat-chart-area")).toHaveLength(2);
    area.unmount();
    const donut = render(
      <ChatBlockView
        block={chart({
          v: 1,
          type: "donut",
          categories: ["A", "B", "C"],
          series: [{ name: "x", values: [1, 2, 3] }],
        })}
      />,
    );
    expect(donut.container.querySelectorAll(".chat-chart-slice")).toHaveLength(3);
    expect(donut.container.querySelector(".chat-chart-total")?.textContent).toBe("6");
    donut.unmount();
    const scatter = render(
      <ChatBlockView
        block={chart({
          v: 1,
          type: "scatter",
          series: [
            {
              name: "a",
              points: [
                [1, 2],
                [3, 4],
              ],
            },
          ],
        })}
      />,
    );
    expect(scatter.container.querySelectorAll(".chat-chart-dot")).toHaveLength(2);
  });

  it("shows its data as a table and saves it as CSV", async () => {
    render(<ChatBlockView block={chart(BAR)} />);
    fireEvent.click(screen.getByRole("button", { name: "Show data" }));
    const data = screen.getByRole("region", { name: "Data for Revenue by quarter" });
    expect(within(data).getAllByRole("row")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Save as CSV" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("export_chat_data");
    expect(args).toMatchObject({
      request: { name: "Revenue by quarter", format: "csv" },
    });
    expect((args as { request: { data: string } }).request.data).toContain("Q1,120,130");
  });

  it("saves a standalone SVG with the title drawn in", async () => {
    render(<ChatBlockView block={chart(BAR)} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as SVG" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const request = (invokeMock.mock.calls[0][1] as { request: { data: string; format: string } })
      .request;
    expect(request.format).toBe("svg");
    expect(request.data.startsWith("<svg")).toBe(true);
    expect(request.data).toContain("Revenue by quarter");
    expect(request.data).not.toContain("class=");
  });
});

describe("table card", () => {
  it("sorts by a column, numbers numerically, and back", () => {
    render(<ChatBlockView block={table(TABLE)} />);
    const firstColumn = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(firstColumn()).toEqual(["North", "South", "East"]);
    fireEvent.click(screen.getByRole("button", { name: /Revenue/ }));
    expect(firstColumn()).toEqual(["South", "North", "East"]);
    expect(screen.getByRole("columnheader", { name: /Revenue/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    fireEvent.click(screen.getByRole("button", { name: /Revenue/ }));
    expect(firstColumn()).toEqual(["East", "North", "South"]);
    fireEvent.click(screen.getByRole("button", { name: /Revenue/ }));
    expect(firstColumn()).toEqual(["North", "South", "East"]);
  });

  it("right-aligns numbers and shows the rest of a long table on demand", () => {
    const rows = Array.from({ length: 130 }, (_, index) => [`R${index}`, index]);
    const { container } = render(<ChatBlockView block={table({ ...TABLE, rows })} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(container.querySelector("td[data-numeric]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 100 more rows" }));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(120);
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more rows" }));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(130);
  });

  it("copies as CSV and Markdown", async () => {
    render(<ChatBlockView block={table(TABLE)} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(2));
    expect(writeTextMock.mock.calls[0][0]).toContain("Region,Revenue (€)");
    expect(writeTextMock.mock.calls[1][0]).toContain("| Region | Revenue (€) |");
  });

  it("an invalid table fence stays a readable code block", () => {
    const { container } = render(
      <SimpleMarkdown text={'```subrosa:table\n{"v":1,"columns":[]}\n```'} />,
    );
    expect(container.querySelector(".chat-table")).toBeNull();
    expect(container.textContent).toContain('"columns"');
  });
});
