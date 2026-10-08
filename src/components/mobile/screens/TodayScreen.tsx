import { t } from "../../../lib/i18n";
import { isIosPlatform } from "../../../lib/mobile";
import { TodaySurface } from "../../assignments/TodaySurface";
import { StackHeader } from "../StackHeader";

/**
 * Today on the phone: the daily brief, results to review, assignments and
 * scheduled tasks (ADR-0091). A run on the phone is a chat, so a result can
 * open the conversation it came from.
 *
 * What the phone can do in the background is said on the screen, not left to
 * be discovered: iOS wakes the app now and then if it chooses to, Android
 * waits for the app to be opened. Either way a missed slot runs once, late,
 * and says so.
 */
export function TodayScreen({
  onBack,
  onOpenChat,
}: {
  onBack: () => void;
  onOpenChat: (taskId: string) => void;
}) {
  const backgroundNote = isIosPlatform()
    ? t(
        "Scheduled work runs on this phone while Sub Rosa is open. iOS may also run it in the background now and then. A run that missed its time runs when you open the app, and says it ran late.",
      )
    : t(
        "On Android, scheduled work runs while Sub Rosa is open. A run that missed its time runs when you open the app, and says it ran late.",
      );
  return (
    <div className="mobile-screen-root today-mobile">
      <TodaySurface
        platform="phone"
        onExit={onBack}
        backgroundNote={backgroundNote}
        onOpenRun={(run) => {
          if (run.handle) onOpenChat(run.handle);
        }}
        renderHeader={({ title, onBack: back }) => (
          <StackHeader title={title} onBack={back} large={title === t("Today")} />
        )}
      />
    </div>
  );
}
