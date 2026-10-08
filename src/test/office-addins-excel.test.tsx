import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { analysisTurn } from "../../website/src/client/analysis";
import type { PythonEngine } from "../../website/src/client/analysis/python";
import {
  answerProse,
  answerTables,
  cellListing,
  parseFormulaAnswer,
  rangeCsv,
  sheetRows,
} from "../../office-addins/src/excel/data";
import { ExcelPane } from "../../office-addins/src/excel/ExcelPane";
import {
  cellValue,
  columnName,
  type ExcelApi,
  type ExcelContext,
  type ExcelRange,
  excelHost,
  firstCell,
  freeSheetName,
  splitAddress,
} from "../../office-addins/src/excel/host";
import { OFFICE } from "../../office-addins/src/words";
import { fakeEngine, lastUser } from "./office-addins-fakes";
import { text } from "./website-client-fakes";

const TABLE = [
  "Totals by region.",
  "```subrosa:table",
  JSON.stringify({
    v: 1,
    title: "Revenue",
    columns: ["Region", { label: "Total", unit: "€" }],
    rows: [
      ["North", 1200],
      ["=HYPERLINK(1)", 900],
    ],
  }),
  "```",
].join("\n");

/** An Excel with one sheet and a selection, recording what is written. */
function fakeExcel(selection: { address: string; values: unknown[][]; formulas?: unknown[][] }) {
  const written: { sheet: string; address: string; formulas?: unknown; values?: unknown }[] = [];
  const sheets = [{ name: "Sheet1" }];
  const range = (sheet: string, address: string): ExcelRange => {
    const record: { sheet: string; address: string; formulas?: unknown; values?: unknown } = {
      sheet,
      address,
    };
    written.push(record);
    return new Proxy({} as ExcelRange, {
      set(_target, key, value) {
        (record as Record<string, unknown>)[key as string] = value;
        return true;
      },
    });
  };
  const worksheet = (name: string) => ({
    name,
    load: () => undefined,
    getRange: (address: string) => range(name, address),
    getUsedRange: () => ({
      address: `${name}!A1:B2`,
      values: [
        ["Region", "Total"],
        ["North", 1200],
      ],
      load: () => undefined,
    }),
    activate: vi.fn(),
  });
  const excel: ExcelApi = {
    async run(batch) {
      const selected = {
        address: selection.address,
        values: selection.values,
        formulas: selection.formulas ?? selection.values,
        rowCount: selection.values.length,
        columnCount: selection.values[0]?.length ?? 0,
        load: () => undefined,
      };
      const context = {
        workbook: {
          getSelectedRange: () => selected,
          worksheets: {
            items: sheets as never,
            load: () => undefined,
            getActiveWorksheet: () => worksheet("Sheet1"),
            getItem: (name: string) => worksheet(name),
            add: (name: string) => {
              sheets.push({ name });
              return worksheet(name);
            },
          },
        },
        sync: async () => undefined,
      } as unknown as ExcelContext;
      return batch(context);
    },
  };
  return { excel, written, sheets };
}

describe("Excel's addresses and cells", () => {
  it("splits, quotes and names addresses", () => {
    expect(splitAddress("'My sheet'!B2:C3")).toEqual(["My sheet", "B2:C3"]);
    expect(firstCell("Sheet1!B2:D9")).toBe("Sheet1!B2");
    expect(firstCell("'It''s'!A1:A2")).toBe("'It''s'!A1");
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
  });

  it("never writes a model's text as a formula", () => {
    expect(cellValue("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(cellValue("+1")).toBe("'+1");
    expect(cellValue("@cmd")).toBe("'@cmd");
    expect(cellValue(42)).toBe(42);
    expect(cellValue(null)).toBe("");
  });

  it("picks a free sheet name within 31 characters", () => {
    expect(freeSheetName("Sub Rosa analysis", ["Sheet1"])).toBe("Sub Rosa analysis");
    expect(freeSheetName("Sub Rosa analysis", ["sub rosa analysis"])).toBe("Sub Rosa analysis 2");
    expect(freeSheetName("x".repeat(40), ["x".repeat(31)])).toHaveLength(31);
  });

  it("writes the range as CSV and as a cell listing", () => {
    expect(
      rangeCsv([
        ["a,b", 1],
        [null, 'q"t'],
      ]),
    ).toBe('"a,b",1\n,"q""t"');
    expect(cellListing("Sheet1!B2:C3", [["x", 2]], 20, [["x", "=A1*2"]])).toBe(
      "B2: x\nC2: =A1*2 -> 2",
    );
  });

  it("reads an answer's tables as rows, and its prose apart", () => {
    expect(answerTables(TABLE)).toEqual([
      [["Revenue"], ["Region", "Total (€)"], ["North", 1200], ["=HYPERLINK(1)", 900]],
    ]);
    expect(answerProse(TABLE)).toBe("Totals by region.");
    expect(sheetRows("Line one.\nLine two.")).toEqual([["Line one."], ["Line two."]]);
  });

  it("reads a formula answer leniently and refuses one without =", () => {
    expect(
      parseFormulaAnswer('```json\n{"formula":"=SUM(A:A)","explanation":"Adds."}\n```'),
    ).toEqual({ formula: "=SUM(A:A)", explanation: "Adds." });
    expect(parseFormulaAnswer('{"formula":"SUM(A:A)","explanation":""}')).toBeNull();
    expect(parseFormulaAnswer("no json")).toBeNull();
  });
});

describe("the analysis plumbing", () => {
  it("mounts the selected range for every Python run of the turn", async () => {
    const run = vi.fn(async () => "Output:\n3");
    const engine = { run, dispose: () => undefined } as PythonEngine;
    const addition = analysisTurn([{ name: "selection.csv", text: "a\n1" }], () => engine);
    const answer = await addition.run?.(
      "run_python",
      { code: "print(3)" },
      { chatId: null, temporary: true, question: "" },
    );
    expect(answer).toBe("Output:\n3");
    expect(run).toHaveBeenCalledWith("print(3)", "temporary", undefined, [
      { name: "selection.csv", text: "a\n1" },
    ]);
  });
});

describe("the Excel pane", () => {
  it("writes analysis results to a new sheet only after confirmation", async () => {
    const { excel, written, sheets } = fakeExcel({
      address: "Sheet1!A1:B3",
      values: [
        ["Region", "Total"],
        ["North", 1200],
        ["South", 900],
      ],
    });
    const { engine, calls } = fakeEngine(() => text(TABLE));
    render(<ExcelPane host={excelHost(excel)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("tab", { name: "Analyse" }));
    await userEvent.type(screen.getByRole("textbox"), "Totals by region?");
    await userEvent.click(screen.getByRole("button", { name: "Analyse the selection" }));
    await screen.findByText("Totals by region.");
    const body = calls[0].body;
    const system = (body.messages as { content: string }[])[0].content;
    expect(system).toContain(OFFICE.excel.analyse);
    const tools = (body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(tools).toContain("run_python");
    expect(tools).not.toContain("search_notes");
    expect(lastUser(body)).toContain("Range Sheet1!A1:B3, 3 rows by 2 columns.");
    expect(lastUser(body)).toContain("A2: North");
    expect(written).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Write the results to a new sheet" }));
    await screen.findByText(/Written to the new sheet Sub Rosa analysis/);
    expect(sheets.map((sheet) => sheet.name)).toContain("Sub Rosa analysis");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      sheet: "Sub Rosa analysis",
      address: "A1:B4",
      values: [
        ["Revenue", ""],
        ["Region", "Total (€)"],
        ["North", 1200],
        ["'=HYPERLINK(1)", 900],
      ],
    });
  });

  it("writes a proposed formula into the cell it was made for", async () => {
    const { excel, written } = fakeExcel({ address: "Sheet1!C2", values: [[""]] });
    const { engine, calls } = fakeEngine(() =>
      text('{"formula":"=SUM(B2:B9)","explanation":"Adds the totals."}'),
    );
    render(<ExcelPane host={excelHost(excel)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("tab", { name: "Write a formula" }));
    await userEvent.type(screen.getByRole("textbox"), "sum of the totals");
    await userEvent.click(screen.getByRole("button", { name: "Write the formula" }));
    await screen.findByText("=SUM(B2:B9)");
    expect(lastUser(calls[0].body)).toContain("cell Sheet1!C2");
    expect(lastUser(calls[0].body)).toContain("A1: Region");
    expect(written).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Put it in Sheet1!C2" }));
    await waitFor(() =>
      expect(written).toEqual([{ sheet: "Sheet1", address: "C2", formulas: [["=SUM(B2:B9)"]] }]),
    );
  });

  it("explains a formula and refuses a cell without one", async () => {
    const { excel } = fakeExcel({ address: "Sheet1!A1", values: [[3]], formulas: [["=1+2"]] });
    const { engine, calls } = fakeEngine(() => text("It adds one and two."));
    const { unmount } = render(
      <ExcelPane host={excelHost(excel)} engine={engine} language="en-US" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Explain the formula" }));
    await screen.findByText("It adds one and two.");
    expect(lastUser(calls[0].body)).toContain("Formula: =1+2");
    unmount();
    const plain = fakeExcel({ address: "Sheet1!A1", values: [[3]] });
    render(<ExcelPane host={excelHost(plain.excel)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("button", { name: "Explain the formula" }));
    await screen.findByText(/holds no formula/);
  });
});
