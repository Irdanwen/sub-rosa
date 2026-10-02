// The state machine both retouch surfaces share: which version is on screen,
// what is rendering, what arrived, what failed, and what is waiting its turn.
// It never polls (ADR-0018): Rust owns the jobs, and this listens to their
// events and to the versions recovery files.

import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactDataUrl } from "../../artifact-media";
import { friendlyErrorMessage } from "../../errors";
import { t } from "../../i18n";
import { listArtifacts, saveArtifactFromBase64 } from "../artifacts";
import { MEDIA_JOB_EVENT, type MediaJob } from "../async-job";
import { estimateCostCredits, imageEditModels } from "../catalog";
import { upscaleImage } from "../edit-image";
import { renderEtaKey, rememberRenderMs } from "../render-eta";
import type { MediaCatalog, MediaModel, RetouchLineage, StudioArtifact } from "../types";
import {
  cropForSending,
  naturalSize,
  prepareForUpscale,
  prepareSource,
  rasterizeZone,
} from "./canvas-io";
import {
  dismissRetouchFailure,
  inFlightRetouches,
  type CompositeSpec,
  RETOUCH_FAILED_EVENT,
  RETOUCH_VERSION_EVENT,
  type RetouchFailure,
  type RetouchVersionDetail,
  readRetouchFailures,
  retouchContextOf,
  retouchRootOf,
  submitRetouch,
} from "./jobs";
import {
  lineageFor,
  nextVersionNumber,
  redoTarget,
  type RetouchSession,
  sessionOf,
  undoTarget,
} from "./lineage";
import {
  type QueuedInstruction,
  type RetouchSettings,
  readCursor,
  readQueue,
  readSettings,
  writeCursor,
  writeQueue,
  writeSettings,
} from "./prefs";
import { buildEditRequest, defaultRetouchModel, editCaps } from "./request";
import { hasZone, strokesInCrop, zoneBounds, zoneCrop, type ZoneStroke } from "./zone";

/** An extra image sent with the instruction. */
export interface RetouchReference {
  id: string;
  /** Ready to send: already under the per-image limit. */
  dataUri: string;
  artifactId?: string;
}

/** A retouch on its way. */
export interface PendingStep {
  key: string;
  jobId?: string;
  parentId: string;
  prompt: string;
  op: RetouchLineage["op"];
  n: number;
  startedAt: number;
  phase: "queueing" | "queued" | "processing";
  variant?: RetouchLineage["variant"];
}

export interface RetouchInput {
  prompt: string;
  refs: RetouchReference[];
  zone?: ZoneStroke[];
}

/** The instruction sent for "extend to a format". It is data sent to the
 * model and saved with the version, not copy. */
const EXTEND_PROMPT =
  "Extend the scene outward to fill the new frame. Keep the existing content exactly as it is, unchanged and centered; only add new surroundings that match it.";

const ETA_KIND = "retouch";

export function useRetouchSession(catalog: MediaCatalog, rootId: string | undefined) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingStep[]>([]);
  const [failures, setFailures] = useState<RetouchFailure[]>([]);
  const [queue, setQueue] = useState<QueuedInstruction[]>([]);
  const [queueArmed, setQueueArmed] = useState(true);
  const [revealId, setRevealId] = useState<string | undefined>(undefined);
  const [variantGroup, setVariantGroup] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [settings, setSettingsState] = useState<RetouchSettings>(readSettings);
  const redoMemory = useRef(new Map<string, string>());
  const cursorRef = useRef(cursorId);
  cursorRef.current = cursorId;

  const session: RetouchSession | undefined = useMemo(
    () => (rootId ? sessionOf(artifacts, rootId) : undefined),
    [artifacts, rootId],
  );
  const cursor = (cursorId && session?.byId.get(cursorId)) || session?.root;

  const models = useMemo(() => imageEditModels(catalog), [catalog]);
  const model: MediaModel | undefined = useMemo(
    () => models.find((entry) => entry.id === settings.modelId) ?? defaultRetouchModel(catalog),
    [models, settings.modelId, catalog],
  );
  const caps = useMemo(() => editCaps(model), [model]);
  const unitCost = model ? estimateCostCredits(model) : undefined;

  const reload = useCallback(async () => {
    const images = await listArtifacts("image").catch(() => []);
    setArtifacts(images);
    setLoaded(true);
    return images;
  }, []);

  // Opening a session: its versions, where it was left, what is still
  // rendering for it, what failed, and what was waiting its turn.
  useEffect(() => {
    if (!rootId) return;
    let cancelled = false;
    setLoaded(false);
    setPending([]);
    setRevealId(undefined);
    setVariantGroup(undefined);
    setError(undefined);
    setCursorId(readCursor(rootId) ?? rootId);
    setFailures(readRetouchFailures(rootId));
    const restored = readQueue(rootId);
    setQueue(restored);
    // Instructions restored after a restart wait for a gesture: incoming
    // state is history, never an order to buy work again.
    setQueueArmed(restored.length === 0);
    void reload();
    void inFlightRetouches(rootId).then((jobs) => {
      if (cancelled) return;
      setPending(jobs.flatMap(pendingFromJob));
    });
    return () => {
      cancelled = true;
    };
  }, [rootId, reload]);

  useEffect(() => {
    if (rootId && cursorId) writeCursor(rootId, cursorId);
  }, [rootId, cursorId]);

  useEffect(() => {
    if (rootId) writeQueue(rootId, queue);
  }, [rootId, queue]);

  const setSettings = useCallback((patch: Partial<RetouchSettings>) => {
    setSettingsState((current) => {
      const next = { ...current, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  // A version arrived. It takes the screen when it was made from the version
  // on screen; otherwise it waits in the filmstrip.
  useEffect(() => {
    if (!rootId) return;
    const onVersion = (event: Event) => {
      const detail = (event as CustomEvent<RetouchVersionDetail>).detail;
      if (detail?.rootId !== rootId) return;
      // The step stops rendering and the version takes the screen in one
      // update. Apart, there is a render where the parent looks idle, and the
      // queue would send the next instruction to the version just left.
      const settle = () =>
        setPending((current) => current.filter((step) => step.jobId !== detail.jobId));
      void reload()
        .then((images) => {
          const version = images.find((image) => image.id === detail.artifactId);
          const elapsed = version?.edit?.elapsedMs;
          if (version && elapsed) rememberRenderMs(renderEtaKey(ETA_KIND, version.model), elapsed);
          settle();
          if (version?.edit?.variant && version.edit.variant.of > 1) {
            setVariantGroup(version.edit.variant.group);
            return;
          }
          if (detail.parentId === cursorRef.current) {
            setCursorId(detail.artifactId);
            setRevealId(detail.artifactId);
          }
        })
        .catch(settle);
    };
    const onFailed = () => {
      const current = readRetouchFailures(rootId);
      setFailures(current);
      const failed = new Set(current.map((failure) => failure.jobId));
      setPending((steps) => steps.filter((step) => !step.jobId || !failed.has(step.jobId)));
    };
    window.addEventListener(RETOUCH_VERSION_EVENT, onVersion);
    window.addEventListener(RETOUCH_FAILED_EVENT, onFailed);
    const unlisten = listen<MediaJob>(MEDIA_JOB_EVENT, (event) => {
      const job = event.payload;
      if (retouchRootOf(job.source) !== rootId) return;
      if (job.status !== "queued" && job.status !== "processing") return;
      setPending((steps) =>
        steps.map((step) =>
          step.jobId === job.id ? { ...step, phase: job.status as PendingStep["phase"] } : step,
        ),
      );
    }).catch(() => () => undefined);
    return () => {
      window.removeEventListener(RETOUCH_VERSION_EVENT, onVersion);
      window.removeEventListener(RETOUCH_FAILED_EVENT, onFailed);
      void unlisten.then((stop) => stop());
    };
  }, [rootId, reload]);

  /** The next free version numbers, counting what is still rendering. */
  const reserve = useCallback((): number => {
    if (!session) return 1;
    return Math.max(nextVersionNumber(session), ...pending.map((step) => step.n + 1));
  }, [session, pending]);

  const send = useCallback(
    async (
      input: RetouchInput,
      options: { op?: RetouchLineage["op"]; aspectRatio?: string; settings?: RetouchSettings } = {},
    ) => {
      if (!session || !cursor || !model) return;
      const used = options.settings ?? settings;
      const usedModel = models.find((entry) => entry.id === used.modelId) ?? model;
      const usedCaps = usedModel === model ? caps : editCaps(usedModel);
      const zone = input.zone && hasZone(input.zone) ? input.zone : undefined;
      const variants = used.variants;
      const parent = cursor;
      const first = reserve();
      const group = variants > 1 ? crypto.randomUUID() : undefined;
      const op: RetouchLineage["op"] =
        options.op ?? (zone ? "zone" : variants > 1 ? "variant" : "prompt");
      const keys: string[] = Array.from({ length: variants }, () => crypto.randomUUID());
      const startedAt = Date.now();
      setPending((current) => [
        ...current,
        ...keys.map((key, index) => ({
          key,
          parentId: parent.id,
          prompt: input.prompt.trim(),
          op,
          n: first + index,
          startedAt,
          phase: "queueing" as const,
          ...(group ? { variant: { group, index, of: variants } } : {}),
        })),
      ]);
      try {
        const src = await artifactDataUrl(parent);
        let image: string;
        let aspectRatio = options.aspectRatio ?? used.aspectRatio;
        let composite: CompositeSpec | undefined;
        let region: RetouchLineage["region"];
        if (zone) {
          const size = await naturalSize(src);
          const bounds = zoneBounds(zone, size);
          const crop = bounds && zoneCrop(bounds, size, { ratios: usedCaps.aspectRatios });
          if (!crop) throw new Error(t("Draw the zone inside the image."));
          image = await cropForSending(src, crop);
          aspectRatio = crop.ratio;
          const rect: [number, number, number, number] = [crop.x, crop.y, crop.width, crop.height];
          composite = {
            parentFileName: parent.fileName,
            crop: rect,
            maskPngBase64: rasterizeZone(strokesInCrop(zone, crop), crop),
          };
          region = { crop: rect };
        } else {
          image = await prepareSource(src);
        }
        const request = buildEditRequest(usedCaps, {
          model: usedModel.id,
          prompt: input.prompt,
          images: [image, ...input.refs.map((ref) => ref.dataUri)],
          resolution: used.resolution,
          quality: used.quality,
          aspectRatio,
        });
        const refs = input.refs.flatMap((ref) => (ref.artifactId ? [ref.artifactId] : []));
        const jobs = await Promise.allSettled(
          keys.map((key, index) =>
            submitRetouch({
              request,
              composite,
              costCredits: estimateCostCredits(usedModel),
              lineage: lineageFor(session, parent, op, first + index, {
                ...(refs.length ? { refs } : {}),
                settings: {
                  resolution: request.body.resolution as string | undefined,
                  quality: request.body.quality as string | undefined,
                  aspectRatio: request.body.aspect_ratio as string | undefined,
                },
                ...(region ? { region } : {}),
                ...(group ? { variant: { group, index, of: variants } } : {}),
              }),
            }).then((job) => {
              setPending((current) =>
                current.map((step) =>
                  step.key === key ? { ...step, jobId: job.id, phase: "queued" } : step,
                ),
              );
              return job;
            }),
          ),
        );
        const refused = jobs.find((result) => result.status === "rejected");
        if (refused) {
          const failedKeys = new Set(keys.filter((_, index) => jobs[index].status === "rejected"));
          setPending((current) => current.filter((step) => !failedKeys.has(step.key)));
          throw (refused as PromiseRejectedResult).reason;
        }
      } catch (cause) {
        setPending((current) =>
          current.filter((step) => !keys.includes(step.key) || step.jobId !== undefined),
        );
        setError(friendlyErrorMessage(cause, t("The retouch could not be sent.")));
        throw cause;
      }
    },
    [session, cursor, model, models, caps, settings, reserve],
  );

  const busyHere = pending.some((step) => step.parentId === cursorId && step.op !== "upscale");

  /** Send now, or queue behind what is rendering on this version. */
  const submit = useCallback(
    async (input: RetouchInput) => {
      setError(undefined);
      if (busyHere && !input.zone) {
        setQueue((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            prompt: input.prompt.trim(),
            refIds: input.refs.flatMap((ref) => (ref.artifactId ? [ref.artifactId] : [])),
            droppedRefs: input.refs.some((ref) => !ref.artifactId) || undefined,
            settings,
          },
        ]);
        setQueueArmed(true);
        return "queued" as const;
      }
      return send(input).then(
        () => "sent" as const,
        () => "failed" as const,
      );
    },
    [busyHere, send, settings],
  );

  // The queue moves on its own only while this session is open and armed:
  // when nothing renders on the version on screen, the next instruction goes.
  // One at a time: its references load before `send` marks the version busy,
  // and without the latch the effect would pop the next one in that gap.
  const dispatching = useRef(false);
  useEffect(() => {
    if (dispatching.current) return;
    if (!queueArmed || busyHere || variantGroup || queue.length === 0 || !session || !cursor)
      return;
    const [next, ...rest] = queue;
    dispatching.current = true;
    setQueue(rest);
    void (async () => {
      const refs: RetouchReference[] = [];
      for (const id of next.refIds) {
        const artifact = session.byId.get(id) ?? artifacts.find((entry) => entry.id === id);
        if (!artifact) continue;
        const dataUri = await artifactDataUrl(artifact)
          .then(prepareSource)
          .catch(() => undefined);
        if (dataUri) refs.push({ id, dataUri, artifactId: id });
      }
      try {
        await send({ prompt: next.prompt, refs }, { settings: next.settings });
      } catch {
        // A refused send stops the queue: the person reads why before more go.
        setQueueArmed(false);
      } finally {
        dispatching.current = false;
      }
    })();
  }, [queueArmed, busyHere, variantGroup, queue, session, cursor, artifacts, send]);

  const removeQueued = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const armQueue = useCallback(() => setQueueArmed(true), []);

  const goTo = useCallback((id: string) => {
    setCursorId(id);
    setRevealId(undefined);
  }, []);

  const undo = useCallback(() => {
    if (!session || !cursor) return;
    const target = undoTarget(session, cursor.id);
    if (!target) return;
    redoMemory.current.set(target.id, cursor.id);
    goTo(target.id);
  }, [session, cursor, goTo]);

  const redo = useCallback(() => {
    if (!session || !cursor) return;
    const target = redoTarget(session, cursor.id, redoMemory.current.get(cursor.id));
    if (target) goTo(target.id);
  }, [session, cursor, goTo]);

  const variants = useMemo(
    () =>
      variantGroup
        ? (session?.versions.filter((version) => version.edit?.variant?.group === variantGroup) ??
          [])
        : [],
    [session, variantGroup],
  );
  const variantPending = useMemo(
    () => pending.filter((step) => step.variant?.group === variantGroup),
    [pending, variantGroup],
  );

  const pickVariant = useCallback((id: string) => {
    setVariantGroup(undefined);
    setCursorId(id);
    setRevealId(id);
  }, []);

  /** Upscale the version on screen. A short, synchronous call: it has no
   * queue to make it durable, so it runs while the session is open. */
  const upscale = useCallback(
    async (scale: 2 | 4) => {
      if (!session || !cursor) return;
      setError(undefined);
      const key = crypto.randomUUID();
      const startedAt = Date.now();
      const n = reserve();
      const parent = cursor;
      setPending((current) => [
        ...current,
        { key, parentId: parent.id, prompt: "", op: "upscale", n, startedAt, phase: "processing" },
      ]);
      try {
        const source = await artifactDataUrl(parent);
        const size = await naturalSize(source);
        if (Math.min(size.width, size.height) < 256)
          throw new Error(t("This image is too small to upscale."));
        // The operator takes 5 MB per image: a large PNG version goes as a
        // high-quality JPEG of the same size rather than being refused.
        const sendable = await prepareForUpscale(source, size);
        const result = await upscaleImage(sendable.replace(/^data:[^,]*,/, ""), scale);
        const version = await saveArtifactFromBase64(result, "png", {
          kind: "image",
          model: "upscaler",
          prompt: `Upscaled image (x${scale})`,
          edit: lineageFor(session, parent, "upscale", n, {
            elapsedMs: Date.now() - startedAt,
            settings: { scale },
          }),
        });
        await reload();
        if (cursorRef.current === parent.id) {
          setCursorId(version.id);
          setRevealId(version.id);
        }
      } catch (cause) {
        setError(friendlyErrorMessage(cause, t("The upscale did not return an image.")));
      } finally {
        setPending((current) => current.filter((step) => step.key !== key));
      }
    },
    [session, cursor, reserve, reload],
  );

  const extend = useCallback(
    (aspectRatio: string) =>
      send(
        { prompt: EXTEND_PROMPT, refs: [] },
        { op: "extend", aspectRatio, settings: { ...settings, variants: 1 } },
      ).catch(() => undefined),
    [send, settings],
  );

  const dismissFailure = useCallback(
    (jobId: string) => {
      dismissRetouchFailure(jobId);
      if (rootId) setFailures(readRetouchFailures(rootId));
    },
    [rootId],
  );

  return {
    loaded,
    artifacts,
    session,
    cursor,
    models,
    model,
    caps,
    unitCost,
    settings,
    setSettings,
    pending,
    busyHere,
    failures,
    dismissFailure,
    queue,
    queueArmed,
    armQueue,
    removeQueued,
    revealId,
    clearReveal: useCallback(() => setRevealId(undefined), []),
    error,
    clearError: useCallback(() => setError(undefined), []),
    submit,
    goTo,
    undo,
    redo,
    canUndo: Boolean(session && cursor && undoTarget(session, cursor.id)),
    canRedo: Boolean(
      session && cursor && redoTarget(session, cursor.id, redoMemory.current.get(cursor.id)),
    ),
    variants,
    variantPending,
    variantGroup,
    pickVariant,
    closeVariants: useCallback(() => setVariantGroup(undefined), []),
    upscale,
    extend,
    reload,
  };
}

export type RetouchSessionState = ReturnType<typeof useRetouchSession>;

/** A job still rendering, as the session shows it. */
function pendingFromJob(job: MediaJob): PendingStep[] {
  const context = retouchContextOf(job);
  if (!context) return [];
  const startedAt = Date.parse(job.createdAt);
  return [
    {
      key: job.id,
      jobId: job.id,
      parentId: context.edit.of,
      prompt: job.prompt,
      op: context.edit.op,
      n: context.edit.n,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      phase: job.status === "processing" ? "processing" : "queued",
      variant: context.edit.variant,
    },
  ];
}
