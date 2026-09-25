import { invoke } from "@tauri-apps/api/core";

/** Native account credentials and encryption keys never enter web storage. */
export type AccountStatus = {
  default_server_url: string;
  server_url: string | null;
  account: { id: string; email: string; created_at: string } | null;
  device_id: string | null;
  /**
   * How this device stands with the service, which is a different question
   * from whether the vault is open. "renewable" means there is no live session
   * but this device can mint one on its own, without a browser.
   */
  connection: "none" | "connected" | "renewable";
  device_authorized: boolean;
  login_pending: boolean;
  pairing_pending: boolean;
  vault_unlocked: boolean;
  recovery_confirmed: boolean;
  recovery_available: boolean;
  vault_exists?: boolean | null;
  sync_enabled: boolean;
  pending_changes: number;
  conflicts: number;
  last_synced_at: string | null;
  last_sync_error?: string | null;
  sync_issue_count?: number;
  sync_issues?: Array<{
    lane: "outbox" | "upload" | "download";
    item_id: string;
    code: string;
    created_at: string;
    label?: string | null;
  }>;
};
export type AccountLogin = {
  request_id: string;
  verification_uri: string;
  user_code: string;
  expires_at: string;
  interval_seconds: number;
};
export type AccountDevice = {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** A cloned device secret shows itself as renewals nobody made. */
  renewed_at?: string | null;
  renew_count?: number;
};
/** A sign-in that returns by itself. No user code: nothing here is read out. */
export type AccountNativeLogin = {
  request_id: string;
  start_url: string;
  expires_at: string;
};
export type AccountConflict = {
  id: string;
  kind: string;
  object_id: string;
  created_at: string;
};

/**
 * Every command that answers with a status publishes it, so a surface that is
 * not the account panel — the sidebar footer naming who you are — does not sit
 * on whatever was true when it mounted.
 */
const watchers = new Set<(status: AccountStatus) => void>();

export function onAccountStatus(watcher: (status: AccountStatus) => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function published(status: AccountStatus) {
  for (const watcher of watchers) watcher(status);
  return status;
}

// Keep the call shape a command with no arguments actually has, rather than
// handing the bridge an explicit undefined.
const statusCommand = (command: string, args?: Record<string, unknown>) =>
  (args === undefined ? invoke<AccountStatus>(command) : invoke<AccountStatus>(command, args)).then(
    published,
  );

export const accountStatus = () => statusCommand("account_status");
export const accountConfigure = (serverUrl: string) =>
  statusCommand("account_configure", { serverUrl });
export const accountLoginOpen = (deviceName: string) =>
  invoke<AccountNativeLogin>("account_login_open", { deviceName });
export const accountLoginPasskey = (deviceName: string) =>
  invoke<void>("account_login_passkey", { deviceName });
export const accountLoginPending = () => invoke<AccountNativeLogin | null>("account_login_pending");
export const accountLoginCancel = () => invoke<void>("account_login_cancel");
/** The fallback flow, kept for when the page cannot hand the app back. */
export const accountLoginStart = (deviceName: string) =>
  invoke<AccountLogin>("account_login_start", { deviceName });
export const accountLoginExchange = (requestId: string) =>
  statusCommand("account_login_exchange", { requestId });
export const accountLogout = () => statusCommand("account_logout");
export const accountDevices = () => invoke<AccountDevice[]>("account_devices");
export const accountRevokeDevice = (deviceId: string) =>
  invoke<void>("account_revoke_device", { deviceId });
export const accountDelete = () => invoke<void>("account_delete");
export const accountVaultCreate = () => invoke<{ recovery_key: string }>("account_vault_create");
export const accountVaultUnlock = (recoveryKey: string) =>
  statusCommand("account_vault_unlock", { recoveryKey });
export const accountSyncSetEnabled = (enabled: boolean) =>
  statusCommand("account_sync_set_enabled", { enabled });
export const accountSyncNow = () => statusCommand("account_sync_now");
export const accountSyncRetryIssues = () => statusCommand("account_sync_retry_issues");
export const accountSyncConflicts = () => invoke<AccountConflict[]>("account_sync_conflicts");
export const accountSyncRestoreConflict = (conflictId: string) =>
  statusCommand("account_sync_restore_conflict", { conflictId });
export const accountVaultShareCarpeDiem = () => statusCommand("account_vault_share_carpe_diem");
export const accountVaultRestoreCarpeDiem = () => statusCommand("account_vault_restore_carpe_diem");

export const accountVaultConfirmRecovery = (recoveryKey: string) =>
  statusCommand("account_vault_confirm_recovery", { recoveryKey });
export const accountVaultRecoveryKit = () =>
  invoke<{ recovery_key: string }>("account_vault_recovery_kit");
export type AccountPairing = { request_id: string; transfer_code: string; expires_at: string };
export const accountPairingStart = () => invoke<AccountPairing>("account_pairing_start");
export const accountPairingApprove = (transferCode: string) =>
  invoke<void>("account_pairing_approve", { transferCode });
export const accountPairingExchange = (requestId: string) =>
  statusCommand("account_pairing_exchange", { requestId });
export const accountPairingCancel = (requestId: string) =>
  invoke<void>("account_pairing_cancel", { requestId });
/** Picks a request back up after a reload, with the same code, instead of
 * stranding it until it expires. */
export const accountPairingResume = () => invoke<AccountPairing | null>("account_pairing_resume");
export type PortableConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
};
export type PortableConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
export type PortableConversation = {
  id: string;
  title: string;
  messages: PortableConversationMessage[];
};
export const accountConversationsList = () =>
  invoke<PortableConversationSummary[]>("account_conversations_list");
export const accountConversationGet = (taskId: string) =>
  invoke<PortableConversation>("account_conversation_get", { taskId });
export const accountConversationPrepare = (taskId: string, newMessage: string) =>
  invoke<{ task_id: string; prompt: string; title: string; display_content: string }>(
    "account_conversation_prepare",
    { taskId, newMessage },
  );
export const accountConversationBind = (taskId: string, sessionId: string) =>
  invoke<void>("account_conversation_bind", { taskId, sessionId });
export type AccountConflictPreview = {
  local_preview: string | null;
  remote_preview: string | null;
  deleted: boolean;
  kind: string;
};
export const accountSyncConflictPreview = (conflictId: string) =>
  invoke<AccountConflictPreview>("account_sync_conflict_preview", { conflictId });
export const accountSyncResolveConflict = (
  conflictId: string,
  resolution: "keep_local" | "use_remote" | "copy",
) => statusCommand("account_sync_resolve_conflict", { conflictId, resolution });

/** How long a share link answers. The same three the Rust side accepts, and
 * the service rejects anything else: an expiry is a decision, not a default. */
export const SHARE_WINDOWS = [24, 24 * 7, 24 * 30] as const;
export type ShareWindow = (typeof SHARE_WINDOWS)[number];
export type ShareLink = { id: string; url: string; expires_at: string };
export type ShareSummary = {
  id: string;
  title: string;
  note_id: string | null;
  created_at: string;
  expires_at: string;
  bytes: number;
};
/** The returned URL carries the key in its fragment. It is the one secret the
 * app hands to the interface on purpose, because copying it is the feature. */
export const accountShareNote = (noteId: string, windowHours: ShareWindow) =>
  invoke<ShareLink>("account_share_note", { noteId, windowHours });
export const accountShares = () => invoke<ShareSummary[]>("account_shares");
export const accountRevokeShare = (shareId: string) =>
  invoke<void>("account_revoke_share", { shareId });
