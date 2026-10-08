/**
 * The web client's finances (ADR-0099): the synchronised transactions, read
 * only, in a panel and through the two tools the app's chat offers. Nothing
 * here imports or files a statement; that stays on the device that holds it.
 */
import { t } from "../../lib/i18n";
import { registerTables } from "../codec";
import type { ToolDefinition } from "../codec";
import type { WebFeature } from "../feature";
import { runTool, SEARCH_TOOL, SPENDING_TOOL, transactions } from "./data";
import { FinancePanel } from "./FinancePanel";
import { FINANCE } from "./summary";

registerTables(FINANCE.tables);

export const financeFeature: WebFeature = {
  id: "finance",
  label: () => t("Finances", "Finances"),
  Panel: FinancePanel,
  // Offered when there is something to read, never in a temporary chat.
  turn(host, turn) {
    if (turn.temporary) return null;
    if (transactions(host.sync).length === 0) return null;
    return {
      tools: FINANCE.tools as ToolDefinition[],
      async run(name, args) {
        if (name !== SPENDING_TOOL && name !== SEARCH_TOOL) return undefined;
        turn.onStatus?.("reading-finances");
        return runTool(transactions(host.sync), name, args);
      },
    };
  },
};
