// Studio: the creative workspace (image, video, music, workflows) on top of
// the Carpe Diem media surface. Model availability, generation constraints,
// and prices all come from the merged catalog — nothing here hardcodes what
// a backend can do today.

import { lazy, Suspense, useEffect, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { FilmStudio } from "./FilmStudio";
import { ImageStudio } from "./ImageStudio";
import { MusicStudio } from "./MusicStudio";
import { VideoStudio } from "./VideoStudio";
import { useMediaCatalog } from "./useMediaCatalog";

// The workflow canvas pulls in @xyflow/react; only the Workflows tab pays
// for it.
const WorkflowStudio = lazy(() =>
  import("./WorkflowStudio").then((module) => ({ default: module.WorkflowStudio })),
);

type StudioTab = "image" | "video" | "music" | "films" | "workflows";

const TAB_STORAGE_KEY = "os-june:studio-tab";

function initialTab(): StudioTab {
  try {
    const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (
      saved === "image" ||
      saved === "video" ||
      saved === "music" ||
      saved === "films" ||
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
            Generate images, videos, and music, or chain them into workflows.
          </p>
        </div>
        <SegmentedControl
          value={tab}
          onValueChange={setTab}
          aria-label="Studio section"
          options={[
            { value: "image", label: "Image" },
            { value: "video", label: "Video" },
            { value: "music", label: "Music" },
            { value: "films", label: "Films" },
            { value: "workflows", label: "Workflows" },
          ]}
        />
      </header>
      {tab === "films" ? (
        // Films drives Videomaker, not the Carpe Diem media catalog — it must
        // render (and explain itself) even when the catalog is unavailable.
        <FilmStudio />
      ) : loading ? (
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
        <VideoStudio catalog={catalog} />
      ) : tab === "music" ? (
        <MusicStudio catalog={catalog} />
      ) : (
        <Suspense
          fallback={
            <div className="studio-loading">
              <Spinner aria-label="Loading workflows" />
            </div>
          }
        >
          <WorkflowStudio catalog={catalog} />
        </Suspense>
      )}
    </div>
  );
}
