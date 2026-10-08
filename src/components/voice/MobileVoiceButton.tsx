// The phone composer's voice conversation button (ADR-0093). The turns go
// through the chat screen's own send, so they are agent-lite turns of this
// chat: stored, titled, remembered, with the tools of any other turn. A
// camera frame rides the turn as an image, which routes it to a model that
// can see (vision-routing.ts).

import { IconVoiceMode } from "central-icons/IconVoiceMode";
import { useState } from "react";
import { hapticImpact } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import type { AgentLiteAttachment } from "../../lib/tauri";
import type { ReplySnapshot } from "../../lib/voice/reply-snapshot";
import { frameAttachment } from "../../lib/voice/voice-camera";
import { VoiceConversation } from "./VoiceConversation";

export function MobileVoiceButton({
  reply,
  send,
  stop,
}: {
  reply: ReplySnapshot;
  send: (text: string, image: AgentLiteAttachment | null) => Promise<void>;
  stop: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="mobile-composer-bare"
        aria-label={t("Voice conversation")}
        onClick={() => {
          hapticImpact("light");
          setOpen(true);
        }}
      >
        <IconVoiceMode size={20} />
      </button>
      {open ? (
        <VoiceConversation
          shell="mobile"
          reply={reply}
          send={(text, frame) =>
            send(text, frame?.kind === "camera" ? frameAttachment(frame.dataUrl) : null)
          }
          stop={stop}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
