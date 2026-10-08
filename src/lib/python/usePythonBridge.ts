import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { startPythonBridge } from "./bridge";
import { PYTHON_CANCEL_EVENT, PYTHON_RUN_EVENT, type PythonRunEvent } from "./protocol";
import { pythonWorkerUrl } from "./worker-url";

/** Mounted once by the phone shell, so a run is answered whatever screen the
 * person is on while the turn works. */
export function usePythonBridge() {
  useEffect(
    () =>
      startPythonBridge({
        onRun: (handler) =>
          listen<PythonRunEvent>(PYTHON_RUN_EVENT, (event) => handler(event.payload)),
        onCancel: (handler) =>
          listen<{ requestId: string }>(PYTHON_CANCEL_EVENT, (event) =>
            handler(event.payload.requestId),
          ),
        reply: (requestId, reply) => invoke("agent_lite_python_reply", { requestId, reply }),
        createWorker: () => new Worker(pythonWorkerUrl(), { type: "module", name: "python" }),
        visible: () => document.visibilityState === "visible",
        onVisibilityChange: (handler) => {
          document.addEventListener("visibilitychange", handler);
          return () => document.removeEventListener("visibilitychange", handler);
        },
      }),
    [],
  );
}
