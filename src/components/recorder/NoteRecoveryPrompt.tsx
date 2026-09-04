import { t } from "../../lib/i18n";
import { IconRecord } from "central-icons/IconRecord";
import { InlineNotice } from "../ui/InlineNotice";
import type { RecoverableRecordingDto } from "../../lib/tauri";

type NoteRecoveryPromptProps = {
  recovery: RecoverableRecordingDto;
  onRecover: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
  disabled?: boolean;
};

export function NoteRecoveryPrompt({
  recovery,
  onRecover,
  onDiscard,
  disabled,
}: NoteRecoveryPromptProps) {
  return (
    <InlineNotice
      className="note-recovery-prompt"
      aria-label={t("Recoverable recording")}
      icon={<IconRecord size={14} aria-hidden />}
      body={`This recording was interrupted. We saved ${formatBytes(recovery.bytesFound)} of audio.`}
      actions={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onDiscard(recovery.sessionId)}
          >
            {t("Discard")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled}
            onClick={() => onRecover(recovery.sessionId)}
          >
            {t("Recover")}
          </button>
        </>
      }
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
