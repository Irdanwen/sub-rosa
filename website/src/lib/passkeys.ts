import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api } from "./api";

interface Challenge<T> {
  attempt_id: string;
  options: { publicKey: T };
}

/** A passkey is enrolled only after a recent, browser-bound account sign-in. */
export async function registerPasskey(): Promise<void> {
  const challenge = await api<Challenge<PublicKeyCredentialCreationOptionsJSON>>(
    "/api/v1/passkeys",
    { method: "POST" },
  );
  const credential = await startRegistration({ optionsJSON: challenge.options.publicKey });
  await api("/api/v1/passkeys/register/finish", {
    method: "POST",
    body: JSON.stringify({ attempt_id: challenge.attempt_id, credential }),
  });
}

/** This signs into the same internal account the passkey was linked to. */
export async function signInWithPasskey(): Promise<void> {
  const challenge = await api<Challenge<PublicKeyCredentialRequestOptionsJSON>>(
    "/api/v1/passkeys/authenticate/start",
    { method: "POST" },
  );
  const credential = await startAuthentication({ optionsJSON: challenge.options.publicKey });
  await api("/api/v1/passkeys/authenticate/finish", {
    method: "POST",
    body: JSON.stringify({ attempt_id: challenge.attempt_id, credential }),
  });
}
