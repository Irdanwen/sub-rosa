// Studio: the creative workspace (image, video, music, workflows) on top of
// the Carpe Diem media surface. Model availability, generation constraints,
// and prices all come from the merged catalog — nothing here hardcodes what
// a backend can do today.

import { t } from "../../lib/i18n";
import { STUDIO_TAB_STORAGE_KEY } from "./studio-keys";
import { useCallback, useEffect, useState } from "react";
import { recoverableView } from "../../app/recoverable-view";
import type { ChainShot } from "../../lib/studio/chain";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { AssembleStudio } from "./AssembleStudio";
import { BibleStudio } from "./BibleStudio";
import { FilmStudio } from "./FilmStudio";
import { AudioStudio, type AudioMode } from "./AudioStudio";
import { StudioStart, type StudioDestination } from "./StudioStart";
import { ImageStudio } from "./ImageStudio";
import { VideoStudio } from "./VideoStudio";
import { useMediaCatalog } from "./useMediaCatalog";

// The workflow canvas pulls in @xyflow/react; only the Workflows tab pays
// for it.
const WorkflowStudio = recoverableView(async () => {
  const module = await import("./WorkflowStudio");
  return { default: module.WorkflowStudio };
});

type StudioTab =
  | "start"
  | "film"
  | "image"
  | "video"
  | "audio"
  | "bible"
  | "assemble"
  | "workflows";

const TAB_STORAGE_KEY = STUDIO_TAB_STORAGE_KEY;

function initialTab(): StudioTab {
  try {
    const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
    // "music" is the tab's pre-audio name; saved values must keep resolving.
    if (saved === "music") return "audio";
    // "films" was the remote studio, which is gone. Somebody who was last on
    // that tab lands where film production actually happens now, rather than
    // on a blank panel or, worse, silently back on Image.
    // "films" was the remote studio. What replaced it is the Film tab.
    if (saved === "films") return "film";
    if (
      saved === "start" ||
      saved === "film" ||
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
  return "start";
}

export function StudioView() {
  const [tab, setTab] = useState<StudioTab>(initialTab);
  const [audioMode, setAudioMode] = useState<AudioMode | undefined>();
  const openWorkshop = useCallback((destination: StudioDestination) => {
    setAudioMode(destination.audioMode);
    setTab(destination.tab);
  }, []);
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
  /**
   * A finished film handed to Assemble, which is where a cut gets finished.
   * Same shape as the chain hand-over: a request the receiving tab consumes.
   */
  const [pendingProduction, setPendingProduction] = useState<string | undefined>(undefined);
  const openProduction = useCallback((runId: string) => {
    setPendingProduction(runId);
    setTab("assemble");
  }, []);
  const clearPendingProduction = useCallback(() => setPendingProduction(undefined), []);

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
          <h1>{t("Studio")}</h1>
          <p className="studio-subtitle">
            {t("Generate images, videos, and audio, or chain them into workflows.")}
          </p>
        </div>
        <div className="studio-section-nav">
          <SegmentedControl
            value={tab}
            onValueChange={(next) => {
              setAudioMode(undefined);
              setTab(next);
            }}
            aria-label={t("Studio section")}
            options={[
              { value: "start", label: t("Explore") },
              { value: "film", label: t("Film") },
              { value: "image", label: t("Image") },
              { value: "video", label: t("Video") },
              { value: "audio", label: t("Audio") },
              { value: "assemble", label: t("Assemble") },
              { value: "bible", label: t("Bible") },
              { value: "workflows", label: t("Workflows") },
            ]}
          />
        </div>
      </header>
      {loading ? (
        <div className="studio-loading">
          <Spinner aria-label={t("Loading models")} />
        </div>
      ) : error || !catalog ? (
        <EmptyState
          title={t("Couldn't load the model catalog")}
          description={error ?? t("The model catalog did not respond. Try again in a moment.")}
          action={
            <button type="button" className="btn btn-secondary" onClick={retry}>
              {t("Try again")}
            </button>
          }
        />
      ) : tab === "start" ? (
        <StudioStart catalog={catalog} onOpen={openWorkshop} />
      ) : tab === "image" ? (
        <ImageStudio catalog={catalog} />
      ) : tab === "video" ? (
        <VideoStudio catalog={catalog} onAssembleChain={assembleChain} />
      ) : tab === "audio" ? (
        <AudioStudio catalog={catalog} requestedMode={audioMode} />
      ) : tab === "film" ? (
        <FilmStudio catalog={catalog} onOpenProduction={openProduction} />
      ) : tab === "bible" ? (
        <BibleStudio catalog={catalog} onMakeAFilm={() => setTab("film")} />
      ) : tab === "assemble" ? (
        <AssembleStudio
          pendingCuts={pendingCuts}
          onPendingCutsApplied={clearPendingCuts}
          catalog={catalog}
          pendingProductionRunId={pendingProduction}
          onPendingProductionApplied={clearPendingProduction}
        />
      ) : (
        <WorkflowStudio catalog={catalog} />
      )}
    </div>
  );
}
