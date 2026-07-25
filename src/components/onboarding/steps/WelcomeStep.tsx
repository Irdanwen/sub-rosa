import { IconCalendar1 } from "central-icons/IconCalendar1";
import { IconLock } from "central-icons/IconLock";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconSparkle } from "central-icons/IconSparkle";
import { CARPE_DIEM_DASHBOARD_URL, PRODUCT_NAME } from "../../../lib/branding";
import { isMacLikePlatform } from "../../../lib/platform";
import { juneOpenCommunityPage } from "../../../lib/tauri";
import { OnboardingPrimaryButton, StepCard } from "../StepChrome";

// macOS can introduce the full agent, dictation, and notes surface because the
// release bundle includes the runtime and helpers. Windows narrows the welcome
// promise below until its Hermes and dictation support is turnkey.
const POINTS = [
  {
    icon: IconSparkle,
    title: `Chat and work with ${PRODUCT_NAME}`,
    detail: `Hand ${PRODUCT_NAME} real work. It runs the session and comes back done.`,
  },
  {
    icon: IconMicrophone,
    title: "Speak instead of type",
    detail: `${PRODUCT_NAME} turns your voice into polished writing in any app on your computer.`,
  },
  {
    icon: IconCalendar1,
    title: "Effortlessly capture meetings",
    detail: `${PRODUCT_NAME} takes meeting notes without ever having to join the meeting.`,
  },
  {
    icon: IconLock,
    title: "Private by default",
    detail:
      "Notes, sessions, and memory stay on this device. Prompts go only to Carpe Diem, with your own key.",
  },
];

const WINDOWS_POINTS = [
  {
    icon: IconSparkle,
    title: "Desktop notes for your work",
    detail: "Keep meeting notes and projects together in one app.",
  },
  {
    icon: IconMicrophone,
    title: "Meeting notes from your mic",
    detail: "Record meetings from your microphone and turn them into notes.",
  },
  POINTS[3],
];

/**
 * Step 1: what the app is, before the wizard starts asking for permissions.
 *
 * Upstream this screen also carried the OS Accounts sign-in button and the
 * accounts terms links. Sub Rosa has no account to sign into, so only the
 * introduction survives; the API key is collected by the gate that runs before
 * the wizard at all.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  const isMac = isMacLikePlatform();
  const points = isMac ? POINTS : WINDOWS_POINTS;

  return (
    <StepCard
      title={`Welcome to ${PRODUCT_NAME}`}
      subtitle="Private AI for everyday life and work."
      mark
      wide
      className={isMac ? "welcome-card-intro" : undefined}
    >
      <ul className="onboarding-points">
        {points.map(({ icon: Icon, title, detail }) => (
          <li key={title}>
            <span className="onboarding-point-icon" aria-hidden>
              <Icon size={15} />
            </span>
            <div>
              <span className="onboarding-point-label">{title}</span>
              <span className="onboarding-point-detail">{detail}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="onboarding-community">
        Join us in the{" "}
        <button
          type="button"
          className="onboarding-community-link"
          onClick={() => void juneOpenCommunityPage().catch(() => undefined)}
        >
          {PRODUCT_NAME} community on Telegram
        </button>
        .
      </p>
      <div className="welcome-providers">
        <OnboardingPrimaryButton onClick={onContinue}>
          <span>Get started</span>
        </OnboardingPrimaryButton>
      </div>
      <p className="welcome-terms">
        Inference runs on{" "}
        <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
          Carpe Diem
        </a>
        , under their terms.
      </p>
    </StepCard>
  );
}
