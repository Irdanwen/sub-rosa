import "../../styles/study-research.css";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconFlashcards } from "central-icons/IconFlashcards";
import { IconGraduateCap } from "central-icons/IconGraduateCap";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { withCodeContext, withCodeDraftContext } from "../../lib/code-mode";
import { sessionWorkingDir } from "../../lib/agent-session-working-dir";
import {
  STUDY_CARDS_CHANGED_EVENT,
  setStudyMode,
  studyStats,
  useStudyMode,
  withStudyContext,
} from "../../lib/study";
import { ActionSheet } from "../mobile/ActionSheet";
import { ResearchDialog } from "../research/ResearchDialog";
import { StudyReview } from "../study/StudyReview";

export { studyChatStarted, withStudyContext } from "../../lib/study";
export { adoptCodeModeDraft } from "../../lib/code-mode";

/** Desktop sends: study mode's block, then Code mode's (ADR-0090) when the
 * chat is in Code mode on its working folder. A new chat has no id yet: it
 * carries the block when Code mode was chosen for `newChatFolder` before its
 * first message. */
export async function withModeContext(
  text: string,
  chatId?: string | null,
  newChatFolder?: string | null,
): Promise<string> {
  const studied = await withStudyContext(text, chatId);
  if (!chatId) return withCodeDraftContext(studied, newChatFolder);
  return withCodeContext(studied, chatId, sessionWorkingDir(chatId));
}

/**
 * The composer's two modes (ADR-0089), shared by both shells: "Study"
 * switches the chat to a tutor that quizzes and makes flashcards, and "Deep
 * research" opens the research dialog on what is typed. "Review" appears
 * once there are cards, with the number due. The desktop shows them as
 * chips beside the model; the phone, short of room, gathers them behind one
 * button.
 */
export function ComposerModes({
  chatId,
  draft,
  compact = false,
}: {
  chatId?: string | null;
  draft: string;
  compact?: boolean;
}) {
  const studying = useStudyMode(chatId);
  const [researchOpen, setResearchOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cards, setCards] = useState({ total: 0, due: 0 });

  const refreshCards = useCallback(() => {
    void studyStats()
      .then((stats) => setCards({ total: stats.total, due: stats.due }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshCards();
    window.addEventListener(STUDY_CARDS_CHANGED_EVENT, refreshCards);
    return () => window.removeEventListener(STUDY_CARDS_CHANGED_EVENT, refreshCards);
  }, [refreshCards]);

  const toggleStudy = () => void setStudyMode(chatId, !studying);
  const reviewLabel = cards.due > 0 ? t("Review, {count} due", { count: cards.due }) : t("Review");

  const dialogs = (
    <>
      <ResearchDialog
        open={researchOpen}
        onClose={() => setResearchOpen(false)}
        initialQuestion={draft.trim()}
        chatId={chatId}
      />
      <StudyReview
        open={reviewOpen}
        onClose={() => {
          setReviewOpen(false);
          refreshCards();
        }}
      />
    </>
  );

  if (compact) {
    return (
      <>
        <button
          type="button"
          className="composer-modes-compact"
          data-on={studying || undefined}
          aria-label={studying ? t("Study mode is on. More modes") : t("Study and research")}
          onClick={() => setMenuOpen(true)}
        >
          <IconGraduateCap size={17} aria-hidden />
          {studying ? <span>{t("Study")}</span> : null}
          {cards.due > 0 ? <span className="composer-modes-badge">{cards.due}</span> : null}
        </button>
        {menuOpen ? (
          <ActionSheet
            title={t("Study and research")}
            onClose={() => setMenuOpen(false)}
            actions={[
              {
                label: studying ? t("Turn study mode off") : t("Turn study mode on"),
                onAction: () => {
                  setMenuOpen(false);
                  toggleStudy();
                },
              },
              {
                label: t("Deep research"),
                onAction: () => {
                  setMenuOpen(false);
                  setResearchOpen(true);
                },
              },
              {
                label: reviewLabel,
                onAction: () => {
                  setMenuOpen(false);
                  setReviewOpen(true);
                },
              },
            ]}
          />
        ) : null}
        {dialogs}
      </>
    );
  }

  // In a narrow composer the chips keep their icon and drop their words
  // (study-research.css, by the composer's width), so each one carries its
  // name for assistive technology and a tooltip whatever is shown.
  return (
    <div className="composer-modes">
      <button
        type="button"
        className="composer-mode"
        aria-pressed={studying}
        aria-label={t("Study")}
        title={t("A tutor that checks what you understood")}
        onClick={toggleStudy}
      >
        <IconGraduateCap size={14} aria-hidden />
        <span className="composer-mode-label">{t("Study")}</span>
      </button>
      <button
        type="button"
        className="composer-mode"
        aria-label={t("Deep research")}
        title={t("Research a question across the web and your notes")}
        onClick={() => setResearchOpen(true)}
      >
        <IconDeepSearch size={14} aria-hidden />
        <span className="composer-mode-label">{t("Deep research")}</span>
      </button>
      {cards.total > 0 ? (
        <button
          type="button"
          className="composer-mode"
          aria-label={reviewLabel}
          title={reviewLabel}
          onClick={() => setReviewOpen(true)}
        >
          <IconFlashcards size={14} aria-hidden />
          <span className="composer-mode-label">{reviewLabel}</span>
          {cards.due > 0 ? (
            <span className="composer-mode-count" aria-hidden>
              {cards.due}
            </span>
          ) : null}
        </button>
      ) : null}
      {dialogs}
    </div>
  );
}
