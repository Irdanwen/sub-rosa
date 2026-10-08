// A voice conversation for a React surface: one controller for the
// surface's life, its state as React state, the chat's reply fed in on
// every change, and the session ended when the surface goes away.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReplySnapshot } from "./reply-snapshot";
import { createVoiceController, type VoicePort } from "./voice-controller";
import { voiceCommands } from "./voice-session";

export function useVoiceConversation(port: VoicePort, reply: ReplySnapshot) {
  const portRef = useRef(port);
  portRef.current = port;
  const [controller] = useState(() =>
    createVoiceController({
      commands: voiceCommands,
      port: {
        send: (text) => portRef.current.send(text),
        stop: () => portRef.current.stop(),
      },
    }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { key, text, done } = reply;
  useEffect(() => {
    controller.updateReply({ key, text, done });
  }, [controller, key, text, done]);
  useEffect(
    () => () => {
      void controller.end();
    },
    [controller],
  );
  return { state, controller };
}
