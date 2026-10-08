import { engine } from "../model";
import { displayLanguage } from "../office";
import { mountPane } from "../pane/mount";
import { wordGlobal, wordHost } from "./host";
import { WordPane } from "./WordPane";

void mountPane("Word", (access, office) => {
  const word = wordGlobal();
  return word ? (
    <WordPane
      host={wordHost(word)}
      engine={engine(access.openKey)}
      language={displayLanguage(office)}
    />
  ) : null;
});
