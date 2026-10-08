/**
 * The web client's chat brain: agent-lite's loop, in the browser.
 *
 * The same system prompt (generated from Rust, `codec.ts`), the same tool
 * declarations, the same research budget and the same answer pass when the
 * budget is spent. What differs is only where each tool runs: notes and
 * memories are the decrypted synchronised objects in this tab, web search and
 * page reading are Carpe Diem's augment routes, and every write is a sync
 * write through `SyncClient`.
 */
import { AGENT_LITE, type ToolDefinition } from "./codec";
import {
  type ChatMessage,
  type Completion,
  fetchPage,
  type Operator,
  streamCompletion,
  webSearch,
} from "./carpe-diem";
import type { TurnAddition, TurnInfo } from "./feature";
import { appendToNote, createNote, listNotes, type Memory, type Message } from "./library";
import { addMemory, memoriesInScope } from "./memories";
import { searchMemories, searchNotes } from "./search";
import type { SyncClient } from "./sync";

/** What a browser cannot run, said to the model once so it does not promise
 * them. Web-only prose: the shared prompt above it is untouched. */
export const BROWSER_SECTION =
  "This conversation runs in the user's web browser. Only the tools you were given work here: the calendar, places, imports and long-form summaries are in the Sub Rosa app. If the user asks for one of those, say it is available in the app.";

export interface Personalization {
  enabled: boolean;
  aboutYou: string;
  responseStyle: string;
  personality: string;
}
export const DEFAULT_PERSONALIZATION: Personalization = {
  enabled: true,
  aboutYou: "",
  responseStyle: "",
  personality: "default",
};

/** `personalization::render_block`, from the exported words. */
export function personalizationBlock(settings: Personalization): string | null {
  if (!settings.enabled) return null;
  const words = AGENT_LITE.personalization;
  const clean = (value: string) => Array.from(value.trim()).slice(0, words.maxFieldChars).join("");
  const about = clean(settings.aboutYou);
  const style = clean(settings.responseStyle);
  const personality = words.personalities[settings.personality];
  if (!about && !style && !personality) return null;
  let block = words.header;
  if (about) block += `${words.about}${about}\n`;
  if (style) block += `${words.style}${style}\n`;
  if (personality) block += `${words.personality}${personality}\n`;
  return block;
}

/** `memory::format_memory_block`. */
export function memoryBlock(memories: Memory[]): string | null {
  if (!memories.length) return null;
  return `${AGENT_LITE.memoryBlockHeader}${memories.map((memory) => `- ${memory.text}\n`).join("")}`;
}

/** The system prompt: agent-lite's, then the blocks joined the way
 * `personalization::default_chat_context` joins them (personalization,
 * memory, past chats), then the sections after them: a project's, as
 * `agent_lite::project::with_section` adds it, the cards, a feature's words
 * (a mode, the skills) and protected mode's, the way the phone appends them
 * after the prompt is chosen. Then the browser's note. */
export function systemPrompt(
  personalization: string | null,
  memory: string | null,
  more: { pastChats?: string | null; sections?: (string | null | undefined)[] } = {},
): string {
  const blocks = [personalization, memory, more.pastChats ?? null]
    .map((block) => block?.trimEnd() ?? "")
    .filter(Boolean);
  const context = blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
  const sections = (more.sections ?? [])
    .map((section) => section?.trim() ?? "")
    .filter(Boolean)
    .map((section) => `\n\n${section}`);
  return `${AGENT_LITE.systemPrompt}${context}${sections.join("")}\n\n${BROWSER_SECTION}`;
}

/** The pieces a turn's system prompt is written from. */
export interface PromptBlocks {
  personalization: string | null;
  memory: string | null;
  /** The features' words for this turn (`TurnAddition.prompt`). */
  features: string[];
  /** Protected mode's instruction, which rides every prompt. */
  guards: string[];
}

/**
 * What a chat adds to a turn beyond agent-lite's defaults (`turn-plan.ts`):
 * its own prompt (a custom assistant's, a project's, past chats) and the
 * memory scope it reads and writes, and, as one more `TurnAddition` beside
 * the features', its tools and their answers (a custom assistant's narrowed
 * to what it permits) and this turn's attachments. A turn without one is the
 * plain default chat.
 */
export interface ChatPlan extends TurnAddition {
  /** null for the person's own memory, a project's folder id otherwise. */
  memoryScope: string | null;
  /** The whole system prompt, in place of the default one. */
  systemPrompt?(blocks: PromptBlocks): string;
}

export interface TurnContext {
  sync: SyncClient;
  operator: Operator;
  key: string;
  model: string;
  effort?: string;
  /** Memory switched on: the block rides along and remember/search exist. */
  memory: boolean;
  personalization: Personalization;
  /** A temporary chat writes nothing to the account, tools included. */
  temporary: boolean;
  signal?: AbortSignal;
  onText: (fragment: string) => void;
  onStatus?: (stage: string, detail?: string) => void;
  /** The chat's own shape of the turn: prompt, memory scope, tools. */
  plan?: ChatPlan;
  /** The chat the turn belongs to (null when temporary), for the features. */
  chatId?: string | null;
  /** What the web client's features add to this turn (`feature.ts`). */
  additions?: TurnAddition[];
  /** Offers only the tools this answers yes to. */
  allowTool?: (name: string) => boolean;
  /** Joined to the system prompt after the features' words (protected mode). */
  promptBlocks?: (string | null)[];
  /** The person's last message; read from the history when absent. */
  question?: string;
}
export interface TurnResult {
  answer: string;
  /** The memories this turn was given, for the sources chip. */
  memories: Memory[];
  /** Notes the turn wrote, so the page can say so. */
  notesWritten: string[];
}

const WRITE_TOOLS = ["create_note", "append_to_note", "remember"];

export function offeredTools(memory: boolean, temporary: boolean): ToolDefinition[] {
  return AGENT_LITE.tools.filter((tool) => {
    const name = tool.function.name;
    if (!memory && (name === "remember" || name === "search_memories")) return false;
    if (temporary && WRITE_TOOLS.includes(name)) return false;
    return true;
  });
}

/** The memories a turn carries: the most important of its scope, up to the
 * app's limit. */
export function memoriesForTurn(
  sync: SyncClient,
  enabled: boolean,
  scope: string | null = null,
): Memory[] {
  return enabled ? memoriesInScope(sync, scope).slice(0, AGENT_LITE.injectedMemoryLimit) : [];
}

function argument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** One tool call, answered as agent-lite answers it. Failures are text for
 * the model, never an exception that ends the turn. */
export async function executeTool(
  context: TurnContext,
  name: string,
  args: Record<string, unknown>,
  written: string[],
): Promise<string> {
  const { sync, operator, key, signal } = context;
  const query = argument(args, "query") ?? "";
  try {
    switch (name) {
      case "search_notes": {
        context.onStatus?.("searching-notes", query);
        const found = searchNotes(listNotes(sync), query, 6);
        return found.length
          ? JSON.stringify(found)
          : "No matching notes or transcripts were found.";
      }
      case "list_recent_notes": {
        context.onStatus?.("reading-note");
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
        const notes = listNotes(sync).slice(0, limit);
        return notes.length
          ? JSON.stringify(
              notes.map((note) => ({
                noteId: note.id,
                title: note.title,
                preview: truncate(note.body.replace(/\s+/g, " ").trim(), 160),
                createdAt: note.createdAt,
              })),
            )
          : "There are no notes yet.";
      }
      case "read_note": {
        const id = argument(args, "note_id");
        if (!id) return "read_note needs a note_id from search_notes or list_recent_notes.";
        context.onStatus?.("reading-note");
        const note = listNotes(sync).find((item) => item.id === id);
        if (!note) return "That note was not found.";
        return truncate(
          JSON.stringify({
            noteId: note.id,
            title: note.title,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            note: note.body,
          }),
          24_000,
        );
      }
      case "search_memories": {
        context.onStatus?.("searching-memory", query);
        if (!context.memory) return "Memory is disabled in the user's settings.";
        const scope = context.plan?.memoryScope ?? null;
        const found = searchMemories(memoriesInScope(sync, scope), query, 8);
        return found.length
          ? JSON.stringify(
              found.map((memory) => ({
                text: memory.text,
                importance: memory.importance,
                createdAt: memory.createdAt,
              })),
            )
          : "No stored memories match that query.";
      }
      case "web_search": {
        context.onStatus?.("searching-web", query);
        const results = await webSearch(
          operator,
          key,
          query,
          AGENT_LITE.limits.webSearchResults,
          signal,
        );
        if (!results.length) return "The web search found nothing.";
        return JSON.stringify(
          results.map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.snippet
              ? truncate(result.snippet.replace(/\s+/g, " "), 600)
              : undefined,
            publishedAt: result.date,
          })),
        );
      }
      case "fetch_page": {
        const url = argument(args, "url");
        if (!url) return "fetch_page needs a url from a web_search result.";
        context.onStatus?.("reading-page", url);
        const content = await fetchPage(operator, key, url, signal);
        return content.trim()
          ? truncate(content, AGENT_LITE.limits.webPageChars)
          : "That page returned no readable text.";
      }
      case "create_note": {
        const content = argument(args, "content");
        if (!content) return "create_note needs content.";
        if (context.temporary) return "A temporary chat writes nothing to the user's notes.";
        context.onStatus?.("writing-note", argument(args, "title"));
        const note = await createNote(sync, argument(args, "title") ?? "", content);
        written.push(note.id);
        return `Created note "${note.title}" (noteId ${note.id}).`;
      }
      case "append_to_note": {
        const id = argument(args, "note_id");
        const content = argument(args, "content");
        if (!id || !content) return "append_to_note needs a note_id and content.";
        if (context.temporary) return "A temporary chat writes nothing to the user's notes.";
        context.onStatus?.("writing-note");
        const note = listNotes(sync).find((item) => item.id === id);
        if (!note || (await appendToNote(sync, id, content)) === null)
          return "Updating the note failed: that note was not found.";
        written.push(id);
        return `Appended to "${note.title}".`;
      }
      case "remember": {
        const fact = argument(args, "text");
        if (!fact) return "remember needs the fact to store.";
        if (!context.memory) return "Memory is disabled in the user's settings.";
        if (context.temporary) return "A temporary chat remembers nothing.";
        context.onStatus?.("remembering", fact);
        return (await addMemory(sync, fact, context.plan?.memoryScope ?? null)) === "known"
          ? "That fact is already remembered."
          : `Remembered: ${fact}`;
      }
      default: {
        const turn = turnInfo(context);
        for (const addition of turnAdditions(context)) {
          const answer = await addition.run?.(name, args, turn);
          if (answer !== undefined) return answer;
        }
        return `The tool ${name} is not available in the browser.`;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : "unknown error";
    return `${name} failed: ${reason}`;
  }
}

function turnInfo(context: TurnContext): TurnInfo {
  // `runTurn` fills `question` from the history before any tool runs.
  return {
    chatId: context.chatId ?? null,
    temporary: context.temporary,
    question: context.question ?? "",
    signal: context.signal,
    onStatus: context.onStatus,
  };
}

/** What adds to the turn, in the order its tools are offered and answered:
 * the chat's plan, then each feature. */
function turnAdditions(context: TurnContext): TurnAddition[] {
  return [...(context.plan ? [context.plan] : []), ...(context.additions ?? [])];
}

/** The turn's one tool registry: agent-lite's own, then the chat plan's
 * (past chats, a project's files, an assistant's references), then each
 * feature's, a name offered once, narrowed by every addition that narrows
 * (a custom assistant's permitted tools, a skill pack) and by `allowTool`. */
export function turnTools(context: TurnContext): ToolDefinition[] {
  const seen = new Set<string>();
  const tools: ToolDefinition[] = [];
  const additions = turnAdditions(context);
  const narrowed = additions
    .map((addition) => addition.narrow ?? [])
    .filter((names) => names.length > 0);
  const offered = [
    ...offeredTools(context.memory, context.temporary),
    ...additions.flatMap((addition) => addition.tools),
  ];
  for (const tool of offered) {
    const name = tool.function.name;
    if (seen.has(name) || (context.allowTool && !context.allowTool(name))) continue;
    if (narrowed.some((names) => !names.includes(name))) continue;
    seen.add(name);
    tools.push(tool);
  }
  return tools;
}

/**
 * Runs one turn over `history` (the chat's messages, ending on the question)
 * and returns the answer. The loop and its budget are agent-lite's: tools
 * while rounds remain, then an answer pass with the tools declared but
 * refused, then one without declarations.
 */
export async function runTurn(given: TurnContext, history: Message[]): Promise<TurnResult> {
  const context: TurnContext = {
    ...given,
    question:
      given.question ?? [...history].reverse().find((message) => message.role === "user")?.content,
  };
  const plan = context.plan;
  const memories = memoriesForTurn(context.sync, context.memory, plan?.memoryScope ?? null);
  const blocks: PromptBlocks = {
    personalization: personalizationBlock(context.personalization),
    memory: memoryBlock(memories),
    features: (context.additions ?? []).flatMap((addition) =>
      addition.prompt ? [addition.prompt] : [],
    ),
    guards: (context.promptBlocks ?? []).filter((block): block is string => !!block),
  };
  const prompt =
    plan?.systemPrompt?.(blocks) ??
    systemPrompt(blocks.personalization, blocks.memory, {
      sections: [plan?.prompt, ...blocks.features, ...blocks.guards],
    });
  let messages: ChatMessage[] = [
    { role: "system", content: prompt },
    ...history.map((message) => ({ role: message.role, content: message.content }) as ChatMessage),
  ];
  for (const addition of turnAdditions(context))
    if (addition.messages) messages = addition.messages(messages);
  const tools = turnTools(context);
  const written: string[] = [];
  let rounds = 0;
  let answerTries = 0;
  for (let completion = 0; completion < AGENT_LITE.limits.maxToolRounds * 2 + 4; completion++) {
    const research = rounds < AGENT_LITE.limits.maxToolRounds;
    if (!research) {
      answerTries++;
      if (answerTries > 2) break;
      if (answerTries === 1) messages.push({ role: "user", content: AGENT_LITE.finalAnswerNudge });
    }
    const body: Record<string, unknown> = { model: context.model, messages };
    if (context.effort) body.reasoning_effort = context.effort;
    if (research || answerTries === 1) {
      body.tools = tools;
      if (!research) body.tool_choice = "none";
    }
    context.onStatus?.("thinking");
    const reply: Completion = await streamCompletion(
      context.operator,
      context.key,
      body,
      context.onText,
      context.signal,
    );
    if (!reply.toolCalls.length || !research) {
      if (reply.content.trim()) {
        let answer = reply.content;
        for (const addition of turnAdditions(context))
          if (addition.seal) answer = addition.seal(answer);
        return { answer, memories, notesWritten: written };
      }
      if (research) break;
      continue;
    }
    messages.push({
      role: "assistant",
      content: reply.content || null,
      tool_calls: reply.toolCalls,
    });
    for (const call of reply.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // A call whose arguments do not parse is answered as missing them.
      }
      const result = await executeTool(context, call.function.name, args, written);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    rounds++;
  }
  throw new Error("No reply: the model returned nothing to show.");
}
