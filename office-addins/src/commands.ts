// The function file the manifests name: the ribbon button opens the pane
// declaratively, so this only tells Office the page is ready.
import { officeGlobal } from "./office";

void officeGlobal()?.onReady();
