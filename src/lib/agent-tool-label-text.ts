import { settledToolLabel, toolActivityLabel } from "./agent-tool-labels";
import { t } from "./i18n";

/**
 * What a person reads for a tool activity.
 *
 * The labels `agent-tool-labels` mints are English on purpose: they are kept
 * on the transcript's tool parts and they are the keys that classify the
 * activity (`toolActivityKind`, `settledToolLabel`). Translating them there
 * would break the classification the moment the language changed. So the
 * keys stay, and this module turns a key into the sentence shown, at render
 * time, with one literal `t()` per label so the catalogs can see them.
 *
 * A label this module does not know is a tool name humanized from the wire,
 * and it is shown as it is.
 */
function labelText(label: string): string | undefined {
  switch (label) {
    case "Running command":
      return t("Running command");
    case "Browsing":
      return t("Browsing");
    case "Searching web":
      return t("Searching web");
    case "Searching":
      return t("Searching");
    case "Searching files":
      return t("Searching files");
    case "Searching images":
      return t("Searching images");
    case "Editing files":
      return t("Editing files");
    case "Reading files":
      return t("Reading files");
    case "Working with images":
      return t("Working with images");
    case "Using GitHub":
      return t("Using GitHub");
    case "Inspecting repository":
      return t("Inspecting repository");
    case "Running tests":
      return t("Running tests");
    case "Building":
      return t("Building");
    case "Checking code":
      return t("Checking code");
    case "Ran command":
      return t("Ran command");
    case "Browsed":
      return t("Browsed");
    case "Searched the web":
      return t("Searched the web");
    case "Searched":
      return t("Searched");
    case "Searched files":
      return t("Searched files");
    case "Searched images":
      return t("Searched images");
    case "Edited files":
      return t("Edited files");
    case "Read files":
      return t("Read files");
    case "Worked with images":
      return t("Worked with images");
    case "Used GitHub":
      return t("Used GitHub");
    case "Inspected the repository":
      return t("Inspected the repository");
    case "Ran tests":
      return t("Ran tests");
    case "Built":
      return t("Built");
    case "Checked code":
      return t("Checked code");
    case "Tool":
      return t("Tool");
    default:
      return undefined;
  }
}

/** A key shown in the reader's language, or as it is when it is a wire name. */
export function toolLabelText(label: string): string {
  return labelText(label) ?? label;
}

/** The tool row's name: the activity while it runs, its past once it is over. */
export function toolRowLabel(label: string, running: boolean): string {
  return toolLabelText(running ? label : settledToolLabel(label));
}

/** The activity of a tool the runtime names, for a status line or a drawer row. */
export function toolActivityText(toolName: string | undefined, payload?: unknown): string {
  return toolLabelText(toolActivityLabel(toolName, payload));
}

/** The status sentence for a tool event. */
export function toolActivitySentenceText(toolName: string | undefined, payload?: unknown): string {
  const label = toolActivityLabel(toolName, payload);
  return label === "Tool" ? t("Using a tool.") : `${toolLabelText(label)}.`;
}
