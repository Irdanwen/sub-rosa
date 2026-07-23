import { IMAGE_GENERATION_ENABLED } from "./feature-flags";

export type BuiltinComposerSlashCommandName = "model" | "file" | "image" | "goal";

export type BuiltinComposerSlashCommandDef = {
  name: BuiltinComposerSlashCommandName;
  label: string;
  description: string;
  insertText: string;
};

export type ParsedBuiltinComposerSlashCommand = {
  name: BuiltinComposerSlashCommandName;
  argument: string;
};

export type SlashFileArgumentsResult =
  | { status: "ok"; paths: string[] }
  | { status: "error"; message: string };

export type ComposerSlashModelOption = {
  id: string;
  name: string;
};

export type SlashModelResolution =
  | { status: "resolved"; model: ComposerSlashModelOption }
  | { status: "missing"; query: string }
  | { status: "ambiguous"; query: string; matches: ComposerSlashModelOption[] };

const BASE_BUILTIN_COMPOSER_SLASH_COMMANDS: BuiltinComposerSlashCommandDef[] = [
  {
    name: "model",
    label: "Model",
    description: "Change the text model.",
    insertText: "/model ",
  },
  {
    name: "file",
    label: "File",
    description: "Attach files to this message.",
    insertText: "/file ",
  },
  {
    name: "goal",
    label: "Goal",
    description: "Work autonomously until a goal is done.",
    insertText: "/goal ",
  },
];

export const BUILTIN_COMPOSER_SLASH_COMMANDS: BuiltinComposerSlashCommandDef[] =
  IMAGE_GENERATION_ENABLED
    ? [
        ...BASE_BUILTIN_COMPOSER_SLASH_COMMANDS,
        {
          name: "image",
          label: "Image",
          description: "Generate an image from a prompt.",
          insertText: "/image ",
        },
      ]
    : BASE_BUILTIN_COMPOSER_SLASH_COMMANDS;

export function parseBuiltinComposerSlashCommand(
  input: string,
): ParsedBuiltinComposerSlashCommand | null {
  const text = input.trim();
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!isBuiltinComposerSlashCommandName(name)) return null;
  return {
    name,
    argument: match[2]?.trim() ?? "",
  };
}

export function matchBuiltinComposerSlashCommands(query: string) {
  const normalized = normalizeSlashCommandQuery(query);
  return BUILTIN_COMPOSER_SLASH_COMMANDS.filter((command) => {
    if (!normalized) return true;
    return (
      normalizeSlashCommandQuery(command.name).startsWith(normalized) ||
      normalizeSlashCommandQuery(command.label).startsWith(normalized)
    );
  });
}

export function isBuiltinComposerSlashCommand(input: string) {
  return Boolean(parseBuiltinComposerSlashCommand(input));
}

/** What a `/goal` invocation asks for. Control verbs mirror the runtime's
 * `/goal` subcommands (`hermes_cli/goals.py`); anything else is the goal text.
 * `stop` and `done` are accepted as aliases of `clear`, matching the runtime. */
export type SlashGoalRequest =
  | { kind: "status" | "pause" | "resume" | "clear" }
  | { kind: "set"; goal: string };

export function parseSlashGoalArgument(argument: string): SlashGoalRequest {
  const text = argument.trim();
  const verb = text.toLowerCase();
  if (!text || verb === "status") return { kind: "status" };
  if (verb === "pause") return { kind: "pause" };
  if (verb === "resume") return { kind: "resume" };
  if (verb === "clear" || verb === "stop" || verb === "done") return { kind: "clear" };
  return { kind: "set", goal: text };
}

/** The gateway's `command.dispatch {name: "goal"}` result. `exec` carries the
 * control-verb output; `send` carries the set-goal notice plus the kickoff
 * message the caller submits as a normal user turn. */
export type HermesGoalDispatchResponse = {
  type?: string;
  output?: string;
  notice?: string;
  message?: string;
};

/** One-line composer notice for a goal dispatch result. The runtime's texts
 * are multi-line (verdict + controls reminder); the composer notice slot is a
 * single line, so keep the first line only. */
export function goalDispatchNoticeText(response: HermesGoalDispatchResponse): string {
  const text = (response.output ?? response.notice ?? "").trim();
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine || "Goal updated.";
}

export function parseSlashFileArguments(argument: string): SlashFileArgumentsResult {
  const paths: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const text = argument.trim();

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next && shouldEscapeFileArgumentChar(next)) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        paths.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    return {
      status: "error",
      message: "Could not parse /file paths. Close the quote and try again.",
    };
  }
  if (current) paths.push(current);
  return { status: "ok", paths };
}

export function resolveSlashModel(
  query: string,
  models: ComposerSlashModelOption[],
): SlashModelResolution {
  const normalizedQuery = normalizeModelQuery(query);
  const rawQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return { status: "missing", query };

  const ranked = models
    .map((model) => ({
      model,
      score: modelMatchScore(model, normalizedQuery, rawQuery),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.model.name.localeCompare(b.model.name) ||
        a.model.id.localeCompare(b.model.id),
    );
  const best = ranked[0];
  if (!best) return { status: "missing", query };
  const matches = ranked.filter((item) => item.score === best.score);
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      query,
      matches: matches.slice(0, 4).map((item) => item.model),
    };
  }
  return { status: "resolved", model: best.model };
}

export function slashModelResolutionError(
  resolution: Exclude<SlashModelResolution, { status: "resolved" }>,
) {
  if (resolution.status === "ambiguous") {
    const names = resolution.matches.map((model) => model.name).join(", ");
    return `Model "${resolution.query}" matches ${names}. Type a longer name.`;
  }
  return `Could not find model "${resolution.query}".`;
}

function isBuiltinComposerSlashCommandName(name: string): name is BuiltinComposerSlashCommandName {
  return name === "model" || name === "file" || name === "image" || name === "goal";
}

function normalizeSlashCommandQuery(value: string) {
  return value.trim().toLowerCase();
}

function shouldEscapeFileArgumentChar(char: string) {
  return char === "\\" || char === '"' || char === "'" || /\s/.test(char);
}

function normalizeModelQuery(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function modelMatchScore(
  model: ComposerSlashModelOption,
  normalizedQuery: string,
  rawQuery: string,
) {
  const idRaw = model.id.trim().toLowerCase();
  const nameRaw = model.name.trim().toLowerCase();
  const id = normalizeModelQuery(model.id);
  const name = normalizeModelQuery(model.name);

  if (idRaw === rawQuery) return 100;
  if (nameRaw === rawQuery) return 95;
  if (id === normalizedQuery) return 90;
  if (name === normalizedQuery) return 85;
  if (name.startsWith(normalizedQuery)) return 80;
  if (id.endsWith(normalizedQuery)) return 75;
  if (id.startsWith(normalizedQuery)) return 70;
  if (name.includes(normalizedQuery)) return 65;
  if (id.includes(normalizedQuery)) return 60;
  return 0;
}
