import { type HermesSessionInfo } from "../../lib/tauri";

export type UseAgentCoreStateDependencies = {
  BROWSER_APPROVALS_CHANGED_EVENT: "june://browser-approvals-changed";
  homeMode: boolean;
  initialSession: HermesSessionInfo | undefined;
  initialSessionIdProp: string | undefined;
  onTopUp: (() => void | Promise<void>) | undefined;
};
