import { useState } from "react";
import { type AccountConflict, accountSyncResolveConflict } from "../../lib/account";
import { errorCode } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { InlineNotice } from "../ui/InlineNotice";
import { AccountConflictReview } from "./AccountConflictReview";

/** What the preserved version is, so a list of them is not a list of dates. */
function conflictLabel(conflict: AccountConflict): string {
  const deleted = conflict.deleted === true;
  switch (conflict.kind) {
    case "memory":
      return deleted ? t("Memory deleted on another device") : t("Memory entry");
    case "note":
      return deleted ? t("Note deleted on another device") : t("Note");
    case "conversation":
      return deleted ? t("Conversation deleted on another device") : t("Conversation");
    case "artifact":
      return deleted ? t("Recording or file deleted on another device") : t("Recording or file");
    default:
      return deleted ? t("Item deleted on another device") : t("Item");
  }
}

/**
 * The versions a sync preserved, and one way to settle them all at once.
 * Keeping this device's version is the choice a person makes most, and one
 * review dialog per item turns eighty of them into an afternoon.
 */
export function AccountConflictList({
  conflicts,
  onResolved,
  formatDate,
}: {
  conflicts: AccountConflict[];
  onResolved: () => Promise<unknown>;
  formatDate: (value: string) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  if (conflicts.length === 0) return null;

  async function keepAll() {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    let waiting = 0;
    let failed = 0;
    for (const conflict of conflicts) {
      try {
        await accountSyncResolveConflict(conflict.id, "keep_local");
      } catch (cause) {
        if (errorCode(cause) === "sync_pending_changes") waiting += 1;
        else failed += 1;
      }
    }
    try {
      await onResolved();
    } finally {
      setBusy(false);
      if (failed > 0) {
        setOutcome(
          failed === 1
            ? t("1 version could not be settled. It is still preserved. Try again.")
            : t("{count} versions could not be settled. They are still preserved. Try again.", {
                count: failed,
              }),
        );
      } else if (waiting > 0) {
        setOutcome(
          waiting === 1
            ? t(
                "1 version is waiting for this device to send its changes. Try again after the next sync.",
              )
            : t(
                "{count} versions are waiting for this device to send its changes. Try again after the next sync.",
                { count: waiting },
              ),
        );
      }
    }
  }

  return (
    <>
      <div className="account-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void keepAll()}
        >
          {t("Keep this device's version for all")}
        </button>
      </div>
      {outcome ? <InlineNotice body={outcome} /> : null}
      {conflicts.map((conflict) => (
        <div className="account-device" key={conflict.id}>
          <p className="settings-row-description">
            {t("{item}, preserved version from {time}", {
              item: conflictLabel(conflict),
              time: formatDate(conflict.created_at),
            })}
          </p>
          <AccountConflictReview conflict={conflict} onResolved={onResolved} />
        </div>
      ))}
    </>
  );
}
