// The library is the website's dependency, not the app's.
import { WebAuthnError } from "../../website/node_modules/@simplewebauthn/browser";
import { describe, expect, it } from "vitest";
import { passkeyWasDismissed } from "../../website/src/lib/passkeys";

describe("passkeyWasDismissed", () => {
  it("recognises a closed prompt in the shape the library throws it", () => {
    // What startAuthentication/startRegistration throw when the browser ends
    // the ceremony with NotAllowedError (checked against Chromium's virtual
    // authenticator): the library's own error, not a DOMException.
    const dismissed = new WebAuthnError({
      message: "The operation either timed out or was not allowed.",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      cause: new DOMException("not allowed", "NotAllowedError"),
    });
    expect(dismissed).not.toBeInstanceOf(DOMException);
    expect(passkeyWasDismissed(dismissed)).toBe(true);
  });

  it("still recognises the browser's own error", () => {
    expect(passkeyWasDismissed(new DOMException("not allowed", "NotAllowedError"))).toBe(true);
  });

  it("leaves every other failure to its own message", () => {
    const refused = new WebAuthnError({
      message: "The authenticator was previously registered",
      code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
      cause: new DOMException("already registered", "InvalidStateError"),
    });
    expect(passkeyWasDismissed(refused)).toBe(false);
    expect(passkeyWasDismissed(new Error("network"))).toBe(false);
    expect(passkeyWasDismissed("NotAllowedError")).toBe(false);
  });
});
