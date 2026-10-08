/**
 * Shared projects and group chats (ADR-0098), the Tauri side. Everything
 * cryptographic happens in Rust (`src-tauri/src/account/spaces/`); this file
 * only names the commands both shells call and the event they listen to.
 * A preview: the protocol waits for an independent review before it is on by
 * default (docs/security/spaces-protocol.md).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SpaceState = "active" | "pending" | "left" | "removed";

export type SpaceSummary = {
  id: string;
  name: string;
  role: "owner" | "member";
  state: SpaceState;
  sourceFolderId: string | null;
  unread: number;
  lastError: string | null;
  updatedAt: string;
};

export type SpacesStatus = {
  enabled: boolean;
  displayName: string;
  spaces: SpaceSummary[];
};

export type SpaceMember = {
  accountId: string;
  name: string | null;
  role: "owner" | "member";
  isMe: boolean;
  verified: boolean;
  safetyNumber: string[];
};

export type SpaceContent = {
  id: string;
  title: string;
  body: string;
  format: string | null;
  authorName: string | null;
  pending: boolean;
  createdAt: string;
};

export type SpaceConversation = {
  id: string;
  title: string;
  messages: number;
  lastAt: string;
};

export type SpaceTurn = { id: string; conversationId: string; failed: boolean };

export type Space = {
  summary: SpaceSummary;
  instructions: string;
  isOwner: boolean;
  members: SpaceMember[];
  notes: SpaceContent[];
  files: SpaceContent[];
  conversations: SpaceConversation[];
  turns: SpaceTurn[];
  pendingWrites: number;
};

export type SpaceMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  authorId: string;
  authorName: string | null;
  isMine: boolean;
  model: string | null;
  paidByName: string | null;
  pending: boolean;
  createdAt: string;
};

export type SpaceInvitation = { id: string; link: string; code: string; expiresAt: string };

export type PendingInvitation = {
  id: string;
  expiresAt: string;
  state: "waiting" | "ready" | "unverifiable";
  safetyNumber: string[];
};

export type InvitationPreview = {
  invitationId: string;
  spaceId: string;
  spaceName: string;
  expiresAt: string;
  safetyNumber: string[];
};

export const SPACES_UPDATED = "subrosa://spaces-updated";

export function onSpacesUpdated(listener: (spaceIds: string[]) => void) {
  return listen<string[]>(SPACES_UPDATED, (event) => listener(event.payload ?? []));
}

export const spacesStatus = () => invoke<SpacesStatus>("spaces_status");
export const spacesSetEnabled = (enabled: boolean, displayName: string) =>
  invoke<SpacesStatus>("spaces_set_enabled", { enabled, displayName });
export const spacesCreate = (folderId: string) =>
  invoke<SpaceSummary>("spaces_create", { folderId });
export const spacesGet = (spaceId: string) => invoke<Space>("spaces_get", { spaceId });
export const spacesSync = (spaceId?: string) =>
  invoke<void>("spaces_sync", { spaceId: spaceId ?? null });
export const spacesMarkRead = (spaceId: string) => invoke<void>("spaces_mark_read", { spaceId });
export const spacesInvite = (spaceId: string) =>
  invoke<SpaceInvitation>("spaces_invite", { spaceId });
export const spacesInvitations = (spaceId: string) =>
  invoke<PendingInvitation[]>("spaces_invitations", { spaceId });
export const spacesAdmit = (spaceId: string, invitationId: string) =>
  invoke<void>("spaces_admit", { spaceId, invitationId });
export const spacesRevokeInvitation = (spaceId: string, invitationId: string) =>
  invoke<void>("spaces_revoke_invitation", { spaceId, invitationId });
export const spacesOpenInvitation = (code: string) =>
  invoke<InvitationPreview>("spaces_open_invitation", { code });
export const spacesAcceptInvitation = (code: string) =>
  invoke<SpaceSummary>("spaces_accept_invitation", { code });
export const spacesRemoveMember = (spaceId: string, accountId: string) =>
  invoke<void>("spaces_remove_member", { spaceId, accountId });
export const spacesLeave = (spaceId: string) => invoke<void>("spaces_leave", { spaceId });
export const spacesDelete = (spaceId: string) => invoke<void>("spaces_delete", { spaceId });
export const spacesForget = (spaceId: string) => invoke<void>("spaces_forget", { spaceId });
export const spacesSetVerified = (spaceId: string, accountId: string, verified: boolean) =>
  invoke<void>("spaces_set_verified", { spaceId, accountId, verified });
export const spacesSaveProject = (spaceId: string, name: string, instructions: string) =>
  invoke<void>("spaces_save_project", { spaceId, name, instructions });
export const spacesSaveNote = (
  spaceId: string,
  noteId: string | null,
  title: string,
  body: string,
) => invoke<string>("spaces_save_note", { spaceId, noteId, title, body });
export const spacesDeleteObject = (spaceId: string, objectId: string) =>
  invoke<void>("spaces_delete_object", { spaceId, objectId });
export const spacesMessages = (spaceId: string, conversationId: string) =>
  invoke<SpaceMessage[]>("spaces_messages", { spaceId, conversationId });
export const spacesNewConversation = (spaceId: string, title: string) =>
  invoke<string>("spaces_new_conversation", { spaceId, title });
export const spacesSendMessage = (
  spaceId: string,
  conversationId: string,
  text: string,
  askAssistant: boolean,
) => invoke<void>("spaces_send_message", { spaceId, conversationId, text, askAssistant });
export const spacesRetryTurn = (turnId: string) => invoke<void>("spaces_retry_turn", { turnId });

/** The safety number as it is read aloud or compared: twelve groups of five. */
export function formatSafetyNumber(groups: string[]): string {
  return groups.join(" ");
}

/** Whether a pasted text holds an invitation code. Mirrors `parse_invitation`. */
export function looksLikeInvitation(text: string): boolean {
  return /srspace1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(text);
}
