/**
 * Study mode on the web (ADR-0089): a chat in study mode carries the
 * tutoring prompt on every turn, read at the prompt seam like the phone's;
 * its quizzes and flashcards are drawn in place, and flashcards can be added
 * to a review scheduled by SM-2. All of it stays in this browser.
 */
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import type { ComposerControlProps, FeatureStore, WebFeature } from "../feature";
import { FlashcardsBlock, QuizBlock } from "./blocks";
import { isStudyChat, setStudyChat } from "./cards";
import { ReviewPanel } from "./ReviewPanel";
import { STUDY } from "./schedule";

/** Study mode chosen before the chat exists (a new chat, the temporary one):
 * held in this tab, written to the chat its first turn creates. */
let pendingNew = false;
let temporaryStudy = false;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export async function studyModeFor(
  store: FeatureStore,
  chatId: string | null,
  temporary: boolean,
): Promise<boolean> {
  if (temporary) return temporaryStudy;
  if (!chatId) return pendingNew;
  if (await isStudyChat(store, chatId)) return true;
  return false;
}

/** For tests: forget the choices held in this tab. */
export function resetStudyTab() {
  pendingNew = false;
  temporaryStudy = false;
}

function StudyToggle({ host, chatId, temporary }: ComposerControlProps) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () =>
      void studyModeFor(host.storeFor("study"), chatId, temporary).then(
        (value) => active && setOn(value),
      );
    read();
    listeners.add(read);
    return () => {
      active = false;
      listeners.delete(read);
    };
  }, [host, chatId, temporary]);
  const toggle = async () => {
    const next = !on;
    if (temporary) temporaryStudy = next;
    else if (!chatId) pendingNew = next;
    else await setStudyChat(host.storeFor("study"), chatId, next);
    setOn(next);
    changed();
  };
  return (
    <button className="button" type="button" aria-pressed={on} onClick={() => void toggle()}>
      {t("Study mode", "Mode étude")}
    </button>
  );
}

export const studyFeature: WebFeature = {
  id: "study",
  label: () => t("Review", "Révision"),
  Panel: ReviewPanel,
  ComposerControl: StudyToggle,
  blocks: { quiz: QuizBlock, flashcards: FlashcardsBlock },
  async turn(host, turn) {
    const store = host.storeFor("study");
    let on: boolean;
    if (turn.temporary) on = temporaryStudy;
    else if (!turn.chatId) on = false;
    else if (await isStudyChat(store, turn.chatId)) on = true;
    else if (pendingNew) {
      // The first turn of a new chat: the choice made before it existed.
      await setStudyChat(store, turn.chatId, true);
      pendingNew = false;
      changed();
      on = true;
    } else on = false;
    return on ? { tools: [], prompt: STUDY.prompt } : null;
  },
};
