// Studio: the creative workspace (image, video, audio, projects) on top of
// the Carpe Diem media surface. Model availability, generation constraints,
// and prices all come from the merged catalog — nothing here hardcodes what
// a backend can do today.
//
// Five tabs (ADR-0111). Image, Video and Audio render on the desk: a dark
// room with the scene, the dock and an inspector. Retouch, Compose, Upscale
// and Cutout are tools of Image; the Bible, the montage and the workflows
// live in Films. The tab says Films, not Projects: a project is a chat
// project (ADR-0085), and the sidebar lists those under that name.

import { t } from "../../lib/i18n";
import { OPEN_STUDIO_TAB_EVENT, STUDIO_TAB_STORAGE_KEY } from "./studio-keys";
import { useCallback, useEffect, useState } from "react";
import { recoverableView } from "../../app/recoverable-view";
import type { ChainShot } from "../../lib/studio/chain";
import { supportsBackgroundRemoval } from "../../lib/studio/catalog";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { AssembleStudio } from "./AssembleStudio";
import { BibleStudio } from "./BibleStudio";
import { ProjectStudio } from "./ProjectStudio";
import { AudioStudio } from "./AudioStudio";
import { ImageStudio, type ImageTool } from "./ImageStudio";
import { StudioGalleryDesktop } from "./StudioGalleryDesktop";
import { VideoStudio } from "./VideoStudio";
import { useMediaCatalog } from "./useMediaCatalog";
import { DeskTools } from "./desk/StudioDesk";
import { StudioStatus, useStudioRunningCount } from "./desk/StudioStatus";
import {
  dismissStandaloneImageFailure,
  observeStandaloneImageJobs,
  readStandaloneImageFailures,
  STUDIO_IMAGE_FAILED_EVENT,
} from "../../lib/studio/image-job-recovery";
import { OPEN_COMPOSE_EVENT } from "../../lib/studio/compose/jobs";
import { OPEN_RETOUCH_EVENT } from "../../lib/studio/retouch/jobs";
import { OPEN_WORKFLOW_EVENT } from "../../lib/studio/workflow/open";
import "./stage/stage.css";
import "./desk/desk.css";

// The workflow canvas pulls in @xyflow/react; only the Workflows section pays
// for it.
const WorkflowStudio = recoverableView(async () => {
  const module = await import("./WorkflowStudio");
  return { default: module.WorkflowStudio };
});

// The composer loads with its tool.
const ComposeStudio = recoverableView(async () => {
  const module = await import("./compose/ComposeStudio");
  return { default: module.ComposeStudio };
});

// The retouch canvas and its tools load with the tool.
const RetouchStudio = recoverableView(async () => {
  const module = await import("./retouch/RetouchStudio");
  return { default: module.RetouchStudio };
});

type StudioTab = "image" | "video" | "audio" | "projects" | "gallery";
type ProjectSection = "films" | "bible" | "assemble" | "workflows";

const TAB_STORAGE_KEY = STUDIO_TAB_STORAGE_KEY;

type Place = { tab: StudioTab; tool?: ImageTool; section?: ProjectSection };

/**
 * Where a saved tab opens now. The eleven tabs the Studio had before
 * ADR-0111 each still resolve to their new home, so nobody lands on nothing
 * after the update.
 */
export function studioPlaceFor(saved: string | null): Place {
  switch (saved) {
    case "image":
    case "video":
    case "audio":
    case "gallery":
      return { tab: saved };
    // "music" is the audio tab's old name.
    case "music":
      return { tab: "audio" };
    case "start":
      return { tab: "image" };
    case "retouch":
      return { tab: "image", tool: "retouch" };
    case "compose":
      return { tab: "image", tool: "compose" };
    case "projects":
    case "films":
    case "film":
      return { tab: "projects", section: "films" };
    case "bible":
      return { tab: "projects", section: "bible" };
    case "assemble":
      return { tab: "projects", section: "assemble" };
    case "workflows":
      return { tab: "projects", section: "workflows" };
    default:
      return { tab: "image" };
  }
}

function initialPlace(): Place {
  try {
    return studioPlaceFor(window.localStorage.getItem(TAB_STORAGE_KEY));
  } catch {
    return { tab: "image" };
  }
}

export function StudioView() {
  useEffect(() => observeStandaloneImageJobs(), []);
  const [imageFailures, setImageFailures] = useState(readStandaloneImageFailures);
  useEffect(() => {
    const refresh = () => setImageFailures(readStandaloneImageFailures());
    window.addEventListener(STUDIO_IMAGE_FAILED_EVENT, refresh);
    return () => window.removeEventListener(STUDIO_IMAGE_FAILED_EVENT, refresh);
  }, []);
  const [initial] = useState(initialPlace);
  const [tab, setTab] = useState<StudioTab>(initial.tab);
  const [imageTool, setImageTool] = useState<ImageTool>(initial.tool ?? "create");
  const [section, setSection] = useState<ProjectSection>(initial.section ?? "films");
  const { catalog, error, loading, retry } = useMediaCatalog();
  // Synchronous renders write no job row; the desk that runs one says so.
  const [localWorking, setLocalWorking] = useState(0);
  const running = useStudioRunningCount(localWorking);
  const openGallery = useCallback(() => setTab("gallery"), []);

  // A shot chain on its way to the montage: the video studio hands over the
  // cut list, the section switches, and Assemble loads it once.
  const [pendingCuts, setPendingCuts] = useState<ChainShot[] | undefined>(undefined);
  const assembleChain = useCallback((cuts: ChainShot[]) => {
    setPendingCuts(cuts);
    setTab("projects");
    setSection("assemble");
  }, []);
  const clearPendingCuts = useCallback(() => setPendingCuts(undefined), []);

  /** A finished film handed to the montage, which is where a cut gets
   * finished. Same shape as the chain hand-over: a request consumed once. */
  const [pendingProduction, setPendingProduction] = useState<string | undefined>(undefined);
  const clearPendingProduction = useCallback(() => setPendingProduction(undefined), []);

  // The shell's "New image" and "New video" open the matching desk.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const place = studioPlaceFor((event as CustomEvent<string>).detail);
      setTab(place.tab);
      if (place.tab === "image") setImageTool(place.tool ?? "create");
    };
    window.addEventListener(OPEN_STUDIO_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_STUDIO_TAB_EVENT, onOpen);
  }, []);

  // Any surface showing an image can hand it to the Retouch tool.
  const [pendingRetouch, setPendingRetouch] = useState<string | undefined>(undefined);
  const clearPendingRetouch = useCallback(() => setPendingRetouch(undefined), []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const artifactId = (event as CustomEvent<string>).detail;
      if (typeof artifactId !== "string" || !artifactId) return;
      setPendingRetouch(artifactId);
      setTab("image");
      setImageTool("retouch");
    };
    window.addEventListener(OPEN_RETOUCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RETOUCH_EVENT, onOpen);
  }, []);

  // The gallery leads back to the workflow that made a file.
  const [pendingWorkflow, setPendingWorkflow] = useState<string | undefined>(undefined);
  const clearPendingWorkflow = useCallback(() => setPendingWorkflow(undefined), []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const workflowId = (event as CustomEvent<string>).detail;
      if (typeof workflowId !== "string" || !workflowId) return;
      setPendingWorkflow(workflowId);
      setTab("projects");
      setSection("workflows");
    };
    window.addEventListener(OPEN_WORKFLOW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WORKFLOW_EVENT, onOpen);
  }, []);

  // And to the Compose tool.
  const [pendingCompose, setPendingCompose] = useState<string | undefined>(undefined);
  const clearPendingCompose = useCallback(() => setPendingCompose(undefined), []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const artifactId = (event as CustomEvent<string>).detail;
      if (typeof artifactId !== "string" || !artifactId) return;
      setPendingCompose(artifactId);
      setTab("image");
      setImageTool("compose");
    };
    window.addEventListener(OPEN_COMPOSE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMPOSE_EVENT, onOpen);
  }, []);

  // What is remembered is the most specific place, so a reopened Studio comes
  // back to the tool or section, not only the tab.
  useEffect(() => {
    const saved =
      tab === "image" && (imageTool === "retouch" || imageTool === "compose")
        ? imageTool
        : tab === "projects" && section !== "films"
          ? section
          : tab;
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, saved);
    } catch {
      // Tab memory is a nicety, not state.
    }
  }, [tab, imageTool, section]);

  const cutoutAvailable = catalog ? supportsBackgroundRemoval(catalog) : false;
  useEffect(() => {
    if (catalog && !cutoutAvailable && imageTool === "cutout") setImageTool("create");
  }, [catalog, cutoutAvailable, imageTool]);
  const imageTools = (
    <DeskTools
      value={imageTool}
      onChange={setImageTool}
      label={t("Image tool")}
      options={[
        { value: "create", label: t("Create") },
        { value: "retouch", label: t("Retouch") },
        { value: "compose", label: t("Compose") },
        { value: "upscale", label: t("Upscale") },
        ...(cutoutAvailable ? [{ value: "cutout" as const, label: t("Cutout") }] : []),
      ]}
    />
  );

  const onDesk = tab === "image" || tab === "video" || tab === "audio" || tab === "gallery";

  const body =
    tab === "gallery" ? (
      // The gallery reads files on this device and needs no model catalog:
      // it stays open offline and when the catalog fails.
      <StudioGalleryDesktop />
    ) : loading ? (
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
    ) : tab === "image" ? (
      imageTool === "retouch" || imageTool === "compose" ? (
        <div className="studio-tool-room">
          <div className="studio-desk-toolbar">{imageTools}</div>
          {imageTool === "retouch" ? (
            <RetouchStudio
              catalog={catalog}
              pendingArtifactId={pendingRetouch}
              onPendingApplied={clearPendingRetouch}
            />
          ) : (
            <ComposeStudio
              catalog={catalog}
              pendingArtifactId={pendingCompose}
              onPendingApplied={clearPendingCompose}
            />
          )}
        </div>
      ) : (
        <ImageStudio
          catalog={catalog}
          tool={imageTool}
          tools={imageTools}
          onWorking={setLocalWorking}
          onOpenGallery={openGallery}
        />
      )
    ) : tab === "video" ? (
      <VideoStudio catalog={catalog} onAssembleChain={assembleChain} onOpenGallery={openGallery} />
    ) : tab === "audio" ? (
      <AudioStudio catalog={catalog} onOpenGallery={openGallery} />
    ) : (
      <div className="studio-projects">
        <SegmentedControl
          value={section}
          onValueChange={setSection}
          aria-label={t("Projects section")}
          options={[
            { value: "films", label: t("Film projects") },
            { value: "bible", label: t("Bible") },
            { value: "assemble", label: t("Assemble") },
            { value: "workflows", label: t("Workflows") },
          ]}
        />
        {section === "films" ? (
          <ProjectStudio catalog={catalog} />
        ) : section === "bible" ? (
          <BibleStudio catalog={catalog} onMakeAFilm={() => setSection("films")} />
        ) : section === "assemble" ? (
          <AssembleStudio
            pendingCuts={pendingCuts}
            onPendingCutsApplied={clearPendingCuts}
            catalog={catalog}
            pendingProductionRunId={pendingProduction}
            onPendingProductionApplied={clearPendingProduction}
          />
        ) : (
          <WorkflowStudio
            catalog={catalog}
            pendingWorkflowId={pendingWorkflow}
            onPendingWorkflowOpened={clearPendingWorkflow}
          />
        )}
      </div>
    );

  return (
    <div className="studio-view" data-desk={onDesk ? "true" : undefined}>
      <header className="studio-header">
        <h1 className="studio-title">{t("Studio")}</h1>
        <div className="studio-section-nav">
          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            aria-label={t("Studio section")}
            options={[
              { value: "image", label: t("Image") },
              { value: "video", label: t("Video") },
              { value: "audio", label: t("Audio") },
              { value: "projects", label: t("Films") },
              { value: "gallery", label: t("Gallery") },
            ]}
          />
        </div>
        <StudioStatus running={running} />
      </header>
      {imageFailures[0] ? (
        <div className="studio-error studio-image-failure" role="alert">
          <span>
            {t("An image could not be generated: {reason}", { reason: imageFailures[0].message })}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => dismissStandaloneImageFailure(imageFailures[0].id)}
          >
            {t("Dismiss")}
          </button>
        </div>
      ) : null}
      {onDesk ? <div className="studio-room stage stage-tokens">{body}</div> : body}
    </div>
  );
}
