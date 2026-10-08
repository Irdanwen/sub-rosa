/**
 * Changing who is in a shared project, from this tab (ADR-0098): the owner
 * makes an invitation link, checks the acceptance that comes back, admits,
 * and removes; any member rotates out someone who signed themselves out.
 * The same steps as the app (`account/spaces/client.rs`, `commands.rs`),
 * and the shared vectors hold `composeRotation` to `compose_rotation`'s
 * bytes.
 *
 * An invitation's secret never leaves the browser that made the link: it is
 * kept in the feature's store, sealed under the vault key, because the
 * owner's device is the one that checks the acceptance proof. A link made
 * in the app is admitted from the app, and the reverse.
 */
import type { FeatureStore } from "../feature";
import type { DetailInvitation, Me, SpaceView, SpacesTransport } from "./client";
import {
  type Bytes,
  b64,
  type Departure,
  type EpochHead,
  type HeadMember,
  type IdentityBundle,
  type IdentitySecret,
  type InvitePayload,
  acceptanceProof,
  grouped,
  invitationCode,
  inviteToken,
  memberFromBundle,
  ROLE_MEMBER,
  safetyNumber,
  sealPayload,
  signHead,
  tokenHash,
  unb64,
  verifyBundle,
  verifyNext,
  wrapKey,
} from "./protocol";

/** Seven days, the longest the service keeps an invitation. */
export const INVITATION_DAYS = 7;

export class MembershipError extends Error {
  constructor(
    public code:
      | "space_owner_only"
      | "space_invitation_unavailable"
      | "space_acceptance_unverifiable",
  ) {
    super(code);
  }
}

// --- Rotations ---------------------------------------------------------------

export interface WrappedKey {
  account_id: string;
  epoch: number;
  sealed: string;
}
export interface Rotation {
  head: EpochHead;
  wrapped_keys: WrappedKey[];
  admit: string[];
}
export interface Admission {
  invitationId: string;
  member: IdentityBundle;
}

/**
 * One new epoch, without the network: a head this account signs, the fresh
 * key sealed to every member, and for a newcomer the earlier keys too, so a
 * project's history is theirs to read. `ephemeral` gives each wrap its HPKE
 * ephemeral secret in the order Rust asks for them: the members in head
 * order, then the newcomer's earlier epochs, oldest first.
 */
export async function composeRotation(draft: {
  identity: IdentitySecret;
  me: string;
  latest: EpochHead;
  keys: Map<number, Bytes>;
  members: HeadMember[];
  departures: Departure[];
  admission: Admission | null;
  key: Bytes;
  createdAt: string;
  ephemeral?: () => Bytes;
}): Promise<Rotation> {
  const next = draft.ephemeral ?? (() => crypto.getRandomValues(new Uint8Array(32)) as Bytes);
  const spaceId = draft.latest.space_id;
  const epoch = draft.latest.epoch + 1;
  const head = await signHead(
    {
      spaceId,
      epoch,
      prev: draft.latest,
      owner: draft.latest.owner,
      members: draft.members,
      key: draft.key,
      author: draft.me,
      departures: draft.departures,
      createdAt: draft.createdAt,
    },
    draft.identity,
  );
  // The same rules every member will apply, applied first by the author.
  await verifyNext(draft.latest, head);
  const wrapped: WrappedKey[] = [];
  for (const member of head.members)
    wrapped.push({
      account_id: member.account_id,
      epoch,
      sealed: await wrapKey(draft.key, member.x25519, spaceId, epoch, member.account_id, next()),
    });
  const admit: string[] = [];
  if (draft.admission) {
    const newcomer = draft.admission.member;
    for (const [oldEpoch, oldKey] of [...draft.keys].sort(([a], [b]) => a - b))
      wrapped.push({
        account_id: newcomer.account_id,
        epoch: oldEpoch,
        sealed: await wrapKey(
          oldKey,
          newcomer.x25519,
          spaceId,
          oldEpoch,
          newcomer.account_id,
          next(),
        ),
      });
    admit.push(draft.admission.invitationId);
  }
  return { head, wrapped_keys: wrapped, admit };
}

async function rotate(
  transport: SpacesTransport,
  me: Me,
  view: SpaceView,
  members: HeadMember[],
  departures: Departure[],
  admission: Admission | null,
) {
  const rotation = await composeRotation({
    identity: me.identity,
    me: me.accountId,
    latest: view.latest,
    keys: view.keys,
    members,
    departures,
    admission,
    key: crypto.getRandomValues(new Uint8Array(32)) as Bytes,
    createdAt: new Date().toISOString(),
  });
  await transport.send("POST", `/api/v1/spaces/${view.id}/epochs`, rotation);
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error
    ? (error as { status: number }).status
    : undefined;
}

const isOwner = (me: Me, view: SpaceView) => view.latest.owner === me.accountId;

/** The owner takes a member out: a new epoch without them, its key sealed
 * to everyone else. They keep what they already read, and nothing after. */
export async function removeMember(
  transport: SpacesTransport,
  me: Me,
  view: SpaceView,
  accountId: string,
): Promise<boolean> {
  if (!isOwner(me, view) || accountId === me.accountId)
    throw new MembershipError("space_owner_only");
  const members = view.latest.members.filter((m) => m.account_id !== accountId);
  if (members.length === view.latest.members.length) return false;
  await rotate(transport, me, view, members, [], null);
  return true;
}

/**
 * The rotation a departure, or an account that vanished, calls for. The
 * owner rotates anyone out; another member only those who signed
 * themselves out. Answers whether a new epoch was made; a rotation someone
 * else made first is not an error, the next read shows it.
 */
export async function rotateIfDue(
  transport: SpacesTransport,
  me: Me,
  view: SpaceView,
): Promise<boolean> {
  const departures: Departure[] = view.departures
    .filter(
      (d) =>
        d.epoch === view.latest.epoch &&
        view.latest.members.some((m) => m.account_id === d.account_id),
    )
    .map((d) => ({ account_id: d.account_id, signature: d.statement }));
  const leaving = (id: string) => departures.some((d) => d.account_id === id);
  const stays = view.latest.members.filter(
    (m) => view.onService.includes(m.account_id) && !leaving(m.account_id),
  );
  if (stays.length === view.latest.members.length) return false;
  const onlyDepartures = view.latest.members.length - stays.length === departures.length;
  if (!isOwner(me, view) && (departures.length === 0 || !onlyDepartures)) return false;
  try {
    await rotate(transport, me, view, stays, departures, null);
    return true;
  } catch (error) {
    if (status(error) === 409) return false;
    throw error;
  }
}

// --- Invitations -------------------------------------------------------------

interface KeptSecret {
  spaceId: string;
  secret: string;
  expiresAt: string;
}
const secretKey = (invitationId: string) => `invitation:${invitationId}`;

/** The body of `POST /api/v1/spaces/{id}/invitations`, and the code the link
 * carries in its fragment. `nonce` is for the vectors only. */
export async function composeInvitation(
  invitationId: string,
  secret: Bytes,
  payload: InvitePayload,
  nonce?: Bytes,
) {
  return {
    request: {
      id: invitationId,
      token_hash: await tokenHash(await inviteToken(secret, invitationId)),
      payload: await sealPayload(secret, invitationId, payload, nonce),
      expires_at: payload.expires_at,
    },
    code: invitationCode(invitationId, secret),
  };
}

export interface MadeInvitation {
  id: string;
  code: string;
  /** The page to open, the code in its fragment so it never reaches a
   * server's logs. */
  link: string;
  expiresAt: string;
}

/** Makes a link for this space. The secret stays sealed in this browser:
 * the acceptance that comes back is checked here, and admitted from here. */
export async function createInvitation(
  transport: SpacesTransport,
  secrets: FeatureStore,
  me: Me,
  view: SpaceView,
  appUrl: string,
  now = new Date(),
): Promise<MadeInvitation> {
  if (!isOwner(me, view)) throw new MembershipError("space_owner_only");
  const id = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000).toISOString();
  const { request, code } = await composeInvitation(id, secret, {
    v: 1,
    space_id: view.id,
    space_name: view.name,
    inviter: me.bundle,
    expires_at: expiresAt,
  });
  await transport.send("POST", `/api/v1/spaces/${view.id}/invitations`, request);
  await secrets.put(secretKey(id), {
    spaceId: view.id,
    secret: b64(secret),
    expiresAt,
  } satisfies KeptSecret);
  return { id, code, link: `${appUrl}#join=${code}`, expiresAt };
}

export type Acceptance =
  | { state: "waiting" }
  /** The link was made on another device, or the proof does not hold. */
  | { state: "unverifiable" }
  | { state: "ready"; member: IdentityBundle };

/** An acceptance the owner may admit: its proof checked with the secret
 * this browser kept when it made the link (`client::check_acceptance`). */
export async function checkAcceptance(
  secrets: FeatureStore,
  spaceId: string,
  invitation: DetailInvitation,
): Promise<Acceptance> {
  if (!invitation.claimed_by || !invitation.acceptance) return { state: "waiting" };
  const kept = await secrets.get<KeptSecret>(secretKey(invitation.id));
  if (!kept || kept.spaceId !== spaceId) return { state: "unverifiable" };
  const acceptance = invitation.acceptance as { member?: IdentityBundle; proof?: unknown };
  const member = acceptance.member;
  try {
    if (!member || member.account_id !== invitation.claimed_by) throw new Error("claimant");
    await verifyBundle(member);
    const expected = await acceptanceProof(unb64(kept.secret), invitation.id, spaceId, member);
    if (!constantTimeEqual(expected, acceptance.proof)) throw new Error("proof");
  } catch {
    return { state: "unverifiable" };
  }
  return { state: "ready", member };
}

function constantTimeEqual(a: string, b: unknown): boolean {
  if (typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface PendingInvitation {
  id: string;
  expiresAt: string;
  state: Acceptance["state"];
  /** The safety number to compare before admitting, when it is ready. */
  safetyNumber: string[];
}

/** The owner's invitations for this space, each with what it waits for. */
export async function pendingInvitations(
  secrets: FeatureStore,
  me: Me,
  view: SpaceView,
): Promise<PendingInvitation[]> {
  if (!isOwner(me, view)) return [];
  const out: PendingInvitation[] = [];
  for (const invitation of view.invitations) {
    const acceptance = await checkAcceptance(secrets, view.id, invitation);
    out.push({
      id: invitation.id,
      expiresAt: invitation.expires_at,
      state: acceptance.state,
      safetyNumber:
        acceptance.state === "ready"
          ? grouped(await safetyNumber(me.bundle, acceptance.member))
          : [],
    });
  }
  return out;
}

/** The owner admits someone whose acceptance holds: a new epoch with them
 * in it, and the earlier keys sealed to them. The secret is forgotten. */
export async function admit(
  transport: SpacesTransport,
  secrets: FeatureStore,
  me: Me,
  view: SpaceView,
  invitationId: string,
): Promise<void> {
  if (!isOwner(me, view)) throw new MembershipError("space_owner_only");
  const invitation = view.invitations.find((i) => i.id === invitationId);
  if (!invitation) throw new MembershipError("space_invitation_unavailable");
  const acceptance = await checkAcceptance(secrets, view.id, invitation);
  if (acceptance.state !== "ready") throw new MembershipError("space_acceptance_unverifiable");
  const members = view.latest.members.filter((m) => m.account_id !== acceptance.member.account_id);
  members.push(memberFromBundle(acceptance.member, ROLE_MEMBER));
  await rotate(transport, me, view, members, [], {
    invitationId,
    member: acceptance.member,
  });
  await secrets.delete(secretKey(invitationId));
}

/** Withdraws a link: the service forgets it, this browser its secret. */
export async function revokeInvitation(
  transport: SpacesTransport,
  secrets: FeatureStore,
  spaceId: string,
  invitationId: string,
): Promise<void> {
  await transport.send("DELETE", `/api/v1/spaces/${spaceId}/invitations/${invitationId}`);
  await secrets.delete(secretKey(invitationId));
}
