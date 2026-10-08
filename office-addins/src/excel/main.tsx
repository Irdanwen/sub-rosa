import { engine } from "../model";
import { displayLanguage } from "../office";
import { mountPane } from "../pane/mount";
import { ExcelPane } from "./ExcelPane";
import { excelGlobal, excelHost } from "./host";

void mountPane("Excel", (access, office) => {
  const excel = excelGlobal();
  return excel ? (
    <ExcelPane
      host={excelHost(excel)}
      engine={engine(access.openKey)}
      language={displayLanguage(office)}
    />
  ) : null;
});
