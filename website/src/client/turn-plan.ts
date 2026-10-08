/**
 * What a chat adds to agent-lite's turn in the browser (`ChatPlan`):
 *
 * - a custom assistant's conversation runs on its snapshot alone: its prompt,
 *   its permitted tools (every other one, a feature's included, narrowed
 *   out), its references, and no project, personalization or past chats
 *   (ADR-0058, ADR-0081); protected mode's instruction still rides it;
 * - a general chat gets the past-chats block and tool while that setting is on
 *   (ADR-0081), its project's section, file search and memory scope when it is
 *   filed in one (ADR-0085), and how to draw charts and tables (ADR-0086);
 * - either gets this turn's attachments folded into its last question.
 */
import { type ChatPlan, memoryBlock, systemPrompt } from "./agent";
import {
  type AssistantSnapshot,
  assistantAllows,
  assistantPrompt,
  searchReferences,
} from "./assistants";
import { type Attachment, attachmentsAddition } from "./attachments";
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

export function planTurn(input: PlanInput): ChatPlan {
  const { messages } = attachmentsAddition(input.attachments);
  const assistant = input.assistant;
  if (assistant) {
    const references = AGENT_LITE.assistant.searchReferences;
    return {
      memoryScope: null,
      systemPrompt: ({ guards }) =>
        [
          assistantPrompt(
            assistant,
            input.memory && assistant.definition.allow_memory
              ? memoryBlock(
                  memoriesInScope(input.sync, null).slice(0, AGENT_LITE.injectedMemoryLimit),
                )
              : null,
          ),
          ...guards,
        ].join("\n\n"),
      tools: [references],
      narrow: [
        ...AGENT_LITE.tools
          .map((tool) => tool.function.name)
          .filter((name) => assistantAllows(assistant.definition, name, input.memory)),
        references.function.name,
      ],
      run: (name, args) =>
        name === references.function.name
          ? searchReferences(assistant, String(args.query ?? ""))
          : undefined,
      messages,
    };
  }

  const project = input.project;
  const scope = memoryScopeOf(project);
  const pastChatsOn = input.memory && input.pastChats && input.chatId !== null;
  const question = [...input.history].reverse().find((message) => message.role === "user");
  return {
    memoryScope: scope,
    systemPrompt: ({ personalization, memory, features, guards }) => {
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
        sections: [
          project ? projectSection(project) : "",
          AGENT_LITE.cardsPrompt,
          ...features,
          ...guards,
        ],
      });
    },
    tools: [
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
    messages,
  };
}
