import { t } from "../../lib/i18n";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { useEffect, useMemo, useState } from "react";
import { onboardingResumeStep, setOnboardingResumeStep } from "../../lib/onboarding";
import { isMacLikePlatform } from "../../lib/platform";
import { dictationSettings, setDictationShortcut } from "../../lib/tauri";
import type { DictationShortcutSetting } from "../../lib/tauri";
import { PermissionsStep } from "./steps/PermissionSteps";
import { WelcomeStep } from "./steps/WelcomeStep";
import { DictationPracticeStep } from "./steps/PracticeStep";
import { KeyStep } from "./steps/KeyStep";
import { FirstNoteStep, type FirstNoteIntent } from "./steps/FirstNoteStep";
import { usePermissionStatuses, useSystemAudioStatus } from "./use-permission-status";

type StepId = "welcome" | "key" | "permissions" | "dictation-practice" | "first-note";

// Announced by the progress bar so screen readers hear where they are, not
// just a bare step count.
function stepLabel(step: StepId): string {
  const labels: Record<StepId, string> = {
    welcome: t("Welcome"),
    key: t("Your key"),
    permissions: t("Permissions"),
    "dictation-practice": t("Try dictation"),
    "first-note": t("Your first note"),
  };
  return labels[step];
}

// The product default: bare fn, mirroring DictationShortcutSetting::bare_fn()
// on the Rust side.
const FN_SHORTCUT = {
  code: "Fn",
  modifiers: {
    command: false,
    control: false,
    option: false,
    shift: false,
    function: true,
  },
  label: t("Fn"),
  pressCount: 1 as const,
};

// Mirrors DictationShortcutSetting::control_option_d() on the Rust side: the
// factory default a fresh install carries before anyone has touched it.
function isFactoryDefaultShortcut(shortcut: DictationShortcutSetting) {
  return (
    shortcut.code === "KeyD" &&
    shortcut.modifiers.control &&
    shortcut.modifiers.option &&
    !shortcut.modifiers.command &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.function
  );
}

// One sequence, not a gate and then a wizard: the key is the second screen
// when the install has none, and the last screen asks for the first note.
const MAC_STEPS: StepId[] = ["welcome", "key", "permissions", "dictation-practice", "first-note"];
const NON_MAC_STEPS: StepId[] = ["welcome", "key", "permissions", "first-note"];

type Props = {
  /** Called once, with what the person chose to do first (or nothing). */
  onComplete: (intent?: FirstNoteIntent) => void;
  /** No key is stored yet: the sequence includes the key step. */
  needsKey?: boolean;
  /** The engine runs on a stored key: the key step may be left. */
  keyReady?: boolean;
};

export function onboardingSteps(mac: boolean, needsKey: boolean): StepId[] {
  const steps = mac ? MAC_STEPS : NON_MAC_STEPS;
  return needsKey ? steps : steps.filter((step) => step !== "key");
}

function initialStepIndex(steps: StepId[]): number {
  const demoStep = browserOnboardingDemoStep();
  if (demoStep) {
    const demoIndex = steps.indexOf(demoStep);
    if (demoIndex !== -1) return demoIndex;
  }
  const saved = onboardingResumeStep();
  if (!saved) return 0;
  const index = steps.indexOf(saved as StepId);
  return index === -1 ? 0 : index;
}

function browserOnboardingDemoStep(): StepId | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const step = new URLSearchParams(window.location.search).get("juneDemoStep");
  return step === "welcome" ||
    step === "key" ||
    step === "permissions" ||
    step === "dictation-practice" ||
    step === "first-note"
    ? step
    : null;
}

export function OnboardingFlow({ onComplete, needsKey = false, keyReady = false }: Props) {
  const steps = useMemo(() => onboardingSteps(isMacLikePlatform(), needsKey), [needsKey]);
  const supportsDictationPractice = steps.includes("dictation-practice");
  const [stepIndex, setStepIndex] = useState(() => initialStepIndex(steps));
  const [shortcutLabel, setShortcutLabel] = useState("fn");

  const stepId = steps[stepIndex];

  // Every step is reachable: the wizard no longer opens on a sign-in gate that
  // the later steps depended on. A stale "sign-in" resume value from a
  // pre-rebrand install resolves to 0 (welcome) through initialStepIndex.
  const firstReachableStepIndex = 0;

  useEffect(() => {
    setOnboardingResumeStep(stepId);
  }, [stepId]);

  // Only poll the helper while the user is on the permissions screen.
  const permissionStatuses = usePermissionStatuses(stepId === "permissions");
  // The probe behind this is also what fires the system-audio TCC prompt
  // on a fresh install — deliberately run from the permissions screen, in
  // context, instead of ambushing the user after onboarding.
  const systemAudio = useSystemAudioStatus(stepId === "permissions");

  // Onboarding pitches the bare-fn default, but a version bump replays the
  // wizard for existing users, so it must not clobber a key they customized
  // in Settings. Read first: only the untouched factory default (Ctrl+Opt+D)
  // gets normalized to fn; anything else is reflected as-is. Runs once per
  // wizard run, not per practice-step mount, so a key rebound on the
  // practice screen survives stepping back and forward.
  useEffect(() => {
    if (!supportsDictationPractice) return;
    dictationSettings()
      .then(({ settings }) => {
        const current = settings.pushToTalkShortcut;
        if (current && !isFactoryDefaultShortcut(current)) {
          if (current.label) setShortcutLabel(current.label);
          return undefined;
        }
        return setDictationShortcut("push_to_talk", FN_SHORTCUT).then((saved) => {
          setShortcutLabel(saved?.pushToTalkShortcut?.label ?? FN_SHORTCUT.label);
        });
      })
      .catch(() => undefined);
  }, [supportsDictationPractice]);

  function goNext() {
    if (stepIndex >= steps.length - 1) {
      onComplete(undefined);
      return;
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function goBack() {
    setStepIndex((index) => {
      return Math.max(index - 1, firstReachableStepIndex);
    });
  }

  return (
    <div className="onboarding-screen">
      <header className="onboarding-topbar">
        {stepIndex > firstReachableStepIndex ? (
          <button
            type="button"
            className="onboarding-back"
            onClick={goBack}
            aria-label={t("Back")}
            title={t("Back")}
          >
            <IconChevronLeftSmall size={18} aria-hidden />
          </button>
        ) : null}
        <nav
          className="onboarding-progress"
          aria-label={t("Setup progress: step {step} of {count}, {label}", {
            step: stepIndex + 1,
            count: steps.length,
            label: stepLabel(stepId),
          })}
        >
          {steps.map((id, index) => (
            <span
              key={id}
              className="onboarding-progress-seg"
              aria-hidden
              data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : "upcoming"}
            />
          ))}
        </nav>
      </header>
      <div className="onboarding-body">
        {stepId === "welcome" ? (
          <WelcomeStep onContinue={goNext} />
        ) : stepId === "key" ? (
          <KeyStep ready={keyReady} onContinue={goNext} />
        ) : stepId === "permissions" ? (
          <PermissionsStep
            statuses={permissionStatuses}
            systemAudioStatus={systemAudio.status}
            onAllowSystemAudio={systemAudio.probe}
            onContinue={goNext}
          />
        ) : stepId === "dictation-practice" ? (
          <DictationPracticeStep
            shortcutLabel={shortcutLabel}
            onShortcutLabelChange={setShortcutLabel}
            onContinue={goNext}
          />
        ) : stepId === "first-note" ? (
          <FirstNoteStep onChoose={onComplete} />
        ) : null}
      </div>
    </div>
  );
}
