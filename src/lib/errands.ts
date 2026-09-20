import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { accountDevices, accountStatus } from "./account";

/**
 * Asking another of your devices to fetch a link (ADR-0054).
 *
 * The phone cannot read a streaming platform page, and the fix is not to move
 * the extractor to a server: it is to move the work to the machine that
 * already has one. This module is the thin side of that — the errand itself
 * travels as an ordinary encrypted revision.
 */
export const ERRAND_EVENT = "june://errand";

export type ErrandState = "requested" | "done" | "declined" | "expired";

export type Errand = {
  id: string;
  deviceId: string;
  url: string;
  folderId: string | null;
  requestedBy: string;
  requestedAt: string;
  state: ErrandState;
  noteId: string | null;
  message: string | null;
  updatedAt: string;
};

export type ErrandTarget = { id: string; name: string };

export const errandRequest = (url: string, deviceId: string, folderId?: string) =>
  invoke<Errand>("errand_request", { url, deviceId, folderId });

/** A list, whatever came back. The IPC boundary is not a type system: a
 * command that answers with nothing must leave the surface empty rather than
 * throw inside a render. */
const asErrands = (value: unknown): Errand[] => (Array.isArray(value) ? (value as Errand[]) : []);

export const errandList = () => invoke<Errand[]>("errand_list").then(asErrands);
export const errandCancel = (id: string) => invoke<void>("errand_cancel", { id });
export const errandSettings = () => invoke<{ enabled: boolean }>("errand_settings");
export const errandSetEnabled = (enabled: boolean) =>
  invoke<{ enabled: boolean }>("errand_set_enabled", { enabled });

export const onErrands = (handler: (errands: Errand[]) => void) => {
  const unlisten = listen<Errand[]>(ERRAND_EVENT, (event) => handler(asErrands(event.payload)));
  return () => {
    void unlisten.then((off) => off());
  };
};

/**
 * The devices that could take a link off this one: the account's own, minus
 * this device and minus anything revoked.
 *
 * Empty is the common answer and not an error — no account, one device, or no
 * network. The caller shows nothing rather than an apology.
 */
export async function errandTargets(): Promise<ErrandTarget[]> {
  try {
    const status = await accountStatus();
    if (!status.account || !status.device_id) return [];
    const devices = await accountDevices();
    return devices
      .filter((device) => device.id !== status.device_id && !device.revoked_at)
      .map((device) => ({ id: device.id, name: device.name || device.id.slice(0, 8) }));
  } catch {
    return [];
  }
}
