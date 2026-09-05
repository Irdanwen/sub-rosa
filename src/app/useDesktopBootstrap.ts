import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../lib/errors";
import { t } from "../lib/i18n";
import {
  type BootstrapResponse,
  type NoteDto,
  bootstrapApp,
  createNote,
  getNote,
} from "../lib/tauri";
import type { NotesAction } from "./state/app-state";

async function loadDesktopBootstrap() {
  const seeded = withFakeRecovery(await bootstrapApp());
  // Select one note up front for the menu-bar recording gesture. Coalescing
  // this whole operation across StrictMode effects avoids creating two notes
  // on an empty install. A retry reads the list again before creating anything.
  const firstNoteId = seeded.payload.notes[0]?.id;
  const note =
    seeded.fakeNote ?? (firstNoteId ? await getNote(firstNoteId) : await createNote(undefined));
  return { payload: seeded.payload, note, fake: Boolean(seeded.fakeNote) };
}

export function useDesktopBootstrap(
  blocked: boolean,
  dispatch: Dispatch<NotesAction>,
  showNotes: (view: "notes") => void,
) {
  const request = useRef<ReturnType<typeof loadDesktopBootstrap> | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryBootstrap = useCallback(async () => {
    request.current = null;
    setBootstrapError(null);
    setAttempt((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the failed startup operation.
  useEffect(() => {
    if (blocked || bootstrapped) return;
    let active = true;
    request.current ??= loadDesktopBootstrap();
    void request.current.then(
      ({ payload, note, fake }) => {
        if (!active) return;
        dispatch({ type: "bootstrapLoaded", payload });
        dispatch({ type: "noteLoaded", note });
        if (fake) showNotes("notes");
        setBootstrapped(true);
      },
      (error: unknown) => {
        if (active) setBootstrapError(messageFromError(error));
      },
    );
    return () => {
      active = false;
    };
  }, [blocked, bootstrapped, attempt, dispatch, showNotes]);

  return { bootstrapped, bootstrapError, retryBootstrap };
}
// Dev-only helper: pass `?fake-recovery=1` in the URL to inject a fake
// recoverable recording so the inline recovery prompt can be iterated
// on without crashing a real recording. No-op in production builds.
function withFakeRecovery(payload: BootstrapResponse): {
  payload: BootstrapResponse;
  fakeNote?: NoteDto;
} {
  if (!import.meta.env.DEV) return { payload };
  let enabled = false;
  try {
    enabled =
      new URLSearchParams(window.location.search).get("fake-recovery") === "1" ||
      window.location.hash.toLowerCase() === "#fake-recovery" ||
      localStorage.getItem("os-june:dev:fake-recovery") === "1";
  } catch {
    return { payload };
  }
  if (!enabled) return { payload };

  const noteId = "fake-recovery-note";
  const sessionId = "fake-recovery-session";
  const now = new Date().toISOString();
  const fakeListItem = {
    id: noteId,
    title: t("Team sync"),
    preview: "Recovered from an interrupted recording",
    processingStatus: "recoverable" as const,
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const fakeNote: NoteDto = {
    ...fakeListItem,
    generatedContent: "",
    editedContent: "",
  };
  return {
    payload: {
      ...payload,
      notes: [fakeListItem, ...payload.notes],
      activeRecoveries: [
        {
          sessionId,
          noteId,
          sourceMode: "microphonePlusSystem",
          startedAt: now,
          partialPathPresent: true,
          finalPathPresent: false,
          bytesFound: 2_400_000,
          sources: [
            {
              source: "microphone",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
            {
              source: "system",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
          ],
        },
        ...payload.activeRecoveries,
      ],
    },
    fakeNote,
  };
}
