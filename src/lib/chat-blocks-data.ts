// The chart and table parser is shared with the web client
// (`@subrosa/chat-core/chat-blocks-data`); the app gives it its own words.
import {
  type ChartChatBlock,
  type DataBlockWords,
  parseChartBlock as parseChartWith,
} from "@subrosa/chat-core/chat-blocks-data";
import { t } from "./i18n";

export * from "@subrosa/chat-core/chat-blocks-data";

const APP_WORDS: DataBlockWords = {
  series: (number) => t("Series {number}", { number }),
  other: () => t("Other"),
};

export function parseChartBlock(payload: Record<string, unknown>): ChartChatBlock | null {
  return parseChartWith(payload, APP_WORDS);
}
