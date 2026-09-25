import { t } from "./i18n";

/**
 * What a failed synchronisation says to the person who owns the data.
 *
 * Never the native or server detail, and never a filename: the point is what
 * to do next. Several of these are not failures at all — work in flight, a
 * change waiting on another — and say so, because "try again" is wrong advice
 * for something that finishes on its own.
 */
export function accountSyncError(code: string): string {
  switch (code) {
    case "sync_file_too_large":
      return t(
        "A file exceeds the sync size limit and remains on this device. Use a smaller copy to sync it.",
      );
    case "sync_object_too_large":
      return t(
        "Some content exceeds the sync size limit and remains on this device. Reduce its size to sync it.",
      );
    case "account_network":
    case "account_offline":
    case "sync_timeout":
    case "sync_blob_request_failed":
      return t(
        "The sync service is unavailable or did not respond in time. Your changes will retry automatically.",
      );
    case "account_not_connected":
    case "account_revoked":
    case "sync_authentication_failed":
      return t("Sign in again to resume synchronization.");
    case "vault_locked":
      return t("Open your vault to resume synchronization.");
    case "sync_file_unavailable":
      return t(
        "A file could not be read on this device. Check that it is available, then try again.",
      );
    case "sync_file_changed":
      return t(
        "A file changed while it was being sent. Wait for it to finish changing, then retry.",
      );
    case "sync_file_type_unsupported":
      return t("This kind of file is not synchronized. It stays on this device.");
    case "sync_local_work_active":
    case "sync_pending_changes":
    case "sync_dependencies_pending":
      return t("Synchronization is waiting for work on this device to finish. Nothing is lost.");
    case "sync_conflict_requires_review":
      return t("Two devices changed the same thing. Review the conflict to choose what to keep.");
    case "sync_resolution_invalid":
      return t("That choice no longer applies. Reload the conflict and choose again.");
    case "sync_blob_invalid":
    case "sync_format_invalid":
      return t(
        "Some content did not match what this version understands, and was left alone. Update your apps, then try again.",
      );
    case "sync_local_object_invalid":
      return t(
        "An item on this device could not be prepared for sync. Other items will continue to sync.",
      );
    default:
      return t("Synchronization could not finish. Your local copies are preserved. Try again.");
  }
}
