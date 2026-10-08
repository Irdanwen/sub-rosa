// The desktop composer's two voice buttons: dictation (words into the
// composer, ADR-0041) and the voice conversation (ADR-0093). The
// conversation's turns go through the workspace's own send, so they land in
// the selected chat (or start one) like typed messages: same history, same
// tools and connectors, same memory. A shared screen frame rides the turn
// as an image attachment, on a model that can see it.

import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconVoiceMode } from "central-icons/IconVoiceMode";
import { useMemo, useState } from "react";
import type { AgentChatTurn } from "../../lib/agent-chat-runtime";
import { attachmentStateFrom, type HermesAttachmentState } from "../../lib/hermes-image-attach";
import { t } from "../../lib/i18n";
import { modelSupportsImageInput } from "../../lib/model-privacy";
import {
  type ImportedHermesFile,
  importHermesBridgeFile,
  type VeniceModelDto,
} from "../../lib/tauri";
import { desktopReplySnapshot } from "../../lib/voice/reply-snapshot";
import { type VoiceFrame, VoiceConversation } from "./VoiceConversation";

export type VoiceTurnAttachment = ImportedHermesFile & {
  id: string;
  attach: HermesAttachmentState;
};

export function DesktopComposerVoice({
  onDictate,
  turns,
  sessionId,
  workingIds,
  send,
  stop,
  model,
  visionModel,
  selectModel,
}: {
  onDictate: () => void;
  /** The selected chat's transcript, as rendered. */
  turns: readonly AgentChatTurn[];
  sessionId: string | null | undefined;
  workingIds: ReadonlySet<string>;
  send: (text: string, attachments: VoiceTurnAttachment[]) => Promise<unknown>;
  stop: (sessionId: string) => unknown;
  /** The chat's model, when the catalog knows it. */
  model: Partial<Pick<VeniceModelDto, "capabilities">> | undefined;
  /** The model a turn with a picture switches to when the chat's cannot see. */
  visionModel: { id: string } | undefined;
  selectModel: (modelId: string) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const working = Boolean(sessionId && workingIds.has(sessionId));
  const reply = useMemo(() => desktopReplySnapshot(turns, working), [turns, working]);

  async function sendTurn(text: string, frame: VoiceFrame | null) {
    const attachments: VoiceTurnAttachment[] = [];
    if (frame?.kind === "screen") {
      const imported = await importHermesBridgeFile(frame.path);
      attachments.push({
        ...imported,
        id: `voice-screen:${Date.now()}`,
        attach: attachmentStateFrom(imported),
      });
      // The picture is the point of the turn: a model that cannot see it
      // would drop it, so the chat moves to one that can.
      if (model && !modelSupportsImageInput(model) && visionModel) {
        await selectModel(visionModel.id);
      }
    }
    await send(text, attachments);
  }

  return (
    <>
      <button
        type="button"
        className="agent-composer-mic"
        aria-label={t("Dictate")}
        title={t("Start dictation")}
        onClick={onDictate}
      >
        <IconMicrophone size={18} />
      </button>
      <button
        type="button"
        className="agent-composer-mic agent-composer-voice"
        aria-label={t("Voice conversation")}
        title={t("Talk with the assistant")}
        onClick={() => setOpen(true)}
      >
        <IconVoiceMode size={18} />
      </button>
      {open ? (
        <VoiceConversation
          shell="desktop"
          reply={reply}
          send={sendTurn}
          stop={() => {
            if (sessionId) void stop(sessionId);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
