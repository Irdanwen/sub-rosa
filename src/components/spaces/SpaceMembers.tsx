import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type PendingInvitation,
  type Space,
  type SpaceInvitation,
  type SpaceMember,
  spacesAdmit,
  spacesInvitations,
  spacesInvite,
  spacesRemoveMember,
  spacesRevokeInvitation,
  spacesSetVerified,
} from "../../lib/spaces";
import { SafetyNumber } from "./SafetyNumber";

function memberName(member: SpaceMember): string {
  if (member.isMe) return t("You");
  return member.name ?? t("A member");
}

/**
 * Who is in the project, and the owner's tools: invite by link, admit after
 * comparing safety numbers, remove. Removing someone starts a new epoch with
 * a new key they never receive.
 */
export function SpaceMembers({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => Promise<void>;
}) {
  const [invitation, setInvitation] = useState<SpaceInvitation | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [showing, setShowing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = space.isOwner && space.summary.state === "active";

  const loadPending = useCallback(async () => {
    if (!owner) return;
    try {
      setPending(await spacesInvitations(space.summary.id));
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }, [owner, space.summary.id]);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      await loadPending();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="spaces-members">
      {error ? (
        <p role="alert" className="spaces-hint">
          {error}
        </p>
      ) : null}
      <ul className="spaces-list">
        {space.members.map((member) => (
          <li key={member.accountId} className="spaces-list-item spaces-member">
            <span className="spaces-list-main">
              <span className="spaces-list-title">
                {memberName(member)}
                {member.role === "owner" ? (
                  <span className="spaces-badge">{t("Owner")}</span>
                ) : null}
                {member.verified ? <span className="spaces-badge">{t("Verified")}</span> : null}
              </span>
              {showing === member.accountId ? (
                <>
                  <span className="settings-row-description">
                    {t(
                      "Compare this number with the one on their device, in person or on a call. If both match, nobody is in between.",
                    )}
                  </span>
                  <SafetyNumber groups={member.safetyNumber} />
                  <label className="spaces-switch">
                    <input
                      type="checkbox"
                      checked={member.verified}
                      onChange={(event) =>
                        void run(() =>
                          spacesSetVerified(
                            space.summary.id,
                            member.accountId,
                            event.target.checked,
                          ),
                        )
                      }
                    />
                    <span>{t("The numbers match")}</span>
                  </label>
                </>
              ) : null}
              {removing === member.accountId ? (
                <span className="spaces-confirm">
                  {t(
                    "Remove this member? They lose access at once and cannot read anything written after, but they keep what they already received.",
                  )}
                </span>
              ) : null}
            </span>
            {member.isMe ? null : (
              <span className="spaces-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowing(showing === member.accountId ? null : member.accountId)}
                >
                  {t("Safety number")}
                </button>
                {owner ? (
                  removing === member.accountId ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setRemoving(null)}
                      >
                        {t("Cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await spacesRemoveMember(space.summary.id, member.accountId);
                            setRemoving(null);
                          })
                        }
                      >
                        {t("Remove")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setRemoving(member.accountId)}
                    >
                      {t("Remove")}
                    </button>
                  )
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      {owner ? (
        <section className="spaces-section">
          <h3 className="spaces-heading">{t("Invitations")}</h3>
          {pending.map((item) => (
            <div key={item.id} className="spaces-list-item">
              <span className="spaces-list-main">
                <span className="spaces-list-title">
                  {item.state === "waiting"
                    ? t("Waiting for someone to open the link")
                    : item.state === "ready"
                      ? t("Someone accepted. Compare safety numbers, then let them in.")
                      : t("This acceptance cannot be verified on this device.")}
                </span>
                {item.state === "ready" ? <SafetyNumber groups={item.safetyNumber} /> : null}
              </span>
              <span className="spaces-row">
                {item.state === "ready" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void run(() => spacesAdmit(space.summary.id, item.id))}
                  >
                    {t("Let them in")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void run(() => spacesRevokeInvitation(space.summary.id, item.id))}
                >
                  {t("Withdraw")}
                </button>
              </span>
            </div>
          ))}
          {invitation ? (
            <div className="spaces-invitation">
              <p className="spaces-hint">
                {t(
                  "Send this link to one person. It works once and for seven days. When they accept, compare safety numbers with them, then let them in here.",
                )}
              </p>
              <code className="spaces-code">{invitation.link}</code>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void writeText(invitation.link).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? t("Copied") : t("Copy link")}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => setInvitation(await spacesInvite(space.summary.id)))
            }
          >
            {t("Invite someone")}
          </button>
          <p className="spaces-hint">
            {t(
              "A new member can read the project's history. Whoever you remove keeps what they already received, and cannot read anything written after.",
            )}
          </p>
        </section>
      ) : null}
    </div>
  );
}
