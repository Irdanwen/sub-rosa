import { invoke } from "@tauri-apps/api/core";

/**
 * Running connectors for the person's browser (ADR-0107). A tab on `/app`
 * cannot reach some services; when this switch is on, this device offers the
 * connectors it is signed in to and makes the calls the tab asks for, under
 * its own rules. Off until the owner of this device says otherwise.
 */
export type RelaySettings = { enabled: boolean };

export const connectorRelaySettings = () => invoke<RelaySettings>("connector_relay_settings");

export const connectorRelaySetEnabled = (enabled: boolean) =>
  invoke<RelaySettings>("connector_relay_set_enabled", { enabled });
