// Studio: the creative workspace (image, video, music, workflows) on top of
// the Carpe Diem media surface. Model availability, generation constraints,
// and prices all come from the merged catalog — nothing here hardcodes what
// a backend can do today.

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ChainShot } from "../../lib/studio/chain";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { AssembleStudio } from "./AssembleStudio";
import { BibleStudio } from "./BibleStudio";
import { AudioStudio } from "./AudioStudio";
import { ImageStudio } from "./ImageStudio";
import { VideoStudio } from "./VideoStudio";
import { useMediaCatalog } from "./useMediaCatalog";

// The workflow canvas pulls in @xyflow/react; only the Workflows tab pays
// for it.
const WorkflowStudio = lazy(() =>
  import("./WorkflowStudio").then((module) => ({ default: module.WorkflowStudio })),
);

type StudioTab = "image" | "video" | "audio" | "bible" | "assemble" | "workflows";

const TAB_STORAGE_KEY = "os-june:studio-tab";

function initialTab(): StudioTab {
  try {
    const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
    // "music" is the tab's pre-audio name; saved values must keep resolving.
    if (saved === "music") return "audio";
    // "films" was the remote studio, which is gone. Somebody who was last on
    // that tab lands where film production actually happens now, rather than
    // on a blank panel or, worse, silently back on Image.
    if (saved === "films") return "workflows";
    if (
      saved === "image" ||
      saved === "video" ||
      saved === "audio" ||
      saved === "assemble" ||
      saved === "bible" ||
      saved === "workflows"
    ) {
      return saved;
    }
  } catch {
    // Fall through to the default.
  }
  return "image";
}

export function StudioView() {
  const [tab, setTab] = useState<StudioTab>(initialTab);
  const { catalog, error, loading, retry } = useMediaCatalog();
  // A shot chain on its way to the Assemble tab: the video studio hands over
  // the cut list, the tab switches, and Assemble loads it once.
  const [pendingCuts, setPendingCuts] = useState<ChainShot[] | undefined>(undefined);
  const assembleChain = useCallback((cuts: ChainShot[]) => {
    setPendingCuts(cuts);
    setTab("assemble");
  }, []);
  const clearPendingCuts = useCallback(() => setPendingCuts(undefined), []);

  /**
   * The hand-over from naming a cast to making a film with it.
   *
   * The two live on different tabs, and nothing joined them: somebody who had
   * just built a bible had no way of knowing that the next step is a note and
   * a button three tabs away. Same shape as the chain hand-over above - a
   * request the receiving tab consumes once.
   */
  const [scriptRequested, setScriptRequested] = useState(false);
  const requestScript = useCallback(() => {
    setScriptRequested(true);
    setTab("workflows");
  }, []);
  const clearScriptRequest = useCallback(() => setScriptRequested(false), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // Tab memory is a nicety, not state.
    }
  }, [tab]);

  return (
    <div className="studio-view">
      <header className="studio-header">
        <div className="studio-header-copy">
          <h1>Studio</h1>
          <p className="studio-subtitle">
            Generate images, videos, and audio, or chain them into workflows.
          </p>
        </div>
        <SegmentedControl
          value={tab}
          onValueChange={setTab}
          aria-label="Studio section"
          options={[
            { value: "image", label: "Image" },
            { value: "video", label: "Video" },
            { value: "audio", label: "Audio" },
            { value: "assemble", label: "Assemble" },
            { value: "bible", label: "Bible" },
            { value: "workflows", label: "Workflows" },
          ]}
        />
      </header>
      {loading ? (
        <div className="studio-loading">
          <Spinner aria-label="Loading models" />
        </div>
      ) : error || !catalog ? (
        <EmptyState
          title="Couldn't load the model catalog"
          description={error ?? "The media backend didn't answer."}
          action={
            <button type="button" className="btn btn-secondary" onClick={retry}>
              Try again
            </button>
          }
        />
      ) : tab === "image" ? (
        <ImageStudio catalog={catalog} />
      ) : tab === "video" ? (
        <VideoStudio catalog={catalog} onAssembleChain={assembleChain} />
      ) : tab === "audio" ? (
        <AudioStudio catalog={catalog} />
      ) : tab === "bible" ? (
        <BibleStudio catalog={catalog} onMakeAFilm={requestScript} />
      ) : tab === "assemble" ? (
        <AssembleStudio
          pendingCuts={pendingCuts}
          onPendingCutsApplied={clearPendingCuts}
          catalog={catalog}
        />
      ) : (
        <Suspense
          fallback={
            <div className="studio-loading">
              <Spinner aria-label="Loading workflows" />
            </div>
          }
        >
          <WorkflowStudio
            catalog={catalog}
            scriptRequested={scriptRequested}
            onScriptRequestApplied={clearScriptRequest}
          />
        </Suspense>
      )}
    </div>
  );
}
