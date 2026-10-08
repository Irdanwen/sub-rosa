/**
 * The two chat blocks connectors add (ADR-0092). Both name a row by id and
 * nothing else: what a call did, and the view it returned, live in the
 * native tables, so a card shows their current state (approved since,
 * declined on another device) rather than what the text said when it was
 * written. The app appends them under a reply itself; a model that copies
 * one gets the same card.
 */

/** A connector call: its result, or the confirmation an "ask" waits for. */
export type ConnectorCallChatBlock = { kind: "connector"; callId: string };

/** An interactive view a connector returned. */
export type ConnectorAppChatBlock = { kind: "app"; appId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseConnectorPayload(
  payload: Record<string, unknown>,
): ConnectorCallChatBlock | null {
  const id = typeof payload.callId === "string" ? payload.callId.trim() : "";
  return UUID.test(id) ? { kind: "connector", callId: id } : null;
}

export function parseAppPayload(payload: Record<string, unknown>): ConnectorAppChatBlock | null {
  const id = typeof payload.appId === "string" ? payload.appId.trim() : "";
  const call = id.startsWith("call-") ? id.slice("call-".length) : "";
  return UUID.test(call) ? { kind: "app", appId: id } : null;
}
