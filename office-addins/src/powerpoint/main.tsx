import { engine } from "../model";
import { supports } from "../office";
import { mountPane } from "../pane/mount";
import { powerPointGlobal, powerPointHost } from "./host";
import { PowerPointPane } from "./PowerPointPane";

void mountPane("PowerPoint", (access, office) => {
  const powerPoint = powerPointGlobal();
  return powerPoint ? (
    <PowerPointPane
      host={powerPointHost(powerPoint, supports(office, "PowerPointApi", "1.5"))}
      engine={engine(access.openKey)}
      canInsert={supports(office, "PowerPointApi", "1.2")}
    />
  ) : null;
});
