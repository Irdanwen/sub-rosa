import { t } from "../../lib/i18n";

/** The words a person reads for each folder of the Files panel, by its id
 * (ADR-0140): the native side's label is only a fallback. */
export function filesystemRootWords(root: { id: string; label: string; description: string }) {
  switch (root.id) {
    case "workspace":
      return {
        label: t("Workspace"),
        description: t("Files of sandboxed sessions and what they produce."),
      };
    case "workspace-unrestricted":
      return {
        label: t("Unrestricted workspace"),
        description: t("Files of unrestricted sessions, and the files you attach."),
      };
    case "memory":
      return { label: t("Memory"), description: t("The assistant's memory files.") };
    default:
      return { label: root.label, description: root.description };
  }
}
