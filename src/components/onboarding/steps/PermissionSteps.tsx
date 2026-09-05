import { intlLocale, t } from "../../../lib/i18n";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconTextIndicator } from "central-icons/IconTextIndicator";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import { dictationHelperCommand, openPrivacySettings } from "../../../lib/tauri";
import { isMacLikePlatform } from "../../../lib/platform";
import { StepActions, StepCard } from "../StepChrome";
import {
  isAccessibilityGranted,
  isMicrophoneDenied,
  isMicrophoneGranted,
  type PermissionStatuses,
  type SystemAudioStatus,
} from "../use-permission-status";

function PermissionRow({
  icon,
  granted,
  probing = false,
  title,
  detail,
  onAllow,
}: {
  icon: ReactNode;
  granted: boolean;
  /** A permission check is in flight (the macOS dialog is up or about to
   * be); the row pulses so the wait reads as activity, not a stall. */
  probing?: boolean;
  title: string;
  detail: string;
  /** Grant affordance — fires the TCC prompt or opens System Settings;
   * either way the user's decision is "allow". */
  onAllow?: () => void;
}) {
  return (
    <li className="onboarding-perm" data-granted={granted} data-probing={probing}>
      <span className="onboarding-perm-icon" aria-hidden>
        {granted ? <IconCheckmark1Small size={15} /> : icon}
      </span>
      <div className="onboarding-perm-copy">
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {!granted && onAllow ? (
        <button
          type="button"
          className="onboarding-perm-btn"
          onClick={onAllow}
          aria-label={t("Allow {permission} access", {
            permission: title.toLocaleLowerCase(intlLocale()),
          })}
        >
          {t("Allow")}
        </button>
      ) : null}
    </li>
  );
}

export function PermissionsStep({
  statuses,
  systemAudioStatus,
  onAllowSystemAudio,
  onContinue,
}: {
  statuses: PermissionStatuses;
  systemAudioStatus: SystemAudioStatus;
  /** Re-runs the capture-helper probe; fires the TCC prompt while the
   * permission is still undetermined. */
  onAllowSystemAudio: () => void;
  onContinue: () => void;
}) {
  const [showUnknownStatuses, setShowUnknownStatuses] = useState(false);
  const micGranted = isMicrophoneGranted(statuses);
  const micDenied = isMicrophoneDenied(statuses);
  const accessibilityGranted = isAccessibilityGranted(statuses);
  const systemAudioGranted = systemAudioStatus === "granted";
  const systemAudioDenied = systemAudioStatus === "denied";
  // macOS < 14.2 (or a missing capture helper) can never grant; the row
  // explains itself and stays out of the Continue gate.
  const systemAudioUnsupported = systemAudioStatus === "unsupported";
  // Granted, but the helper cannot capture until June restarts. Onboarding has
  // nothing left to ask for, so the row explains itself and clears the gate
  // too. It is not marked granted: the source does not work yet.
  const systemAudioUnavailable = systemAudioStatus === "unavailable";
  const systemAudioSettled = systemAudioGranted || systemAudioUnsupported || systemAudioUnavailable;
  const showPermissionRows = statuses.checked || showUnknownStatuses;
  const macLikePlatform = isMacLikePlatform();

  // Fire the native TCC prompt as soon as the screen shows — the user just
  // read why we're asking, so the dialog lands in context. No-op when
  // already granted; for already-denied users the helper emits the current
  // status so the System Settings fallback renders instead.
  useEffect(() => {
    void dictationHelperCommand({
      type: "request_microphone_permission",
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (statuses.checked) {
      setShowUnknownStatuses(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowUnknownStatuses(true);
    }, 240);

    return () => window.clearTimeout(timer);
  }, [statuses.checked]);

  function openAccessibilitySettings() {
    // Fire the helper's prompting check first: it registers the dictation
    // helper in the Accessibility list (so there's a toggle to flip) and
    // shows the native dialog. Let macOS own the System Settings handoff so
    // the native prompt is not left open behind a programmatic settings launch.
    void dictationHelperCommand({
      type: "request_accessibility_permission",
    }).catch(() => undefined);
  }

  return (
    <StepCard
      title={t("Let Sub Rosa listen and type")}
      subtitle={
        macLikePlatform
          ? t("Dictation and meeting notes need three macOS permissions.")
          : t("Dictation and meeting notes need microphone access.")
      }
      wide
    >
      <ul
        className="onboarding-perms"
        data-checking={!showPermissionRows}
        aria-busy={!showPermissionRows}
      >
        <PermissionRow
          icon={<IconMicrophone size={15} />}
          granted={showPermissionRows && micGranted}
          title={t("Microphone")}
          detail={
            micDenied
              ? t("Turned off in System Settings. Flip the toggle and Sub Rosa will notice.")
              : t("Hears you only when you ask Sub Rosa to listen.")
          }
          onAllow={
            showPermissionRows
              ? micDenied
                ? () => void openPrivacySettings("microphone")
                : () =>
                    void dictationHelperCommand({
                      type: "request_microphone_permission",
                    }).catch(() => undefined)
              : undefined
          }
        />
        {macLikePlatform ? (
          <>
            <PermissionRow
              icon={<IconTextIndicator size={15} />}
              granted={showPermissionRows && accessibilityGranted}
              title={t("Accessibility")}
              detail={t("Types your words at your cursor, in any app.")}
              onAllow={showPermissionRows ? openAccessibilitySettings : undefined}
            />
            <PermissionRow
              icon={<IconVolumeFull size={15} />}
              granted={showPermissionRows && systemAudioGranted}
              probing={showPermissionRows && systemAudioStatus === "probing"}
              title={t("System audio")}
              detail={
                systemAudioDenied
                  ? t("Turned off in System Settings. Flip the toggle and Sub Rosa will notice.")
                  : systemAudioUnsupported
                    ? t("Needs macOS 14.2 or later.")
                    : systemAudioUnavailable
                      ? t("Allowed. Restart Sub Rosa to finish turning it on.")
                      : systemAudioStatus === "probing"
                        ? t("Waiting for macOS. Approve the prompt when it appears.")
                        : t("Hears your calls and meetings, only while you record.")
              }
              onAllow={
                showPermissionRows
                  ? systemAudioDenied
                    ? () => void openPrivacySettings("systemAudio")
                    : systemAudioStatus === "unknown"
                      ? onAllowSystemAudio
                      : undefined
                  : undefined
              }
            />
          </>
        ) : null}
      </ul>
      <StepActions
        onContinue={onContinue}
        continueDisabled={
          !showPermissionRows ||
          !micGranted ||
          (macLikePlatform && (!accessibilityGranted || !systemAudioSettled))
        }
        onSkip={onContinue}
      />
    </StepCard>
  );
}
