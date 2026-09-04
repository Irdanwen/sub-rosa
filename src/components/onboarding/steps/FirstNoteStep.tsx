import { t } from "../../../lib/i18n";
import { IconFileArrowLeftIn } from "central-icons/IconFileArrowLeftIn";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { PRODUCT_NAME } from "../../../lib/branding";
import { StepCard } from "../StepChrome";

/** What the person chose to do first, handed back to the app shell. */
export type FirstNoteIntent = "record" | "import";

/**
 * The last screen of the first run asks for the first note rather than
 * announcing that setup is complete. Both choices are things the product
 * does well and both end in a note: a recording starts one, an import turns
 * a file or a link into one. "Later" is a real option, not a hidden one.
 */
export function FirstNoteStep({
  onChoose,
}: {
  onChoose: (intent: FirstNoteIntent | undefined) => void;
}) {
  return (
    <StepCard
      title={t("Your first note")}
      subtitle={`Everything ${PRODUCT_NAME} does starts from a note. Record a meeting now, or bring in something you already have.`}
    >
      <div className="onboarding-first-note">
        <button type="button" className="onboarding-choice" onClick={() => onChoose("record")}>
          <IconMicrophone size={18} aria-hidden />
          <span className="onboarding-choice-copy">
            <span className="onboarding-choice-title">{t("Record a meeting")}</span>
            <span className="onboarding-choice-detail">
              {t("A new note opens and starts listening. Stop when the meeting ends.")}
            </span>
          </span>
        </button>
        <button type="button" className="onboarding-choice" onClick={() => onChoose("import")}>
          <IconFileArrowLeftIn size={18} aria-hidden />
          <span className="onboarding-choice-copy">
            <span className="onboarding-choice-title">{t("Import a file or a link")}</span>
            <span className="onboarding-choice-detail">
              {t("A recording, a podcast, a talk: it becomes a note with a transcript.")}
            </span>
          </span>
        </button>
      </div>
      <div className="welcome-providers">
        <button type="button" className="onboarding-skip" onClick={() => onChoose(undefined)}>
          {t("Later")}
        </button>
      </div>
    </StepCard>
  );
}
