/**
 * What a chat adds to agent-lite's turn in the browser (`TurnExtension`):
 *
 * - a custom assistant's conversation runs on its snapshot alone: its prompt,
 *   its permitted tools, its references, and no project, personalization or
 *   past chats (ADR-0058, ADR-0081);
 * - a general chat gets the past-chats block and tool while that setting is on
 *   (ADR-0081), its project's section, file search and memory scope when it is
 *   filed in one (ADR-0085), and how to draw charts and tables (ADR-0086);
 * - either gets this turn's attachments folded into its last question.
 */
import { memoryBlock, systemPrompt, type TurnExtension } from "./agent";
import {
  type AssistantSnapshot,
  assistantPrompt,
  assistantTools,
  searchReferences,
} from "./assistants";
import { type Attachment, attachToLastUserMessage } from "./attachments";
import { AGENT_LITE } from "./codec";
import type { Message } from "./library";
import { memoriesInScope } from "./memories";
import { pastChatsBlock, runPastChatsTool, searchPastChats } from "./past-chats";
import { memoryScopeOf, type Project, projectSection, searchProjectFiles } from "./projects";
import type { SyncClient } from "./sync";

export interface PlanInput {
  sync: SyncClient;
  /** The chat asking, or null for a temporary chat. */
  chatId: string | null;
  history: Message[];
  memory: boolean;
  /** "Reference past chats" (memory settings, on by default). */
  pastChats: boolean;
  project: Project | null;
  assistant: AssistantSnapshot | null;
  attachments: Attachment[];
}

export function planTurn(input: PlanInput): TurnExtension {
  const prepare = input.attachments.length
    ? (messages: Parameters<NonNullable<TurnExtension["prepare"]>>[0]) =>
        attachToLastUserMessage(messages, input.attachments)
    : undefined;
  const assistant = input.assistant;
  if (assistant)
    return {
      memoryScope: null,
      systemPrompt: () =>
        assistantPrompt(
          assistant,
          input.memory && assistant.definition.allow_memory
            ? memoryBlock(
                memoriesInScope(input.sync, null).slice(0, AGENT_LITE.injectedMemoryLimit),
              )
            : null,
        ),
      tools: (offered) => assistantTools(assistant, offered, input.memory),
      run: (name, args) =>
        name === "search_references"
          ? searchReferences(assistant, String(args.query ?? ""))
          : undefined,
      prepare,
    };

  const project = input.project;
  const scope = memoryScopeOf(project);
  const pastChatsOn = input.memory && input.pastChats && input.chatId !== null;
  const question = [...input.history].reverse().find((message) => message.role === "user");
  return {
    memoryScope: scope,
    systemPrompt: ({ personalization, memory }) => {
      const pastChats = pastChatsOn
        ? pastChatsBlock(
            searchPastChats(input.sync, question?.content ?? "", {
              exclude: input.chatId,
              scope,
              limit: AGENT_LITE.pastChats.turnSnippets,
            }),
          )
        : null;
      return systemPrompt(personalization, memory, {
        pastChats,
        sections: [project ? projectSection(project) : "", AGENT_LITE.cardsPrompt],
      });
    },
    tools: (offered) => [
      ...offered,
      ...(pastChatsOn ? [AGENT_LITE.pastChats.tool] : []),
      ...(project?.files.length ? [AGENT_LITE.project.tool] : []),
    ],
    run: (name, args) => {
      const query = String(args.query ?? "");
      if (name === "search_past_chats" && pastChatsOn)
        return runPastChatsTool(input.sync, query, input.chatId, scope);
      if (name === "search_project_files" && project) return searchProjectFiles(project, query);
      return undefined;
    },
    prepare,
  };
}
