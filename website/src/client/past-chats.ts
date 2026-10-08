/**
 * Memory of past chats in the browser (ADR-0081): the person's other
 * conversations, searched at the moment of use over what this tab decrypted,
 * never summarised and never stored ahead of time.
 *
 * The app reads `agent_messages_fts`; the browser has no index and builds
 * none, so it scores the synchronised messages the way `search.ts` scores
 * notes. The block's words, its limits and the tool's declaration are Rust's
 * (`memory/past_chats.rs`), exported to `agent-lite.json`.
 *
 * Which chats count follows the app: never the chat asking, never a custom
 * assistant's conversation, and a "Project only" project keeps its chats to
 * itself (`projects.ts`).
 */
import { AGENT_LITE } from "./codec";
import { type Chat, listChats, messagesOf } from "./library";
import { chatsInScope } from "./projects";
import { snippetAround } from "./search";
import type { SyncClient } from "./sync";

export interface PastChatSnippet {
  taskId: string;
  title: string;
  role: "user" | "assistant";
  excerpt: string;
  createdAt: string;
}

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** `ask::content_terms` in spirit: words of three characters or more,
 * deduplicated. Any of them may match, as the app's `"a" OR "b"` does. */
export function contentTerms(query: string): string[] {
  return [
    ...new Set(
      fold(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => Array.from(word).length >= 3),
    ),
  ];
}

/**
 * Messages of the person's other general chats that share a term with
 * `query`, best first, one excerpt per message. `scope` is the memory scope
 * of the chat asking: null for the person's own, a folder id for a "Project
 * only" project.
 */
export function searchPastChats(
  sync: SyncClient,
  query: string,
  options: { exclude?: string | null; scope: string | null; limit: number },
): PastChatSnippet[] {
  const terms = contentTerms(query);
  if (!terms.length) return [];
  const allowed = chatsInScope(sync, options.scope);
  const chats: Chat[] = listChats(sync).filter(
    (chat) => !chat.assistant && chat.id !== options.exclude && allowed(chat.id),
  );
  const found: (PastChatSnippet & { score: number })[] = [];
  for (const chat of chats)
    for (const message of messagesOf(sync, chat.id)) {
      const body = fold(message.content);
      const score = terms.reduce((sum, term) => sum + body.split(term).length - 1, 0);
      if (!score) continue;
      const first = terms.find((term) => body.includes(term)) ?? "";
      found.push({
        taskId: chat.id,
        title: chat.title,
        role: message.role,
        excerpt: snippetAround(message.content, first, AGENT_LITE.pastChats.snippetChars),
        createdAt: message.createdAt,
        score,
      });
    }
  return found
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, options.limit)
    .map(({ score: _score, ...snippet }) => snippet);
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** `past_chats::format_block`: the header, then each excerpt under its
 * chat's title and date, every excerpt and the whole list capped. */
export function pastChatsBlock(snippets: PastChatSnippet[]): string {
  const words = AGENT_LITE.pastChats;
  if (!snippets.length) return `${words.header}\n`;
  let block = `${words.header}${words.excerptsIntro}`;
  let budget = words.blockChars;
  for (const snippet of snippets.slice(0, words.turnSnippets)) {
    const line = fill(snippet.role === "assistant" ? words.assistantLine : words.userLine, {
      title: clip(oneLine(snippet.title), words.titleChars),
      date: snippet.createdAt.slice(0, 10),
      excerpt: clip(oneLine(snippet.excerpt), words.snippetChars),
    });
    const cost = Array.from(line).length;
    if (cost > budget) break;
    budget -= cost;
    block += line;
  }
  return block;
}

/** The `search_past_chats` tool's answer, worded as `run_tool` words it. */
export function runPastChatsTool(
  sync: SyncClient,
  query: string,
  exclude: string | null,
  scope: string | null,
): string {
  if (!contentTerms(query).length) return "search_past_chats needs a few keywords.";
  const found = searchPastChats(sync, query, {
    exclude,
    scope,
    limit: AGENT_LITE.pastChats.toolResults,
  });
  if (!found.length) return "Nothing in the user's other conversations matches that.";
  return JSON.stringify(
    found.map((snippet) => ({
      conversation: snippet.title,
      date: snippet.createdAt.slice(0, 10),
      speaker: snippet.role,
      excerpt: clip(oneLine(snippet.excerpt), AGENT_LITE.pastChats.snippetChars * 2),
    })),
  );
}
