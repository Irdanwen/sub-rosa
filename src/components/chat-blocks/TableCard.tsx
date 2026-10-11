import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronTriangleDownSmall } from "central-icons/IconChevronTriangleDownSmall";
import { IconChevronTriangleUpSmall } from "central-icons/IconChevronTriangleUpSmall";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconFileDownload } from "central-icons/IconFileDownload";
import { useMemo, useState } from "react";
import "../../styles/chat-data.css";
import {
  type TableCell,
  type TableChatBlock,
  tableToCsv,
  tableToMarkdown,
} from "../../lib/chat-blocks-data";
import { exportChatData } from "../../lib/chat-data-export";
import { messageFromError } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";

/** Rows shown before "Show more"; every press adds this many again. */
export const TABLE_PAGE_ROWS = 20;

type Sort = { column: number; direction: "ascending" | "descending" };

function compareCells(a: TableCell, b: TableCell, direction: Sort["direction"]): number {
  // Empty cells sit at the bottom whichever way the column is sorted.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), intlLocale(), { numeric: true, sensitivity: "base" });
  return direction === "ascending" ? order : -order;
}

export function formatCell(value: TableCell): string {
  if (value === null) return "";
  if (typeof value === "number") {
    return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 6 }).format(value);
  }
  return value;
}

/**
 * A sortable table with a sticky header, right-aligned numbers and a
 * horizontal scroll of its own, so a wide table never widens the reply.
 * Shared by the table card and a chart's "Show data" view.
 */
export function DataTable({ table, label }: { table: TableChatBlock; label: string }) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [visible, setVisible] = useState(TABLE_PAGE_ROWS);
  // Sorting moves rows, so each one keeps its place in the block as its key.
  const rows = useMemo(() => {
    const placed = table.rows.map((cells, source) => ({ cells, source }));
    if (!sort) return placed;
    return placed.sort((a, b) =>
      compareCells(a.cells[sort.column] ?? null, b.cells[sort.column] ?? null, sort.direction),
    );
  }, [table.rows, sort]);
  const toggle = (column: number) =>
    setSort((current) => {
      if (current?.column !== column) return { column, direction: "ascending" };
      if (current.direction === "ascending") return { column, direction: "descending" };
      return null;
    });
  const remaining = rows.length - visible;
  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to scroll it */}
      <section className="chat-table-scroll" aria-label={label} tabIndex={0}>
        <table className="chat-table">
          <thead>
            <tr>
              {table.columns.map((column, index) => {
                const sorted = sort?.column === index ? sort.direction : undefined;
                return (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional, labels may repeat, and sorting moves rows, never columns
                    key={index}
                    scope="col"
                    aria-sort={sorted ?? "none"}
                    data-numeric={column.numeric || undefined}
                  >
                    <button
                      type="button"
                      className="chat-table-sort"
                      onClick={() => toggle(index)}
                      title={t("Sort by {name}", { name: column.label })}
                    >
                      <span>
                        {column.label}
                        {column.unit ? (
                          <span className="chat-table-unit"> ({column.unit})</span>
                        ) : null}
                      </span>
                      <span className="chat-table-sort-icon" aria-hidden>
                        {sorted === "descending" ? (
                          <IconChevronTriangleDownSmall size={12} />
                        ) : (
                          <IconChevronTriangleUpSmall size={12} />
                        )}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visible).map((row) => (
              <tr key={row.source}>
                {row.cells.map((value, index) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: a cell's column is its identity, and columns never move
                    key={index}
                    data-numeric={table.columns[index]?.numeric || undefined}
                  >
                    {formatCell(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {remaining > 0 ? (
        <button
          type="button"
          className="chat-data-more"
          onClick={() => setVisible((count) => count + TABLE_PAGE_ROWS * 5)}
        >
          {t("Show {count} more rows", { count: Math.min(remaining, TABLE_PAGE_ROWS * 5) })}
        </button>
      ) : null}
    </>
  );
}

/** What the caps left out, said plainly under the card. */
export function DroppedNotice({ parts }: { parts: string[] }) {
  if (parts.length === 0) return null;
  return <p className="chat-data-notice">{parts.join(" · ")}</p>;
}

/** One action under a data card, with a short "done" state. */
export function DataAction({
  icon,
  label,
  run,
}: {
  icon: React.ReactNode;
  label: string;
  run: () => Promise<unknown>;
}) {
  const [state, setState] = useState<"idle" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="chat-data-action"
        onClick={() => {
          setError(null);
          void run()
            .then(() => {
              setState("done");
              window.setTimeout(() => setState("idle"), 1600);
            })
            .catch((reason: unknown) => setError(messageFromError(reason)));
        }}
      >
        <span aria-hidden>{state === "done" ? <IconCheckmark1Small size={13} /> : icon}</span>
        {label}
      </button>
      {error ? (
        <span className="chat-data-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function TableCard({ block }: { block: TableChatBlock }) {
  const name = block.title || t("Table");
  const dropped = [
    block.dropped?.rows
      ? t("{count} more rows were left out", { count: block.dropped.rows })
      : null,
    block.dropped?.columns
      ? t("{count} more columns were left out", { count: block.dropped.columns })
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <section className="chat-block chat-data" aria-label={name}>
      {block.title ? <h4 className="chat-block-title">{block.title}</h4> : null}
      <DataTable table={block} label={name} />
      <DroppedNotice parts={dropped} />
      {block.source ? (
        <p className="chat-data-source">{t("Source: {source}", { source: block.source })}</p>
      ) : null}
      <div className="chat-data-actions">
        <DataAction
          icon={<IconClipboard size={13} />}
          label={t("Copy as CSV")}
          run={() => writeText(tableToCsv(block))}
        />
        <DataAction
          icon={<IconClipboard size={13} />}
          label={t("Copy as Markdown")}
          run={() => writeText(tableToMarkdown(block))}
        />
        <DataAction
          icon={<IconFileDownload size={13} />}
          label={t("Save as CSV")}
          run={() => exportChatData(name, "csv", tableToCsv(block))}
        />
      </div>
    </section>
  );
}
