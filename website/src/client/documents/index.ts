/** The web client's Word, Excel and PowerPoint files (ADR-0090). */
import { t } from "../../lib/i18n";
import { registerTables } from "../codec";
import type { WebFeature } from "../feature";
import { makeDocument } from "./documents";
import { FileCard, FilesPanel } from "./ui";
import { DOCUMENTS } from "./writers/exported";

// The Studio lane's two tables: a document filed here is a gallery file.
registerTables(DOCUMENTS.tables);

export const documentsFeature: WebFeature = {
  id: "documents",
  label: () => t("Files", "Fichiers"),
  Panel: FilesPanel,
  blocks: { file: FileCard },
  turn: (host) => ({
    tools: [DOCUMENTS.tool],
    run: (name, args, turn) =>
      name === DOCUMENTS.tool.function.name
        ? makeDocument(host, args, turn)
        : Promise.resolve(undefined),
  }),
};
